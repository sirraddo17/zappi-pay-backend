// Safety limit on giveaways: on any one purchase, discounts + promo
// codes + cashback + loyalty points together may use at most
// rewardGuardPercent % of what the owner really earns on it: markup +
// VTpass commission − the Monnify fee paid when that money came into the
// wallet (less any bank-funding fee the customer paid for it). So a sale
// that earns nothing after Monnify's cut (e.g. TV or light with no
// markup) gives nothing away. Admin-set discounts are shown to customers as prices, so
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

// Monnify's cut on the wallet money this purchase spends, after any
// bank-funding fee the customer already paid for it. Never below 0.
function fundingCost(amount, settings = {}) {
  const { collectionCost, bankFundingFee } = require('./earnings');
  const a = Math.max(0, Number(amount) || 0);
  return Math.max(0, collectionCost(a) - bankFundingFee(a, settings));
}

// Earnings on a purchase before any giveaway (never below 0).
function earningsBeforeRewards({ service, provider, face, markedUp, commission }, settings) {
  const c = commission ?? estimateCommission(service, provider, face);
  const gross = Math.max(0, Number(markedUp) - Number(face)) + Number(c || 0);
  return Math.max(0, gross - (settings ? fundingCost(markedUp, settings) : 0));
}

// ₦ still allowed to give away, after `alreadyGiven`. null = no limit.
function room({ service, provider, face, markedUp, commission, alreadyGiven = 0 }, settings) {
  if (!enabled(settings)) return null;
  const pct = percent(settings);
  const allowed = (earningsBeforeRewards({ service, provider, face, markedUp, commission }, settings) * pct) / 100;
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

module.exports = { enabled, percent, room, roomForOrder, earningsBeforeRewards, fundingCost };
