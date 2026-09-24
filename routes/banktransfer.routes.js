const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');
const { confirmTransaction } = require('../lib/security');
const monnify = require('../lib/monnify');
const d = require('../lib/disbursement');

// Send to Bank (wallet → any Nigerian bank account).
const router = express.Router();

function fail(res, error, fallback) {
  if (error instanceof d.TransferError) return res.status(error.status).json({ error: error.message, code: error.code });
  if (error instanceof monnify.MonnifyError && error.status && error.status < 500) {
    return res.status(400).json({ error: error.message });
  }
  console.error(fallback, error.message || error);
  return res.status(502).json({ error: fallback });
}

// --- Customer ------------------------------------------------------

router.get('/wallet/bank-transfer/config', requireCustomerAuth, async (req, res) => {
  try {
    const cfg = await d.transferSettings();
    const available = cfg.enabled && Boolean(cfg.walletAccount) && (await monnify.isConfigured());
    res.json({ available, fee: cfg.fee, min: cfg.min, max: cfg.max, dailyMax: cfg.dailyMax });
  } catch (error) {
    fail(res, error, 'Could not load transfer settings.');
  }
});

router.get('/banks', requireCustomerAuth, async (req, res) => {
  try {
    res.json({ banks: await d.listBanks() });
  } catch (error) {
    fail(res, error, 'Could not load the list of banks.');
  }
});

// Name enquiry — light per-customer throttle so it can't be used to
// scrape account names.
const lookups = new Map();
router.get('/wallet/bank-transfer/lookup', requireCustomerAuth, async (req, res) => {
  try {
    const bankCode = String(req.query.bankCode || '').trim();
    const accountNumber = String(req.query.accountNumber || '').replace(/\D/g, '');
    if (!bankCode || accountNumber.length !== 10) return res.status(400).json({ error: 'Choose a bank and enter the 10-digit account number.' });

    const id = req.customer.customerId;
    const now = Date.now();
    const recent = (lookups.get(id) || []).filter((t) => now - t < 10 * 60 * 1000);
    if (recent.length >= 30) return res.status(429).json({ error: 'Too many account checks. Please wait a few minutes.' });
    lookups.set(id, [...recent, now]);

    res.json(await d.lookupAccount(bankCode, accountNumber));
  } catch (error) {
    if (error instanceof monnify.MonnifyError && error.status && error.status < 500) {
      console.warn('Bank lookup failed:', error.message); return res.status(400).json({ error: `We could not find that account. (${error.message})` });
    }
    fail(res, error, 'Could not check that account right now.');
  }
});

router.post('/wallet/bank-transfer', requireCustomerAuth, async (req, res) => {
  try {
    const { bankCode, accountNumber, amount, narration } = req.body || {};
    const cleanNumber = String(accountNumber || '').replace(/\D/g, '');
    if (!bankCode || cleanNumber.length !== 10) return res.status(400).json({ error: 'Choose a bank and enter the 10-digit account number.' });
    if (!(Number(amount) > 0)) return res.status(400).json({ error: 'Enter an amount to send.' });

    const confirmation = await confirmTransaction(req);
    if (!confirmation.ok) return res.status(confirmation.status).json({ error: confirmation.error, code: confirmation.code });

    const result = await d.sendToBank(req.customer.customerId, { bankCode, accountNumber: cleanNumber, amount, narration });
    res.status(201).json({ transfer: d.publicTransfer(result.transfer), pending: result.pending });
  } catch (error) {
    fail(res, error, 'Could not send the transfer right now.');
  }
});

router.get('/wallet/bank-transfers', requireCustomerAuth, async (req, res) => {
  try {
    await d.refreshCustomerPending(req.customer.customerId).catch(() => {});
    const transfers = await prisma.bankTransfer.findMany({
      where: { customerId: req.customer.customerId },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    res.json({ transfers: transfers.map(d.publicTransfer) });
  } catch (error) {
    fail(res, error, 'Could not load your bank transfers.');
  }
});

// --- Admin ---------------------------------------------------------

router.get('/admin/bank-transfers', requireAdminAuth, async (req, res) => {
  try {
    const status = String(req.query.status || '').toUpperCase();
    const transfers = await prisma.bankTransfer.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { customer: { select: { id: true, name: true, phone: true } } },
    });
    const waiting = await prisma.bankTransfer.count({ where: { status: 'PENDING_AUTHORIZATION' } });
    res.json({ transfers, waiting });
  } catch (error) {
    fail(res, error, 'Could not load bank transfers.');
  }
});

async function loadTransfer(req, res) {
  const t = await prisma.bankTransfer.findUnique({ where: { id: req.params.id } });
  if (!t) res.status(404).json({ error: 'Transfer not found.' });
  return t;
}

async function audit(req, action, t, extra) {
  await prisma.auditLog.create({
    data: { actorAdminId: req.admin.adminId, action, details: { transferId: t.id, reference: t.reference, amount: String(t.amount), ...extra } },
  }).catch(() => {});
}

router.post('/admin/bank-transfers/:id/authorize', requireAdminAuth, async (req, res) => {
  try {
    const t = await loadTransfer(req, res);
    if (!t) return;
    if (t.status !== 'PENDING_AUTHORIZATION') return res.status(400).json({ error: 'This transfer is not waiting for an OTP.' });
    const otp = String(req.body?.otp || '').trim();
    if (!otp) return res.status(400).json({ error: 'Enter the OTP Monnify sent to your email.' });
    const result = await d.authorizeWithOtp(t, otp);
    await audit(req, 'BANK_TRANSFER_AUTHORIZED', t, { result: result.status });
    res.json({ status: result.status });
  } catch (error) {
    fail(res, error, 'Could not authorize the transfer.');
  }
});

router.post('/admin/bank-transfers/:id/resend-otp', requireAdminAuth, async (req, res) => {
  try {
    const t = await loadTransfer(req, res);
    if (!t) return;
    await d.resendOtp(t);
    res.json({ ok: true });
  } catch (error) {
    fail(res, error, 'Could not resend the OTP.');
  }
});

router.post('/admin/bank-transfers/:id/check', requireAdminAuth, async (req, res) => {
  try {
    const t = await loadTransfer(req, res);
    if (!t) return;
    const result = await d.refreshStatus(t);
    res.json({ status: result.status });
  } catch (error) {
    fail(res, error, 'Could not check the transfer status.');
  }
});

// Admin gives up on a transfer still waiting for OTP → refund customer.
router.post('/admin/bank-transfers/:id/cancel', requireAdminAuth, async (req, res) => {
  try {
    const t = await loadTransfer(req, res);
    if (!t) return;
    if (t.status !== 'PENDING_AUTHORIZATION') return res.status(400).json({ error: 'Only transfers waiting for an OTP can be cancelled.' });
    const result = await d.finalize(t, 'CANCELLED', 'Cancelled by ZappiPay.');
    await audit(req, 'BANK_TRANSFER_CANCELLED', t, {});
    res.json({ status: result.status });
  } catch (error) {
    fail(res, error, 'Could not cancel the transfer.');
  }
});

module.exports = router;
