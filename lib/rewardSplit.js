const prisma = require('./prisma');
const { notify } = require('./notify');

// Rewards split: "give back 30% of what I earn". On every successful
// purchase, that share of the owner's earnings (markup + VTpass
// commission, after any discount and promo code) is divided between
// the reward programmes that are switched on:
//   CASHBACK   → paid to the buyer straight away
//   LOYALTY    → loyalty points for the buyer (at the point value)
//   SHOP       → the agent, when the purchase came through a shop link
//   REFERRAL, CHALLENGES, PROMISE → saved in a pool that pays referral
//                bonuses, challenge rewards and delivery-promise bonuses
// A programme that is off (or a shop share on a purchase that didn't
// come through a shop) gives its share to the others, so the full %
// is always given back and never more.

const KEYS = ['CASHBACK', 'LOYALTY', 'REFERRAL', 'CHALLENGES', 'PROMISE', 'SHOP'];
const POOLS = ['REFERRAL', 'CHALLENGES', 'PROMISE'];
const DEFAULT_SHARES = { CASHBACK: 35, LOYALTY: 20, REFERRAL: 20, CHALLENGES: 10, PROMISE: 5, SHOP: 10 };
const LABELS = { CASHBACK: 'Cashback', LOYALTY: 'Loyalty points', REFERRAL: 'Referral bonuses', CHALLENGES: 'Challenges', PROMISE: 'Delivery promise', SHOP: 'Agent shop commission' };
const kobo = (n) => Math.floor(Number(n) * 100) / 100;

function config(s) {
  let shares = s.rewardSplitShares;
  if (typeof shares === 'string') { try { shares = JSON.parse(shares); } catch { shares = null; } }
  const clean = {};
  for (const k of KEYS) clean[k] = Math.max(0, Math.min(100, Number((shares || DEFAULT_SHARES)[k] ?? 0)));
  return {
    enabled: Boolean(s.rewardSplitEnabled),
    pct: Math.max(0, Math.min(100, Number(s.rewardSplitPct ?? 30))),
    shares: clean,
  };
}

// Challenges running right now (cached for a minute).
let chCache = { at: 0, any: false };
async function anyChallenge() {
  if (Date.now() - chCache.at < 60 * 1000) return chCache.any;
  const n = await prisma.challenge.count({ where: { active: true } }).catch(() => 0);
  chCache = { at: Date.now(), any: n > 0 };
  return chCache.any;
}

// Which programmes take part on this purchase.
async function programmes(s, order) {
  return {
    CASHBACK: Boolean(s.cashbackEnabled),
    LOYALTY: Boolean(s.loyaltyEnabled) && Number(s.loyaltyPointValue || 0) > 0,
    REFERRAL: Boolean(s.referralEnabled) && Number(s.referralBonusAmount || 0) > 0,
    CHALLENGES: await anyChallenge(),
    PROMISE: Boolean(s.deliveryPromiseEnabled) && Number(s.deliveryPromiseBonus || 0) > 0,
    SHOP: Boolean(s.shopLinksEnabled) && Boolean(order?.shopAgentId) && order.shopAgentId !== order.customerId,
  };
}

// Split `budget` by the shares of the programmes that are on.
function allocate(budget, shares, on) {
  const live = KEYS.filter((k) => on[k] && shares[k] > 0);
  const total = live.reduce((a, k) => a + shares[k], 0);
  const out = Object.fromEntries(KEYS.map((k) => [k, 0]));
  if (!(budget > 0) || !total) return out;
  for (const k of live) out[k] = kobo((budget * shares[k]) / total);
  return out;
}

// --- Pools -------------------------------------------------------

async function addToPool(key, amount, orderId) {
  if (!(amount >= 0.01)) return;
  await prisma.rewardPool.upsert({ where: { key }, create: { key, balance: amount }, update: { balance: { increment: amount } } });
  await prisma.rewardPoolMove.create({ data: { pool: key, amount, orderId: orderId || null, note: 'From a purchase' } }).catch(() => {});
}

// Inside a transaction: take `amount` from a pool if it has enough.
async function takeFromPool(tx, key, amount, note) {
  const r = await tx.rewardPool.updateMany({ where: { key, balance: { gte: amount } }, data: { balance: { decrement: amount } } });
  if (r.count !== 1) return false;
  await tx.rewardPoolMove.create({ data: { pool: key, amount: -amount, note: note || null } });
  return true;
}

async function poolBalance(key) {
  const p = await prisma.rewardPool.findUnique({ where: { key } });
  return Number(p?.balance || 0);
}

async function balances() {
  const rows = await prisma.rewardPool.findMany({});
  return Object.fromEntries(POOLS.map((k) => [k, Number(rows.find((r) => r.key === k)?.balance || 0)]));
}

// --- On each successful purchase -----------------------------------

async function distribute(order, settings) {
  const zero = { cashback: 0, points: 0, shopCommission: 0 };
  try {
    const c = config(settings);
    if (!c.enabled) return zero;
    const budget = require('./rewardGuard').roomForOrder(order, settings);
    if (!(budget >= 0.01)) return zero;
    const parts = allocate(budget, c.shares, await programmes(settings, order));
    const result = { ...zero };

    if (parts.CASHBACK >= 0.01) {
      const amount = parts.CASHBACK;
      await prisma.$transaction(async (tx) => {
        await require('./cashback').creditEarned(tx, settings, { customerId: order.customerId, amount, order, note: `Cashback on ${String(order.service).toLowerCase()}` });
        await tx.order.update({ where: { id: order.id }, data: { cashbackAmount: amount } });
      });
      result.cashback = amount;
      if (amount >= 5) notify(order.customerId, 'Cashback Received', `You got ₦${amount.toLocaleString()} cashback on your ${String(order.service).toLowerCase()} purchase.`);
    }

    if (parts.LOYALTY > 0) {
      const points = Math.floor(parts.LOYALTY / Number(settings.loyaltyPointValue));
      if (points >= 1) {
        await prisma.$transaction(async (tx) => {
          await tx.customer.update({ where: { id: order.customerId }, data: { loyaltyPoints: { increment: points } } });
          await tx.order.update({ where: { id: order.id }, data: { pointsEarned: points } });
        });
        result.points = points;
      }
    }

    if (parts.SHOP >= 0.01) {
      result.shopCommission = await require('./shop').payCommission(order, settings, { fixedAmount: parts.SHOP });
    }

    for (const k of POOLS) await addToPool(k, parts[k], order.id);
    return result;
  } catch (error) {
    console.error('rewardSplit.distribute failed:', error.message);
    return zero;
  }
}

// Referral bonuses that waited because the pool was short: try again.
async function payWaitingReferrals() {
  const s = await require('./vtpass').getSettings();
  if (!config(s).enabled || !s.referralEnabled) return 0;
  const waiting = await prisma.customer.findMany({ where: { referredById: { not: null }, referralBonusPaidAt: null, deletedAt: null }, select: { referredById: true }, take: 300 });
  const referrers = [...new Set(waiting.map((w) => w.referredById))].slice(0, 100);
  const { catchUpReferralBonuses } = require('./referral');
  for (const id of referrers) await catchUpReferralBonuses(id);
  return referrers.length;
}

let timer = null;
function startRewardSplitTimer() {
  if (timer || process.env.DISABLE_SCHEDULER === '1') return;
  const run = () => payWaitingReferrals().catch((e) => console.error('waiting referrals failed:', e.message));
  timer = setInterval(run, 60 * 60 * 1000);
}

module.exports = { KEYS, POOLS, LABELS, DEFAULT_SHARES, config, programmes, allocate, distribute, addToPool, takeFromPool, poolBalance, balances, payWaitingReferrals, startRewardSplitTimer };
