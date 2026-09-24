const crypto = require('crypto');
const prisma = require('./prisma');
const { vtpassRequest, getSettings } = require('./vtpass');
const { notify } = require('./notify');
const { computePrice } = require('./pricing');
const { maybePayReferralBonus } = require('./referral');
const { checkDailyLimit } = require('./limits');
const promoLib = require('./promo');

function generateRequestId() {
  // VTpass wants something unique and roughly time-ordered; this is
  // their own documented convention (date/time prefix + random suffix).
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 12);
  return `${stamp}${crypto.randomBytes(4).toString('hex')}`;
}

async function refund(customerId, service, chargeAmount) {
  await prisma.$transaction([
    prisma.customer.update({ where: { id: customerId }, data: { walletBalance: { increment: chargeAmount } } }),
    prisma.walletTransaction.create({
      data: {
        customerId,
        type: 'REFUND',
        amount: chargeAmount,
        status: 'APPROVED',
        note: `Refund for failed ${service} purchase`,
      },
    }),
  ]);
}

// Cashback: a % of the price back into the wallet after a successful
// purchase (admin-set per service, capped per order).
async function payCashback(customerId, order, service, chargeAmount, settings) {
  if (!settings.cashbackEnabled) return 0;
  const pct = Number(settings.cashbackPercentByService?.[service] || 0);
  if (!(pct > 0)) return 0;
  let amount = Math.floor((chargeAmount * pct) / 100 * 100) / 100;
  const cap = Number(settings.cashbackMaxPerOrder || 0);
  if (cap > 0) amount = Math.min(amount, cap);
  if (!(amount >= 1)) return 0;
  try {
    await prisma.$transaction([
      prisma.customer.update({ where: { id: customerId }, data: { walletBalance: { increment: amount } } }),
      prisma.walletTransaction.create({
        data: { customerId, type: 'CASHBACK', amount, status: 'APPROVED', reference: order.vtpassRequestId, note: `${pct}% cashback on ${service.toLowerCase()}` },
      }),
      prisma.order.update({ where: { id: order.id }, data: { cashbackAmount: amount } }),
    ]);
    notify(customerId, 'Cashback Received', `You got ₦${amount.toLocaleString()} cashback on your ${service.toLowerCase()} purchase.`);
    return amount;
  } catch (error) {
    console.error('payCashback failed:', error.message);
    return 0;
  }
}

// The whole purchase flow, shared by the Buy screen and scheduled
// top-ups. Reserve-then-commit: the wallet is debited and the Order
// row created in one DB transaction *before* calling VTpass, so a crash
// mid-request can never leave money unaccounted for. If VTpass fails or
// declines, the debit is reversed with a REFUND transaction.
//
// Returns { status, body } — an HTTP status and JSON body the route can
// send as-is, and that the scheduler reads to decide what happened.
// PIN / biometric confirmation is the caller's job (the scheduler's
// "confirmation" is the PIN entered when the schedule was created).
async function performPurchase(customerId, input, { source = 'app' } = {}) {
  const { service, serviceID, variationCode, billersCode, phone, amount, meterType, promoCode } = input;

  if (!service || !serviceID || !billersCode || !phone) {
    return { status: 400, body: { error: 'service, serviceID, billersCode, and phone are required.' } };
  }

  const settings = await getSettings();
  if (!variationCode) {
    const minPurchase = Number(settings.minPurchaseAmount);
    if (!amount || Number(amount) < minPurchase) {
      return { status: 400, body: { error: `Minimum purchase amount is ₦${minPurchase}.` } };
    }
  }

  // Data/cable/education plans have a fixed VTpass price tied to their
  // variation code — looked up here rather than trusted from the client.
  let baseAmount;
  if (variationCode) {
    try {
      const variationsData = await vtpassRequest('GET', '/service-variations', { query: { serviceID } });
      const variations = variationsData?.content?.varations || variationsData?.content?.variations || [];
      const match = variations.find((v) => v.variation_code === variationCode);
      if (!match) return { status: 400, body: { error: 'That plan is no longer available for this service.' } };
      baseAmount = Number(match.variation_amount);
    } catch (error) {
      console.error('performPurchase (variation lookup) failed:', error);
      return { status: 502, body: { error: 'Could not verify plan pricing with VTpass.' } };
    }
  } else {
    baseAmount = Number(amount);
  }
  if (!baseAmount || baseAmount <= 0) {
    return { status: 400, body: { error: 'A positive amount is required.' } };
  }

  // Markup is our margin on top of VTpass's price, then any admin-set
  // discount comes off (lib/pricing.js). VTpass is still sent baseAmount.
  const priced = computePrice(baseAmount, service, settings);
  const { discountAmount } = priced;
  let { chargeAmount } = priced;

  // Promo code (only from the Buy screen, never on scheduled runs).
  let promo = null;
  let promoDiscount = 0;
  if (promoCode && source !== 'schedule') {
    try {
      const r = await promoLib.evaluatePromo(customerId, promoCode, service, chargeAmount);
      promo = r.promo;
      promoDiscount = r.discount;
      chargeAmount = Math.max(0, chargeAmount - promoDiscount);
    } catch (error) {
      return { status: 400, body: { error: error.message, code: 'PROMO_INVALID' } };
    }
  }

  // Electricity needs prepaid/postpaid sent to VTpass as variation_code.
  const cleanMeterType = service === 'ELECTRICITY' ? (meterType === 'postpaid' ? 'postpaid' : 'prepaid') : undefined;

  let order;
  try {
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) return { status: 404, body: { error: 'Account not found.' } };
    if (!customer.active) return { status: 403, body: { error: 'This account has been deactivated.' } };
    const limitError = await checkDailyLimit(customer, chargeAmount, settings);
    if (limitError) return { status: 403, body: { error: limitError, code: 'DAILY_LIMIT' } };
    if (Number(customer.walletBalance) < chargeAmount) {
      return { status: 402, body: { error: 'Insufficient wallet balance.', code: 'INSUFFICIENT_BALANCE', needed: chargeAmount } };
    }

    const result = await prisma.$transaction([
      prisma.customer.update({ where: { id: customer.id }, data: { walletBalance: { decrement: chargeAmount } } }),
      prisma.walletTransaction.create({
        data: {
          customerId: customer.id,
          type: 'DEBIT',
          amount: chargeAmount,
          status: 'APPROVED',
          note: source === 'schedule' ? `${service} purchase (scheduled)` : `${service} purchase`,
        },
      }),
      prisma.order.create({
        data: {
          customerId: customer.id,
          service,
          provider: serviceID,
          variationCode: variationCode || undefined,
          meterType: cleanMeterType,
          recipient: billersCode,
          amount: chargeAmount,
          costAmount: baseAmount,
          discountAmount: discountAmount > 0 ? discountAmount : undefined,
          promoCode: promo ? promo.code : undefined,
          promoDiscount: promoDiscount > 0 ? promoDiscount : undefined,
          vtpassRequestId: generateRequestId(),
          status: 'PENDING',
        },
      }),
    ]);
    order = result[2];
  } catch (error) {
    console.error('performPurchase (reserve) failed:', error);
    return { status: 500, body: { error: 'Could not reserve funds for this purchase.' } };
  }

  try {
    const vtpassResponse = await vtpassRequest('POST', '/pay', {
      body: {
        request_id: order.vtpassRequestId,
        serviceID,
        billersCode,
        variation_code: variationCode || cleanMeterType || undefined,
        amount: baseAmount,
        phone,
      },
    });

    const status = vtpassResponse?.content?.transactions?.status || (vtpassResponse.code === '000' ? 'delivered' : 'failed');
    const succeeded = status === 'delivered' || vtpassResponse.code === '000';

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: { status: succeeded ? 'SUCCESS' : 'FAILED', vtpassStatus: status, responsePayload: vtpassResponse },
    });

    if (!succeeded) {
      console.error('performPurchase (not delivered):', status, JSON.stringify(vtpassResponse, null, 2));
      await refund(customerId, service, chargeAmount);
      notify(customerId, 'Purchase Failed', `Your ${service} purchase failed and ₦${Number(chargeAmount).toLocaleString()} was refunded to your wallet.`);
      return { status: 502, body: { error: 'Purchase was not successful. You have been refunded.', order: updated } };
    }

    if (promo) promoLib.recordRedemption(promo, customerId, order.id, promoDiscount);
    const totalSaved = Number(discountAmount || 0) + promoDiscount;
    const savedText = totalSaved > 0 ? ` You saved ₦${totalSaved.toLocaleString()}.` : '';
    const scheduledText = source === 'schedule' ? ' (scheduled top-up)' : '';
    notify(customerId, 'Purchase Successful', `Your ${service} purchase of ₦${Number(chargeAmount).toLocaleString()}${scheduledText} was successful.${savedText}`);
    maybePayReferralBonus(customerId, chargeAmount);
    const cashback = await payCashback(customerId, updated, service, chargeAmount, settings);

    return { status: 201, body: { order: cashback ? { ...updated, cashbackAmount: cashback } : updated } };
  } catch (error) {
    console.error('performPurchase (VTpass call) failed:', error);
    await prisma.order.update({ where: { id: order.id }, data: { status: 'FAILED' } });
    await refund(customerId, service, chargeAmount);
    notify(customerId, 'Purchase Failed', `Your ${service} purchase couldn't be completed and ₦${Number(chargeAmount).toLocaleString()} was refunded to your wallet.`);
    return { status: 502, body: { error: 'Could not reach VTpass. You have been refunded.' } };
  }
}

module.exports = { performPurchase };
