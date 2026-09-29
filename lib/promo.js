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
  if (promo.type === 'CREDIT') throw new Error('That is a wallet coupon — redeem it on the Wallet page.');
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
  if (promo.audience && promo.audience !== 'ALL' && !(await require('./audience').isMember(customerId, promo.audience))) {
    throw new Error('That promo code isn’t available on your account.');
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

// Wallet gift coupon (type CREDIT): adds promo.value ₦ to the wallet.
// Exactly-once: the usage claim is conditional, and each customer's
// n-th use gets a unique redemption key, so two taps at the same moment
// can't both succeed.
async function redeemCredit(customerId, code) {
  const clean = normalize(code);
  if (!clean) throw new Error('Enter a coupon code.');
  const promo = await prisma.promoCode.findUnique({ where: { code: clean } });
  if (!promo || !promo.active) throw new Error('That coupon code is not valid.');
  if (promo.type !== 'CREDIT') throw new Error('That is a discount code — enter it when you buy airtime, data or bills.');
  if (promo.expiresAt && promo.expiresAt < new Date()) throw new Error('That coupon has expired.');
  if (promo.usageLimit != null && promo.usedCount >= promo.usageLimit) throw new Error('That coupon has been fully used.');
  const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { active: true, createdAt: true } });
  if (!customer?.active) throw new Error('Your account cannot redeem coupons right now.');
  if (promo.newCustomersOnly) {
    const orders = await prisma.order.count({ where: { customerId, status: 'SUCCESS' } });
    if (orders > 0) throw new Error('That coupon is for new customers only.');
  }
  if (promo.audience && promo.audience !== 'ALL' && !(await require('./audience').isMember(customerId, promo.audience))) {
    throw new Error('That coupon isn’t available on your account.');
  }
  const used = await prisma.promoRedemption.count({ where: { promoId: promo.id, customerId } });
  if (used >= promo.perCustomerLimit) throw new Error('You have already used this coupon.');
  const amount = Number(promo.value);

  try {
    await prisma.$transaction(async (tx) => {
      const claim = await tx.promoCode.updateMany({
        where: { id: promo.id, active: true, ...(promo.usageLimit != null ? { usedCount: { lt: promo.usageLimit } } : {}) },
        data: { usedCount: { increment: 1 } },
      });
      if (claim.count !== 1) throw new Error('That coupon has been fully used.');
      await tx.promoRedemption.create({ data: { promoId: promo.id, customerId, orderId: `COUPON:${promo.id}:${customerId}:${used + 1}`, discount: amount } });
      await tx.customer.update({ where: { id: customerId }, data: { walletBalance: { increment: amount } } });
      await tx.walletTransaction.create({ data: { customerId, type: 'COUPON', amount, status: 'APPROVED', note: `Coupon ${promo.code}${promo.description ? ` — ${promo.description}` : ''}` } });
    });
  } catch (error) {
    if (error.code === 'P2002') throw new Error('You have already used this coupon.');
    throw error;
  }
  return { amount, code: promo.code };
}

module.exports = { normalize, evaluatePromo, recordRedemption, discountFor, redeemCredit };
