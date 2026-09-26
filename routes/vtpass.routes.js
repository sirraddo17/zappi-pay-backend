const express = require('express');
const prisma = require('../lib/prisma');
const { vtpassRequest, getSettings } = require('../lib/vtpass');
const { confirmTransaction } = require('../lib/security');
const { performPurchase, recheckOrder, forceSettle } = require('../lib/purchase');
const { FREQUENCIES, createSchedule, upsertBeneficiary } = require('../lib/schedules');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');

const router = express.Router();

// VTpass's catalog (networks, data plans, TV bouquets) rarely changes,
// but fetching it live takes 1-2 seconds every time a customer opens a
// Buy page. Keep good answers in memory for an hour, per sandbox/live
// mode. Prices are still checked by VTpass when the purchase is made.
const CATALOG_TTL_MS = 60 * 60 * 1000;
const catalogCache = new Map();

async function cachedCatalog(path, query) {
  const { vtpassMode } = await getSettings();
  const key = `${vtpassMode}|${path}|${JSON.stringify(query || {})}`;
  const hit = catalogCache.get(key);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.data;
  const data = await vtpassRequest('GET', path, { query });
  const content = data?.content;
  const ok = Array.isArray(content) ? content.length > 0 : Boolean(content && (content.varations || content.variations || Object.keys(content).length));
  if (ok) {
    if (catalogCache.size > 200) catalogCache.clear();
    catalogCache.set(key, { at: Date.now(), data });
  }
  return data;
}

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
    const data = await vtpassRequest('GET', '/merchant-verify', {
      query: { serviceID, billersCode, type: type || undefined },
    });
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
      discountPercentByService: settings.discountPercentByService || {},
      agentPricing: settings !== raw,
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
  const { service, serviceID, variationCode, billersCode, phone, amount, meterType, saveBeneficiary, repeat, promoCode } = req.body;
  if (!service || !serviceID || !billersCode || !phone) {
    return res.status(400).json({ error: 'service, serviceID, billersCode, and phone are required.' });
  }
  if (repeat && !FREQUENCIES.includes(repeat.frequency)) {
    return res.status(400).json({ error: 'Choose how often to repeat: daily, weekly or monthly.' });
  }

  const confirmation = await confirmTransaction(req);
  if (!confirmation.ok) return res.status(confirmation.status).json({ error: confirmation.error, code: confirmation.code });

  const input = { service, serviceID, variationCode, billersCode, phone, amount, meterType };
  const result = await performPurchase(req.customer.customerId, { ...input, promoCode });

  if (result.status === 201 || result.status === 202) {
    const extras = {};
    if (saveBeneficiary) {
      extras.beneficiary = await upsertBeneficiary(req.customer.customerId, {
        service, serviceID, billersCode, meterType, nickname: saveBeneficiary.nickname,
      }).catch((e) => { console.error('save beneficiary failed:', e); return null; });
    }
    if (repeat) {
      extras.schedule = await createSchedule(req.customer.customerId, { ...input, frequency: repeat.frequency, nickname: repeat.nickname })
        .catch((e) => { console.error('create schedule failed:', e); return null; });
    }
    return res.status(result.status).json({ ...result.body, ...extras });
  }
  res.status(result.status).json(result.body);
});

router.get('/orders', requireCustomerAuth, async (req, res) => {
  try {
    // Settle this customer's orders still waiting on VTpass.
    const pending = await prisma.order.findMany({
      where: { customerId: req.customer.customerId, status: 'PENDING', createdAt: { lt: new Date(Date.now() - 30 * 1000) } },
      take: 3,
    });
    for (const o of pending) await recheckOrder(o).catch(() => {});
    const orders = await prisma.order.findMany({
      where: { customerId: req.customer.customerId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ orders });
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
    res.json({ order });
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

router.get('/admin/orders', requireAdminAuth, async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { customer: { select: { id: true, name: true, phone: true } } },
    });
    res.json({ orders });
  } catch (error) {
    console.error('GET /admin/orders failed:', error);
    res.status(500).json({ error: 'Could not load orders.' });
  }
});

module.exports = router;
