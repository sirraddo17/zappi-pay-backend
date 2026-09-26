const express = require('express');
const prisma = require('../lib/prisma');
const { getSettings } = require('../lib/vtpass');
const { notify } = require('../lib/notify');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');

const router = express.Router();

// Keys match VTpass's airtime serviceIDs, so an existing airtime
// Order's provider can be used directly to pre-fill a request.
const NETWORKS = { mtn: 'MTN', glo: 'Glo', airtel: 'Airtel', etisalat: '9mobile' };
const MAX_AMOUNT = 50000;
const MAX_PENDING_PER_CUSTOMER = 3;

// Payout is always rounded DOWN to whole naira, so rounding can never
// pay out more than the quoted fee allows.
function computePayout(amount, feePercent) {
  return Math.floor(Number(amount) * (1 - Number(feePercent) / 100));
}

function naira(n) {
  return `₦${Number(n).toLocaleString()}`;
}

// --- Customer ---

// Everything the request form needs: whether it's on, the fee, the
// minimum, and which networks have a receiving line set up (only
// those can be chosen).
router.get('/airtime-cash/config', requireCustomerAuth, async (req, res) => {
  try {
    const s = await getSettings();
    const numbers = s.airtimeToCashNumbers || {};
    res.json({
      enabled: s.airtimeToCashEnabled,
      feePercent: Number(s.airtimeToCashFeePercent),
      minAmount: Number(s.airtimeToCashMinAmount),
      maxAmount: MAX_AMOUNT,
      networks: Object.keys(NETWORKS)
        .filter((key) => numbers[key])
        .map((key) => ({ key, label: NETWORKS[key], receivingNumber: numbers[key] })),
    });
  } catch (error) {
    console.error('GET /airtime-cash/config failed:', error);
    res.status(500).json({ error: 'Could not load Airtime to Cash settings.' });
  }
});

router.get('/airtime-cash/requests', requireCustomerAuth, async (req, res) => {
  try {
    const requests = await prisma.airtimeCashRequest.findMany({
      where: { customerId: req.customer.customerId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ requests });
  } catch (error) {
    console.error('GET /airtime-cash/requests failed:', error);
    res.status(500).json({ error: 'Could not load your requests.' });
  }
});

router.post('/airtime-cash/requests', requireCustomerAuth, async (req, res) => {
  try {
    const customerId = req.customer.customerId;
    const network = String(req.body.network || '').toLowerCase();
    const senderPhone = String(req.body.senderPhone || '').replace(/\s+/g, '');
    const amount = Number(req.body.amount);
    const note = req.body.note ? String(req.body.note).trim().slice(0, 300) : null;
    const orderId = req.body.orderId || null;

    const s = await getSettings();
    const numbers = s.airtimeToCashNumbers || {};
    if (!s.airtimeToCashEnabled) {
      return res.status(400).json({ error: 'Airtime to Cash is not available right now.' });
    }
    if (!NETWORKS[network] || !numbers[network]) {
      return res.status(400).json({ error: 'Please choose a supported network.' });
    }
    if (!/^0\d{10}$/.test(senderPhone)) {
      return res.status(400).json({ error: 'Enter the 11-digit phone number the airtime is on.' });
    }
    const minAmount = Number(s.airtimeToCashMinAmount);
    if (!Number.isFinite(amount) || amount < minAmount || amount > MAX_AMOUNT) {
      return res.status(400).json({ error: `Amount must be between ${naira(minAmount)} and ${naira(MAX_AMOUNT)}.` });
    }

    // A linked order has to be this customer's own successful airtime
    // purchase — it's context for the admin, so it must be real.
    if (orderId) {
      const order = await prisma.order.findFirst({
        where: { id: orderId, customerId, service: 'AIRTIME', status: 'SUCCESS' },
      });
      if (!order) return res.status(400).json({ error: 'That airtime purchase could not be found.' });
    }

    const pendingCount = await prisma.airtimeCashRequest.count({ where: { customerId, status: 'PENDING' } });
    if (pendingCount >= MAX_PENDING_PER_CUSTOMER) {
      return res.status(400).json({ error: `You already have ${pendingCount} requests waiting. Please wait for those to be reviewed.` });
    }

    const feePercent = Number(s.airtimeToCashFeePercent);
    const request = await prisma.airtimeCashRequest.create({
      data: {
        customerId,
        network,
        senderPhone,
        amount,
        feePercent,
        payoutAmount: computePayout(amount, feePercent),
        orderId,
        note,
      },
    });
    require('../lib/adminAlert').alertAdmins('New Airtime to Cash request', `₦${Number(request.amount ?? 0).toLocaleString()} ${request.network || ''} airtime is waiting for you to confirm.`, '/admin/airtime-cash');

    notify(
      customerId,
      'Airtime to Cash Request Received',
      `Transfer ${naira(amount)} ${NETWORKS[network]} airtime from ${senderPhone} to ${numbers[network]}. Once we confirm it, ${naira(request.payoutAmount)} will be added to your wallet.`
    );

    res.status(201).json({ request, receivingNumber: numbers[network] });
  } catch (error) {
    console.error('POST /airtime-cash/requests failed:', error);
    res.status(500).json({ error: 'Could not submit your request.' });
  }
});

// --- Admin ---

router.get('/admin/airtime-cash', requireAdminAuth, async (req, res) => {
  try {
    const status = ['PENDING', 'APPROVED', 'REJECTED'].includes(req.query.status) ? req.query.status : 'PENDING';
    const requests = await prisma.airtimeCashRequest.findMany({
      where: { status },
      orderBy: { createdAt: status === 'PENDING' ? 'asc' : 'desc' },
      take: 200,
      include: { customer: { select: { id: true, name: true, phone: true, username: true } } },
    });
    const pendingCount = await prisma.airtimeCashRequest.count({ where: { status: 'PENDING' } });
    res.json({ requests, pendingCount });
  } catch (error) {
    console.error('GET /admin/airtime-cash failed:', error);
    res.status(500).json({ error: 'Could not load Airtime to Cash requests.' });
  }
});

// Approving credits the wallet. The status flip is a conditional
// updateMany on status: 'PENDING' inside the same transaction as the
// credit, so two admins clicking Approve at once can never pay the
// same request twice — the second one updates 0 rows and aborts.
router.post('/admin/airtime-cash/:id/approve', requireAdminAuth, async (req, res) => {
  try {
    const existing = await prisma.airtimeCashRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Request not found.' });
    if (existing.status !== 'PENDING') return res.status(400).json({ error: 'This request has already been reviewed.' });

    // Admin can confirm a smaller amount actually arrived; never more
    // than was requested.
    let received = Number(existing.amount);
    if (req.body.receivedAmount !== undefined && req.body.receivedAmount !== '') {
      received = Number(req.body.receivedAmount);
      if (!Number.isFinite(received) || received <= 0 || received > Number(existing.amount)) {
        return res.status(400).json({ error: `Received amount must be above ₦0 and no more than ${naira(existing.amount)}.` });
      }
    }
    const payout = computePayout(received, existing.feePercent);
    if (payout <= 0) return res.status(400).json({ error: 'Payout would be ₦0 — reject this request instead.' });
    const adminNote = req.body.adminNote ? String(req.body.adminNote).trim().slice(0, 300) : null;

    const request = await prisma.$transaction(async (tx) => {
      const flipped = await tx.airtimeCashRequest.updateMany({
        where: { id: existing.id, status: 'PENDING' },
        data: {
          status: 'APPROVED',
          receivedAmount: received,
          payoutAmount: payout,
          adminNote,
          reviewedByAdminId: req.admin.adminId,
          reviewedAt: new Date(),
        },
      });
      if (flipped.count === 0) throw Object.assign(new Error('already reviewed'), { code: 'ALREADY_REVIEWED' });

      await tx.customer.update({ where: { id: existing.customerId }, data: { walletBalance: { increment: payout } } });
      await tx.walletTransaction.create({
        data: {
          customerId: existing.customerId,
          type: 'AIRTIME_CASH',
          amount: payout,
          status: 'APPROVED',
          note: `Airtime to Cash (${NETWORKS[existing.network] || existing.network} ${naira(received)})`,
          reviewedByAdminId: req.admin.adminId,
          reviewedAt: new Date(),
        },
      });
      await tx.auditLog.create({
        data: {
          actorAdminId: req.admin.adminId,
          action: 'AIRTIME_CASH_APPROVED',
          details: { requestId: existing.id, customerId: existing.customerId, requested: Number(existing.amount), received, payout },
        },
      });
      return tx.airtimeCashRequest.findUnique({ where: { id: existing.id } });
    });

    const shortNote = received < Number(existing.amount) ? ` We received ${naira(received)} of the ${naira(existing.amount)} requested.` : '';
    notify(existing.customerId, 'Airtime to Cash Approved', `${naira(payout)} has been added to your wallet.${shortNote}`);

    res.json({ request });
  } catch (error) {
    if (error.code === 'ALREADY_REVIEWED') return res.status(400).json({ error: 'This request has already been reviewed.' });
    console.error('POST /admin/airtime-cash/:id/approve failed:', error);
    res.status(500).json({ error: 'Could not approve this request.' });
  }
});

router.post('/admin/airtime-cash/:id/reject', requireAdminAuth, async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    if (!reason) return res.status(400).json({ error: 'Please give the customer a reason.' });

    const flipped = await prisma.airtimeCashRequest.updateMany({
      where: { id: req.params.id, status: 'PENDING' },
      data: { status: 'REJECTED', adminNote: reason, reviewedByAdminId: req.admin.adminId, reviewedAt: new Date() },
    });
    if (flipped.count === 0) return res.status(400).json({ error: 'This request was not found or has already been reviewed.' });

    const request = await prisma.airtimeCashRequest.findUnique({ where: { id: req.params.id } });
    await prisma.auditLog.create({
      data: { actorAdminId: req.admin.adminId, action: 'AIRTIME_CASH_REJECTED', details: { requestId: request.id, customerId: request.customerId, reason } },
    });
    notify(request.customerId, 'Airtime to Cash Rejected', `Your ${naira(request.amount)} request was not approved: ${reason}`);

    res.json({ request });
  } catch (error) {
    console.error('POST /admin/airtime-cash/:id/reject failed:', error);
    res.status(500).json({ error: 'Could not reject this request.' });
  }
});

module.exports = router;
