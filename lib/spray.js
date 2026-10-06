// Owambe Spray: the celebrant (host) opens a spray event and shows its QR.
// Guests set a spray budget once (with their PIN), then tap to spray —
// each spray moves money from the guest's wallet to the host's straight
// away. A live screen shows the notes flying, the total and top sprayers.

const prisma = require('./prisma');
const { notify } = require('./notify');
const F = require('./features');

const MAX_BUDGET = 500000;
const AMOUNTS = [100, 200, 500, 1000, 2000, 5000];

async function create(hostId, { title, celebrant } = {}) {
  await F.requireOn('spray', hostId);
  const t = String(title || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (t.length < 3) throw new F.FeatureError('Give the party a name, e.g. “Tunde & Ada’s wedding”.');
  const open = await prisma.sprayEvent.count({ where: { hostId, status: 'OPEN' } });
  if (open >= 3) throw new F.FeatureError('Close one of your open spray events first.');
  return prisma.sprayEvent.create({ data: { code: F.newCode(5), hostId, title: t, celebrant: String(celebrant || '').trim().slice(0, 60) || null, status: 'OPEN', total: 0, count: 0 } });
}

async function byCode(code) {
  const e = await prisma.sprayEvent.findUnique({ where: { code: String(code || '') } });
  if (!e) throw new F.FeatureError('This spray link is not valid.', 404);
  return e;
}

// Public live view (screen / guests): first names only.
async function live(code, { since } = {}) {
  const e = await byCode(code);
  const gifts = await prisma.sprayGift.findMany({ where: { eventId: e.id }, orderBy: { createdAt: 'desc' }, take: 300 });
  const recent = gifts.filter((g) => !since || new Date(g.createdAt) > new Date(since)).slice(0, 30);
  const totals = new Map();
  for (const g of gifts) totals.set(g.senderId, { name: g.name, amount: (totals.get(g.senderId)?.amount || 0) + Number(g.amount) });
  const top = [...totals.values()].sort((a, b) => b.amount - a.amount).slice(0, 10);
  const host = await prisma.customer.findUnique({ where: { id: e.hostId }, select: { name: true } });
  return { event: { code: e.code, title: e.title, celebrant: e.celebrant || host?.name, status: e.status, total: Number(e.total), count: e.count }, recent: recent.map((g) => ({ id: g.id, name: g.name, amount: Number(g.amount), message: g.message, at: g.createdAt })), top, amounts: AMOUNTS, now: new Date() };
}

async function startSession(code, senderId, budgetIn) {
  await F.requireOn('spray', senderId);
  const e = await byCode(code);
  if (e.status !== 'OPEN') throw new F.FeatureError('This spray event has ended.');
  if (e.hostId === senderId) throw new F.FeatureError('You can’t spray yourself 😄 — share the QR with your guests.');
  const budget = F.r2(budgetIn);
  if (!(budget >= 100)) throw new F.FeatureError('Set a spray budget of at least ₦100.');
  if (budget > MAX_BUDGET) throw new F.FeatureError(`The most you can set is ${F.naira(MAX_BUDGET)}.`);
  await F.checkSpend(senderId);
  const me = await prisma.customer.findUnique({ where: { id: senderId }, select: { walletBalance: true } });
  if (Number(me?.walletBalance || 0) < Math.min(budget, 100)) throw new F.FeatureError('Fund your wallet first.', 402, 'INSUFFICIENT_BALANCE');
  return prisma.spraySession.create({ data: { eventId: e.id, senderId, budget, spent: 0, expiresAt: new Date(Date.now() + 12 * 3600 * 1000) } });
}

async function spray(code, senderId, { sessionId, amount, message } = {}) {
  await F.requireOn('spray', senderId);
  const e = await byCode(code);
  if (e.status !== 'OPEN') throw new F.FeatureError('This spray event has ended.');
  const s = await prisma.spraySession.findUnique({ where: { id: String(sessionId || '') } });
  if (!s || s.senderId !== senderId || s.eventId !== e.id || new Date(s.expiresAt) < new Date()) throw new F.FeatureError('Set your spray budget again (with your PIN).', 401, 'SESSION');
  const amt = F.r2(amount);
  if (!(amt >= 50)) throw new F.FeatureError('The smallest spray is ₦50.');
  if (Number(s.spent) + amt > Number(s.budget) + 0.001) throw new F.FeatureError(`That’s over your spray budget (${F.naira(Number(s.budget) - Number(s.spent))} left). Set a new budget to spray more.`, 400, 'BUDGET');
  await F.checkSpend(senderId);
  const sender = await prisma.customer.findUnique({ where: { id: senderId }, select: { name: true } });
  const first = String(sender?.name || 'Guest').split(' ')[0];
  const msg = String(message || '').trim().slice(0, 60) || null;
  let gift = null;
  const ok = await F.move({
    fromId: senderId, toId: e.hostId, amount: amt, outType: 'SPRAY_OUT', inType: 'SPRAY_IN',
    outNote: `Sprayed at “${e.title}”`, inNote: `Spray from ${sender?.name} at “${e.title}”`,
    extra: async (tx) => {
      const up = await tx.spraySession.updateMany({ where: { id: s.id, spent: s.spent }, data: { spent: { increment: amt } } });
      if (up.count !== 1) throw Object.assign(new Error('busy'), { busy: true });
      await tx.sprayEvent.update({ where: { id: e.id }, data: { total: { increment: amt }, count: { increment: 1 } } });
      gift = await tx.sprayGift.create({ data: { eventId: e.id, senderId, name: first, amount: amt, message: msg } });
    },
  }).catch((err) => { if (err.busy) throw new F.FeatureError('Slow down a little — try again.', 429); throw err; });
  if (!ok) throw new F.FeatureError('Your wallet is empty — fund it to keep spraying.', 402, 'INSUFFICIENT_BALANCE');
  const fresh = await prisma.spraySession.findUnique({ where: { id: s.id } });
  return { gift: { id: gift.id, name: first, amount: amt, message: msg }, left: F.r2(Number(fresh.budget) - Number(fresh.spent)) };
}

async function close(code, hostId) {
  const e = await byCode(code);
  if (e.hostId !== hostId) throw new F.FeatureError('Only the host can end it.', 403);
  await prisma.sprayEvent.update({ where: { id: e.id }, data: { status: 'CLOSED', closedAt: new Date() } });
  notify(hostId, 'Spray event ended', `“${e.title}” has ended. You received ${F.naira(e.total)} from ${e.count} sprays 🎉`, { category: 'TRANSACTION' });
  return { closed: true, total: Number(e.total), count: e.count };
}

async function mine(hostId) {
  const list = await prisma.sprayEvent.findMany({ where: { hostId }, orderBy: { createdAt: 'desc' }, take: 20 });
  return list.map((e) => ({ code: e.code, title: e.title, celebrant: e.celebrant, status: e.status, total: Number(e.total), count: e.count, createdAt: e.createdAt }));
}

module.exports = { AMOUNTS, create, live, startSession, spray, close, mine };
