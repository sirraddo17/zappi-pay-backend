// Shared Light: people on one prepaid meter (flatmates, a compound, a
// shop) pay into a light pot. When the pot reaches the target, ZAPPI PAY
// buys the token for the meter automatically and every member sees it.
// Money in the pot can't be spent by anyone until the token is bought.

const prisma = require('./prisma');
const { notify } = require('./notify');
const { vtpassRequest } = require('./vtpass');
const F = require('./features');

async function verifyMeter(serviceID, meterNumber, meterType) {
  const data = await vtpassRequest('GET', '/merchant-verify', { query: { serviceID, billersCode: meterNumber, type: meterType } });
  const c = data?.content || {};
  if (c.error || !c.Customer_Name) throw new F.FeatureError(`That meter didn’t check out${c.error ? `: ${c.error}` : ''}.`);
  return String(c.Customer_Name).trim();
}

async function create(ownerId, b = {}) {
  await F.requireOn('sharedLight');
  const name = String(b.name || '').trim().slice(0, 50);
  if (name.length < 3) throw new F.FeatureError('Give the pot a name (e.g. “Flat 3 light”).');
  const meterNumber = String(b.meterNumber || '').replace(/\D/g, '');
  if (!/^\d{6,13}$/.test(meterNumber) || !b.serviceID) throw new F.FeatureError('Choose the electricity company and enter the meter number.');
  const meterType = b.meterType === 'postpaid' ? 'postpaid' : 'prepaid';
  const target = F.r2(b.target);
  if (!(target >= 1000 && target <= 200000)) throw new F.FeatureError('The token amount must be between ₦1,000 and ₦200,000.');
  const meterName = await verifyMeter(String(b.serviceID), meterNumber, meterType);
  const pot = await prisma.lightPot.create({ data: { code: F.newCode(5), ownerId, name, serviceID: String(b.serviceID), meterNumber, meterType, meterName, target, collected: 0, cycle: 1, status: 'ACTIVE' } });
  await prisma.lightPotMember.create({ data: { potId: pot.id, customerId: ownerId, status: 'ACTIVE' } });
  return pot;
}

async function byCode(code) {
  const p = await prisma.lightPot.findUnique({ where: { code: String(code || '') } });
  if (!p) throw new F.FeatureError('This light pot link is not valid.', 404);
  return p;
}

async function join(code, customerId) {
  await F.requireOn('sharedLight');
  const p = await byCode(code);
  if (p.status !== 'ACTIVE') throw new F.FeatureError('This pot is closed.');
  const m = await prisma.lightPotMember.findUnique({ where: { potId_customerId: { potId: p.id, customerId } } });
  if (!m) await prisma.lightPotMember.create({ data: { potId: p.id, customerId, status: 'ACTIVE' } });
  else if (m.status !== 'ACTIVE') await prisma.lightPotMember.update({ where: { id: m.id }, data: { status: 'ACTIVE' } });
  return { potId: p.id };
}

async function members(potId) {
  return prisma.lightPotMember.findMany({ where: { potId, status: 'ACTIVE' } });
}

// Buys the token once the pot is full. The pot money is moved to the
// owner's wallet and the purchase made from there in one go; if it fails
// straight away the money goes back into the pot.
async function buy(potId) {
  const pot = await prisma.lightPot.findUnique({ where: { id: potId } });
  if (!pot || pot.status !== 'ACTIVE' || Number(pot.collected) < Number(pot.target)) return null;
  const amt = Number(pot.target);
  const take = await prisma.$transaction(async (tx) => {
    const r = await tx.lightPot.updateMany({ where: { id: pot.id, collected: pot.collected }, data: { collected: { decrement: amt } } });
    if (r.count !== 1) return false;
    await F.credit(tx, pot.ownerId, amt, 'POT_IN', `Shared Light “${pot.name}” — token money (cycle ${pot.cycle})`);
    return true;
  });
  if (!take) return null;
  const owner = await prisma.customer.findUnique({ where: { id: pot.ownerId }, select: { phone: true } });
  const res = await require('./purchase').performPurchase(pot.ownerId, { service: 'ELECTRICITY', serviceID: pot.serviceID, billersCode: pot.meterNumber, phone: owner.phone, amount: amt, meterType: pot.meterType }, { source: 'pot' });
  if (res.status === 201 || res.status === 202) {
    await prisma.lightPot.update({ where: { id: pot.id }, data: { cycle: { increment: 1 }, lastOrderId: res.body.order.id } });
    await prisma.lightPotBuy.create({ data: { potId: pot.id, cycle: pot.cycle, amount: amt, orderId: res.body.order.id, status: res.status === 201 ? 'SUCCESS' : 'PENDING' } });
    for (const m of await members(pot.id)) notify(m.customerId, 'Light token bought 💡', `The “${pot.name}” pot was full, so a ${F.naira(amt)} token was bought for meter ${pot.meterNumber}. Open Shared Light to see the token.`, { category: 'TRANSACTION' });
    return { bought: true, orderId: res.body.order.id };
  }
  // Failed at once (or was refunded): put the money back in the pot.
  const back = await prisma.$transaction(async (tx) => {
    const d = await tx.customer.updateMany({ where: { id: pot.ownerId, walletBalance: { gte: amt } }, data: { walletBalance: { decrement: amt } } });
    if (d.count !== 1) return false;
    await tx.walletTransaction.create({ data: { customerId: pot.ownerId, type: 'POT_OUT', amount: amt, status: 'APPROVED', note: `Shared Light “${pot.name}” — token failed, money back to the pot` } });
    await tx.lightPot.update({ where: { id: pot.id }, data: { collected: { increment: amt } } });
    return true;
  });
  await prisma.lightPotBuy.create({ data: { potId: pot.id, cycle: pot.cycle, amount: amt, status: 'FAILED' } });
  notify(pot.ownerId, 'Light token failed', `We couldn’t buy the token for “${pot.name}” (${res.body?.error || 'try again later'}).${back ? ' The money is back in the pot — tap “Buy token now” to try again.' : ''}`, { category: 'TRANSACTION' });
  return { bought: false, error: res.body?.error };
}

async function contribute(potId, customerId, amountIn) {
  await F.requireOn('sharedLight');
  const pot = await prisma.lightPot.findUnique({ where: { id: potId } });
  if (!pot || pot.status !== 'ACTIVE') throw new F.FeatureError('Pot not found.', 404);
  const m = await prisma.lightPotMember.findUnique({ where: { potId_customerId: { potId, customerId } } });
  if (!m || m.status !== 'ACTIVE') throw new F.FeatureError('Join the pot first.', 403);
  const amt = F.r2(amountIn);
  if (!(amt >= 100)) throw new F.FeatureError('Put in at least ₦100.');
  if (amt > 200000) throw new F.FeatureError('That’s too much for one go.');
  await F.checkSpend(customerId);
  const ok = await F.move({
    fromId: customerId, toId: null, amount: amt, outType: 'POT_OUT', outNote: `Shared Light “${pot.name}” — my share`,
    extra: async (tx) => {
      await tx.lightPot.update({ where: { id: pot.id }, data: { collected: { increment: amt } } });
      await tx.lightPotPayment.create({ data: { potId: pot.id, customerId, cycle: pot.cycle, amount: amt } });
    },
  });
  if (!ok) throw new F.FeatureError('Insufficient wallet balance.', 402, 'INSUFFICIENT_BALANCE');
  const who = await prisma.customer.findUnique({ where: { id: customerId }, select: { name: true } });
  if (customerId !== pot.ownerId) notify(pot.ownerId, 'Shared Light', `${who?.name} put ${F.naira(amt)} into “${pot.name}”.`, { category: 'TRANSACTION' });
  const bought = await buy(pot.id);
  return { added: amt, bought };
}

async function detail(potId, viewerId) {
  const pot = await prisma.lightPot.findUnique({ where: { id: potId } });
  if (!pot) throw new F.FeatureError('Pot not found.', 404);
  const ms = await members(potId);
  if (!ms.some((m) => m.customerId === viewerId)) throw new F.FeatureError('You are not in this pot.', 403);
  const custs = new Map((await prisma.customer.findMany({ where: { id: { in: ms.map((m) => m.customerId) } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const pays = await prisma.lightPotPayment.findMany({ where: { potId, cycle: pot.cycle } });
  const buys = (await prisma.lightPotBuy.findMany({ where: { potId } })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 10);
  let token = null;
  if (pot.lastOrderId) {
    const o = await prisma.order.findUnique({ where: { id: pot.lastOrderId } });
    if (o?.status === 'SUCCESS') {
      const pl = o.responsePayload || {};
      token = String(pl.purchased_code || pl.mainToken || pl.token || pl.content?.transactions?.purchased_code || '').replace(/^Token\s*:\s*/i, '').trim() || null;
    }
  }
  const share = F.r2(Number(pot.target) / Math.max(1, ms.length));
  return {
    pot: { id: pot.id, code: pot.code, name: pot.name, serviceID: pot.serviceID, meterNumber: pot.meterNumber, meterType: pot.meterType, meterName: pot.meterName, target: Number(pot.target), collected: Number(pot.collected), cycle: pot.cycle, status: pot.status, suggestedShare: share },
    isOwner: pot.ownerId === viewerId,
    members: ms.map((m) => {
      const paid = F.r2(pays.filter((p) => p.customerId === m.customerId).reduce((t, p) => t + Number(p.amount), 0));
      return { name: custs.get(m.customerId), paid, done: paid >= share, isOwner: m.customerId === pot.ownerId };
    }),
    lastToken: token,
    history: await Promise.all(buys.map(async (b) => ({ cycle: b.cycle, amount: Number(b.amount), status: b.orderId ? (await prisma.order.findUnique({ where: { id: b.orderId }, select: { status: true } }))?.status || b.status : b.status, at: b.createdAt }))),
  };
}

// Owner can buy with what's there (e.g. the target was too high) — only if it's at least ₦1,000.
async function buyNow(potId, ownerId) {
  const pot = await prisma.lightPot.findUnique({ where: { id: potId } });
  if (!pot || pot.ownerId !== ownerId) throw new F.FeatureError('Only the pot owner can do this.', 403);
  if (Number(pot.collected) < 1000) throw new F.FeatureError('There must be at least ₦1,000 in the pot.');
  if (Number(pot.collected) < Number(pot.target)) await prisma.lightPot.update({ where: { id: pot.id }, data: { target: pot.collected } });
  const r = await buy(pot.id);
  if (Number(pot.collected) < Number(pot.target)) await prisma.lightPot.update({ where: { id: pot.id }, data: { target: pot.target } });
  return r;
}

async function close(potId, ownerId) {
  const pot = await prisma.lightPot.findUnique({ where: { id: potId } });
  if (!pot || pot.ownerId !== ownerId) throw new F.FeatureError('Only the pot owner can close it.', 403);
  const r = await prisma.lightPot.updateMany({ where: { id: pot.id, status: 'ACTIVE' }, data: { status: 'CLOSED' } });
  if (r.count !== 1) return { closed: true };
  // Give back this cycle's money, in proportion to what each paid.
  const pays = await prisma.lightPotPayment.findMany({ where: { potId, cycle: pot.cycle } });
  const paidIn = pays.reduce((t, p) => t + Number(p.amount), 0);
  const inPot = Number(pot.collected);
  const per = new Map();
  for (const p of pays) per.set(p.customerId, (per.get(p.customerId) || 0) + Number(p.amount));
  for (const [cid, amt] of per) {
    const back = paidIn > 0 ? Math.floor((amt / paidIn) * inPot * 100) / 100 : 0;
    if (back > 0) await prisma.$transaction(async (tx) => { await F.credit(tx, cid, back, 'POT_IN', `Shared Light “${pot.name}” closed — money returned`); });
  }
  await prisma.lightPot.update({ where: { id: pot.id }, data: { collected: 0 } });
  for (const m of await members(potId)) notify(m.customerId, 'Shared Light closed', `“${pot.name}” was closed. Money in the pot was returned to the people who paid it.`, { category: 'TRANSACTION' });
  return { closed: true };
}

async function mine(customerId) {
  const rows = await prisma.lightPotMember.findMany({ where: { customerId, status: 'ACTIVE' } });
  const pots = await prisma.lightPot.findMany({ where: { id: { in: rows.map((r) => r.potId) } } });
  return pots.map((p) => ({ id: p.id, code: p.code, name: p.name, meterNumber: p.meterNumber, target: Number(p.target), collected: Number(p.collected), status: p.status, isOwner: p.ownerId === customerId }));
}

async function preview(code) {
  const p = await byCode(code);
  const owner = await prisma.customer.findUnique({ where: { id: p.ownerId }, select: { name: true } });
  return { pot: { id: p.id, name: p.name, meterNumber: p.meterNumber, meterName: p.meterName, target: Number(p.target), status: p.status }, owner: owner?.name, members: await prisma.lightPotMember.count({ where: { potId: p.id, status: 'ACTIVE' } }) };
}

module.exports = { create, join, contribute, buy, buyNow, detail, close, mine, preview };
