// SafeBuy — buyer protection for online/WhatsApp/Instagram deals.
// The seller creates a deal link; the buyer pays and the money is HELD
// (not in anyone's wallet). The seller marks it sent; the buyer confirms
// "received" and the seller is paid (minus the SafeBuy fee). If the buyer
// says nothing for N days after it was sent, it's released automatically.
// Problems go to ZAPPI PAY, who refunds the buyer or pays the seller.
//
// ⚠ This is escrow. It is OFF until the owner switches it on in Admin →
// New features, after checking the licence position with a lawyer.

const prisma = require('./prisma');
const { notify } = require('./notify');
const { getSettings } = require('./vtpass');
const F = require('./features');

const DAY = 24 * 3600 * 1000;

function feeFor(amount, s) {
  let fee = (Number(amount) * Number(s.safeBuyFeePercent ?? 1)) / 100;
  const cap = Number(s.safeBuyFeeCap ?? 2000);
  if (cap > 0) fee = Math.min(fee, cap);
  return Math.round(fee * 100) / 100;
}

async function create(sellerId, b = {}) {
  const s = await F.requireOn('safeBuy', sellerId);
  const title = String(b.title || '').trim().slice(0, 80);
  if (title.length < 3) throw new F.FeatureError('Describe what you are selling.');
  const amount = F.r2(b.amount);
  if (!(amount >= 500 && amount <= 2000000)) throw new F.FeatureError('The price must be between ₦500 and ₦2,000,000.');
  return prisma.safeDeal.create({ data: { code: F.newCode(6), sellerId, title, description: String(b.description || '').trim().slice(0, 600) || null, amount, fee: feeFor(amount, s), status: 'AWAITING_PAYMENT' } });
}

async function byCode(code) {
  const d = await prisma.safeDeal.findUnique({ where: { code: String(code || '') } });
  if (!d) throw new F.FeatureError('This SafeBuy link is not valid.', 404);
  return d;
}

async function view(code, viewerId) {
  const d = await byCode(code);
  const [seller, buyer] = await Promise.all([
    prisma.customer.findUnique({ where: { id: d.sellerId }, select: { name: true, username: true, createdAt: true, kycType: true } }),
    d.buyerId ? prisma.customer.findUnique({ where: { id: d.buyerId }, select: { name: true } }) : null,
  ]);
  const s = await getSettings();
  const sold = await prisma.safeDeal.count({ where: { sellerId: d.sellerId, status: 'COMPLETED' } });
  const role = viewerId === d.sellerId ? 'SELLER' : d.buyerId && viewerId === d.buyerId ? 'BUYER' : 'VISITOR';
  return {
    deal: { code: d.code, title: d.title, description: d.description, amount: Number(d.amount), fee: Number(d.fee), sellerGets: F.r2(Number(d.amount) - Number(d.fee)), status: d.status, sentNote: d.sentNote, disputeReason: d.disputeReason, resolution: d.resolution, autoReleaseAt: d.autoReleaseAt, paidAt: d.paidAt, sentAt: d.sentAt, createdAt: d.createdAt },
    seller: { name: seller?.name, username: seller?.username, verified: Boolean(seller?.kycType), since: seller?.createdAt, completedDeals: sold },
    buyer: buyer?.name || null,
    role,
    autoReleaseDays: Number(s.safeBuyAutoReleaseDays ?? 3),
  };
}

async function pay(code, buyerId) {
  await F.requireOn('safeBuy', buyerId);
  const d = await byCode(code);
  if (d.sellerId === buyerId) throw new F.FeatureError('You can’t buy your own item.');
  if (d.status !== 'AWAITING_PAYMENT') throw new F.FeatureError('This deal has already been paid or closed.');
  await F.checkSpend(buyerId);
  const ok = await F.move({
    fromId: buyerId, toId: null, amount: d.amount, outType: 'SAFEBUY_OUT', outNote: `SafeBuy: ${d.title} (held until you confirm delivery)`,
    extra: async (tx) => {
      const r = await tx.safeDeal.updateMany({ where: { id: d.id, status: 'AWAITING_PAYMENT' }, data: { status: 'PAID', buyerId, paidAt: new Date() } });
      if (r.count !== 1) throw Object.assign(new Error('taken'), { taken: true });
    },
  }).catch((e) => { if (e.taken) throw new F.FeatureError('Someone else just paid for this.'); throw e; });
  if (!ok) throw new F.FeatureError('Insufficient wallet balance.', 402, 'INSUFFICIENT_BALANCE');
  const buyer = await prisma.customer.findUnique({ where: { id: buyerId }, select: { name: true } });
  notify(d.sellerId, 'SafeBuy: paid ✅', `${buyer?.name} paid ${F.naira(d.amount)} for “${d.title}”. The money is held safely — send the item, then tap “I’ve sent it”.`, { category: 'TRANSACTION' });
  return { paid: true };
}

async function markSent(code, sellerId, note) {
  const s = await getSettings();
  const d = await byCode(code);
  if (d.sellerId !== sellerId) throw new F.FeatureError('Only the seller can do this.', 403);
  if (d.status !== 'PAID') throw new F.FeatureError('The buyer hasn’t paid yet, or it’s already marked sent.');
  const autoReleaseAt = new Date(Date.now() + Number(s.safeBuyAutoReleaseDays ?? 3) * DAY);
  await prisma.safeDeal.update({ where: { id: d.id }, data: { status: 'SENT', sentAt: new Date(), sentNote: String(note || '').trim().slice(0, 300) || null, autoReleaseAt } });
  notify(d.buyerId, 'SafeBuy: item sent 📦', `The seller says “${d.title}” has been sent${note ? `: ${note}` : ''}. When you receive it, tap “I’ve received it”. If you say nothing, the money goes to the seller on ${autoReleaseAt.toDateString()}. Problem? Tap “Report a problem” before then.`, { category: 'TRANSACTION' });
  return { sent: true, autoReleaseAt };
}

async function release(d, why) {
  let done = false;
  await prisma.$transaction(async (tx) => {
    const r = await tx.safeDeal.updateMany({ where: { id: d.id, status: { in: ['SENT', 'PAID', 'DISPUTED'] } }, data: { status: 'COMPLETED', closedAt: new Date(), resolution: why } });
    if (r.count !== 1) return;
    done = true;
    await F.credit(tx, d.sellerId, F.r2(Number(d.amount) - Number(d.fee)), 'SAFEBUY_IN', `SafeBuy: ${d.title}${Number(d.fee) > 0 ? ` (₦${Number(d.fee).toLocaleString()} SafeBuy fee)` : ''}`);
  });
  if (done) {
    notify(d.sellerId, 'SafeBuy: you’ve been paid 💰', `${F.naira(Number(d.amount) - Number(d.fee))} for “${d.title}” is in your wallet. (${why})`, { category: 'TRANSACTION' });
    if (d.buyerId) notify(d.buyerId, 'SafeBuy complete', `The deal for “${d.title}” is complete. (${why})`, { category: 'TRANSACTION' });
    require('./circles').onDeposit(d.sellerId).catch(() => {});
  }
  return done;
}

async function refund(d, why) {
  let done = false;
  await prisma.$transaction(async (tx) => {
    const r = await tx.safeDeal.updateMany({ where: { id: d.id, status: { in: ['PAID', 'SENT', 'DISPUTED'] } }, data: { status: 'REFUNDED', closedAt: new Date(), resolution: why } });
    if (r.count !== 1) return;
    done = true;
    await F.credit(tx, d.buyerId, Number(d.amount), 'SAFEBUY_IN', `SafeBuy refund: ${d.title}`);
  });
  if (done) {
    notify(d.buyerId, 'SafeBuy refund', `${F.naira(d.amount)} for “${d.title}” was refunded to your wallet. (${why})`, { category: 'TRANSACTION' });
    notify(d.sellerId, 'SafeBuy refunded', `The buyer was refunded for “${d.title}”. (${why})`, { category: 'TRANSACTION' });
  }
  return done;
}

async function confirm(code, buyerId) {
  const d = await byCode(code);
  if (d.buyerId !== buyerId) throw new F.FeatureError('Only the buyer can confirm.', 403);
  if (!['PAID', 'SENT'].includes(d.status)) throw new F.FeatureError('This deal can’t be confirmed now.');
  await release(d, 'The buyer confirmed they received it');
  return { completed: true };
}

async function dispute(code, buyerId, reason) {
  const d = await byCode(code);
  if (d.buyerId !== buyerId) throw new F.FeatureError('Only the buyer can report a problem.', 403);
  if (!['PAID', 'SENT'].includes(d.status)) throw new F.FeatureError('This deal can’t be disputed now.');
  const why = String(reason || '').trim();
  if (why.length < 10) throw new F.FeatureError('Tell us what went wrong (at least 10 letters).');
  await prisma.safeDeal.update({ where: { id: d.id }, data: { status: 'DISPUTED', disputeReason: why.slice(0, 600) } });
  notify(d.sellerId, 'SafeBuy: problem reported', `The buyer reported a problem with “${d.title}”: ${why.slice(0, 200)}. The money stays held while ZAPPI PAY looks into it — reply through Help → Support.`, { category: 'TRANSACTION' });
  require('./adminAlert').alertAdmins('SafeBuy dispute', `“${d.title}” (${F.naira(d.amount)}): ${why.slice(0, 200)}`, '/admin/features').catch?.(() => {});
  return { disputed: true };
}

// Seller cancels: before payment = just closed; after = buyer refunded.
// Buyer can cancel if the seller hasn't sent it within 7 days of payment.
async function cancel(code, viewerId) {
  const d = await byCode(code);
  if (d.sellerId === viewerId) {
    if (d.status === 'AWAITING_PAYMENT') { await prisma.safeDeal.update({ where: { id: d.id }, data: { status: 'CANCELLED', closedAt: new Date() } }); return { cancelled: true }; }
    if (d.status === 'PAID') { await refund(d, 'The seller cancelled'); return { refunded: true }; }
  }
  if (d.buyerId === viewerId && d.status === 'PAID' && Date.now() - new Date(d.paidAt) > 7 * DAY) { await refund(d, 'Not sent within 7 days'); return { refunded: true }; }
  throw new F.FeatureError('This deal can’t be cancelled now.');
}

async function resolve(code, adminId, { outcome, note } = {}) {
  const d = await byCode(code);
  if (d.status !== 'DISPUTED') throw new F.FeatureError('This deal isn’t in dispute.');
  const why = `Decided by ZAPPI PAY${note ? `: ${String(note).slice(0, 200)}` : ''}`;
  if (outcome === 'RELEASE') await release(d, why);
  else if (outcome === 'REFUND') await refund(d, why);
  else throw new F.FeatureError('Choose release or refund.');
  return { done: true };
}

async function tick() {
  const s = await getSettings();
  if (!(await F.anyOn('safeBuy'))) return;
  const due = await prisma.safeDeal.findMany({ where: { status: 'SENT', autoReleaseAt: { lte: new Date() } }, take: 50 });
  for (const d of due) await release(d, 'Released automatically — the buyer didn’t report a problem in time').catch((e) => console.error('safebuy release failed:', e.message));
}

async function mine(customerId) {
  const list = await prisma.safeDeal.findMany({ where: { OR: [{ sellerId: customerId }, { buyerId: customerId }] }, take: 40 });
  return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map((d) => ({ code: d.code, title: d.title, amount: Number(d.amount), status: d.status, role: d.sellerId === customerId ? 'SELLER' : 'BUYER', createdAt: d.createdAt }));
}

async function adminList() {
  const list = await prisma.safeDeal.findMany({ where: { status: { in: ['DISPUTED', 'PAID', 'SENT'] } }, take: 100 });
  const ids = [...new Set(list.flatMap((d) => [d.sellerId, d.buyerId]).filter(Boolean))];
  const names = new Map((await prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, phone: true } })).map((c) => [c.id, c]));
  return list.map((d) => ({ code: d.code, title: d.title, amount: Number(d.amount), status: d.status, seller: names.get(d.sellerId), buyer: names.get(d.buyerId), disputeReason: d.disputeReason, sentNote: d.sentNote, paidAt: d.paidAt, sentAt: d.sentAt }));
}

module.exports = { feeFor, create, view, pay, markSent, confirm, dispute, cancel, resolve, tick, mine, adminList };
