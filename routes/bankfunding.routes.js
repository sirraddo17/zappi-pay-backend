const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth } = require('../lib/auth');
const { getSettings } = require('../lib/vtpass');
const monnify = require('../lib/monnify');

// Automatic wallet funding by bank transfer: each customer gets their
// own account number; money sent to it lands in their wallet.
const router = express.Router();

async function feeInfo() {
  const s = await getSettings();
  return { feePercent: Number(s.bankFundingFeePercent || 0), feeCap: Number(s.bankFundingFeeCap || 0) };
}

router.get('/wallet/bank-account', requireCustomerAuth, async (req, res) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    res.json({
      available: monnify.isConfigured(),
      accounts: customer.bankAccounts || null,
      kycType: customer.kycType || null,
      ...(await feeInfo()),
    });
  } catch (error) {
    console.error('GET /wallet/bank-account failed:', error);
    res.status(500).json({ error: 'Could not load your bank account details.' });
  }
});

router.post('/wallet/bank-account', requireCustomerAuth, async (req, res) => {
  try {
    if (!monnify.isConfigured()) return res.status(503).json({ error: 'Bank transfer funding is not available yet.' });
    const idType = String(req.body.idType || '').toUpperCase();
    const idNumber = String(req.body.idNumber || '').replace(/\D/g, '');
    if (!['BVN', 'NIN'].includes(idType)) return res.status(400).json({ error: 'Choose BVN or NIN.' });
    if (idNumber.length !== 11) return res.status(400).json({ error: `Your ${idType} must be 11 digits.` });

    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    if (customer.bankAccounts) return res.json({ accounts: customer.bankAccounts, kycType: customer.kycType });

    const updated = await monnify.createReservedAccount(customer, { idType, idNumber });
    res.status(201).json({ accounts: updated.bankAccounts, kycType: updated.kycType });
  } catch (error) {
    console.error('POST /wallet/bank-account failed:', error.message, JSON.stringify(error.body || {}));
    if (error instanceof monnify.MonnifyError && error.status && error.status < 500) {
      return res.status(400).json({ error: `Could not create your account: ${error.message}` });
    }
    res.status(502).json({ error: 'Could not create your account number right now. Please try again shortly.' });
  }
});

// "I've sent money" — picks up any payment the webhook missed.
const lastCheck = new Map();
router.post('/wallet/bank-account/check', requireCustomerAuth, async (req, res) => {
  try {
    const id = req.customer.customerId;
    const last = lastCheck.get(id) || 0;
    if (Date.now() - last < 15000) return res.status(429).json({ error: 'Please wait a few seconds before checking again.' });
    lastCheck.set(id, Date.now());

    const customer = await prisma.customer.findUnique({ where: { id } });
    if (!customer.bankAccountRef || !monnify.isConfigured()) return res.json({ credited: 0, amount: 0 });
    const result = await monnify.syncCustomerPayments(customer);
    const fresh = await prisma.customer.findUnique({ where: { id }, select: { walletBalance: true } });
    res.json({ ...result, walletBalance: fresh.walletBalance });
  } catch (error) {
    console.error('POST /wallet/bank-account/check failed:', error.message);
    res.status(502).json({ error: 'Could not check for new payments right now. If you sent money, it will still be credited automatically.' });
  }
});

// Monnify calls this when a payment arrives. Signature-checked, and
// the payment is re-verified with Monnify's API before crediting.
// Answering non-200 on errors makes Monnify retry later.
router.post('/webhooks/monnify', async (req, res) => {
  try {
    if (!monnify.isValidSignature(req.rawBody, req.headers['monnify-signature'])) {
      console.warn('Monnify webhook rejected: bad signature');
      return res.status(401).json({ error: 'Invalid signature.' });
    }
    const { eventType, eventData } = req.body || {};
    if (eventType === 'SUCCESSFUL_TRANSACTION' && eventData?.product?.type === 'RESERVED_ACCOUNT') {
      const result = await monnify.creditFromTransaction(eventData.transactionReference);
      console.log('Monnify webhook:', eventData.transactionReference, JSON.stringify(result));
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('POST /webhooks/monnify failed:', error.message);
    res.status(500).json({ error: 'Processing failed.' });
  }
});

module.exports = router;
