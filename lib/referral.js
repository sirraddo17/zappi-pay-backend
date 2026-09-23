const prisma = require('./prisma');
const { getSettings } = require('./vtpass');
const { notify } = require('./notify');

// Pays the referrer's one-time bonus the first time the customer they
// invited completes a successful purchase of at least the admin-set
// minimum. Safe to call after every successful purchase: the
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
      notify(referrer.id, 'Referral Bonus', `You earned ₦${bonus.toLocaleString()}! ${customer.name.split(' ')[0]} made their first purchase with your referral code.`);
    }
  } catch (error) {
    console.error('maybePayReferralBonus failed:', error);
  }
}

module.exports = { maybePayReferralBonus };
