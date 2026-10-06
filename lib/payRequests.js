// "Pay me" links, split bills and group gifts.
//  - REQUEST: "Pay me ₦5,000 for rent" — one payment, then done.
//  - SPLIT:   one bill shared by N people; each pays their share once.
//  - POOL:    group gift / contribution — anyone pays any amount.
// Every payment is an ordinary ZAPPI PAY transfer, straight from the
// payer's wallet to the owner's wallet, confirmed with the payer's PIN.
// ZAPPI PAY never holds the money in between (no escrow, no interest).

const crypto = require('crypto');
const prisma = require('./prisma');
const { notify } = require('./notify');

const DAY = 24 * 60 * 60 * 1000;
const MIN_AMOUNT = 100;
const MAX_AMOUNT = 500000;
const MAX_OPEN = 30;
const MAX_PER_DAY = 30;
const ABC = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class PayRequestError extends Error {
  constructor(msg, code = 'BAD_REQUEST', status = 400) { super(msg); this.code = code; this.status = status; }
}

const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const appUrl = () => String(process.env.APP_URL || 'https://zappipay.com.ng').replace(/\/$/, '');
const linkFor = (token) => `${appUrl()}/r/${token}`;
const short = (name) => { const p = String(name || '').trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : p[0] || 'A ZAPPI PAY user'; };
const token = () => Array.from({ length: 10 }, () => ABC[crypto.randomInt(0, ABC.length)]).join('');
const money = (v, what) => {
  const n = Math.round(Number(v) * 100) / 100;
  if (!Number.isFinite(n) || n < MIN_AMOUNT) throw new PayRequestError(`${what} must be at least ₦${MIN_AMOUNT}.`);
  if (n > MAX_AMOUNT * 50) throw new PayRequestError(`${what} is too large.`);
  return n;
};
const KIND_LABEL = { REQUEST: 'Pay me', SPLIT: 'Split bill', POOL: 'Group gift' };

async function findPeople(list, ownerId) {
  const ids = [...new Set((Array.isArray(list) ? list : []).map((x) => String(x || '').trim().replace(/^@/, '')).filter(Boolean))].slice(0, 20);
  const out = [];
  const missing = [];
  for (const raw of ids) {
    const c = await prisma.customer.findFirst({ where: { OR: [{ phone: raw }, { username: raw.toLowerCase() }], active: true, deletedAt: null }, select: { id: true, name: true } });
    if (!c) missing.push(raw); else if (c.id !== ownerId && !out.some((o) => o.id === c.id)) out.push({ id: c.id, name: c.name });
  }
  return { people: out, missing };
}

async function create(ownerId, input = {}) {
  const kind = ['REQUEST', 'SPLIT', 'POOL'].includes(input.kind) ? input.kind : null;
  if (!kind) throw new PayRequestError('Choose: Pay me, Split bill or Group gift.');
  const owner = await prisma.customer.findUnique({ where: { id: ownerId }, select: { id: true, name: true, active: true, selfFrozenAt: true } });
  if (!owner || !owner.active || owner.selfFrozenAt) throw new PayRequestError('Your account can’t receive money right now.', 'ACCOUNT', 403);
  const title = String(input.title || '').trim().slice(0, 80);
  if (title.length < 2) throw new PayRequestError('Say what it is for (e.g. “Rent”, “Dinner at Mama Put”, “Tolu’s birthday”).');
  const note = input.note ? String(input.note).trim().slice(0, 300) : null;

  const [open, today] = await Promise.all([
    prisma.moneyRequest.count({ where: { ownerId, status: 'OPEN' } }),
    prisma.moneyRequest.count({ where: { ownerId, createdAt: { gte: new Date(Date.now() - DAY) } } }),
  ]);
  if (open >= MAX_OPEN) throw new PayRequestError(`You have ${MAX_OPEN} open links. Close some first.`, 'TOO_MANY');
  if (today >= MAX_PER_DAY) throw new PayRequestError('You have made a lot of links today. Try again tomorrow.', 'TOO_MANY', 429);

  const data = { kind, ownerId, title, note, token: token(), status: 'OPEN', collected: 0, payments: 0 };
  if (kind === 'REQUEST') {
    data.amount = money(input.amount, 'The amount');
    if (data.amount > MAX_AMOUNT) throw new PayRequestError(`The most you can request is ${naira(MAX_AMOUNT)}.`);
    data.slots = 1;
    data.expiresAt = new Date(Date.now() + 14 * DAY);
  } else if (kind === 'SPLIT') {
    const total = money(input.total, 'The bill');
    const people = parseInt(input.people, 10);
    if (!(people >= 2 && people <= 50)) throw new PayRequestError('Split between 2 and 50 people.');
    const includeMe = input.includeMe !== false;
    const share = Math.ceil((total / people) * 100) / 100;
    if (share < MIN_AMOUNT) throw new PayRequestError(`Each share must be at least ₦${MIN_AMOUNT}.`);
    if (share > MAX_AMOUNT) throw new PayRequestError(`Each share can be at most ${naira(MAX_AMOUNT)}.`);
    data.total = total;
    data.amount = share;
    data.slots = includeMe ? people - 1 : people;
    data.expiresAt = new Date(Date.now() + 14 * DAY);
  } else {
    if (input.target !== undefined && input.target !== null && input.target !== '') data.target = money(input.target, 'The target');
    const days = parseInt(input.days, 10);
    data.expiresAt = days >= 1 && days <= 90 ? new Date(Date.now() + days * DAY) : new Date(Date.now() + 30 * DAY);
  }
  const { people, missing } = await findPeople(input.invite, ownerId);
  if (people.length) data.invited = people;

  // Rare token clash → try again.
  let row = null;
  for (let i = 0; i < 3 && !row; i += 1) {
    try { row = await prisma.moneyRequest.create({ data }); } catch (e) { if (e.code !== 'P2002') throw e; data.token = token(); }
  }
  if (!row) throw new PayRequestError('Could not make the link. Try again.', 'RETRY', 500);
  for (const p of people) {
    const what = kind === 'POOL' ? `invited you to chip in for “${title}”${row.target ? ` (target ${naira(row.target)})` : ''}` : `asked you to pay ${naira(row.amount)} for “${title}”`;
    notify(p.id, kind === 'POOL' ? '🎁 Group gift' : '💸 Payment request', `${owner.name} ${what}. Open Home → More → Request money → “For you”, or this link: ${linkFor(row.token)}`, { category: 'UPDATE' });
  }
  return { request: await shape(row, ownerId), link: linkFor(row.token), notFound: missing };
}

function expired(r) { return r.expiresAt && new Date(r.expiresAt) < new Date(); }
function stateOf(r) { return r.status === 'OPEN' && expired(r) ? 'EXPIRED' : r.status; }

async function shape(r, viewerId, { full = false } = {}) {
  const pays = await prisma.moneyRequestPayment.findMany({ where: { requestId: r.id }, orderBy: { createdAt: 'asc' }, take: 200 });
  const payerIds = [...new Set(pays.map((p) => p.payerId))];
  const names = payerIds.length ? Object.fromEntries((await prisma.customer.findMany({ where: { id: { in: payerIds } }, select: { id: true, name: true } })).map((c) => [c.id, c.name])) : {};
  const isOwner = viewerId === r.ownerId;
  const invited = Array.isArray(r.invited) ? r.invited : [];
  return {
    id: r.id,
    token: r.token,
    link: linkFor(r.token),
    kind: r.kind,
    kindLabel: KIND_LABEL[r.kind],
    title: r.title,
    note: r.note,
    amount: r.amount != null ? Number(r.amount) : null,
    total: r.total != null ? Number(r.total) : null,
    target: r.target != null ? Number(r.target) : null,
    slots: r.slots,
    collected: Number(r.collected || 0),
    payments: r.payments,
    status: stateOf(r),
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
    isOwner,
    youPaid: Boolean(viewerId && pays.some((p) => p.payerId === viewerId)),
    paidBy: pays.map((p) => ({
      name: isOwner || full ? names[p.payerId] || 'Someone' : short(names[p.payerId]),
      amount: p.hideAmount && !isOwner ? null : Number(p.amount),
      message: p.message || null,
      at: p.createdAt,
    })),
    // Who was asked but hasn't paid yet (owner only).
    waitingFor: isOwner ? invited.filter((i) => !pays.some((p) => p.payerId === i.id)).map((i) => i.name) : undefined,
  };
}

async function byToken(t) {
  const r = await prisma.moneyRequest.findUnique({ where: { token: String(t || '') } });
  if (!r) throw new PayRequestError('This link is not valid.', 'NOT_FOUND', 404);
  return r;
}

// What someone opening the link sees. Not logged in → short name only.
async function view(t, viewerId = null) {
  const r = await byToken(t);
  const owner = await prisma.customer.findUnique({ where: { id: r.ownerId }, select: { name: true, username: true, kycVerifiedAt: true, kycType: true, active: true, deletedAt: true } });
  const s = await shape(r, viewerId);
  return {
    ...s,
    owner: {
      name: viewerId ? owner?.name : short(owner?.name),
      username: owner?.username || null,
      verified: Boolean(owner?.kycVerifiedAt || owner?.kycType),
      active: Boolean(owner?.active && !owner?.deletedAt),
    },
  };
}

// Pay from the viewer's wallet (route checks the PIN first).
async function pay(t, payerId, { amount, message, hideAmount } = {}) {
  const r = await byToken(t);
  const st = stateOf(r);
  if (st === 'EXPIRED') throw new PayRequestError('This link has expired.', 'EXPIRED', 410);
  if (st !== 'OPEN') throw new PayRequestError(st === 'DONE' ? 'This has already been paid in full.' : 'This link is closed.', 'CLOSED', 410);
  if (r.ownerId === payerId) throw new PayRequestError('You can’t pay your own link — share it instead.', 'OWN');
  const [payer, owner] = await Promise.all([
    prisma.customer.findUnique({ where: { id: payerId } }),
    prisma.customer.findUnique({ where: { id: r.ownerId } }),
  ]);
  if (!payer || !payer.active) throw new PayRequestError('Your account can’t send money right now.', 'ACCOUNT', 403);
  if (!owner || !owner.active || owner.deletedAt || owner.selfFrozenAt) throw new PayRequestError('This person can’t receive money right now.', 'OWNER', 409);

  let amt;
  if (r.kind === 'POOL') {
    amt = money(amount, 'Your contribution');
    if (amt > MAX_AMOUNT) throw new PayRequestError(`The most you can give at once is ${naira(MAX_AMOUNT)}.`);
  } else {
    amt = Number(r.amount);
  }
  if (r.kind === 'SPLIT' && (await prisma.moneyRequestPayment.count({ where: { requestId: r.id, payerId } }))) throw new PayRequestError('You have already paid your share.', 'ALREADY');

  const familyError = await require('./family').checkSend(payerId, owner.id);
  if (familyError) throw new PayRequestError(familyError, 'FAMILY_LIMIT', 403);
  const { checkDailyLimit } = require('./limits');
  const limitError = await checkDailyLimit(payer, amt, await require('./vtpass').getSettings());
  if (limitError) throw new PayRequestError(limitError, 'DAILY_LIMIT', 403);
  // Direct pay: paid by card / transfer straight into the requester's bank.
  if (await require('./directPay').on(payerId)) {
    return require('./directPay').start({ kind: 'REQUEST', refId: r.id, payerId, recipientId: owner.id, amount: amt, description: `${KIND_LABEL[r.kind]}: ${r.title}`, meta: { message: message ? String(message).trim().slice(0, 140) : null, hideAmount: Boolean(hideAmount) }, returnPath: `/r/${r.token}` });
  }
  if (Number(payer.walletBalance) < amt) throw new PayRequestError('Insufficient wallet balance. Fund your wallet first.', 'INSUFFICIENT_BALANCE', 402);

  const slotKey = r.kind === 'POOL' ? `p:${crypto.randomUUID()}` : r.kind === 'SPLIT' ? `u:${payerId}` : 'single';
  const label = `${KIND_LABEL[r.kind]}: ${r.title}`.slice(0, 120);
  let done = false;
  try {
    await prisma.$transaction(async (tx) => {
      // Claim the request first (one payment for REQUEST, a free share for SPLIT).
      const where = { id: r.id, status: 'OPEN' };
      if (r.kind !== 'POOL') where.payments = { lt: r.slots || 1 };
      const claim = await tx.moneyRequest.updateMany({ where, data: { payments: { increment: 1 }, collected: { increment: amt } } });
      if (claim.count !== 1) throw new PayRequestError(r.kind === 'SPLIT' ? 'Everyone has already paid.' : 'This has already been paid.', 'CLOSED', 410);
      const debit = await tx.customer.updateMany({ where: { id: payerId, walletBalance: { gte: amt } }, data: { walletBalance: { decrement: amt } } });
      if (debit.count !== 1) throw new PayRequestError('Insufficient wallet balance. Fund your wallet first.', 'INSUFFICIENT_BALANCE', 402);
      await tx.customer.update({ where: { id: owner.id }, data: { walletBalance: { increment: amt } } });
      const transfer = await tx.transfer.create({ data: { senderId: payerId, receiverId: owner.id, amount: amt, note: label } });
      await tx.walletTransaction.create({ data: { customerId: payerId, type: 'TRANSFER_OUT', amount: amt, status: 'APPROVED', note: `Paid ${owner.name} — ${label}` } });
      await tx.walletTransaction.create({ data: { customerId: owner.id, type: 'TRANSFER_IN', amount: amt, status: 'APPROVED', note: `From ${payer.name} — ${label}` } });
      await tx.moneyRequestPayment.create({ data: { requestId: r.id, payerId, slotKey, amount: amt, message: message ? String(message).trim().slice(0, 140) : null, hideAmount: Boolean(hideAmount), transferId: transfer.id } });
      const fresh = await tx.moneyRequest.findUnique({ where: { id: r.id } });
      if (r.kind !== 'POOL' && fresh.payments >= (r.slots || 1)) { await tx.moneyRequest.update({ where: { id: r.id }, data: { status: 'DONE' } }); done = true; }
    });
  } catch (e) {
    if (e instanceof PayRequestError) throw e;
    if (e.code === 'P2002') throw new PayRequestError(r.kind === 'SPLIT' ? 'You have already paid your share.' : 'This has already been paid.', 'ALREADY');
    throw e;
  }
  const after = await prisma.moneyRequest.findUnique({ where: { id: r.id } });
  const progress = r.kind === 'SPLIT' ? ` (${after.payments} of ${r.slots} paid)` : r.kind === 'POOL' ? ` — ${naira(after.collected)} so far${after.target ? ` of ${naira(after.target)}` : ''}` : '';
  notify(owner.id, 'Money Received', `${payer.name} paid ${naira(amt)} for “${r.title}”${progress}.${done ? ' Everyone has paid 🎉' : ''}`);
  notify(payerId, 'Money Sent', `You paid ${naira(amt)} to ${owner.name} for “${r.title}”.`);
  return { ok: true, amount: amt, done, request: await view(t, payerId) };
}

async function mine(ownerId) {
  const rows = await prisma.moneyRequest.findMany({ where: { ownerId }, orderBy: { createdAt: 'desc' }, take: 50 });
  return Promise.all(rows.map((r) => shape(r, ownerId)));
}

// Requests other people sent me that I haven't paid yet.
async function forMe(customerId) {
  const rows = await prisma.moneyRequest.findMany({ where: { status: 'OPEN', createdAt: { gte: new Date(Date.now() - 90 * DAY) } }, orderBy: { createdAt: 'desc' }, take: 500 });
  const mineRows = rows.filter((r) => Array.isArray(r.invited) && r.invited.some((i) => i.id === customerId) && !expired(r));
  const out = [];
  for (const r of mineRows.slice(0, 30)) {
    const v = await view(r.token, customerId);
    if (!v.youPaid || r.kind === 'POOL') out.push(v);
  }
  return out;
}

async function close(ownerId, id) {
  const r = await prisma.moneyRequest.findFirst({ where: { id: String(id), ownerId } });
  if (!r) throw new PayRequestError('Not found.', 'NOT_FOUND', 404);
  if (r.status !== 'OPEN') return shape(r, ownerId);
  const upd = await prisma.moneyRequest.update({ where: { id: r.id }, data: { status: r.payments ? 'CLOSED' : 'CANCELLED' } });
  return shape(upd, ownerId);
}

// Remind invited people who haven't paid (at most once a day).
const reminded = new Map();
async function remind(ownerId, id) {
  const r = await prisma.moneyRequest.findFirst({ where: { id: String(id), ownerId } });
  if (!r || stateOf(r) !== 'OPEN') throw new PayRequestError('This link is not open.', 'CLOSED');
  if (Date.now() - (reminded.get(r.id) || 0) < DAY) throw new PayRequestError('You already sent a reminder today.', 'TOO_SOON', 429);
  const owner = await prisma.customer.findUnique({ where: { id: ownerId }, select: { name: true } });
  const paid = new Set((await prisma.moneyRequestPayment.findMany({ where: { requestId: r.id }, select: { payerId: true } })).map((p) => p.payerId));
  const waiting = (Array.isArray(r.invited) ? r.invited : []).filter((i) => !paid.has(i.id));
  for (const w of waiting) notify(w.id, '💸 Reminder', `${owner.name} is reminding you about “${r.title}”${r.amount ? ` (${naira(r.amount)})` : ''}. Pay here: ${linkFor(r.token)}`, { category: 'UPDATE' });
  reminded.set(r.id, Date.now());
  return { reminded: waiting.length };
}

module.exports = { create, view, pay, mine, forMe, close, remind, PayRequestError, linkFor, MIN_AMOUNT, MAX_AMOUNT };
