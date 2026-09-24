const express = require('express');
const prisma = require('../lib/prisma');
const { vtpassRequest, getSettings } = require('../lib/vtpass');
const { confirmTransaction } = require('../lib/security');
const { performPurchase } = require('../lib/purchase');
const { FREQUENCIES, createSchedule, upsertBeneficiary } = require('../lib/schedules');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');

const router = express.Router();

// --- Catalog & verification (read-only, proxied straight to VTpass) ---
// These don't touch the wallet or Order table at all — just pass VTpass's
// own catalog data through, since re-hosting a copy of it here would go
// stale the moment VTpass adds or reprices a plan.

router.get('/vtpass/categories', requireCustomerAuth, async (req, res) => {
  try {
    const data = await vtpassRequest('GET', '/service-categories');
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
    const data = await vtpassRequest('GET', '/services', { query: { identifier } });
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
    const data = await vtpassRequest('GET', '/service-variations', { query: { serviceID } });
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

  if (result.status === 201) {
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
    return res.status(201).json({ ...result.body, ...extras });
  }
  res.status(result.status).json(result.body);
});

router.get('/orders', requireCustomerAuth, async (req, res) => {
  try {
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
