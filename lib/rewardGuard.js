// Safety limit on giveaways: on any one purchase, discounts + promo
// codes + cashback + loyalty points together may use at most
// rewardGuardPercent % of what the owner earns on it (markup + VTpass
// commission). Admin-set discounts are shown to customers as prices, so
// they are counted but never trimmed here; the promo code, then
// cashback, then loyalty points are trimmed to fit what's left.

const { estimateCommission, commissionOf } = require('./earnings');

// While the rewards split is on (lib/rewardSplit.js), its % is the
// limit, so promo codes and the split share the same budget.
function percent(settings) {
  const p = settings.rewardSplitEnabled ? Number(settings.rewardSplitPct ?? 30) : Number(settings.rewardGuardPercent ?? 50);
  return Math.min(100, Math.max(0, p));
}

function enabled(settings) {
  if (settings.rewardSplitEnabled) return true;
  return settings.rewardGuardEnabled !== false && Number(settings.rewardGuardPercent ?? 50) >= 0;
}

// Earnings on a purchase before any giveaway.
function earningsBeforeRewards({ service, provider, face, markedUp, commission }) {
  const c = commission ?? estimateCommission(service, provider, face);
  return Math.max(0, Number(markedUp) - Number(face)) + Number(c || 0);
}

// ₦ still allowed to give away, after `alreadyGiven`. null = no limit.
function room({ service, provider, face, markedUp, commission, alreadyGiven = 0 }, settings) {
  if (!enabled(settings)) return null;
  const pct = percent(settings);
  const allowed = (earningsBeforeRewards({ service, provider, face, markedUp, commission }) * pct) / 100;
  return Math.max(0, Math.floor((allowed - Number(alreadyGiven || 0)) * 100) / 100);
}

// Room left on a finished order (uses VTpass's exact commission).
function roomForOrder(order, settings, extraGiven = 0) {
  const discount = Number(order.discountAmount || 0);
  const promo = Number(order.promoDiscount || 0);
  const face = order.costAmount == null ? Number(order.amount) : Number(order.costAmount);
  return room({
    service: order.service,
    provider: order.provider,
    face,
    markedUp: Number(order.amount) + discount + promo,
    commission: commissionOf(order).amount,
    alreadyGiven: discount + promo + extraGiven,
  }, settings);
}

module.exports = { enabled, percent, room, roomForOrder, earningsBeforeRewards };
