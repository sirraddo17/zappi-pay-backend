const express = require('express');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { vtpassRequest, getSettings } = require('../lib/vtpass');
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
  const settings = await getSettings();
  const markupPercent = Number(settings.markupPercentByService?.[service] || 0);
  const chargeAmount = Math.round(baseAmount * (1 + markupPercent / 100));

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
      return res.status(502).json({ error: 'Purchase was not successful. You have been refunded.', order: updated });
    }

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
