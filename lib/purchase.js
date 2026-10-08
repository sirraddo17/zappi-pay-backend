const crypto = require('crypto');
const { hasDeliverable, redact, customerView } = require('./orderSafety');
const prisma = require('./prisma');
const { vtpassRequest, getSettings } = require('./vtpass');
const { notify } = require('./notify');
const { computePrice, settingsForCustomer } = require('./pricing');
const { maybePayReferralBonus } = require('./referral');
const { checkDailyLimit } = require('./limits');
const promoLib = require('./promo');

// Exam services VTpass lets us buy in bulk (pay with "quantity").
const BULK_EXAM_SERVICES = ['waec'];
const MAX_EXAM_PINS = 50;

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
  const left = require('./rewardGuard').roomForOrder(order, settings);
  if (left !== null) amount = Math.min(amount, Math.floor(left * 100) / 100);
  if (!(amount >= 1)) return 0;
  try {
    const cb = require('./cashback');
    await prisma.$transaction(async (tx) => {
      await cb.creditEarned(tx, settings, { customerId, amount, order, note: `${pct}% cashback on ${service.toLowerCase()}` });
      await tx.order.update({ where: { id: order.id }, data: { cashbackAmount: amount } });
    });
    notify(customerId, 'Cashback Received', cb.separate(settings) ? `You got ₦${amount.toLocaleString()} cashback on your ${service.toLowerCase()} purchase. It’s saved in your cashback — switch on “Use cashback” on your next purchase to pay less.` : `You got ₦${amount.toLocaleString()} cashback on your ${service.toLowerCase()} purchase.`);
    return amount;
  } catch (error) {
    console.error('payCashback failed:', error.message);
    return 0;
  }
}

// Loyalty points on a successful purchase.
async function awardPoints(order, amount, settings) {
  if (!settings.loyaltyEnabled) return 0;
  let points = Math.floor((amount / 100) * Number(settings.loyaltyPointsPer100 || 0));
  const value = Number(settings.loyaltyPointValue || 0);
  const left = require('./rewardGuard').roomForOrder(order, settings, Number(order.cashbackAmount || 0));
  if (left !== null && value > 0) points = Math.min(points, Math.floor(left / value));
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
  const { service, serviceID, variationCode, phone, amount, meterType, promoCode, shopAgentId, useCashback } = input;
  let { billersCode } = input;

  if (!service || !serviceID || !billersCode || !phone) {
    return { status: 400, body: { error: 'service, serviceID, billersCode, and phone are required.' } };
  }

  const rawSettings = await getSettings();
  const paused = require('./maintenance').pauseMessage(rawSettings, service);
  if (paused) return { status: 503, body: { error: paused, code: 'PAUSED' } };
  const autoPaused = require('./partnerHealth').pauseFor(rawSettings, serviceID);
  if (autoPaused) return { status: 503, body: { error: autoPaused, code: 'PAUSED' } };
  // Bet funding may go through ClubKonnect (serviceID "ck:CODE").
  const ckBet = require('./ckBetting');
  const viaCk = ckBet.isCk(serviceID);
  if (viaCk && (service !== 'BETTING' || !(await ckBet.useCk(rawSettings)) || !/^[A-Z0-9_-]{2,30}$/.test(ckBet.codeOf(serviceID)))) {
    return { status: 400, body: { error: 'That betting company is not available right now.' } };
  }
  // International airtime and motor insurance need extra details.
  const X = require('./extraServices');
  const special = service === 'INTERNATIONAL' || service === 'INSURANCE' || serviceID === X.INTL || serviceID === X.INSURE;
  if (special && !((service === 'INTERNATIONAL' && serviceID === X.INTL) || (service === 'INSURANCE' && serviceID === X.INSURE))) {
    return { status: 400, body: { error: 'That service is not available.' } };
  }
  const buyer = await prisma.customer.findUnique({ where: { id: customerId }, select: { isAgent: true, email: true } });
  let payExtras = {};
  let intlBase = null;
  try {
    if (service === 'INTERNATIONAL') {
      if (!rawSettings.intlAirtimeEnabled) return { status: 503, body: { error: 'International airtime is coming soon.', code: 'PAUSED' } };
      if (!variationCode) return { status: 400, body: { error: 'Choose what to send.' } };
      const q = await X.intlQuote({ ...(input.intl || {}), variationCode });
      intlBase = q.baseAmount;
      payExtras = { ...q.payExtras, email: buyer?.email || `${customerId}@customers.zappipay.com.ng` };
    } else if (service === 'INSURANCE') {
      payExtras = X.insuranceExtras(input.insurance || {}, buyer);
      billersCode = payExtras.Plate_Number;
    }
  } catch (error) {
    if (error instanceof X.ExtraServiceError) return { status: error.status, body: { error: error.message } };
    console.error('performPurchase (extra service) failed:', error);
    return { status: 502, body: { error: 'Could not check this with VTpass. Please try again.' } };
  }
  const settings = settingsForCustomer(rawSettings, buyer);
  if (!variationCode) {
    const minPurchase = Number(settings.minPurchaseAmount);
    if (!amount || Number(amount) < minPurchase) {
      return { status: 400, body: { error: `Minimum purchase amount is ₦${minPurchase}.` } };
    }
  }

  // Data/cable/education plans have a fixed VTpass price tied to their
  // variation code — looked up here rather than trusted from the client.
  // Bulk exam PINs: WAEC result checkers can be bought many at once.
  let quantity = null;
  if (input.quantity !== undefined && input.quantity !== null && input.quantity !== '' && Number(input.quantity) !== 1) {
    const q = parseInt(input.quantity, 10);
    if (!(service === 'EDUCATION' && BULK_EXAM_SERVICES.includes(serviceID) && variationCode)) return { status: 400, body: { error: 'You can only buy several at once for exam result checker PINs.' } };
    if (!(q >= 1 && q <= MAX_EXAM_PINS)) return { status: 400, body: { error: `Choose between 1 and ${MAX_EXAM_PINS} PINs.` } };
    quantity = q > 1 ? q : null;
  }

  let baseAmount;
  if (intlBase) {
    baseAmount = intlBase;
  } else if (variationCode) {
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
  if (quantity) baseAmount = Math.round(baseAmount * quantity * 100) / 100;

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
      // Safety limit: the promo only gets what's left of the giveaway budget.
      const left = require('./rewardGuard').room({ service, provider: serviceID, face: baseAmount, markedUp: priced.markedUp, alreadyGiven: discountAmount }, settings);
      if (left !== null && promoDiscount > left) promoDiscount = Math.floor(left);
      if (!(promoDiscount > 0)) return { status: 400, body: { error: "That promo code can't be used on this purchase.", code: 'PROMO_INVALID' } };
      chargeAmount = Math.max(0, chargeAmount - promoDiscount);
    } catch (error) {
      return { status: 400, body: { error: error.message, code: 'PROMO_INVALID' } };
    }
  }

  // Electricity needs prepaid/postpaid sent to VTpass as variation_code.
  const cleanMeterType = service === 'ELECTRICITY' ? (meterType === 'postpaid' ? 'postpaid' : 'prepaid') : undefined;

  let order;
  let cashbackUsed = 0;
  try {
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) return { status: 404, body: { error: 'Account not found.' } };
    if (!customer.active) return { status: 403, body: { error: 'This account has been deactivated.' } };
    const circleLock = await require('./circles').owingLock(customer.id);
    if (circleLock) return { status: 403, body: { error: circleLock, code: 'CIRCLE_OWING' } };
    const limitError = await checkDailyLimit(customer, chargeAmount, settings);
    if (limitError) return { status: 403, body: { error: limitError, code: 'DAILY_LIMIT' } };
    // Family wallet controls (daily limit, allowed services).
    const familyError = await require('./family').checkPurchase(customer.id, service, chargeAmount);
    if (familyError) return { status: 403, body: { error: familyError, code: 'FAMILY_LIMIT' } };
    // Cashback switched on at checkout: part of the price comes from it.
    const cb = require('./cashback');
    cashbackUsed = useCashback && source === 'app' && cb.separate(rawSettings) ? cb.usable(customer.cashbackBalance, chargeAmount, rawSettings) : 0;
    const cashPart = Math.round((chargeAmount - cashbackUsed) * 100) / 100;
    if (Number(customer.walletBalance) < cashPart) {
      return { status: 402, body: { error: 'Insufficient wallet balance.', code: 'INSUFFICIENT_BALANCE', needed: cashPart } };
    }

    order = await prisma.$transaction(async (tx) => {
      if (cashbackUsed > 0) {
        const took = await tx.customer.updateMany({ where: { id: customer.id, cashbackBalance: { gte: cashbackUsed } }, data: { cashbackBalance: { decrement: cashbackUsed } } });
        if (took.count !== 1) throw Object.assign(new Error('cashback changed'), { code: 'CASHBACK_CHANGED' });
      }
      await tx.customer.update({ where: { id: customer.id }, data: { walletBalance: { decrement: cashPart } } });
      if (cashPart > 0) {
        await tx.walletTransaction.create({
          data: {
            customerId: customer.id,
            type: 'DEBIT',
            amount: cashPart,
            status: 'APPROVED',
            note: `${service} purchase${source === 'schedule' ? ' (scheduled)' : ''}${cashbackUsed > 0 ? ` (₦${cashbackUsed.toLocaleString()} paid with cashback)` : ''}`,
          },
        });
      }
      const created = await tx.order.create({
        data: {
          customerId: customer.id,
          service,
          provider: serviceID,
          variationCode: variationCode || undefined,
          meterType: cleanMeterType,
          quantity: quantity || undefined,
          recipient: billersCode,
          amount: chargeAmount,
          costAmount: baseAmount,
          discountAmount: discountAmount > 0 ? discountAmount : undefined,
          promoCode: promo ? promo.code : undefined,
          promoDiscount: promoDiscount > 0 ? promoDiscount : undefined,
          shopAgentId: shopAgentId && shopAgentId !== customer.id ? shopAgentId : undefined,
          vtpassRequestId: generateRequestId(),
          status: 'PENDING',
          cashbackUsed: cashbackUsed > 0 ? cashbackUsed : undefined,
        },
      });
      if (cashbackUsed > 0) await tx.cashbackEntry.create({ data: { customerId: customer.id, amount: -cashbackUsed, orderId: created.id, note: `Used on ${service.toLowerCase()} purchase` } });
      return created;
    });
  } catch (error) {
    if (error.code === 'CASHBACK_CHANGED') return { status: 409, body: { error: 'Your cashback balance just changed. Please try again.' } };
    console.error('performPurchase (reserve) failed:', error);
    return { status: 500, body: { error: 'Could not reserve funds for this purchase.' } };
  }

  let vtpassResponse = null;
  if (viaCk) {
    let reply = null;
    try {
      reply = await ckBet.fund({ serviceID, customerId: billersCode, amount: baseAmount, requestId: order.vtpassRequestId });
    } catch (error) {
      if (error.code !== 'NO_RESPONSE') console.error('ClubKonnect bet funding failed:', error.code, error.message);
    }
    const ckOutcome = reply ? ckBet.classify(reply) : 'PENDING';
    const settledCk = await settleOrder(order, ckOutcome, reply ? { supplier: 'CLUBKONNECT', ...reply } : null, { source, promoDiscount, discountAmount, settings });
    if (settledCk.status === 'SUCCESS') return { status: 201, body: { order: settledCk.order } };
    if (settledCk.status === 'FAILED') {
      if (/^(INVALID_CREDENTIALS|MISSING_|INSUFFICIENT_)/.test(String(reply?.status || ''))) {
        Promise.resolve(require('./adminAlert').alertAdmins('Bet funding failed at ClubKonnect', `${require('./clubkonnect').errorText(String(reply.status))} A customer was refunded.`, '/admin/settings')).catch(() => {});
      }
      const why = /^MINIMUM_/.test(String(reply?.status || '')) ? ` The minimum for this company is ₦${String(reply.status).replace(/\D/g, '')}.` : /INVALID_CUSTOMERID/.test(String(reply?.status || '')) ? ' That betting account ID was not found.' : '';
      return { status: 502, body: { error: `Bet funding was not successful.${why} You have been refunded.`, order: settledCk.order } };
    }
    scheduleChecks(order.id);
    return { status: 202, body: { pending: true, order: settledCk.order, message: 'Your bet funding is processing. You will be notified as soon as it is confirmed.' } };
  }
  try {
    vtpassResponse = await vtpassRequest('POST', '/pay', {
      body: {
        request_id: order.vtpassRequestId,
        serviceID,
        billersCode,
        variation_code: variationCode || cleanMeterType || undefined,
        amount: baseAmount,
        phone,
        ...(quantity ? { quantity } : {}),
        ...payExtras,
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
    return { status: 502, body: { error: 'Purchase was not successful. You have been refunded.', order: customerView(settled.order) } };
  }
  // Unclear — don't refund yet (it may still be delivered). Re-checked
  // with VTpass shortly; the customer is notified either way.
  scheduleChecks(order.id);
  return { status: 202, body: { pending: true, order: customerView(settled.order), message: 'Your purchase is processing. You will be notified as soon as it is confirmed.' } };
}

// --- Settling orders (shared by purchase, requery, webhook, admin) ---

// Pay response → SUCCESS / FAILED / PENDING, following VTpass's rules:
// only "delivered" is success; only explicit failure codes are failure;
// anything unclear is pending and must be re-queried.
const NOT_PROCESSED_CODES = new Set(['010', '011', '012', '013', '015', '016', '017', '018', '019', '021', '022', '023', '024', '025', '026', '027', '028', '030', '031', '032', '034', '035', '040', '085', '087', '091']);

const HELD = 'held-pins-given';

function txStatus(resp) {
  return String(resp?.content?.transactions?.status || '').toLowerCase();
}

function classifyPay(resp) {
  const code = String(resp?.code ?? '');
  const st = txStatus(resp);
  if (st === 'delivered' || st === 'successful') return 'SUCCESS';
  if (st === 'failed' || st === 'reversed') return 'FAILED';
  if (NOT_PROCESSED_CODES.has(code)) return 'FAILED';
  // PINs/token already in the reply = delivered (they can't be taken back).
  if (hasDeliverable(resp)) return 'SUCCESS';
  return 'PENDING';
}

// Requery response: if VTpass isn't processing/has not processed it
// (any code other than 000/099/001), it never went through.
function classifyRequery(resp) {
  const code = String(resp?.code ?? '');
  const st = txStatus(resp);
  if (st === 'delivered' || st === 'successful') return 'SUCCESS';
  if (st === 'failed' || st === 'reversed') return 'FAILED';
  if (hasDeliverable(resp)) return 'SUCCESS';
  if (['000', '099', '001'].includes(code)) return 'PENDING';
  return code ? 'FAILED' : 'PENDING';
}

// Moves a PENDING order to its final state exactly once (conditional
// update), then does the side effects: refund on failure; notification,
// promo, referral bonus and cashback on success.
async function settleOrder(order, outcome, vtpassResponse, ctx = {}) {
  let payload = vtpassResponse || undefined;
  // An earlier reply already carried the PINs/token: that's delivered.
  if (outcome === 'PENDING' && hasDeliverable(order.responsePayload)) outcome = 'SUCCESS';
  if (outcome === 'PENDING') {
    if (payload) await prisma.order.update({ where: { id: order.id }, data: { vtpassStatus: txStatus(payload) || String(payload.code || ''), responsePayload: payload } }).catch(() => {});
    return { status: 'PENDING', order: await prisma.order.findUnique({ where: { id: order.id } }) };
  }

  const amount = Number(order.amount);
  if (outcome === 'FAILED' && !ctx.force && (hasDeliverable(payload) || hasDeliverable(order.responsePayload))) {
    // VTpass gave PINs/token for this order at some point, so it is never
    // refunded automatically — an admin checks with VTpass first.
    const first = order.vtpassStatus !== HELD;
    if (first) {
      // Keep the reply that has the PINs (the failed one is kept beside it).
      const keep = hasDeliverable(order.responsePayload) ? { ...order.responsePayload, laterReply: payload ? redact(payload) : null } : payload;
      await prisma.order.updateMany({ where: { id: order.id, status: 'PENDING' }, data: { vtpassStatus: HELD, ...(keep ? { responsePayload: keep } : {}) } }).catch(() => {});
      Promise.resolve(require('./adminAlert').alertAdmins('Order held: PINs given but VTpass now says failed', `${order.service} ${order.provider} → ${order.recipient} · ₦${amount.toLocaleString()}. It was NOT refunded. Ask VTpass support whether the PINs/token work, then mark it Delivered or Failed + refund under Orders.`, '/admin/orders?status=PENDING')).catch(() => {});
    }
    return { status: 'PENDING', order: await prisma.order.findUnique({ where: { id: order.id } }) };
  }
  if (outcome === 'FAILED') {
    let claimed = false;
    const split = require('./cashback').refundSplit(order, amount);
    await prisma.$transaction(async (tx) => {
      const r = await tx.order.updateMany({
        where: { id: order.id, status: 'PENDING' },
        data: { status: 'FAILED', vtpassStatus: payload ? txStatus(payload) || String(payload.code || '') : 'no-response', ...(payload ? { responsePayload: payload } : {}) },
      });
      if (r.count !== 1) return;
      claimed = true;
      await tx.customer.update({ where: { id: order.customerId }, data: { walletBalance: { increment: split.wallet }, ...(split.cashback > 0 ? { cashbackBalance: { increment: split.cashback } } : {}) } });
      if (split.wallet > 0) {
        await tx.walletTransaction.create({
          data: { customerId: order.customerId, type: 'REFUND', amount: split.wallet, status: 'APPROVED', reference: order.vtpassRequestId, note: `Refund for failed ${order.service} purchase` },
        });
      }
      if (split.cashback > 0) await tx.cashbackEntry.create({ data: { customerId: order.customerId, amount: split.cashback, orderId: order.id, note: `Returned: failed ${String(order.service).toLowerCase()} purchase` } });
    });
    if (claimed) {
      console.error('Order failed:', order.vtpassRequestId, JSON.stringify(payload || {}));
      require('./errorAlerts').vtpassFailure(order);
      require('./partnerHealth').failure(order);
      setImmediate(() => require('./deliveryPromise').check(order, 'FAILED'));
      notify(order.customerId, 'Purchase Failed', `Your ${order.service} purchase for ${order.recipient} failed and ₦${split.wallet.toLocaleString()} was refunded to your wallet${split.cashback > 0 ? ` (and ₦${split.cashback.toLocaleString()} back to your cashback)` : ''}.`);
    }
    return { status: 'FAILED', order: await prisma.order.findUnique({ where: { id: order.id } }) };
  }

  // SUCCESS. If an earlier reply had the PINs and this one doesn't, keep them.
  if (!hasDeliverable(payload) && hasDeliverable(order.responsePayload)) payload = order.responsePayload;
  const r = await prisma.order.updateMany({
    where: { id: order.id, status: 'PENDING' },
    data: { status: 'SUCCESS', vtpassStatus: txStatus(payload) || 'delivered', ...(payload ? { responsePayload: payload } : {}) },
  });
  const updated = await prisma.order.findUnique({ where: { id: order.id } });
  if (r.count !== 1) return { status: updated.status, order: updated };
  require('./partnerHealth').success(order);
  // Bulk exam PINs: refund any PINs VTpass didn't deliver.
  if (order.quantity > 1) await refundUndelivered(updated, payload);

  const settings = ctx.settings || settingsForCustomer(await getSettings(), await prisma.customer.findUnique({ where: { id: order.customerId }, select: { isAgent: true } }));
  const promoDiscount = ctx.promoDiscount ?? Number(order.promoDiscount || 0);
  if (order.promoCode && promoDiscount > 0) {
    const promo = await prisma.promoCode.findUnique({ where: { code: order.promoCode } }).catch(() => null);
    if (promo) promoLib.recordRedemption(promo, order.customerId, order.id, promoDiscount);
  }
  const totalSaved = Number(ctx.discountAmount ?? order.discountAmount ?? 0) + promoDiscount;
  const savedText = totalSaved > 0 ? ` You saved ₦${totalSaved.toLocaleString()}.` : '';
  const scheduledText = ctx.source === 'schedule' ? ' (scheduled top-up)' : '';
  const LABEL = { INTERNATIONAL: 'international airtime', INSURANCE: 'motor insurance' };
  notify(order.customerId, 'Purchase Successful', `Your ${LABEL[order.service] || order.service} purchase of ₦${amount.toLocaleString()}${scheduledText} was successful.${savedText}`);
  if (order.service === 'INSURANCE') {
    const cert = require('./extraServices').certUrlOf(payload);
    notify(order.customerId, 'Insurance certificate ready', cert ? `Your third-party insurance for ${order.recipient} is active. Download the certificate from Orders → this purchase → "Download certificate", or: ${cert}` : `Your third-party insurance for ${order.recipient} is active. The certificate is sent to your email; you can also open Orders → this purchase.`, { category: 'TRANSACTION' });
  }
  let cashback;
  let points;
  let shopCommission;
  const split = require('./rewardSplit');
  if (split.config(settings).enabled) {
    // Rewards split: one % of earnings shared between every programme
    // (and the pools that pay referral / challenge / promise rewards).
    ({ cashback, points, shopCommission } = await split.distribute(updated, settings));
    maybePayReferralBonus(order.customerId, amount);
    setImmediate(() => require('./deliveryPromise').check(order, 'SUCCESS'));
  } else {
    maybePayReferralBonus(order.customerId, amount);
    setImmediate(() => require('./deliveryPromise').check(order, 'SUCCESS'));
    cashback = await payCashback(order.customerId, updated, order.service, amount, settings);
    points = await awardPoints({ ...updated, cashbackAmount: cashback || 0 }, amount, settings);
    // Agent shop link commission (after cashback and points, which the
    // safety limit counts first).
    shopCommission = await require('./shop').payCommission(updated, settings, { cashback, points });
  }
  // Activity rewards ("buy data 5 times this month…"), after cashback
  // and points so the safety limit counts those first.
  // Renewal reminders; cable waits two minutes so the smartcard shows
  // the new expiry date.
  setTimeout(() => require('./reminders').afterPurchase(updated), order.service === 'CABLE' ? 2 * 60 * 1000 : 0).unref?.();
  setImmediate(() => require('./challenges').checkAfterPurchase({ ...updated, cashbackAmount: cashback || 0, pointsEarned: points || 0, shopCommission: shopCommission || 0 }));
  return { status: 'SUCCESS', order: { ...updated, ...(cashback ? { cashbackAmount: cashback } : {}), ...(points ? { pointsEarned: points } : {}) } };
}

// How many exam PINs a VTpass reply actually contains.
function deliveredCount(payload) {
  if (!payload) return 0;
  const cards = payload.cards || payload.content?.cards || payload.content?.transactions?.cards;
  if (Array.isArray(cards)) return cards.filter((c) => c && (c.Pin || c.pin)).length;
  const code = String(payload.purchased_code || payload.content?.transactions?.purchased_code || '');
  return (code.match(/pin\s*:/gi) || []).length;
}

async function refundUndelivered(order, payload) {
  const want = Number(order.quantity || 1);
  const got = deliveredCount(payload);
  if (!(got > 0 && got < want)) return null;
  const amount = Math.floor((Number(order.amount) * (want - got) / want) * 100) / 100;
  if (!(amount > 0)) return null;
  try {
    const split = require('./cashback').refundSplit(order, amount);
    await prisma.$transaction(async (tx) => {
      // providerRef is unique, so this refund can only ever happen once.
      await tx.walletTransaction.create({ data: { customerId: order.customerId, type: 'REFUND', amount: split.wallet, status: 'APPROVED', reference: order.vtpassRequestId, providerRef: `partial:${order.id}`, note: `Refund: ${want - got} of ${want} exam PINs not delivered` } });
      await tx.customer.update({ where: { id: order.customerId }, data: { walletBalance: { increment: split.wallet }, ...(split.cashback > 0 ? { cashbackBalance: { increment: split.cashback } } : {}) } });
      if (split.cashback > 0) await tx.cashbackEntry.create({ data: { customerId: order.customerId, amount: split.cashback, orderId: order.id, note: 'Returned: exam PINs not delivered' } });
    });
  } catch (e) {
    if (e.code === 'P2002') return null;
    console.error('partial refund failed:', e.message);
    return null;
  }
  notify(order.customerId, 'Partial refund', `Only ${got} of your ${want} exam PINs were delivered, so ₦${amount.toLocaleString()} was refunded to your wallet.`);
  return { got, want, amount };
}

// Asks VTpass for the real status of a pending order and settles it.
async function recheckOrder(orderOrId) {
  const order = typeof orderOrId === 'string' ? await prisma.order.findUnique({ where: { id: orderOrId } }) : orderOrId;
  if (!order || order.status !== 'PENDING' || !order.vtpassRequestId) return { status: order?.status || 'MISSING' };
  if (require('./ckBetting').isCk(order.provider)) return recheckCkOrder(order);
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

// ClubKonnect bet funding: "not found" only counts as failed once the
// order is old enough that it would have reached ClubKonnect.
async function recheckCkOrder(order) {
  const ckBet = require('./ckBetting');
  let resp;
  try {
    resp = await ckBet.query(order.vtpassRequestId);
  } catch (error) {
    return { status: 'PENDING', error: error.message };
  }
  let outcome = ckBet.classify(resp);
  const st = String(resp?.status || resp?.orderstatus || '').toUpperCase();
  if (/NOT_FOUND|INVALID_REQUESTID|INVALID_ORDERID/.test(st)) outcome = Date.now() - new Date(order.createdAt).getTime() > 30 * 60 * 1000 ? 'FAILED' : 'PENDING';
  const settled = await settleOrder(order, outcome, { supplier: 'CLUBKONNECT', ...resp });
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

const stuckAlerted = new Set();
async function sweepPendingOrders() {
  sweepTimer = null;
  try {
    const pending = await prisma.order.findMany({
      where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - 60 * 1000), gt: new Date(Date.now() - 7 * 24 * 3600 * 1000) } },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    for (const o of pending) await recheckOrder(o).catch((e) => console.error('sweep recheck failed:', e.message));
    // Orders still unconfirmed after 15 minutes: tell the admins once.
    const stuck = await prisma.order.findMany({
      where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - 15 * 60 * 1000), gt: new Date(Date.now() - 24 * 3600 * 1000) } },
      select: { id: true, service: true, provider: true, recipient: true, amount: true },
      take: 10,
    });
    const fresh = stuck.filter((o) => !stuckAlerted.has(o.id));
    if (fresh.length) {
      fresh.forEach((o) => stuckAlerted.add(o.id));
      require('./adminAlert').alertAdmins(
        `${fresh.length} order${fresh.length === 1 ? '' : 's'} still pending after 15 minutes`,
        fresh.map((o) => `${o.service} ${o.provider} → ${o.recipient} · ₦${Number(o.amount).toLocaleString()}`).join('\n') + '\nCheck them under Orders (Check now / Delivered / Failed + refund).',
        '/admin/orders'
      );
    }
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
  const settled = await settleOrder(order, outcome, null, { force: true });
  return { status: settled.status };
}

module.exports = { HELD, deliveredCount, refundUndelivered, performPurchase, recheckOrder, sweepPendingOrders, startOrderSweeper, forceSettle, classifyPay, classifyRequery };
