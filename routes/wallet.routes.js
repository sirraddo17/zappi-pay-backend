const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');
const { getSettings } = require('../lib/vtpass');
const { notify } = require('../lib/notify');

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
    const settings = await getSettings();
    const minFunding = Number(settings.minFundingAmount);
    if (amountNum < minFunding) {
      return res.status(400).json({ error: `Minimum funding amount is ₦${minFunding}.` });
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

    notify(existing.customerId, 'Wallet Funded', `Your wallet was credited ₦${Number(existing.amount).toLocaleString()}.`);

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

    notify(existing.customerId, 'Funding Request Rejected', `Your ₦${Number(existing.amount).toLocaleString()} funding request was rejected. Contact support if you have questions.`);

    res.json({ transaction });
  } catch (error) {
    console.error('POST /admin/wallet/:id/reject failed:', error);
    res.status(500).json({ error: 'Could not reject request.' });
  }
});

// Looks up a ZappiPay customer by phone or username, without
// exposing anything beyond their name — used before a transfer is
// confirmed so the sender can see who they're actually paying.
router.get('/wallet/lookup', requireCustomerAuth, async (req, res) => {
  try {
    const { identifier } = req.query;
    if (!identifier) return res.status(400).json({ error: 'identifier is required.' });
    const trimmed = identifier.trim();
    const recipient = await prisma.customer.findFirst({
      where: { OR: [{ phone: trimmed }, { username: trimmed.toLowerCase() }] },
      select: { id: true, name: true },
    });
    if (!recipient || recipient.id === req.customer.customerId) {
      return res.status(404).json({ error: 'No ZappiPay user found with that phone number or username.' });
    }
    res.json({ recipient });
  } catch (error) {
    console.error('GET /wallet/lookup failed:', error);
    res.status(500).json({ error: 'Could not look up recipient.' });
  }
});

// Wallet-to-wallet transfer between two ZappiPay customers. Fully
// internal — no external payment provider involved, so this works
// regardless of the Monnify integration's status.
router.post('/wallet/transfer', requireCustomerAuth, async (req, res) => {
  try {
    const { identifier, amount, note } = req.body;
    const amountNum = Number(amount);
    if (!identifier || !amountNum || amountNum <= 0) {
      return res.status(400).json({ error: 'identifier and a positive amount are required.' });
    }

    const trimmed = identifier.trim();
    const receiver = await prisma.customer.findFirst({
      where: { OR: [{ phone: trimmed }, { username: trimmed.toLowerCase() }] },
    });
    if (!receiver) return res.status(404).json({ error: 'No ZappiPay user found with that phone number or username.' });
    if (receiver.id === req.customer.customerId) {
      return res.status(400).json({ error: 'You cannot send money to yourself.' });
    }

    const sender = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    if (Number(sender.walletBalance) < amountNum) {
      return res.status(400).json({ error: 'Insufficient wallet balance.' });
    }

    const [transfer] = await prisma.$transaction([
      prisma.transfer.create({
        data: { senderId: sender.id, receiverId: receiver.id, amount: amountNum, note: note || undefined },
      }),
      prisma.customer.update({ where: { id: sender.id }, data: { walletBalance: { decrement: amountNum } } }),
      prisma.customer.update({ where: { id: receiver.id }, data: { walletBalance: { increment: amountNum } } }),
      prisma.walletTransaction.create({
        data: {
          customerId: sender.id,
          type: 'TRANSFER_OUT',
          amount: amountNum,
          status: 'APPROVED',
          note: `Sent to ${receiver.name}`,
        },
      }),
      prisma.walletTransaction.create({
        data: {
          customerId: receiver.id,
          type: 'TRANSFER_IN',
          amount: amountNum,
          status: 'APPROVED',
          note: `Received from ${sender.name}`,
        },
      }),
    ]);

    notify(receiver.id, 'Money Received', `${sender.name} sent you ₦${amountNum.toLocaleString()}.`);
    notify(sender.id, 'Money Sent', `You sent ₦${amountNum.toLocaleString()} to ${receiver.name}.`);

    res.status(201).json({ transfer });
  } catch (error) {
    console.error('POST /wallet/transfer failed:', error);
    res.status(500).json({ error: 'Could not complete transfer.' });
  }
});

module.exports = router;
