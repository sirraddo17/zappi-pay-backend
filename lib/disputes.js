// Wrong transfers ("I sent this by mistake"), following the CBN rules on
// erroneous instant transfers:
//  • ZAPPI PAY user → ZAPPI PAY user: we hold (lien) the amount still in
//    the recipient's wallet for up to 14 days and ask them to return it.
//    Nothing leaves their wallet without their consent, except when an
//    admin finds it was ZAPPI PAY's own system error, or after a review
//    (mediation) decides for the sender — and then only the held amount.
//    When the 14 days end without a decision, the hold is released.
//  • ZAPPI PAY → bank: we can't hold anything; an admin raises a recall
//    with the payment partner and records the outcome. Money recovered is
//    credited back to the sender.
// Every step is notified and kept as a statement the sender can print for
// the police / bank if the recipient refuses.

const prisma = require('./prisma');
const { notify } = require('./notify');

const DAY = 24 * 3600 * 1000;
const HOLD_DAYS = 14;
const REPORT_WITHIN_DAYS = 30;
const OPEN_WALLET = ['AWAITING_RECIPIENT', 'RECIPIENT_DISPUTES'];
const OPEN_BANK = ['RECALL_REQUESTED', 'RECALL_SENT'];
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

class DisputeError extends Error {
  constructor(msg, status = 400, code) { super(msg); this.status = status; this.code = code; }
}
const alert = (title, body) => require('./adminAlert').alertAdmins(title, body, '/admin/disputes').catch?.(() => {});

// Hold up to `amount` of what is in the recipient's wallet right now.
async function hold(tx, recipientId, amount, note) {
  const c = await tx.customer.findUnique({ where: { id: recipientId }, select: { walletBalance: true } });
  const h = r2(Math.max(0, Math.min(Number(amount), Number(c?.walletBalance || 0))));
  if (h > 0) {
    const ok = await tx.customer.updateMany({ where: { id: recipientId, walletBalance: { gte: h } }, data: { walletBalance: { decrement: h } } });
    if (ok.count !== 1) return 0;
    await tx.walletTransaction.create({ data: { customerId: recipientId, type: 'DISPUTE_HOLD', amount: h, status: 'APPROVED', note } });
  }
  return h;
}
async function credit(tx, customerId, amount, type, note) {
  if (!(amount > 0)) return;
  await tx.customer.update({ where: { id: customerId }, data: { walletBalance: { increment: amount } } });
  await tx.walletTransaction.create({ data: { customerId, type, amount, status: 'APPROVED', note } });
}
// Move the dispute from one open status to another exactly once.
async function claim(tx, d, from, data) {
  const r = await tx.transferDispute.updateMany({ where: { id: d.id, status: { in: from } }, data });
  if (r.count !== 1) throw new DisputeError('This has already been dealt with.', 409);
}

// --- Customer ---------------------------------------------------------

async function reportWallet(senderId, transferId, reason) {
  const t = await prisma.transfer.findUnique({ where: { id: transferId }, include: { receiver: { select: { id: true, name: true } }, sender: { select: { name: true } } } });
  if (!t || t.senderId !== senderId) throw new DisputeError('Transfer not found.', 404);
  if (Date.now() - new Date(t.createdAt).getTime() > REPORT_WITHIN_DAYS * DAY) throw new DisputeError(`This transfer is more than ${REPORT_WITHIN_DAYS} days old. Please contact support.`);
  if (await prisma.transferDispute.findUnique({ where: { transferId } })) throw new DisputeError('You already reported this transfer.');
  const text = String(reason || '').trim().slice(0, 300);
  if (text.length < 3) throw new DisputeError('Tell us briefly what happened (e.g. “wrong username”).');
  const amount = r2(t.amount);
  const d = await prisma.$transaction(async (tx) => {
    const row = await tx.transferDispute.create({ data: { kind: 'WALLET', senderId, recipientId: t.receiverId, transferId, amount, reason: text, status: 'AWAITING_RECIPIENT', holdUntil: new Date(Date.now() + HOLD_DAYS * DAY) } });
    const h = await hold(tx, t.receiverId, amount, `On hold: ${t.sender.name} says ${naira(amount)} was sent to you by mistake`);
    return tx.transferDispute.update({ where: { id: row.id }, data: { held: h } });
  });
  notify(t.receiverId, 'Money sent to you by mistake?', `${t.sender.name} says the ${naira(amount)} they sent you was a mistake. ${Number(d.held) > 0 ? `${naira(d.held)} is on hold in your wallet for up to ${HOLD_DAYS} days. ` : ''}Please open the request and tap “Return the money”, or tell us why it’s yours.`, { category: 'TRANSACTION', link: `/disputes/${d.id}` });
  notify(senderId, 'We’ve asked them to return it', `We’ve asked ${t.receiver.name} to return ${naira(amount)}.${Number(d.held) > 0 ? ` ${naira(d.held)} is on hold in their wallet.` : ' Their wallet is empty right now, so nothing could be held.'} We’ll update you.`, { category: 'TRANSACTION', link: `/disputes/${d.id}` });
  alert('Wrong transfer reported', `${t.sender.name} → ${t.receiver.name}: ${naira(amount)} (held ${naira(d.held)}).`);
  return d;
}

async function reportBank(senderId, bankTransferId, reason) {
  const b = await prisma.bankTransfer.findUnique({ where: { id: bankTransferId } });
  if (!b || b.customerId !== senderId) throw new DisputeError('Transfer not found.', 404);
  if (b.status !== 'SUCCESS') throw new DisputeError('Only completed transfers can be recalled. If it failed, the money comes back automatically.');
  if (Date.now() - new Date(b.createdAt).getTime() > REPORT_WITHIN_DAYS * DAY) throw new DisputeError(`This transfer is more than ${REPORT_WITHIN_DAYS} days old. Please contact support.`);
  if (await prisma.transferDispute.findUnique({ where: { bankTransferId } })) throw new DisputeError('You already reported this transfer.');
  const text = String(reason || '').trim().slice(0, 300);
  if (text.length < 3) throw new DisputeError('Tell us briefly what happened (e.g. “wrong account number”).');
  const d = await prisma.transferDispute.create({ data: { kind: 'BANK', senderId, bankTransferId, amount: r2(b.amount), reason: text, status: 'RECALL_REQUESTED', partnerRef: b.reference } });
  notify(senderId, 'Recall requested', `We’re asking the receiving bank to return ${naira(b.amount)} sent to ${b.accountName} (${b.bankName || 'bank'}). The bank must ask its customer for consent, so this can take a few days. We’ll update you.`, { category: 'TRANSACTION', link: `/disputes/${d.id}` });
  alert('Bank transfer recall requested', `${naira(b.amount)} to ${b.accountName} (${b.bankName || b.bankCode}) · ref ${b.reference}. Raise the recall with the payment partner now.`);
  return d;
}

async function returnMoney(recipientId, id) {
  const d = await prisma.transferDispute.findUnique({ where: { id } });
  if (!d || d.kind !== 'WALLET' || d.recipientId !== recipientId) throw new DisputeError('Not found.', 404);
  if (!OPEN_WALLET.includes(d.status)) throw new DisputeError('This has already been dealt with.');
  let returned = 0;
  const [rec, snd] = await Promise.all([prisma.customer.findUnique({ where: { id: recipientId }, select: { name: true } }), prisma.customer.findUnique({ where: { id: d.senderId }, select: { name: true } })]);
  await prisma.$transaction(async (tx) => {
    await claim(tx, d, OPEN_WALLET, { status: 'RETURNED', resolvedAt: new Date() });
    // The rest (beyond what's held), with their consent, from what's in the wallet now.
    const rest = r2(Number(d.amount) - Number(d.held));
    let extra = 0;
    if (rest > 0) {
      const c = await tx.customer.findUnique({ where: { id: recipientId }, select: { walletBalance: true } });
      extra = r2(Math.min(rest, Number(c.walletBalance)));
      if (extra > 0) {
        const ok = await tx.customer.updateMany({ where: { id: recipientId, walletBalance: { gte: extra } }, data: { walletBalance: { decrement: extra } } });
        if (ok.count !== 1) extra = 0;
        else await tx.walletTransaction.create({ data: { customerId: recipientId, type: 'DISPUTE_RETURN_OUT', amount: extra, status: 'APPROVED', note: `Returned to ${snd?.name} (sent by mistake)` } });
      }
    }
    returned = r2(Number(d.held) + extra);
    await credit(tx, d.senderId, returned, 'DISPUTE_RETURN_IN', `Returned by ${rec?.name} (sent by mistake)`);
    await tx.transferDispute.update({ where: { id: d.id }, data: { recovered: returned } });
  });
  const short = r2(Number(d.amount) - returned);
  notify(d.senderId, 'Money returned 🎉', `${rec?.name} returned ${naira(returned)} to your wallet.${short > 0 ? ` ${naira(short)} is still outstanding — contact support.` : ''}`, { category: 'TRANSACTION', link: `/disputes/${d.id}` });
  return { returned, outstanding: short };
}

async function recipientClaims(recipientId, id, reply) {
  const d = await prisma.transferDispute.findUnique({ where: { id } });
  if (!d || d.kind !== 'WALLET' || d.recipientId !== recipientId) throw new DisputeError('Not found.', 404);
  if (d.status !== 'AWAITING_RECIPIENT') throw new DisputeError('You’ve already answered, or this has been dealt with.');
  const text = String(reply || '').trim().slice(0, 500);
  if (text.length < 5) throw new DisputeError('Tell us why this money is yours (e.g. “payment for goods I delivered”).');
  await prisma.transferDispute.update({ where: { id }, data: { status: 'RECIPIENT_DISPUTES', recipientReply: text } });
  notify(d.senderId, 'They say the money is theirs', 'The person you sent money to says it was meant for them. ZAPPI PAY will review both sides and let you know within 14 days.', { category: 'TRANSACTION', link: `/disputes/${id}` });
  alert('Wrong transfer: recipient disagrees', `Dispute ${id}: “${text}”. Review both sides before the hold ends.`);
  return { ok: true };
}

async function cancel(senderId, id) {
  const d = await prisma.transferDispute.findUnique({ where: { id } });
  if (!d || d.senderId !== senderId) throw new DisputeError('Not found.', 404);
  if (![...OPEN_WALLET, 'RECALL_REQUESTED'].includes(d.status)) throw new DisputeError('This can’t be cancelled now.');
  await prisma.$transaction(async (tx) => {
    await claim(tx, d, [...OPEN_WALLET, 'RECALL_REQUESTED'], { status: 'CANCELLED', resolvedAt: new Date() });
    if (d.kind === 'WALLET') await credit(tx, d.recipientId, r2(d.held), 'DISPUTE_RELEASE', 'Hold released — the sender withdrew the report');
  });
  if (d.kind === 'WALLET' && d.recipientId) notify(d.recipientId, 'Hold released', `The sender withdrew their report. ${Number(d.held) > 0 ? `${naira(d.held)} is available in your wallet again.` : ''}`, { category: 'TRANSACTION', link: `/disputes/${id}` });
  return { ok: true };
}

// What a customer may see (sender or recipient).
async function view(d, customerId) {
  const asSender = d.senderId === customerId;
  const [snd, rec, bt] = await Promise.all([
    prisma.customer.findUnique({ where: { id: d.senderId }, select: { name: true, username: true, phone: true } }),
    d.recipientId ? prisma.customer.findUnique({ where: { id: d.recipientId }, select: { name: true, username: true, phone: true } }) : null,
    d.bankTransferId ? prisma.bankTransfer.findUnique({ where: { id: d.bankTransferId }, select: { accountName: true, accountNumber: true, bankName: true, reference: true, createdAt: true } }) : null,
    ]);
  const t = d.transferId ? await prisma.transfer.findUnique({ where: { id: d.transferId }, select: { createdAt: true, note: true } }) : null;
  return {
    id: d.id, kind: d.kind, role: asSender ? 'SENDER' : 'RECIPIENT', status: d.status, amount: Number(d.amount), held: Number(d.held), recovered: Number(d.recovered),
    reason: d.reason, recipientReply: d.recipientReply, holdUntil: d.holdUntil, adminNote: d.adminNote, createdAt: d.createdAt, resolvedAt: d.resolvedAt,
    sentAt: t?.createdAt || bt?.createdAt || null, reference: d.partnerRef || d.transferId,
    sender: { name: snd?.name, username: snd?.username },
    recipient: d.kind === 'BANK' ? { name: bt?.accountName, account: bt?.accountNumber, bank: bt?.bankName } : { name: rec?.name, username: rec?.username },
    ...(asSender ? { senderPhone: snd?.phone } : {}),
  };
}

async function mine(customerId) {
  const rows = await prisma.transferDispute.findMany({ where: { OR: [{ senderId: customerId }, { recipientId: customerId }] }, orderBy: { createdAt: 'desc' }, take: 50 });
  return Promise.all(rows.map((d) => view(d, customerId)));
}
async function detail(id, customerId) {
  const d = await prisma.transferDispute.findUnique({ where: { id } });
  if (!d || (d.senderId !== customerId && d.recipientId !== customerId)) throw new DisputeError('Not found.', 404);
  return view(d, customerId);
}
// For the Home banner: requests waiting for this customer's answer.
async function waitingForMe(customerId) {
  const rows = await prisma.transferDispute.findMany({ where: { recipientId: customerId, status: 'AWAITING_RECIPIENT' }, orderBy: { createdAt: 'desc' }, take: 5 });
  return rows.map((d) => ({ id: d.id, amount: Number(d.amount), held: Number(d.held), holdUntil: d.holdUntil }));
}
// Which of these transfers the customer has already reported.
async function reportedIds({ transferIds = [], bankTransferIds = [] }) {
  const rows = await prisma.transferDispute.findMany({ where: { OR: [{ transferId: { in: transferIds } }, { bankTransferId: { in: bankTransferIds } }] }, select: { id: true, transferId: true, bankTransferId: true, status: true } });
  return rows;
}

// Recent sends this customer can report (last 30 days).
async function recentSends(customerId) {
  const since = new Date(Date.now() - REPORT_WITHIN_DAYS * DAY);
  const [ts, bs] = await Promise.all([
    prisma.transfer.findMany({ where: { senderId: customerId, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 30 }),
    prisma.bankTransfer.findMany({ where: { customerId, status: 'SUCCESS', createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 30 }),
  ]);
  const names = new Map((await prisma.customer.findMany({ where: { id: { in: [...new Set(ts.map((t) => t.receiverId))] } }, select: { id: true, name: true, username: true } })).map((c) => [c.id, c]));
  const reported = await reportedIds({ transferIds: ts.map((t) => t.id), bankTransferIds: bs.map((b) => b.id) });
  const rep = (k, id) => reported.find((r) => r[k] === id);
  return [
    ...ts.map((t) => ({ kind: 'WALLET', id: t.id, amount: Number(t.amount), at: t.createdAt, to: names.get(t.receiverId)?.name || 'ZAPPI PAY user', detail: names.get(t.receiverId)?.username ? `@${names.get(t.receiverId).username}` : 'ZAPPI PAY wallet', disputeId: rep('transferId', t.id)?.id || null })),
    ...bs.map((b) => ({ kind: 'BANK', id: b.id, amount: Number(b.amount), at: b.createdAt, to: b.accountName, detail: `${b.bankName || 'Bank'} · ${String(b.accountNumber).replace(/^(\d{3})\d+(\d{3})$/, '$1****$2')}`, disputeId: rep('bankTransferId', b.id)?.id || null })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));
}

// --- Admin --------------------------------------------------------------

async function adminList(status = 'OPEN') {
  const where = status === 'OPEN' ? { status: { in: [...OPEN_WALLET, ...OPEN_BANK] } } : status === 'ALL' ? {} : { status };
  const rows = await prisma.transferDispute.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
  const out = [];
  for (const d of rows) {
    const v = await view(d, d.senderId);
    const flagged = d.recipientId ? (await prisma.customer.findUnique({ where: { id: d.recipientId }, select: { wrongTransferFlaggedAt: true } }))?.wrongTransferFlaggedAt : null;
    out.push({ ...v, senderPhone: undefined, recipientFlagged: Boolean(flagged), daysLeft: d.holdUntil ? Math.max(0, Math.ceil((new Date(d.holdUntil) - Date.now()) / DAY)) : null });
  }
  return out;
}

// decision: SENDER (review found for the sender: held amount goes back),
// RECIPIENT (hold released), SYSTEM_ERROR (ZAPPI PAY's own error: reverse
// the full amount if it's there, no consent needed).
async function adminResolve(id, { decision, note }) {
  const d = await prisma.transferDispute.findUnique({ where: { id } });
  if (!d || d.kind !== 'WALLET') throw new DisputeError('Not found.', 404);
  if (!OPEN_WALLET.includes(d.status)) throw new DisputeError('Already resolved.');
  if (!['SENDER', 'RECIPIENT', 'SYSTEM_ERROR'].includes(decision)) throw new DisputeError('Choose a decision.');
  const status = { SENDER: 'RESOLVED_SENDER', RECIPIENT: 'RESOLVED_RECIPIENT', SYSTEM_ERROR: 'REVERSED_SYSTEM' }[decision];
  let back = 0;
  await prisma.$transaction(async (tx) => {
    await claim(tx, d, OPEN_WALLET, { status, adminNote: String(note || '').slice(0, 300) || null, resolvedAt: new Date() });
    if (decision === 'RECIPIENT') {
      await credit(tx, d.recipientId, r2(d.held), 'DISPUTE_RELEASE', 'Hold released after review');
      return;
    }
    back = r2(d.held);
    if (decision === 'SYSTEM_ERROR') {
      const rest = r2(Number(d.amount) - Number(d.held));
      const c = await tx.customer.findUnique({ where: { id: d.recipientId }, select: { walletBalance: true } });
      const extra = r2(Math.min(rest, Number(c.walletBalance)));
      if (extra > 0 && (await tx.customer.updateMany({ where: { id: d.recipientId, walletBalance: { gte: extra } }, data: { walletBalance: { decrement: extra } } })).count === 1) {
        await tx.walletTransaction.create({ data: { customerId: d.recipientId, type: 'DISPUTE_RETURN_OUT', amount: extra, status: 'APPROVED', note: 'Reversed: credited to you by a ZAPPI PAY system error' } });
        back = r2(back + extra);
      }
    }
    await credit(tx, d.senderId, back, 'DISPUTE_RETURN_IN', decision === 'SYSTEM_ERROR' ? 'Reversed: ZAPPI PAY system error' : 'Returned after review (sent by mistake)');
    await tx.transferDispute.update({ where: { id: d.id }, data: { recovered: back } });
    // Couldn't recover it all → watch-list the recipient (CBN).
    if (back < Number(d.amount)) await tx.customer.update({ where: { id: d.recipientId }, data: { wrongTransferFlaggedAt: new Date() } });
  });
  const short = r2(Number(d.amount) - back);
  if (decision === 'RECIPIENT') {
    notify(d.senderId, 'Review finished', `After reviewing both sides, the money stays with the recipient.${note ? ` Note: ${note}` : ''} If you still disagree, you can report it to the police or your lawyer — download your statement from the request.`, { category: 'TRANSACTION', link: `/disputes/${id}` });
    notify(d.recipientId, 'Hold released', `The review is finished. ${naira(d.held)} is available in your wallet again.`, { category: 'TRANSACTION', link: `/disputes/${id}` });
  } else {
    notify(d.senderId, 'Money returned', `${naira(back)} has been returned to your wallet.${short > 0 ? ` ${naira(short)} could not be recovered — the recipient has been flagged, and you can report it to the police with your statement.` : ''}`, { category: 'TRANSACTION', link: `/disputes/${id}` });
    notify(d.recipientId, decision === 'SYSTEM_ERROR' ? 'A mistaken credit was reversed' : 'Review finished', decision === 'SYSTEM_ERROR' ? `${naira(back)} credited to you by a system error has been reversed.` : `After reviewing both sides, ${naira(back)} on hold was returned to the sender.${short > 0 ? ` Please return the remaining ${naira(short)} — keeping money sent by mistake can be reported to the police.` : ''}`, { category: 'TRANSACTION', link: `/disputes/${id}` });
  }
  return { status, returned: back, outstanding: decision === 'RECIPIENT' ? 0 : short };
}

// Bank recalls: admin records progress with the payment partner.
async function adminBank(id, { status, note, amount }) {
  const d = await prisma.transferDispute.findUnique({ where: { id } });
  if (!d || d.kind !== 'BANK') throw new DisputeError('Not found.', 404);
  if (!OPEN_BANK.includes(d.status)) throw new DisputeError('Already closed.');
  if (!['RECALL_SENT', 'RECOVERED', 'NOT_RECOVERED'].includes(status)) throw new DisputeError('Choose a status.');
  const got = status === 'RECOVERED' ? r2(amount == null || amount === '' ? d.amount : Math.min(Number(amount), Number(d.amount))) : 0;
  if (status === 'RECOVERED' && !(got > 0)) throw new DisputeError('Enter the amount recovered.');
  await prisma.$transaction(async (tx) => {
    await claim(tx, d, OPEN_BANK, { status, adminNote: String(note || '').slice(0, 300) || null, ...(status === 'RECALL_SENT' ? {} : { resolvedAt: new Date() }), ...(got ? { recovered: got } : {}) });
    if (got) await credit(tx, d.senderId, got, 'DISPUTE_RETURN_IN', 'Recovered from the receiving bank (sent to the wrong account)');
  });
  const msg = {
    RECALL_SENT: 'Your recall has been sent to the receiving bank. They will ask their customer to return the money — we’ll tell you the result.',
    RECOVERED: `${naira(got)} was recovered from the receiving bank and added to your wallet.`,
    NOT_RECOVERED: `The receiving bank couldn’t recover the money${note ? ` (${note})` : ''}. You can report it to the police with your statement — they can ask the bank for a court order.`,
  }[status];
  notify(d.senderId, 'Wrong-account recall', msg, { category: 'TRANSACTION', link: `/disputes/${id}` });
  return { status, recovered: got };
}

// Holds end after 14 days (CBN: a lien can't run longer). Admins are
// reminded 3 days before.
async function tick(now = new Date()) {
  const soon = await prisma.transferDispute.findMany({ where: { status: { in: OPEN_WALLET }, remindedAt: null, holdUntil: { lte: new Date(now.getTime() + 3 * DAY) } } });
  for (const d of soon) {
    await prisma.transferDispute.update({ where: { id: d.id }, data: { remindedAt: now } });
    alert('Wrong transfer: hold ends soon', `Dispute ${d.id} (${naira(d.amount)}) — the hold ends ${new Date(d.holdUntil).toLocaleDateString('en-NG')}. Decide before then or it is released to the recipient.`);
  }
  const due = await prisma.transferDispute.findMany({ where: { status: { in: OPEN_WALLET }, holdUntil: { lte: now } } });
  for (const d of due) {
    try {
      await prisma.$transaction(async (tx) => {
        await claim(tx, d, OPEN_WALLET, { status: 'EXPIRED', resolvedAt: now });
        await credit(tx, d.recipientId, r2(d.held), 'DISPUTE_RELEASE', 'Hold ended (14 days)');
      });
      notify(d.senderId, 'Hold ended', `The 14-day hold ended without the money being returned. You can report it to the police or a lawyer with your statement (open the request → Download statement); they can ask for a court order.`, { category: 'TRANSACTION', link: `/disputes/${d.id}` });
      notify(d.recipientId, 'Hold ended', `The hold on ${naira(d.held)} has ended. If you know this money was sent to you by mistake, please still return it — keeping it can be reported to the police.`, { category: 'TRANSACTION', link: `/disputes/${d.id}` });
    } catch (e) {
      if (!(e instanceof DisputeError)) console.error('disputes.tick:', e.message);
    }
  }
}
let timer = null;
function startJob() {
  if (timer) return;
  timer = true;
  require('./quietClock').every('disputes job', 30 * 60 * 1000, tick, { firstAfter: 60 * 1000 });
}

async function heldTotal() {
  const a = await prisma.transferDispute.aggregate({ where: { status: { in: OPEN_WALLET } }, _sum: { held: true } });
  return r2(a._sum.held);
}

module.exports = { recentSends, DisputeError, HOLD_DAYS, reportWallet, reportBank, returnMoney, recipientClaims, cancel, mine, detail, waitingForMe, reportedIds, adminList, adminResolve, adminBank, tick, startJob, heldTotal };
