const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');
const { getSettings } = require('../lib/vtpass');
const { notify } = require('../lib/notify');

const { confirmTransaction } = require('../lib/security');
const { checkDailyLimit } = require('../lib/limits');

const router = express.Router();

// --- Customer-facing ---

// Cashback balance + history (earned, used at checkout, returned).
router.get('/wallet/cashback', requireCustomerAuth, async (req, res) => {
  try {
    const [c, entries, settings] = await Promise.all([
      prisma.customer.findUnique({ where: { id: req.customer.customerId }, select: { cashbackBalance: true } }),
      prisma.cashbackEntry.findMany({ where: { customerId: req.customer.customerId }, orderBy: { createdAt: 'desc' }, take: 30 }),
      require('../lib/vtpass').getSettings(),
    ]);
    res.json({ balance: Number(c?.cashbackBalance || 0), maxPercent: Number(settings.cashbackUseMaxPercent ?? 20), separate: settings.cashbackSeparate !== false, entries: entries.map((e) => ({ id: e.id, amount: Number(e.amount), note: e.note, createdAt: e.createdAt })) });
  } catch (error) {
    console.error('GET /wallet/cashback failed:', error);
    res.status(500).json({ error: 'Could not load your cashback.' });
  }
});

router.get('/wallet/balance', requireCustomerAuth, async (req, res) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    if (!customer) return res.status(404).json({ error: 'Account not found.' });
    res.json({ walletBalance: customer.walletBalance, cashbackBalance: customer.cashbackBalance ?? 0 });
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

// One wallet transaction with what we know about it, for its receipt.
router.get('/wallet/transactions/:id', requireCustomerAuth, async (req, res) => {
  try {
    const t = await prisma.walletTransaction.findUnique({ where: { id: String(req.params.id) } });
    if (!t || t.customerId !== req.customer.customerId) return res.status(404).json({ error: 'Transaction not found.' });
    let bank = null;
    if (t.reference && (t.type === 'TRANSFER_OUT' || t.type === 'REFUND')) {
      const b = await prisma.bankTransfer.findFirst({ where: { reference: t.reference, customerId: t.customerId } }).catch(() => null);
      if (b) bank = { accountName: b.accountName, accountNumber: b.accountNumber, bankName: b.bankName, amount: Number(b.amount), fee: Number(b.fee || 0), status: b.status, narration: b.narration, reference: b.reference, completedAt: b.completedAt };
    }
    res.json({ transaction: { id: t.id, type: t.type, amount: Number(t.amount), status: t.status, note: t.note, reference: t.providerRef || t.reference || t.id, createdAt: t.createdAt }, bank });
  } catch (error) {
    console.error('GET /wallet/transactions/:id failed:', error);
    res.status(500).json({ error: 'Could not load the transaction.' });
  }
});

// Submits a funding request for admin review — doesn't touch the wallet
// balance itself. The customer has already sent a bank transfer outside
// this app; reference/note are whatever proof they can give (transfer
// reference, sender name, screenshot description). Balance only moves
// once an admin approves it below.
router.post('/wallet/fund-request', requireCustomerAuth, async (req, res) => {
  try {
    const { amount, reference, accountId } = req.body;
    let { note } = req.body;
    const amountNum = Number(amount);
    if (!amountNum || amountNum <= 0) {
      return res.status(400).json({ error: 'A positive amount is required.' });
    }
    const settings = await getSettings();
    const accounts = require('../lib/funding').activeManualAccounts(settings);
    if (!accounts.length) {
      return res.status(400).json({ error: 'Manual funding is not available. Please use your personal account number instead.' });
    }
    // Record which business account they paid into, so the admin checks
    // the right bank.
    const paidTo = accounts.find((a) => a.id === accountId) || (accounts.length === 1 ? accounts[0] : null);
    if (paidTo) note = `Paid to ${paidTo.bankName} ${paidTo.accountNumber}${note ? ` — ${String(note).slice(0, 200)}` : ''}`;
    const minFunding = Number(settings.minFundingAmount);
    if (amountNum < minFunding) {
      return res.status(400).json({ error: `Minimum funding amount is ₦${minFunding}.` });
    }
    // Safety rules for money sent to the business account (Admin → Settings).
    const naira = (n) => `₦${Number(n).toLocaleString('en-NG')}`;
    const me = await prisma.customer.findUnique({ where: { id: req.customer.customerId }, select: { kycType: true } });
    if (settings.manualFundingVerifiedOnly !== false && !me?.kycType) {
      return res.status(403).json({ error: 'Verify your BVN or NIN first to use this option. Tap "Get my account number" on this page — it is also the quicker way to fund: money sent there is added automatically.', code: 'VERIFY_FIRST' });
    }
    const cap = Number(settings.manualFundingMaxAmount ?? 50000);
    if (cap > 0 && amountNum > cap) {
      return res.status(400).json({ error: `The most you can add this way is ${naira(cap)} per request. For more, use your personal account number — it has no waiting.` });
    }
    const waiting = await prisma.walletTransaction.findFirst({ where: { customerId: req.customer.customerId, type: 'FUND', status: 'PENDING' }, orderBy: { createdAt: 'desc' } });
    if (waiting) {
      return res.status(409).json({ error: `You already have a ${naira(waiting.amount)} request being checked. Please wait for it — you'll get a notification. Sent more than once? Add it in the note on the next request after this one is done.`, code: 'ALREADY_WAITING' });
    }
    // The same bank reference can only be used once.
    const ref = reference ? String(reference).replace(/\s+/g, '').toUpperCase().slice(0, 80) : null;
    if (ref) {
      const used = await prisma.walletTransaction.findFirst({ where: { type: 'FUND', reference: ref, status: { in: ['PENDING', 'APPROVED'] } }, select: { id: true } });
      if (used) return res.status(409).json({ error: 'That transfer reference has already been used. Check your wallet history, or contact support if this is a new transfer.', code: 'REF_USED' });
    }

    const transaction = await prisma.walletTransaction.create({
      data: {
        customerId: req.customer.customerId,
        type: 'FUND',
        amount: amountNum,
        status: 'PENDING',
        remindedStage: 0,
        reference: ref || undefined,
        note: note || undefined,
      },
    });
    require('../lib/adminAlert').alertAdmins('New funding request', `A customer says they sent ₦${Number(transaction.amount).toLocaleString()} to the business account (ref ${transaction.reference || '—'}). Check your bank and approve or reject.`, '/admin/pending-funding');

    res.status(201).json({ transaction, waitMinutes: Number(settings.manualFundingWaitMinutes || 30) });
  } catch (error) {
    console.error('POST /wallet/fund-request failed:', error);
    res.status(500).json({ error: 'Could not submit funding request.' });
  }
});

// The request still being checked (for the waiting card on the Wallet page).
router.get('/wallet/fund-request/pending', requireCustomerAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    const t = await prisma.walletTransaction.findFirst({ where: { customerId: req.customer.customerId, type: 'FUND', status: 'PENDING' }, orderBy: { createdAt: 'desc' } });
    res.json({ request: t ? { id: t.id, amount: Number(t.amount), reference: t.reference, createdAt: t.createdAt } : null, waitMinutes: Number(settings.manualFundingWaitMinutes || 30) });
  } catch (error) {
    console.error('GET /wallet/fund-request/pending failed:', error);
    res.status(500).json({ error: 'Could not load your request.' });
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
const noAi = (req, res) => (req.headers['x-admin-assistant'] ? res.status(403).json({ error: 'Only a person can approve or reject funding.' }) : null);

router.post('/admin/wallet/:id/approve', requireAdminAuth, async (req, res) => {
  if (noAi(req, res)) return;
  try {
    const { id } = req.params;
    const existing = await prisma.walletTransaction.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Funding request not found.' });
    if (existing.status !== 'PENDING') {
      return res.status(400).json({ error: 'This request has already been reviewed.' });
    }
    // Claim-then-credit in one database transaction: if two admins tap
    // Approve together, only the first one moves money.
    try {
      await prisma.$transaction(async (tx) => {
        const r = await tx.walletTransaction.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'APPROVED', reviewedByAdminId: req.admin.adminId, reviewedAt: new Date() } });
        if (r.count !== 1) throw Object.assign(new Error('This request has already been reviewed.'), { status: 409 });
        await tx.customer.update({ where: { id: existing.customerId }, data: { walletBalance: { increment: existing.amount } } });
      });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      throw error;
    }
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'MANUAL_FUNDING_APPROVED', details: { id, customerId: existing.customerId, amount: Number(existing.amount), reference: existing.reference || undefined } } }).catch(() => {});
    notify(existing.customerId, 'Wallet Funded', `Your transfer was confirmed and ₦${Number(existing.amount).toLocaleString()} has been added to your wallet.`, { category: 'TRANSACTION' });
    require('../lib/circles').onDeposit(existing.customerId).catch(() => {});

    res.json({ transaction: { ...existing, status: 'APPROVED' } });
  } catch (error) {
    console.error('POST /admin/wallet/:id/approve failed:', error);
    res.status(500).json({ error: 'Could not approve request.' });
  }
});

router.post('/admin/wallet/:id/reject', requireAdminAuth, async (req, res) => {
  if (noAi(req, res)) return;
  try {
    const { id } = req.params;
    const reason = String(req.body?.reason || '').trim().slice(0, 200);
    const existing = await prisma.walletTransaction.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Funding request not found.' });
    const r = await prisma.walletTransaction.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'REJECTED', reviewedByAdminId: req.admin.adminId, reviewedAt: new Date(), ...(reason ? { note: `${existing.note ? `${existing.note} · ` : ''}Rejected: ${reason}`.slice(0, 400) } : {}) } });
    if (r.count !== 1) return res.status(400).json({ error: 'This request has already been reviewed.' });
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'MANUAL_FUNDING_REJECTED', details: { id, customerId: existing.customerId, amount: Number(existing.amount), reason: reason || undefined } } }).catch(() => {});
    notify(existing.customerId, 'Funding Request Not Approved', `We couldn't find your ₦${Number(existing.amount).toLocaleString()} transfer${reason ? ` (${reason})` : ''}. If money left your bank, contact support with your receipt.`);

    res.json({ transaction: { ...existing, status: 'REJECTED' } });
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
router.post('/wallet/transfer', requireCustomerAuth, require('../lib/features').gate('sendMoney'), async (req, res) => {
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

    const familyError = await require('../lib/family').checkSend(req.customer.customerId, receiver.id);
    if (familyError) return res.status(403).json({ error: familyError, code: 'FAMILY_LIMIT' });

    const circleLock = await require('../lib/circles').owingLock(req.customer.customerId);
    if (circleLock) return res.status(403).json({ error: circleLock, code: 'CIRCLE_OWING' });

    const confirmation = await confirmTransaction(req);
    if (!confirmation.ok) return res.status(confirmation.status).json({ error: confirmation.error, code: confirmation.code });

    const sender = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    if (Number(sender.walletBalance) < amountNum) {
      return res.status(400).json({ error: 'Insufficient wallet balance.' });
    }
    try {
      await require('../lib/fundsGuard').checkSender(sender, amountNum, await getSettings());
    } catch (e) {
      if (e.code) return res.status(e.status || 403).json({ error: e.message, code: e.code });
      throw e;
    }
    const limitError = await checkDailyLimit(sender, amountNum, await getSettings());
    if (limitError) return res.status(403).json({ error: limitError, code: 'DAILY_LIMIT' });

    // The debit only happens if the balance still covers it, so two
    // quick sends at once can never take the wallet below zero.
    let transfer;
    try {
      transfer = await prisma.$transaction(async (tx) => {
        const debit = await tx.customer.updateMany({ where: { id: sender.id, walletBalance: { gte: amountNum } }, data: { walletBalance: { decrement: amountNum } } });
        if (debit.count !== 1) throw Object.assign(new Error('INSUFFICIENT'), { insufficient: true });
        const t = await tx.transfer.create({ data: { senderId: sender.id, receiverId: receiver.id, amount: amountNum, note: note || undefined } });
        await tx.customer.update({ where: { id: receiver.id }, data: { walletBalance: { increment: amountNum } } });
        await tx.walletTransaction.create({ data: { customerId: sender.id, type: 'TRANSFER_OUT', amount: amountNum, status: 'APPROVED', note: `Sent to ${receiver.name}` } });
        await tx.walletTransaction.create({ data: { customerId: receiver.id, type: 'TRANSFER_IN', amount: amountNum, status: 'APPROVED', note: `Received from ${sender.name}` } });
        return t;
      });
    } catch (e) {
      if (e.insufficient) return res.status(400).json({ error: 'Insufficient wallet balance.' });
      throw e;
    }

    notify(receiver.id, 'Money Received', `${sender.name} sent you ₦${amountNum.toLocaleString()}.`);
    require('../lib/circles').checkOffAppFee({ senderId: sender.id, receiverId: receiver.id, amount: amountNum });
    require('../lib/circles').onDeposit(receiver.id).catch(() => {});
    notify(sender.id, 'Money Sent', `You sent ₦${amountNum.toLocaleString()} to ${receiver.name}.`);
    require('../lib/recovery').worked('send-money', { customerId: sender.id });

    res.status(201).json({ transfer });
  } catch (error) {
    console.error('POST /wallet/transfer failed:', error);
    // A system error (not the customer's): tell them when sending works again.
    require('../lib/recovery').failed({ customerId: req.customer?.customerId, key: 'send-money', label: 'Send money', amount: Number(req.body?.amount) || null, retryLink: '/transfer', reason: 'system error' });
    res.status(500).json({ error: 'Could not complete transfer.' });
  }
});

module.exports = router;
