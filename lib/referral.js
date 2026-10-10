const prisma = require('./prisma');
const { getSettings } = require('./vtpass');
const { notify } = require('./notify');

// Pays the referrer's one-time bonus once the customer they invited has
// completed a successful purchase or bank transfer of at least the
// admin-set minimum. While the rewards split is on, the bonus must be
// covered: it comes from the referral pool, or — if the pool is short —
// from what the app has already earned on that friend's own purchases
// (after their discounts and rewards). So a bigger bonus just takes a
// few more purchases by the friend, and never costs more than they
// brought in. Safe to call after every successful purchase: the
// conditional update below means the bonus can only ever be paid once,
// even if two purchases finish at the same moment.
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// What the owner has kept from this customer's own successful purchases:
// earnings minus everything given away on them (discounts, promo codes,
// and the rewards-split share that went to cashback, points, the agent
// and the pools).
async function earnedFrom(customerId, settings) {
  const guard = require('./rewardGuard');
  const { commissionOf } = require('./earnings');
  const orders = await prisma.order.findMany({
    where: { customerId, status: 'SUCCESS' },
    orderBy: { createdAt: 'asc' },
    take: 500,
    select: { service: true, provider: true, amount: true, costAmount: true, discountAmount: true, promoDiscount: true, responsePayload: true },
  });
  const pct = guard.percent(settings) / 100;
  let total = 0;
  for (const o of orders) {
    const discount = Number(o.discountAmount || 0);
    const promo = Number(o.promoDiscount || 0);
    const face = o.costAmount == null ? Number(o.amount) : Number(o.costAmount);
    const earned = guard.earningsBeforeRewards({ service: o.service, provider: o.provider, face, markedUp: Number(o.amount) + discount + promo, commission: commissionOf(o).amount }, settings);
    total += earned - Math.max(discount + promo, earned * pct);
  }
  return r2(Math.max(0, total));
}

async function qualified(customerId, min) {
  const [o, t] = await Promise.all([
    prisma.order.findFirst({ where: { customerId, status: 'SUCCESS', amount: { gte: min } }, select: { id: true } }),
    prisma.bankTransfer.findFirst({ where: { customerId, status: 'SUCCESS', amount: { gte: min } }, select: { id: true } }),
  ]);
  return Boolean(o || t);
}

async function maybePayReferralBonus(customerId, purchaseAmount) {
  try {
    const settings = await getSettings();
    if (!settings.referralEnabled) return;
    const bonus = Number(settings.referralBonusAmount);
    if (!(bonus > 0)) return;
    const min = Number(settings.referralMinPurchase);

    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, name: true, referredById: true, referralBonusPaidAt: true },
    });
    if (!customer?.referredById || customer.referralBonusPaidAt) return;
    const referrer = await prisma.customer.findUnique({ where: { id: customer.referredById }, select: { id: true, active: true } });
    if (!referrer?.active) return;
    // A later small purchase still counts once a qualifying one happened.
    if (Number(purchaseAmount) < min && !(await qualified(customer.id, min))) return;
    const coveredByFriend = settings.rewardSplitEnabled ? (await earnedFrom(customer.id, settings)) >= bonus : false;

    const paid = await prisma.$transaction(async (tx) => {
      const claim = await tx.customer.updateMany({
        where: { id: customer.id, referralBonusPaidAt: null },
        data: { referralBonusPaidAt: new Date(), referralBonusAmount: bonus },
      });
      if (claim.count !== 1) return false;
      // Rewards split on: the referral pool pays first; if it's short, the
      // friend's own purchases must already cover the bonus, else it waits.
      if (settings.rewardSplitEnabled) {
        const ok = await require('./rewardSplit').takeFromPool(tx, 'REFERRAL', bonus, `Referral bonus for ${customer.name.split(' ')[0]}`);
        if (!ok && !coveredByFriend) throw Object.assign(new Error('POOL_SHORT'), { poolShort: true });
      }
      await tx.customer.update({ where: { id: referrer.id }, data: { walletBalance: { increment: bonus } } });
      await tx.walletTransaction.create({
        data: {
          customerId: referrer.id,
          type: 'REFERRAL_BONUS',
          amount: bonus,
          status: 'APPROVED',
          note: `Referral bonus — ${customer.name.split(' ')[0]} joined with your code`,
        },
      });
      return true;
    });

    if (paid) {
      notify(referrer.id, 'Referral Bonus', `You earned ₦${bonus.toLocaleString()}! ${customer.name.split(' ')[0]}, who joined with your code, made their first purchase.`);
    }
  } catch (error) {
    if (error.poolShort) return; // waits for the pool (lib/rewardSplit.js)
    console.error('maybePayReferralBonus failed:', error);
  }
}

// Catch-up: pays any bonus that was missed (e.g. the friend's first
// qualifying action was a bank transfer before transfers counted).
// Called when the referrer opens Refer & Earn; at most every 30s.
const lastCatchUp = new Map();
async function catchUpReferralBonuses(referrerId) {
  const now = Date.now();
  if (now - (lastCatchUp.get(referrerId) || 0) < 30 * 1000) return;
  lastCatchUp.set(referrerId, now);
  if (lastCatchUp.size > 5000) lastCatchUp.clear();
  try {
    const settings = await getSettings();
    if (!settings.referralEnabled || !(Number(settings.referralBonusAmount) > 0)) return;
    const min = Number(settings.referralMinPurchase || 0);
    const waiting = await prisma.customer.findMany({ where: { referredById: referrerId, referralBonusPaidAt: null, deletedAt: null }, select: { id: true }, take: 200 });
    if (!waiting.length) return;
    const ids = waiting.map((w) => w.id);
    const [orders, transfers] = await Promise.all([
      prisma.order.groupBy({ by: ['customerId'], where: { customerId: { in: ids }, status: 'SUCCESS', amount: { gte: min } }, _max: { amount: true } }),
      prisma.bankTransfer.groupBy({ by: ['customerId'], where: { customerId: { in: ids }, status: 'SUCCESS', amount: { gte: min } }, _max: { amount: true } }),
    ]);
    const done = new Map();
    for (const g of [...orders, ...transfers]) done.set(g.customerId, Math.max(done.get(g.customerId) || 0, Number(g._max.amount || 0)));
    for (const [id, amt] of done) await maybePayReferralBonus(id, amt);
  } catch (error) {
    console.error('catchUpReferralBonuses failed:', error.message);
  }
}

module.exports = { maybePayReferralBonus, catchUpReferralBonuses, earnedFrom };
