// Single source of truth for what a customer's wallet is charged for
// a purchase. VTpass's own price (baseAmount) gets the admin-set
// markup for that service added on top, then any admin-set discount
// for that service taken off the marked-up price. Rounded to whole
// naira at each step, matching how the purchase route always charged.
//
// Mirrored (display only) in the frontend's Buy page — if this
// formula ever changes, change priceFor() in Buy.jsx too so the
// total a customer sees before paying still matches what's charged.
function computePrice(baseAmount, service, settings) {
  const markupPercent = Number(settings.markupPercentByService?.[service] || 0);
  const discountPercent = Math.min(100, Math.max(0, Number(settings.discountPercentByService?.[service] || 0)));
  const markedUp = Math.round(Number(baseAmount) * (1 + markupPercent / 100));
  const discountAmount = Math.round(markedUp * (discountPercent / 100));
  const chargeAmount = Math.max(0, markedUp - discountAmount);
  return { chargeAmount, discountAmount, markedUp, markupPercent, discountPercent };
}

module.exports = { computePrice };
