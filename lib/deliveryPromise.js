const prisma = require('./prisma');
const { getSettings } = require('./vtpass');
const { notify } = require('./notify');

// "Delivered in 60 seconds or ₦20 back". When an airtime/data purchase
// takes longer than the promise to confirm (delivered late, or failed
// after a long wait), the customer gets a small bonus. Quick failures
// (e.g. a wrong number) don't count, so it can't be farmed. Limits: one
// bonus per customer per day and a daily budget for everyone.

const LAGOS = 60 * 60 * 1000;
const lagosYmd = (d) => new Date(new Date(d).getTime() + LAGOS).toISOString().slice(0, 10);
const startOfLagosDay = (ymd) => new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() - LAGOS);
const SERVICES = ['AIRTIME', 'DATA', 'ELECTRICITY', 'CABLE', 'EDUCATION', 'INTERNET', 'BETTING'];

function config(s) {
  let services = s.deliveryPromiseServices;
  if (typeof services === 'string') { try { services = JSON.parse(services); } catch { services = null; } }
  return {
    enabled: Boolean(s.deliveryPromiseEnabled),
    seconds: Number(s.deliveryPromiseSeconds ?? 60),
    bonus: Number(s.deliveryPromiseBonus ?? 20),
    minAmount: Number(s.deliveryPromiseMinAmount ?? 100),
    dailyBudget: Number(s.deliveryPromiseDailyBudget ?? 2000),
    services: Array.isArray(services) ? services.filter((x) => SERVICES.includes(x)) : ['AIRTIME', 'DATA'],
  };
}

// For the Buy page badge.
function publicInfo(s) {
  const c = config(s);
  if (!c.enabled || !(c.bonus > 0)) return null;
  return { seconds: c.seconds, bonus: c.bonus, minAmount: c.minAmount, services: c.services };
}

async function paidToday(customerId, now = new Date()) {
  const since = startOfLagosDay(lagosYmd(now));
  const where = { type: 'DELIVERY_BONUS', status: 'APPROVED', createdAt: { gte: since } };
  const [mine, all] = await Promise.all([
    prisma.walletTransaction.count({ where: { ...where, customerId } }),
    prisma.walletTransaction.aggregate({ where, _sum: { amount: true } }),
  ]);
  return { mine, total: Number(all?._sum?.amount || 0) };
}

// Called once an order is settled (SUCCESS or FAILED), by the code that
// claimed the settle — so it runs once per order.
async function check(order, outcome, now = new Date()) {
  try {
    const c = config(await getSettings());
    if (!c.enabled || !(c.bonus > 0)) return null;
    if (!c.services.includes(order.service)) return null;
    if (Number(order.amount) < c.minAmount) return null;
    const took = now.getTime() - new Date(order.createdAt).getTime();
    if (took <= c.seconds * 1000) return null;
    const { mine, total } = await paidToday(order.customerId, now);
    if (mine >= 1) return null;
    if (total + c.bonus > c.dailyBudget) return null;
    try {
      await prisma.$transaction([
        prisma.walletTransaction.create({
          data: { customerId: order.customerId, type: 'DELIVERY_BONUS', amount: c.bonus, status: 'APPROVED', providerRef: `promise:${order.id}`, reference: order.vtpassRequestId, note: `Delivery promise — ${order.service.toLowerCase()} took longer than ${c.seconds}s` },
        }),
        prisma.customer.update({ where: { id: order.customerId }, data: { walletBalance: { increment: c.bonus } } }),
      ]);
    } catch (e) {
      if (e.code === 'P2002') return null; // already paid for this order
      throw e;
    }
    const mins = Math.max(1, Math.round(took / 60000));
    const what = outcome === 'SUCCESS' ? `Your ${order.service.toLowerCase()} for ${order.recipient} took about ${mins} min to arrive` : `Your ${order.service.toLowerCase()} for ${order.recipient} didn't go through (you've been refunded)`;
    notify(order.customerId, 'Delivery Promise', `${what}. Sorry about that — we've added ₦${c.bonus} to your wallet, as promised.`);
    return c.bonus;
  } catch (error) {
    console.error('deliveryPromise.check failed:', error.message);
    return null;
  }
}

async function stats(now = new Date()) {
  const since30 = new Date(now.getTime() - 30 * 24 * LAGOS);
  const where = { type: 'DELIVERY_BONUS', status: 'APPROVED' };
  const [today, month] = await Promise.all([
    prisma.walletTransaction.aggregate({ where: { ...where, createdAt: { gte: startOfLagosDay(lagosYmd(now)) } }, _sum: { amount: true }, _count: true }),
    prisma.walletTransaction.aggregate({ where: { ...where, createdAt: { gte: since30 } }, _sum: { amount: true }, _count: true }),
  ]);
  const n = (a) => ({ count: typeof a._count === 'number' ? a._count : a._count?._all || 0, amount: Number(a._sum?.amount || 0) });
  return { today: n(today), last30: n(month) };
}

module.exports = { SERVICES, config, publicInfo, check, stats };
