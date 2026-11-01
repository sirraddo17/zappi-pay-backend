// Monthly rewards cap: rewards EARNED in a calendar month (Lagos time)
// may be at most rewardMonthlyCapPercent (default: the rewards split %,
// 40%) of that month's REAL earnings (test orders left out). A reward
// counts when it is earned, not when it is spent — so loyalty points
// count when given, and turning points into cash later is not counted
// again. When the cap is reached, new cashback and points pause until
// the 1st of next month (the app keeps working, just without rewards).

const prisma = require('./prisma');
const { toKobo, nairaNum } = require('./money');

const LAGOS = 60 * 60 * 1000;
// Rewards paid as wallet credits (LOYALTY = points turned into cash: not
// counted, the points were counted when earned).
const WALLET_REWARD_TYPES = ['CASHBACK', 'REFERRAL_BONUS', 'CONTEST_PRIZE', 'COUPON', 'CHALLENGE_REWARD', 'DELIVERY_BONUS', 'SHOP_COMMISSION'];

function monthStart(now = new Date()) {
  const ymd = new Date(now.getTime() + LAGOS).toISOString().slice(0, 8);
  return new Date(new Date(`${ymd}01T00:00:00.000Z`).getTime() - LAGOS);
}

function capPercent(settings) {
  const own = settings.rewardMonthlyCapPercent;
  const p = own === null || own === undefined || own === '' ? Number(settings.rewardSplitPct ?? 40) : Number(own);
  return Math.max(0, Math.min(100, Number.isFinite(p) ? p : 40));
}

// What the business really earned on an order, in kobo (never below 0):
// price paid (after discounts and promo codes) − what the supplier
// charged + supplier commission − the payment partner's fee on the
// wallet money spent (less any funding fee the customer paid for it).
function orderEarningsKobo(order, settings) {
  const { commissionOf } = require('./earnings');
  const paid = toKobo(order.amount);
  const cost = order.costAmount == null ? paid : toKobo(order.costAmount);
  const gross = paid - cost + toKobo(commissionOf(order).amount || 0);
  const funding = settings ? toKobo(require('./rewardGuard').fundingCost(Number(order.amount), settings) || 0) : 0;
  return Math.max(0, gross - funding);
}

// Month figures, test orders excluded.
async function month({ now = new Date(), customerId } = {}) {
  const from = monthStart(now);
  const range = { gte: from };
  const s = await require('./vtpass').getSettings();
  const pointValueK = toKobo(s.loyaltyPointValue || 0);
  const who = customerId ? { customerId } : {};
  const [orders, cashback, points, wallet] = await Promise.all([
    customerId ? [] : prisma.order.findMany({ where: { status: 'SUCCESS', isTest: false, createdAt: range }, select: { amount: true, costAmount: true, service: true, provider: true, responsePayload: true } }),
    prisma.cashbackEntry.findMany({ where: { ...who, createdAt: range, OR: [{ type: { in: ['EARNED', 'ADJUSTMENT', 'REVERSED'] } }, { type: null, amount: { gt: 0 } }] }, select: { amount: true, amountKobo: true, type: true, note: true, orderId: true } }),
    prisma.order.aggregate({ where: { ...who, isTest: false, createdAt: range, pointsEarned: { gt: 0 } }, _sum: { pointsEarned: true } }),
    prisma.walletTransaction.findMany({ where: { ...who, createdAt: range, status: 'APPROVED', type: { in: WALLET_REWARD_TYPES } }, select: { type: true, amount: true } }),
  ]);
  const earnedK = orders.reduce((a, o) => a + orderEarningsKobo(o, s), 0);
  // Cashback on orders later marked as test doesn't count either.
  const ids = [...new Set(cashback.map((e) => e.orderId).filter(Boolean))];
  const testIds = new Set(ids.length ? (await prisma.order.findMany({ where: { id: { in: ids }, isTest: true }, select: { id: true } })).map((o) => o.id) : []);
  const byType = { CASHBACK: 0, LOYALTY: 0 };
  for (const e of cashback) {
    if (e.orderId && testIds.has(e.orderId)) continue;
    if (!e.type && /^returned:/i.test(String(e.note || ''))) continue; // a refund, not a reward
    if (e.type === 'ADJUSTMENT' && /^returned/i.test(String(e.note || ''))) continue;
    byType.CASHBACK += e.amountKobo ?? toKobo(e.amount);
  }
  byType.LOYALTY = Number(points?._sum?.pointsEarned || 0) * pointValueK;
  for (const w of wallet) byType[w.type] = (byType[w.type] || 0) + toKobo(w.amount);
  const rewardsK = Object.values(byType).reduce((a, b) => a + b, 0);
  const pct = capPercent(s);
  const capK = Math.floor((earnedK * Math.round(pct * 100)) / 10000);
  return {
    from,
    earnedKobo: earnedK,
    rewardsKobo: rewardsK,
    capKobo: capK,
    capPercent: pct,
    leftKobo: Math.max(0, capK - rewardsK),
    usedPct: capK > 0 ? Math.round((rewardsK / capK) * 1000) / 10 : rewardsK > 0 ? 100 : 0,
    givenPctOfEarnings: earnedK > 0 ? Math.round((rewardsK / earnedK) * 1000) / 10 : 0,
    reached: rewardsK >= capK,
    byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, nairaNum(v)])),
  };
}

let cache = { at: 0, data: null };
async function cached(force) {
  if (!force && cache.data && Date.now() - cache.at < 30 * 1000) return cache.data;
  cache = { at: Date.now(), data: await month() };
  return cache.data;
}
const invalidate = () => { cache = { at: 0, data: null }; };

// Trims a reward (kobo) to what the month's cap (and the optional
// per-customer cap) still allows. Returns the kobo that may be given.
async function trim(kobo, { customerId } = {}) {
  if (!(kobo > 0)) return 0;
  const m = await cached(true);
  let ok = Math.min(kobo, m.leftKobo);
  const s = await require('./vtpass').getSettings();
  const perUserK = toKobo(s.rewardUserMonthlyCap || 0);
  if (ok > 0 && perUserK > 0 && customerId) {
    const mine = await month({ customerId });
    ok = Math.min(ok, Math.max(0, perUserK - mine.rewardsKobo));
  }
  if (ok > 0) cache.data = { ...m, rewardsKobo: m.rewardsKobo + ok, leftKobo: Math.max(0, m.leftKobo - ok) };
  return Math.max(0, ok);
}

module.exports = { month, cached, trim, invalidate, capPercent, monthStart, orderEarningsKobo, WALLET_REWARD_TYPES };
