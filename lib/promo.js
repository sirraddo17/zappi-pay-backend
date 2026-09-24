const prisma = require('./prisma');

// Promo codes: checked when a purchase is priced, recorded only after
// the purchase succeeds (a failed purchase never uses up a code).

function normalize(code) {
  return String(code || '').trim().toUpperCase();
}

function discountFor(promo, amount) {
  const value = Number(promo.value);
  let d = promo.type === 'PERCENT' ? Math.round((amount * value) / 100) : value;
  if (promo.maxDiscount != null) d = Math.min(d, Number(promo.maxDiscount));
  return Math.max(0, Math.min(d, amount));
}

// Returns { promo, discount } or throws Error(message).
async function evaluatePromo(customerId, code, service, amount) {
  const clean = normalize(code);
  if (!clean) throw new Error('Enter a promo code.');
  const promo = await prisma.promoCode.findUnique({ where: { code: clean } });
  if (!promo || !promo.active) throw new Error('That promo code is not valid.');
  if (promo.expiresAt && promo.expiresAt < new Date()) throw new Error('That promo code has expired.');
  if (promo.usageLimit != null && promo.usedCount >= promo.usageLimit) throw new Error('That promo code has been fully used.');
  if (promo.services.length && !promo.services.includes(service)) throw new Error('That promo code does not apply to this service.');
  if (Number(amount) < Number(promo.minAmount)) throw new Error(`That promo code needs a purchase of at least ₦${Number(promo.minAmount).toLocaleString()}.`);
  const used = await prisma.promoRedemption.count({ where: { promoId: promo.id, customerId } });
  if (used >= promo.perCustomerLimit) throw new Error('You have already used this promo code.');
  if (promo.newCustomersOnly) {
    const orders = await prisma.order.count({ where: { customerId, status: 'SUCCESS' } });
    if (orders > 0) throw new Error('That promo code is for first purchases only.');
  }
  return { promo, discount: discountFor(promo, Number(amount)) };
}

async function recordRedemption(promo, customerId, orderId, discount) {
  try {
    await prisma.$transaction([
      prisma.promoRedemption.create({ data: { promoId: promo.id, customerId, orderId, discount } }),
      prisma.promoCode.update({ where: { id: promo.id }, data: { usedCount: { increment: 1 } } }),
    ]);
  } catch (error) {
    console.error('recordRedemption failed:', error.message);
  }
}

module.exports = { normalize, evaluatePromo, recordRedemption, discountFor };
