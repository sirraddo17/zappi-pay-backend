const prisma = require('./prisma');
const { getSettings } = require('./vtpass');
const { notify } = require('./notify');

// Pays the referrer's one-time bonus the first time the customer they
// invited completes a successful purchase or bank transfer of at least
// the admin-set minimum. Safe to call after every successful purchase: the
// conditional update below means the bonus can only ever be paid once,
// even if two purchases finish at the same moment.
async function maybePayReferralBonus(customerId, purchaseAmount) {
  try {
    const settings = await getSettings();
    if (!settings.referralEnabled) return;
    const bonus = Number(settings.referralBonusAmount);
    if (!(bonus > 0) || Number(purchaseAmount) < Number(settings.referralMinPurchase)) return;

    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, name: true, referredById: true, referralBonusPaidAt: true },
    });
    if (!customer?.referredById || customer.referralBonusPaidAt) return;
    const referrer = await prisma.customer.findUnique({ where: { id: customer.referredById }, select: { id: true, active: true } });
    if (!referrer?.active) return;

    const paid = await prisma.$transaction(async (tx) => {
      const claim = await tx.customer.updateMany({
        where: { id: customer.id, referralBonusPaidAt: null },
        data: { referralBonusPaidAt: new Date(), referralBonusAmount: bonus },
      });
      if (claim.count !== 1) return false;
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

module.exports = { maybePayReferralBonus, catchUpReferralBonuses };
