const express = require('express');
const prisma = require('../lib/prisma');
const { vtpassRequest, getSettings } = require('../lib/vtpass');
const { confirmTransaction } = require('../lib/security');
const { performPurchase, recheckOrder, forceSettle, HELD } = require('../lib/purchase');
const { customerView, hasDeliverable } = require('../lib/orderSafety');
const { FREQUENCIES, createSchedule, upsertBeneficiary } = require('../lib/schedules');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');

const router = express.Router();

// Catalog cache lives in lib/catalog.js (also used by the deal finder).
const { cachedCatalog } = require('../lib/catalog');

// --- Catalog & verification (read-only, proxied straight to VTpass) ---
// These don't touch the wallet or Order table at all — just pass VTpass's
// own catalog data through, since re-hosting a copy of it here would go
// stale the moment VTpass adds or reprices a plan.

router.get('/vtpass/categories', requireCustomerAuth, async (req, res) => {
  try {
    const data = await cachedCatalog('/service-categories');
    res.json(data);
  } catch (error) {
    console.error('GET /vtpass/categories failed:', error);
    res.status(502).json({ error: error.message });
  }
});

router.get('/vtpass/services', requireCustomerAuth, async (req, res) => {
  try {
    const { identifier } = req.query;
    if (!identifier) return res.status(400).json({ error: 'identifier is required.' });
    // Bet funding companies: from ClubKonnect or VTpass (Settings → ClubKonnect).
    if (identifier === 'betting') {
      const ckBet = require('../lib/ckBetting');
      if (await ckBet.useCk()) return res.json(await ckBet.servicesForApp());
      const data = await cachedCatalog('/services', { identifier: 'other-services' });
      const list = Array.isArray(data?.content) ? data.content : [];
      return res.json({ ...data, content: list.filter((p) => ckBet.VTPASS_BET_IDS.includes(p.serviceID)) });
    }
    const data = await cachedCatalog('/services', { identifier });
    res.json(data);
  } catch (error) {
    console.error('GET /vtpass/services failed:', error);
    res.status(502).json({ error: error.message });
  }
});

router.get('/vtpass/variations', requireCustomerAuth, async (req, res) => {
  try {
    const { serviceID } = req.query;
    if (!serviceID) return res.status(400).json({ error: 'serviceID is required.' });
    const data = await cachedCatalog('/service-variations', { serviceID });
    res.json(data);
  } catch (error) {
    console.error('GET /vtpass/variations failed:', error);
    res.status(502).json({ error: error.message });
  }
});

// --- International airtime/data and motor insurance (lib/extraServices.js) ---
async function priceFor(customerId, service, base) {
  const { computePrice, settingsForCustomer } = require('../lib/pricing');
  const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { isAgent: true } });
  return computePrice(base, service, settingsForCustomer(await getSettings(), c)).chargeAmount;
}
function xfail(res, e, what) {
  const X = require('../lib/extraServices');
  if (e instanceof X.ExtraServiceError) return res.status(e.status).json({ error: e.message });
  console.error(`${what} failed:`, e.message);
  return res.status(502).json({ error: e.code === 'VTPASS_NOT_CONFIGURED' ? e.message : 'Could not load this from VTpass right now. Please try again.' });
}
router.get('/vtpass/intl/countries', requireCustomerAuth, async (req, res) => {
  try { res.json({ countries: await require('../lib/extraServices').countries() }); } catch (e) { xfail(res, e, 'intl countries'); }
});
router.get('/vtpass/intl/types', requireCustomerAuth, async (req, res) => {
  try { res.json({ types: await require('../lib/extraServices').productTypes(req.query.code) }); } catch (e) { xfail(res, e, 'intl types'); }
});
router.get('/vtpass/intl/operators', requireCustomerAuth, async (req, res) => {
  try { res.json({ operators: await require('../lib/extraServices').operators(req.query.code, req.query.type) }); } catch (e) { xfail(res, e, 'intl operators'); }
});
router.get('/vtpass/intl/variations', requireCustomerAuth, async (req, res) => {
  try {
    const vs = await require('../lib/extraServices').variations(req.query.operator, req.query.type);
    const out = [];
    for (const v of vs) out.push({ ...v, price: v.fixed ? await priceFor(req.customer.customerId, 'INTERNATIONAL', v.naira) : null });
    // Nothing priceable: send what VTpass returned (catalog data only) so
    // the owner can screenshot it for support.
    let raw;
    if (!out.length) {
      const { d, vs: rv } = await require('../lib/extraServices').rawVariations(req.query.operator, req.query.type);
      raw = { count: rv.length, sample: rv.slice(0, 3), keys: Object.keys(d?.content || {}), description: d?.response_description || null };
    }
    res.json({ variations: out, ...(raw ? { raw } : {}) });
  } catch (e) { xfail(res, e, 'intl variations'); }
});
router.get('/vtpass/intl/quote', requireCustomerAuth, async (req, res) => {
  try {
    const q = await require('../lib/extraServices').intlQuote({ countryCode: req.query.code, productTypeId: req.query.type, operatorId: req.query.operator, variationCode: req.query.variation, localAmount: req.query.amount });
    res.json({ price: await priceFor(req.customer.customerId, 'INTERNATIONAL', q.baseAmount) });
  } catch (e) { xfail(res, e, 'intl quote'); }
});
router.get('/vtpass/insurance/plans', requireCustomerAuth, async (req, res) => {
  try {
    const plans = await require('../lib/extraServices').insurancePlans();
    const out = [];
    for (const p of plans) out.push({ ...p, price: p.amount > 0 ? await priceFor(req.customer.customerId, 'INSURANCE', p.amount) : null });
    res.json({ plans: out });
  } catch (e) { xfail(res, e, 'insurance plans'); }
});
router.get('/vtpass/insurance/options/:kind', requireCustomerAuth, async (req, res) => {
  try {
    const options = await require('../lib/extraServices').insuranceOptions(req.params.kind, req.query.parent);
    res.json({ options, ...(options.raw ? { raw: options.raw } : {}) });
  } catch (e) { xfail(res, e, 'insurance options'); }
});

// Confirms a meter number / smartcard number / similar identifier
// resolves to a real customer name before money moves — not every
// service supports this (VTpass returns an error for ones that don't,
// which the frontend can treat as "skip verification for this one").
router.get('/vtpass/verify', requireCustomerAuth, async (req, res) => {
  try {
    const { serviceID, billersCode, type } = req.query;
    if (!serviceID || !billersCode) {
      return res.status(400).json({ error: 'serviceID and billersCode are required.' });
    }
    const ckBet = require('../lib/ckBetting');
    if (ckBet.isCk(serviceID)) {
      try {
        return res.json(await ckBet.verify(serviceID, billersCode));
      } catch (e) {
        return res.status(502).json({ error: e.message });
      }
    }
    const data = await vtpassRequest('GET', '/merchant-verify', {
      query: { serviceID, billersCode: String(billersCode).trim(), type: type || undefined },
    });
    // VTpass answers a wrong number with code 000 and content.error.
    const c = data?.content || {};
    if (c.error || c.WrongBillersCode || (data?.code && String(data.code) !== '000')) {
      return res.status(400).json({ error: String(c.error || data.response_description || 'This number could not be verified.').slice(0, 200) });
    }
    res.json(data);
  } catch (error) {
    console.error('GET /vtpass/verify failed:', error);
    res.status(502).json({ error: error.message });
  }
});

// --- Pricing ---
// The customer-facing half of Settings: just the markup and discount
// percentages (never the VTpass keys), so the dashboard can badge
// discounted services and the Buy page can show the exact total the
// wallet will be charged before the customer taps Pay. The purchase
// route still recomputes the price itself — this is display only.
router.get('/pricing', requireCustomerAuth, async (req, res) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId }, select: { isAgent: true } });
    const raw = await getSettings();
    const settings = require('../lib/pricing').settingsForCustomer(raw, customer);
    res.json({
      markupPercentByService: settings.markupPercentByService || {},
      markupCapByService: settings.markupCapByService || {},
      discountPercentByService: settings.discountPercentByService || {},
      agentPricing: settings !== raw,
      // Separate cashback balance used at checkout (lib/cashback.js).
      cashback: raw.cashbackSeparate !== false ? { balance: Number((await prisma.customer.findUnique({ where: { id: req.customer.customerId }, select: { cashbackBalance: true } }))?.cashbackBalance || 0), maxPercent: Number(raw.cashbackUseMaxPercent ?? 20) } : null,
    });
  } catch (error) {
    console.error('GET /pricing failed:', error);
    res.status(500).json({ error: 'Could not load pricing.' });
  }
});

// --- Purchase ---
// The purchase itself lives in lib/purchase.js (shared with scheduled
// top-ups). This route adds the PIN / biometric check and, optionally,
// saves the recipient as a beneficiary and/or sets the purchase to
// repeat automatically — both only after a successful purchase, so a
// failed first payment never leaves a schedule behind.
router.post('/vtpass/purchase', requireCustomerAuth, async (req, res) => {
  const { service, serviceID, variationCode, billersCode, phone, amount, meterType, saveBeneficiary, repeat, promoCode, gift, shop } = req.body;
  if (!service || !serviceID || !billersCode || !phone) {
    return res.status(400).json({ error: 'service, serviceID, billersCode, and phone are required.' });
  }
  if (repeat && !FREQUENCIES.includes(repeat.frequency)) {
    return res.status(400).json({ error: 'Choose how often to repeat: daily, weekly or monthly.' });
  }

  if ((service === 'INTERNATIONAL' || service === 'INSURANCE' || Number(req.body.quantity) > 1) && repeat) {
    return res.status(400).json({ error: 'Repeat is not available for this service yet.' });
  }

  const confirmation = await confirmTransaction(req);
  if (!confirmation.ok) return res.status(confirmation.status).json({ error: confirmation.error, code: confirmation.code });

  const input = { service, serviceID, variationCode, billersCode, phone, amount, meterType, quantity: req.body.quantity, intl: req.body.intl, insurance: req.body.insurance, useCashback: Boolean(req.body.useCashback) };
  // Bought through an agent's shop link?
  const shopAgentId = await require('../lib/shop').agentForPurchase(req.customer.customerId, shop).catch(() => null);
  const result = await performPurchase(req.customer.customerId, { ...input, promoCode, shopAgentId });

  if (result.status === 201 || result.status === 202) {
    const extras = {};
    if (saveBeneficiary && service !== 'INTERNATIONAL' && service !== 'INSURANCE') {
      extras.beneficiary = await upsertBeneficiary(req.customer.customerId, {
        service, serviceID, billersCode, meterType, nickname: saveBeneficiary.nickname,
      }).catch((e) => { console.error('save beneficiary failed:', e); return null; });
    }
    if (repeat) {
      extras.schedule = await createSchedule(req.customer.customerId, { ...input, frequency: repeat.frequency, nickname: repeat.nickname })
        .catch((e) => { console.error('create schedule failed:', e); return null; });
    }
    // "Send as a gift" — a shareable card with the customer's message.
    if (gift && result.body.order?.id) {
      extras.gift = await require('../lib/gifts').createGift(req.customer.customerId, result.body.order.id, gift)
        .then(() => require('../lib/gifts').forOrder(req.customer.customerId, result.body.order.id))
        .catch((e) => { console.error('create gift failed:', e.message); return null; });
    }
    return res.status(result.status).json({ ...result.body, ...extras });
  }
  res.status(result.status).json(result.body);
});

// The app refreshes pending orders automatically every few seconds, so
// ask VTpass about any one order at most every 20 seconds.
const lastRecheck = new Map();
async function throttledRecheck(order) {
  const now = Date.now();
  if (now - (lastRecheck.get(order.id) || 0) < 20 * 1000) return;
  lastRecheck.set(order.id, now);
  if (lastRecheck.size > 5000) lastRecheck.clear();
  await recheckOrder(order).catch(() => {});
}

router.get('/orders', requireCustomerAuth, async (req, res) => {
  try {
    // Settle this customer's orders still waiting on VTpass.
    const pending = await prisma.order.findMany({
      where: { customerId: req.customer.customerId, status: 'PENDING', createdAt: { lt: new Date(Date.now() - 30 * 1000) } },
      take: 3,
    });
    for (const o of pending) await throttledRecheck(o);
    const orders = await prisma.order.findMany({
      where: { customerId: req.customer.customerId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    // PINs/tokens only on SUCCESS orders.
    res.json({ orders: orders.map(customerView) });
  } catch (error) {
    console.error('GET /orders failed:', error);
    res.status(500).json({ error: 'Could not load orders.' });
  }
});

// A single order's full detail, for the receipt view — scoped to
// the requesting customer so one person can never pull up another's
// order by guessing an id.
router.get('/orders/:id', requireCustomerAuth, async (req, res) => {
  try {
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, customerId: req.customer.customerId },
    });
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (order.status === 'PENDING' && Date.now() - new Date(order.createdAt).getTime() > 30 * 1000) {
      await throttledRecheck(order);
      const fresh = await prisma.order.findUnique({ where: { id: order.id } });
      return res.json({ order: customerView(fresh || order) });
    }
    res.json({ order: customerView(order) });
  } catch (error) {
    console.error('GET /orders/:id failed:', error);
    res.status(500).json({ error: 'Could not load order.' });
  }
});

// Admin: re-check a pending order with VTpass, or settle it by hand
// after confirming with VTpass support.
router.post('/admin/orders/:id/recheck', requireAdminAuth, async (req, res) => {
  try {
    res.json(await recheckOrder(req.params.id));
  } catch (error) {
    console.error('POST /admin/orders/:id/recheck failed:', error);
    res.status(500).json({ error: 'Could not check this order.' });
  }
});

router.post('/admin/orders/:id/settle', requireAdminAuth, async (req, res) => {
  try {
    const outcome = req.body?.outcome === 'SUCCESS' ? 'SUCCESS' : req.body?.outcome === 'FAILED' ? 'FAILED' : null;
    if (!outcome) return res.status(400).json({ error: 'outcome must be SUCCESS or FAILED.' });
    const result = await forceSettle(req.params.id, outcome);
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'ORDER_FORCE_SETTLED', details: { orderId: req.params.id, outcome } } }).catch(() => {});
    res.json(result);
  } catch (error) {
    console.error('POST /admin/orders/:id/settle failed:', error);
    res.status(500).json({ error: 'Could not settle this order.' });
  }
});

// Admin: check VTpass's verify with the sandbox test numbers and show
// exactly what VTpass answers (no money moves, keys are never shown).
const SELFTEST = [
  { label: 'Electricity prepaid (Ikeja) 1111111111111', serviceID: 'ikeja-electric', billersCode: '1111111111111', type: 'prepaid' },
  { label: 'Electricity postpaid (Ikeja) 1010101010101', serviceID: 'ikeja-electric', billersCode: '1010101010101', type: 'postpaid' },
  { label: 'DStv 1212121212', serviceID: 'dstv', billersCode: '1212121212' },
  { label: 'JAMB 0123456789', serviceID: 'jamb', billersCode: '0123456789', type: 'utme-mock' },
  { label: 'Smile tester@sandbox.com', serviceID: 'smile-direct', billersCode: 'tester@sandbox.com' },
];
router.get('/admin/vtpass/selftest', requireAdminAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    const results = [];
    for (const t of SELFTEST) {
      let data;
      try {
        data = await vtpassRequest('GET', '/merchant-verify', { query: { serviceID: t.serviceID, billersCode: t.billersCode, type: t.type } });
      } catch (e) {
        data = e.vtpassResponse || { error: e.message };
      }
      const c = data?.content || {};
      const name = c.Customer_Name || c.customerName || (Array.isArray(c.AccountList) ? c.AccountList.map((a) => a.FriendlyName || a.AccountId).join(', ') : null);
      results.push({ label: t.label, ok: Boolean(name) && !c.error, name: name || null, code: data?.code ?? null, message: String(c.error || data?.response_description || data?.error || '').slice(0, 200) || null, reply: JSON.stringify(data).slice(0, 600) });
    }
    res.json({ mode: settings.vtpassMode, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// VTpass wallet balance (for the admin Overview).
router.get('/admin/vtpass/balance', requireAdminAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    const data = await vtpassRequest('GET', '/balance');
    const balance = Number(data?.contents?.balance ?? data?.content?.balance ?? data?.balance);
    res.json({ mode: settings.vtpassMode, balance: Number.isFinite(balance) ? balance : null });
  } catch (error) {
    res.json({ mode: null, balance: null, error: error.message });
  }
});

// VTpass transaction-update webhook. The body is only a hint: the order
// is re-queried with VTpass before anything changes.
router.post('/webhooks/vtpass', async (req, res) => {
  try {
    const b = req.body || {};
    const requestId = b.data?.requestId || b.requestId || b.data?.request_id || b.request_id;
    if (requestId) {
      const order = await prisma.order.findUnique({ where: { vtpassRequestId: String(requestId) } });
      if (order) console.log('VTpass webhook:', requestId, JSON.stringify(await recheckOrder(order)));
    }
    res.json({ response: 'success' });
  } catch (error) {
    console.error('POST /webhooks/vtpass failed:', error.message);
    res.json({ response: 'success' });
  }
});

const ORDER_STATUSES = ['PENDING', 'SUCCESS', 'FAILED', 'REFUNDED'];
router.get('/admin/orders', requireAdminAuth, async (req, res) => {
  try {
    const status = ORDER_STATUSES.includes(String(req.query.status || '').toUpperCase()) ? String(req.query.status).toUpperCase() : null;
    const [orders, total, pending, success, failed, revenue] = await Promise.all([
      prisma.order.findMany({
        where: status ? { status } : {},
        orderBy: { createdAt: 'desc' },
        take: 300,
        include: { customer: { select: { id: true, name: true, phone: true } } },
      }),
      prisma.order.count(),
      prisma.order.count({ where: { status: 'PENDING' } }),
      prisma.order.count({ where: { status: 'SUCCESS' } }),
      prisma.order.count({ where: { status: 'FAILED' } }),
      prisma.order.aggregate({ where: { status: 'SUCCESS' }, _sum: { amount: true } }).catch(() => null),
    ]);
    res.json({
      // pinsGiven: VTpass already handed out PINs/token — never refund without checking.
      orders: orders.map((o) => {
        const p = o.responsePayload || {};
        const reason = o.status === 'FAILED' ? String(p.content?.error || p.response_description || p.content?.transactions?.status || o.vtpassStatus || '').slice(0, 160) || null : null;
        return { ...o, pinsGiven: hasDeliverable(o.responsePayload), held: o.vtpassStatus === HELD, vtpassReason: reason };
      }),
      counts: { total, PENDING: pending, SUCCESS: success, FAILED: failed, revenue: Number(revenue?._sum?.amount || 0) },
    });
  } catch (error) {
    console.error('GET /admin/orders failed:', error);
    res.status(500).json({ error: 'Could not load orders.' });
  }
});

module.exports = router;
