const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth } = require('../lib/auth');
const { getSettings } = require('../lib/vtpass');
const monnify = require('../lib/monnify');
const { visibleReservedAccounts } = require('../lib/funding');

// Hides banks the admin has paused (network problems) and says how many.
async function shown(accounts) {
  if (!Array.isArray(accounts)) return { accounts: accounts || null, pausedCount: 0 };
  const visible = visibleReservedAccounts(accounts, await getSettings());
  return { accounts: visible, pausedCount: accounts.length - visible.length };
}

// Automatic wallet funding by bank transfer: each customer gets their
// own account number; money sent to it lands in their wallet.
const router = express.Router();

function identityHash(idType, idNumber) {
  const secret = process.env.KYC_HASH_SECRET || process.env.JWT_SECRET || 'zappipay';
  return require('crypto').createHmac('sha256', secret).update(`${idType}:${idNumber}`).digest('hex');
}

async function feeInfo() {
  const s = await getSettings();
  return { feePercent: Number(s.bankFundingFeePercent || 0), feeCap: Number(s.bankFundingFeeCap || 0), feeIsPassThrough: require('../lib/earnings').fundingFeeIsPassThrough(s) };
}

router.get('/wallet/bank-account', requireCustomerAuth, async (req, res) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    res.json({
      available: await monnify.isConfigured(),
      ...(await shown(customer.bankAccounts)),
      kycType: customer.kycType || null,
      idMatch: Boolean((await getSettings()).idMatchEnabled),
      hasDob: Boolean(customer.dateOfBirth),
      ...(await feeInfo()),
    });
  } catch (error) {
    console.error('GET /wallet/bank-account failed:', error);
    res.status(500).json({ error: 'Could not load your bank account details.' });
  }
});

router.post('/wallet/bank-account', requireCustomerAuth, async (req, res) => {
  try {
    if (!(await monnify.isConfigured())) return res.status(503).json({ error: 'Bank transfer funding is not available yet.' });
    const idType = String(req.body.idType || '').toUpperCase();
    const idNumber = String(req.body.idNumber || '').replace(/\D/g, '');
    if (!['BVN', 'NIN'].includes(idType)) return res.status(400).json({ error: 'Choose BVN or NIN.' });
    if (idNumber.length !== 11) return res.status(400).json({ error: `Your ${idType} must be 11 digits.` });

    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    if (customer.bankAccounts) return res.json({ ...(await shown(customer.bankAccounts)), kycType: customer.kycType });

    // One BVN/NIN = one ZAPPI PAY account. Only a keyed hash is kept,
    // never the number. Claim it first so two sign-ups can't race.
    const kycHash = identityHash(idType, idNumber);
    const other = await prisma.customer.findFirst({ where: { kycHash, NOT: { id: customer.id } }, select: { id: true } });
    if (other) {
      return res.status(409).json({ error: `This ${idType} is already linked to another ZAPPI PAY account. Each person can have only one account — contact support if this is a mistake.`, code: 'IDENTITY_IN_USE' });
    }

    // Name + date of birth must match the BVN/NIN (when switched on).
    const settings = await getSettings();
    let verifiedDob = null;
    if (settings.idMatchEnabled) {
      if (!req.body.consent) return res.status(400).json({ error: `Tick the box to let us check your name and date of birth with your ${idType}.`, code: 'CONSENT_NEEDED' });
      let dob = customer.dateOfBirth;
      if (!dob) {
        const parsed = require('../lib/identity').parseDob(req.body.dateOfBirth);
        if (parsed.error) return res.status(400).json({ error: parsed.error, code: 'DOB_NEEDED' });
        dob = parsed.date;
      }
      const idCheck = require('../lib/idCheck');
      try {
        await idCheck.verify(customer, { idType, idNumber, dateOfBirth: dob });
      } catch (e) {
        if (e instanceof idCheck.IdCheckError) return res.status(e.status).json({ error: e.message, code: e.code });
        throw e;
      }
      verifiedDob = dob;
    }
    try {
      await prisma.customer.update({ where: { id: customer.id }, data: { kycHash } });
    } catch (error) {
      if (error.code === 'P2002') return res.status(409).json({ error: `This ${idType} is already linked to another ZAPPI PAY account.`, code: 'IDENTITY_IN_USE' });
      throw error;
    }
    let updated;
    try {
      updated = await monnify.createReservedAccount(customer, { idType, idNumber });
    } catch (error) {
      // Not verified after all — free the identity again.
      await prisma.customer.update({ where: { id: customer.id }, data: { kycHash: null } }).catch(() => {});
      throw error;
    }
    if (verifiedDob) {
      // Name and date of birth now match the ID — lock them.
      await prisma.customer.update({ where: { id: customer.id }, data: { kycVerifiedAt: new Date(), ...(customer.dateOfBirth ? {} : { dateOfBirth: verifiedDob }) } }).catch((e) => console.warn('kyc lock failed:', e.message));
    }
    res.status(201).json({ ...(await shown(updated.bankAccounts)), kycType: updated.kycType, verified: Boolean(verifiedDob) });
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
    if (!customer.bankAccountRef || !(await monnify.isConfigured())) return res.json({ credited: 0, amount: 0 });
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
    if (!(await monnify.isValidSignature(req.rawBody, req.headers['monnify-signature']))) {
      console.warn('Monnify webhook rejected: bad signature');
      return res.status(401).json({ error: 'Invalid signature.' });
    }
    const { eventType, eventData } = req.body || {};
    if (eventType === 'SUCCESSFUL_TRANSACTION' && eventData?.product?.type === 'RESERVED_ACCOUNT') {
      const result = await monnify.creditFromTransaction(eventData.transactionReference);
      console.log('Monnify webhook:', eventData.transactionReference, JSON.stringify(result));
    }
    // Send-to-Bank results. The body is only a hint — refreshStatus asks
    // Monnify's API for the real status before anything is refunded.
    if (/_DISBURSEMENT$/.test(String(eventType || '')) && eventData?.reference) {
      const transfer = await prisma.bankTransfer.findUnique({ where: { reference: String(eventData.reference) } });
      if (transfer) {
        const result = await require('../lib/disbursement').refreshStatus(transfer);
        console.log('Monnify disbursement webhook:', transfer.reference, eventType, JSON.stringify(result));
      }
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('POST /webhooks/monnify failed:', error.message);
    res.status(500).json({ error: 'Processing failed.' });
  }
});

module.exports = router;
