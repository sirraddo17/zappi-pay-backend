const express = require('express');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { vtpassRequest, getSettings } = require('../lib/vtpass');
const { notify } = require('../lib/notify');
const { computePrice } = require('../lib/pricing');
const { confirmTransaction } = require('../lib/security');
const { maybePayReferralBonus } = require('../lib/referral');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');

const router = express.Router();

function generateRequestId() {
  // VTpass wants something unique and roughly time-ordered; this is
  // their own documented convention (date/time prefix + random suffix).
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 12);
  return `${stamp}${crypto.randomBytes(4).toString('hex')}`;
}

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
    const settings = await getSettings();
    res.json({
      markupPercentByService: settings.markupPercentByService || {},
      discountPercentByService: settings.discountPercentByService || {},
    });
  } catch (error) {
    console.error('GET /pricing failed:', error);
    res.status(500).json({ error: 'Could not load pricing.' });
  }
});

// --- Purchase ---
// Reserve-then-commit: the wallet is debited and the Order row created
// as PENDING in one Prisma transaction *before* VTpass is ever called,
// so a crash mid-request can never leave money unaccounted for. If the
// VTpass call then fails or comes back declined, the debit is reversed
// with a REFUND transaction. This is deliberately two separate
// transactions (debit, then refund-if-needed) rather than one, because
// the VTpass call in between is a real network request Prisma can't
// hold a DB transaction open across safely.
router.post('/vtpass/purchase', requireCustomerAuth, async (req, res) => {
  const { service, serviceID, variationCode, billersCode, phone, amount } = req.body;

  if (!service || !serviceID || !billersCode || !phone) {
    return res.status(400).json({ error: 'service, serviceID, billersCode, and phone are required.' });
  }

  if (!variationCode) {
    const settings = await getSettings();
    const minPurchase = Number(settings.minPurchaseAmount);
    if (!amount || Number(amount) < minPurchase) {
      return res.status(400).json({ error: `Minimum purchase amount is ₦${minPurchase}.` });
    }
  }

  // Data/cable/education plans have a fixed VTpass price tied to their
  // variation code — looked up here rather than trusted from the
  // client, so a customer can't claim a cheaper price for a plan than
  // VTpass actually charges. Airtime/electricity have no such fixed
  // price (the customer picks the amount), so those still come from
  // the request body.
  let baseAmount;
  if (variationCode) {
    try {
      const variationsData = await vtpassRequest('GET', '/service-variations', { query: { serviceID } });
      const variations = variationsData?.content?.varations || variationsData?.content?.variations || [];
      const match = variations.find((v) => v.variation_code === variationCode);
      if (!match) return res.status(400).json({ error: 'Unknown variation for this service.' });
      baseAmount = Number(match.variation_amount);
    } catch (error) {
      console.error('POST /vtpass/purchase (variation lookup) failed:', error);
      return res.status(502).json({ error: 'Could not verify plan pricing with VTpass.' });
    }
  } else {
    baseAmount = Number(amount);
  }
  if (!baseAmount || baseAmount <= 0) {
    return res.status(400).json({ error: 'A positive amount is required.' });
  }

  // Markup is added on top of the verified base price to get what the
  // customer's wallet is actually charged; VTpass itself is still paid
  // the base amount below, since that's what determines what the
  // customer receives (airtime credited, data allocated, etc.) — the
  // markup is our margin, not part of what VTpass processes.
  //
  // Any admin-set discount for this service is then taken off that
  // marked-up price (see lib/pricing.js) — also only affects what the
  // wallet is charged, never what VTpass is sent.
  const settings = await getSettings();
  const { chargeAmount, discountAmount } = computePrice(baseAmount, service, settings);

  // PIN or fingerprint/Face ID confirmation — checked after pricing so
  // a bad plan/amount is reported first, but before any money moves.
  const confirmation = await confirmTransaction(req);
  if (!confirmation.ok) return res.status(confirmation.status).json({ error: confirmation.error, code: confirmation.code });

  let order;
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    if (!customer) return res.status(404).json({ error: 'Account not found.' });
    if (Number(customer.walletBalance) < chargeAmount) {
      return res.status(402).json({ error: 'Insufficient wallet balance.' });
    }

    const requestId = generateRequestId();

    const result = await prisma.$transaction([
      prisma.customer.update({
        where: { id: customer.id },
        data: { walletBalance: { decrement: chargeAmount } },
      }),
      prisma.walletTransaction.create({
        data: {
          customerId: customer.id,
          type: 'DEBIT',
          amount: chargeAmount,
          status: 'APPROVED',
          note: `${service} purchase`,
        },
      }),
      prisma.order.create({
        data: {
          customerId: customer.id,
          service,
          provider: serviceID,
          variationCode: variationCode || undefined,
          recipient: billersCode,
          amount: chargeAmount,
          costAmount: baseAmount,
          discountAmount: discountAmount > 0 ? discountAmount : undefined,
          vtpassRequestId: requestId,
          status: 'PENDING',
        },
      }),
    ]);
    order = result[2];
  } catch (error) {
    console.error('POST /vtpass/purchase (reserve) failed:', error);
    return res.status(500).json({ error: 'Could not reserve funds for this purchase.' });
  }

  try {
    const vtpassResponse = await vtpassRequest('POST', '/pay', {
      body: {
        request_id: order.vtpassRequestId,
        serviceID,
        billersCode,
        variation_code: variationCode || undefined,
        amount: baseAmount,
        phone,
      },
    });

    const status = vtpassResponse?.content?.transactions?.status || (vtpassResponse.code === '000' ? 'delivered' : 'failed');
    const succeeded = status === 'delivered' || vtpassResponse.code === '000';

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        status: succeeded ? 'SUCCESS' : 'FAILED',
        vtpassStatus: status,
        responsePayload: vtpassResponse,
      },
    });

    if (!succeeded) {
      console.error('POST /vtpass/purchase (not delivered):', status, JSON.stringify(vtpassResponse, null, 2));
      await prisma.$transaction([
        prisma.customer.update({ where: { id: req.customer.customerId }, data: { walletBalance: { increment: chargeAmount } } }),
        prisma.walletTransaction.create({
          data: {
            customerId: req.customer.customerId,
            type: 'REFUND',
            amount: chargeAmount,
            status: 'APPROVED',
            note: `Refund for failed ${service} purchase`,
          },
        }),
      ]);
      notify(req.customer.customerId, 'Purchase Failed', `Your ${service} purchase failed and ₦${Number(chargeAmount).toLocaleString()} was refunded to your wallet.`);
      return res.status(502).json({ error: 'Purchase was not successful. You have been refunded.', order: updated });
    }

    const savedText = discountAmount > 0 ? ` You saved ₦${Number(discountAmount).toLocaleString()} with a discount.` : '';
    notify(req.customer.customerId, 'Purchase Successful', `Your ${service} purchase of ₦${Number(chargeAmount).toLocaleString()} was successful.${savedText}`);

    maybePayReferralBonus(req.customer.customerId, chargeAmount);

    res.status(201).json({ order: updated });
  } catch (error) {
    console.error('POST /vtpass/purchase (VTpass call) failed:', error);
    await prisma.order.update({ where: { id: order.id }, data: { status: 'FAILED' } });
    await prisma.$transaction([
      prisma.customer.update({ where: { id: req.customer.customerId }, data: { walletBalance: { increment: chargeAmount } } }),
      prisma.walletTransaction.create({
        data: {
          customerId: req.customer.customerId,
          type: 'REFUND',
          amount: chargeAmount,
          status: 'APPROVED',
          note: `Refund for failed ${service} purchase`,
        },
      }),
    ]);
    notify(req.customer.customerId, 'Purchase Failed', `Your ${service} purchase couldn't be completed and ₦${Number(chargeAmount).toLocaleString()} was refunded to your wallet.`);
    res.status(502).json({ error: 'Could not reach VTpass. You have been refunded.' });
  }
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
