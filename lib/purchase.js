const crypto = require('crypto');
const prisma = require('./prisma');
const { vtpassRequest, getSettings } = require('./vtpass');
const { notify } = require('./notify');
const { computePrice, settingsForCustomer } = require('./pricing');
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

// Loyalty points on a successful purchase.
async function awardPoints(order, amount, settings) {
  if (!settings.loyaltyEnabled) return 0;
  const points = Math.floor((amount / 100) * Number(settings.loyaltyPointsPer100 || 0));
  if (points < 1) return 0;
  try {
    await prisma.$transaction([
      prisma.customer.update({ where: { id: order.customerId }, data: { loyaltyPoints: { increment: points } } }),
      prisma.order.update({ where: { id: order.id }, data: { pointsEarned: points } }),
    ]);
    return points;
  } catch (error) {
    console.error('awardPoints failed:', error.message);
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

  const rawSettings = await getSettings();
  const buyer = await prisma.customer.findUnique({ where: { id: customerId }, select: { isAgent: true } });
  const settings = settingsForCustomer(rawSettings, buyer);
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

  let vtpassResponse = null;
  try {
    vtpassResponse = await vtpassRequest('POST', '/pay', {
      body: {
        request_id: order.vtpassRequestId,
        serviceID,
        billersCode,
        variation_code: variationCode || cleanMeterType || undefined,
        amount: baseAmount,
        phone,
      },
    });
  } catch (error) {
    // A response body with an error code usually means VTpass rejected
    // it outright; no body (timeout / network) means we don't know.
    console.error('performPurchase (VTpass call) failed:', error.message, JSON.stringify(error.vtpassResponse || {}));
    vtpassResponse = error.vtpassResponse || null;
  }

  const outcome = vtpassResponse ? classifyPay(vtpassResponse) : 'PENDING';
  const settled = await settleOrder(order, outcome, vtpassResponse, { source, promoDiscount, discountAmount, settings });

  if (settled.status === 'SUCCESS') return { status: 201, body: { order: settled.order } };
  if (settled.status === 'FAILED') {
    return { status: 502, body: { error: 'Purchase was not successful. You have been refunded.', order: settled.order } };
  }
  // Unclear — don't refund yet (it may still be delivered). Re-checked
  // with VTpass shortly; the customer is notified either way.
  scheduleChecks(order.id);
  return { status: 202, body: { pending: true, order: settled.order, message: 'Your purchase is processing. You will be notified as soon as it is confirmed.' } };
}

// --- Settling orders (shared by purchase, requery, webhook, admin) ---

// Pay response → SUCCESS / FAILED / PENDING, following VTpass's rules:
// only "delivered" is success; only explicit failure codes are failure;
// anything unclear is pending and must be re-queried.
const NOT_PROCESSED_CODES = new Set(['010', '011', '012', '013', '015', '016', '017', '018', '019', '021', '022', '023', '024', '025', '026', '027', '028', '030', '031', '032', '034', '035', '040', '085', '087', '091']);

function txStatus(resp) {
  return String(resp?.content?.transactions?.status || '').toLowerCase();
}

function classifyPay(resp) {
  const code = String(resp?.code ?? '');
  const st = txStatus(resp);
  if (st === 'delivered' || st === 'successful') return 'SUCCESS';
  if (st === 'failed' || st === 'reversed') return 'FAILED';
  if (NOT_PROCESSED_CODES.has(code)) return 'FAILED';
  return 'PENDING';
}

// Requery response: if VTpass isn't processing/has not processed it
// (any code other than 000/099/001), it never went through.
function classifyRequery(resp) {
  const code = String(resp?.code ?? '');
  const st = txStatus(resp);
  if (st === 'delivered' || st === 'successful') return 'SUCCESS';
  if (st === 'failed' || st === 'reversed') return 'FAILED';
  if (['000', '099', '001'].includes(code)) return 'PENDING';
  return code ? 'FAILED' : 'PENDING';
}

// Moves a PENDING order to its final state exactly once (conditional
// update), then does the side effects: refund on failure; notification,
// promo, referral bonus and cashback on success.
async function settleOrder(order, outcome, vtpassResponse, ctx = {}) {
  const payload = vtpassResponse || undefined;
  if (outcome === 'PENDING') {
    if (payload) await prisma.order.update({ where: { id: order.id }, data: { vtpassStatus: txStatus(payload) || String(payload.code || ''), responsePayload: payload } }).catch(() => {});
    return { status: 'PENDING', order: await prisma.order.findUnique({ where: { id: order.id } }) };
  }

  const amount = Number(order.amount);
  if (outcome === 'FAILED') {
    let claimed = false;
    await prisma.$transaction(async (tx) => {
      const r = await tx.order.updateMany({
        where: { id: order.id, status: 'PENDING' },
        data: { status: 'FAILED', vtpassStatus: payload ? txStatus(payload) || String(payload.code || '') : 'no-response', ...(payload ? { responsePayload: payload } : {}) },
      });
      if (r.count !== 1) return;
      claimed = true;
      await tx.customer.update({ where: { id: order.customerId }, data: { walletBalance: { increment: amount } } });
      await tx.walletTransaction.create({
        data: { customerId: order.customerId, type: 'REFUND', amount, status: 'APPROVED', reference: order.vtpassRequestId, note: `Refund for failed ${order.service} purchase` },
      });
    });
    if (claimed) {
      console.error('Order failed:', order.vtpassRequestId, JSON.stringify(payload || {}));
      notify(order.customerId, 'Purchase Failed', `Your ${order.service} purchase for ${order.recipient} failed and ₦${amount.toLocaleString()} was refunded to your wallet.`);
    }
    return { status: 'FAILED', order: await prisma.order.findUnique({ where: { id: order.id } }) };
  }

  // SUCCESS
  const r = await prisma.order.updateMany({
    where: { id: order.id, status: 'PENDING' },
    data: { status: 'SUCCESS', vtpassStatus: txStatus(payload) || 'delivered', ...(payload ? { responsePayload: payload } : {}) },
  });
  const updated = await prisma.order.findUnique({ where: { id: order.id } });
  if (r.count !== 1) return { status: updated.status, order: updated };

  const settings = ctx.settings || settingsForCustomer(await getSettings(), await prisma.customer.findUnique({ where: { id: order.customerId }, select: { isAgent: true } }));
  const promoDiscount = ctx.promoDiscount ?? Number(order.promoDiscount || 0);
  if (order.promoCode && promoDiscount > 0) {
    const promo = await prisma.promoCode.findUnique({ where: { code: order.promoCode } }).catch(() => null);
    if (promo) promoLib.recordRedemption(promo, order.customerId, order.id, promoDiscount);
  }
  const totalSaved = Number(ctx.discountAmount ?? order.discountAmount ?? 0) + promoDiscount;
  const savedText = totalSaved > 0 ? ` You saved ₦${totalSaved.toLocaleString()}.` : '';
  const scheduledText = ctx.source === 'schedule' ? ' (scheduled top-up)' : '';
  notify(order.customerId, 'Purchase Successful', `Your ${order.service} purchase of ₦${amount.toLocaleString()}${scheduledText} was successful.${savedText}`);
  maybePayReferralBonus(order.customerId, amount);
  const cashback = await payCashback(order.customerId, updated, order.service, amount, settings);
  const points = await awardPoints(order, amount, settings);
  return { status: 'SUCCESS', order: { ...updated, ...(cashback ? { cashbackAmount: cashback } : {}), ...(points ? { pointsEarned: points } : {}) } };
}

// Asks VTpass for the real status of a pending order and settles it.
async function recheckOrder(orderOrId) {
  const order = typeof orderOrId === 'string' ? await prisma.order.findUnique({ where: { id: orderOrId } }) : orderOrId;
  if (!order || order.status !== 'PENDING' || !order.vtpassRequestId) return { status: order?.status || 'MISSING' };
  let resp;
  try {
    resp = await vtpassRequest('POST', '/requery', { body: { request_id: order.vtpassRequestId } });
  } catch (error) {
    if (!error.vtpassResponse) return { status: 'PENDING', error: error.message };
    resp = error.vtpassResponse;
  }
  const settled = await settleOrder(order, classifyRequery(resp), resp);
  return { status: settled.status };
}

// Re-check a new pending order after 20s, 2 min and 10 min, plus a
// background sweep while any pending orders exist.
const CHECK_DELAYS = [20 * 1000, 2 * 60 * 1000, 10 * 60 * 1000];
function scheduleChecks(orderId) {
  CHECK_DELAYS.forEach((ms) => setTimeout(() => recheckOrder(orderId).catch((e) => console.error('recheckOrder failed:', e.message)), ms));
  armSweep(15 * 60 * 1000);
}

let sweepTimer = null;
function armSweep(ms) {
  if (sweepTimer) return;
  sweepTimer = setTimeout(sweepPendingOrders, ms);
}

async function sweepPendingOrders() {
  sweepTimer = null;
  try {
    const pending = await prisma.order.findMany({
      where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - 60 * 1000), gt: new Date(Date.now() - 7 * 24 * 3600 * 1000) } },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    for (const o of pending) await recheckOrder(o).catch((e) => console.error('sweep recheck failed:', e.message));
    const left = await prisma.order.count({ where: { status: 'PENDING' } });
    if (left > 0) armSweep(15 * 60 * 1000);
  } catch (error) {
    console.error('sweepPendingOrders failed:', error.message);
    armSweep(15 * 60 * 1000);
  }
}

function startOrderSweeper() {
  if (process.env.DISABLE_SCHEDULER === '1') return;
  armSweep(45 * 1000);
}

// Admin override for an order VTpass can't resolve (after checking
// with VTpass support). FAILED refunds the customer.
async function forceSettle(orderId, outcome) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.status !== 'PENDING') return { status: order?.status || 'MISSING' };
  const settled = await settleOrder(order, outcome, null);
  return { status: settled.status };
}

module.exports = { performPurchase, recheckOrder, sweepPendingOrders, startOrderSweeper, forceSettle, classifyPay, classifyRequery };
