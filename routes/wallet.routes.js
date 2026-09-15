const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');

const router = express.Router();

// --- Customer-facing ---

router.get('/wallet/balance', requireCustomerAuth, async (req, res) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    if (!customer) return res.status(404).json({ error: 'Account not found.' });
    res.json({ walletBalance: customer.walletBalance });
  } catch (error) {
    console.error('GET /wallet/balance failed:', error);
    res.status(500).json({ error: 'Could not load wallet balance.' });
  }
});

router.get('/wallet/transactions', requireCustomerAuth, async (req, res) => {
  try {
    const transactions = await prisma.walletTransaction.findMany({
      where: { customerId: req.customer.customerId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ transactions });
  } catch (error) {
    console.error('GET /wallet/transactions failed:', error);
    res.status(500).json({ error: 'Could not load transactions.' });
  }
});

// Submits a funding request for admin review — doesn't touch the wallet
// balance itself. The customer has already sent a bank transfer outside
// this app; reference/note are whatever proof they can give (transfer
// reference, sender name, screenshot description). Balance only moves
// once an admin approves it below.
router.post('/wallet/fund-request', requireCustomerAuth, async (req, res) => {
  try {
    const { amount, reference, note } = req.body;
    const amountNum = Number(amount);
    if (!amountNum || amountNum <= 0) {
      return res.status(400).json({ error: 'A positive amount is required.' });
    }

    const transaction = await prisma.walletTransaction.create({
      data: {
        customerId: req.customer.customerId,
        type: 'FUND',
        amount: amountNum,
        status: 'PENDING',
        reference: reference || undefined,
        note: note || undefined,
      },
    });

    res.status(201).json({ transaction });
  } catch (error) {
    console.error('POST /wallet/fund-request failed:', error);
    res.status(500).json({ error: 'Could not submit funding request.' });
  }
});

// --- Admin-facing ---

router.get('/admin/wallet/pending', requireAdminAuth, async (req, res) => {
  try {
    const transactions = await prisma.walletTransaction.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: { customer: { select: { id: true, name: true, phone: true } } },
    });
    res.json({ transactions });
  } catch (error) {
    console.error('GET /admin/wallet/pending failed:', error);
    res.status(500).json({ error: 'Could not load pending requests.' });
  }
});

// Approving is the only thing that actually credits the wallet — done
// as one transaction so a crash between the two writes can never leave
// a transaction marked approved without the balance actually moving,
// or vice versa.
router.post('/admin/wallet/:id/approve', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.walletTransaction.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Funding request not found.' });
    if (existing.status !== 'PENDING') {
      return res.status(400).json({ error: 'This request has already been reviewed.' });
    }

    const [transaction] = await prisma.$transaction([
      prisma.walletTransaction.update({
        where: { id },
        data: { status: 'APPROVED', reviewedByAdminId: req.admin.adminId, reviewedAt: new Date() },
      }),
      prisma.customer.update({
        where: { id: existing.customerId },
        data: { walletBalance: { increment: existing.amount } },
      }),
    ]);

    res.json({ transaction });
  } catch (error) {
    console.error('POST /admin/wallet/:id/approve failed:', error);
    res.status(500).json({ error: 'Could not approve request.' });
  }
});

router.post('/admin/wallet/:id/reject', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.walletTransaction.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Funding request not found.' });
    if (existing.status !== 'PENDING') {
      return res.status(400).json({ error: 'This request has already been reviewed.' });
    }

    const transaction = await prisma.walletTransaction.update({
      where: { id },
      data: { status: 'REJECTED', reviewedByAdminId: req.admin.adminId, reviewedAt: new Date() },
    });

    res.json({ transaction });
  } catch (error) {
    console.error('POST /admin/wallet/:id/reject failed:', error);
    res.status(500).json({ error: 'Could not reject request.' });
  }
});

module.exports = router;
