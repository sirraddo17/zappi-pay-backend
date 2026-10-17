const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth } = require('../lib/auth');
const { getSettings } = require('../lib/vtpass');
const monnify = require('../lib/monnify');
const squad = require('../lib/squad');
const nomba = require('../lib/nomba');
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

// Admin switch: bank-transfer funding off = no new account numbers shown.
// Money already sent to an existing account number is still credited.
async function monnifyOn() {
  return (await getSettings()).monnifyFundingEnabled !== false && (await monnify.isConfigured());
}

async function feeInfo() {
  const s = await getSettings();
  // Top-level fee = Monnify's (older app versions); feeByProvider = each partner's.
  return { feePercent: Number(s.bankFundingFeePercent || 0), feeCap: Number(s.bankFundingFeeCap || 0), feeIsPassThrough: require('../lib/earnings').fundingFeeIsPassThrough(s), feeByProvider: require('../lib/fundingFees').publicFees(s) };
}

// Which partner new account numbers come from: Squad (GTBank) when the
// owner made it the main one (or Monnify is off), else Monnify.
async function providers() {
  const [m, q, n, s] = await Promise.all([monnifyOn(), squad.fundingOn(), nomba.fundingOn(), getSettings()]);
  const on = { monnify: m, squad: q, nomba: n };
  let primary = on[s.fundingPrimary] ? s.fundingPrimary : null;
  if (!primary) primary = q && (s.squadPrimary || !m) ? 'squad' : m ? 'monnify' : q ? 'squad' : n ? 'nomba' : null;
  return { ...on, primary };
}

router.get('/wallet/bank-account', requireCustomerAuth, async (req, res) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    const p = await providers();
    res.json({
      available: Boolean(p.primary),
      provider: p.primary,
      // Already has (Monnify) account numbers: can add a GTBank one too.
      squadAddable: p.squad && !customer.squadAccountRef && Array.isArray(customer.bankAccounts) && customer.bankAccounts.length > 0,
      nombaAddable: p.nomba && !customer.nombaAccountRef && Array.isArray(customer.bankAccounts) && customer.bankAccounts.length > 0,
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
    const p = await providers();
    if (req.body?.provider === 'squad' || (!req.body?.provider && p.primary === 'squad')) {
      if (!p.squad) return res.status(503).json({ error: 'This option is not available right now. Please use another way to fund.' });
      return await createSquadAccount(req, res);
    }
    if (req.body?.provider === 'nomba' || (!req.body?.provider && p.primary === 'nomba')) {
      if (!p.nomba) return res.status(503).json({ error: 'This option is not available right now. Please use another way to fund.' });
      return await createNombaAccount(req, res);
    }
    if (!(await monnifyOn())) return res.status(503).json({ error: 'Bank transfer funding is not available right now. Please use another way to fund.' });
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
    if (settings.idMatchEnabled && !(customer.kycVerifiedAt && customer.kycHash === kycHash)) {
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
    // Invited friend just verified: welcome cashback (lib/referralPlus.js).
    require('../lib/referralPlus').payWelcome(customer.id).catch(() => {});
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
    const result = { credited: 0, amount: 0 };
    const add = (r) => { result.credited += r.credited || 0; result.amount += r.amount || 0; };
    if (customer.bankAccountRef && (await monnify.isConfigured())) add(await monnify.syncCustomerPayments(customer).catch((e) => { console.error('monnify sync:', e.message); return {}; }));
    if (customer.nombaAccountRef && (await nomba.isConfigured())) add(await nomba.syncCustomerPayments(customer).catch((e) => { console.error('nomba sync:', e.message); return {}; }));
    if (customer.squadAccountRef && (await squad.isConfigured())) add(await squad.syncCustomerPayments(customer).catch((e) => { console.error('squad sync:', e.message); return {}; }));
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
      require('../lib/attackWatch').record('WEBHOOK_BAD_SIGNATURE', req, { detail: 'Someone sent a payment message that was not signed by Monnify. It was rejected — no money moved.' });
      return res.status(401).json({ error: 'Invalid signature.' });
    }
    const { eventType, eventData } = req.body || {};
    if (eventType === 'SUCCESSFUL_TRANSACTION' && eventData?.product?.type === 'RESERVED_ACCOUNT') {
      const result = await monnify.creditFromTransaction(eventData.transactionReference);
      console.log('Monnify webhook:', eventData.transactionReference, JSON.stringify(result));
    }
    // Direct pay (straight to the receiver's bank).
    if (eventType === 'SUCCESSFUL_TRANSACTION' && String(eventData?.paymentReference || '').startsWith('DP-')) {
      const result = await require('../lib/directPay').confirm(eventData.paymentReference);
      console.log('Monnify direct-pay webhook:', eventData.paymentReference, JSON.stringify(result));
    }
    // Pay-by-card checkouts (re-verified with Monnify before anything is credited).
    if (eventType === 'SUCCESSFUL_TRANSACTION' && String(eventData?.paymentReference || '').startsWith('CHK-')) {
      const result = await require('../lib/checkout').confirm(eventData.paymentReference);
      console.log('Monnify checkout webhook:', eventData.paymentReference, JSON.stringify(result));
    }
    // Event-ticket checkouts (re-verified with Monnify before tickets are issued).
    if (eventType === 'SUCCESSFUL_TRANSACTION' && String(eventData?.paymentReference || '').startsWith('TKT-')) {
      const result = await require('../lib/tickets').confirm(eventData.paymentReference);
      console.log('Monnify ticket webhook:', eventData.paymentReference, JSON.stringify(result));
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

// GTBank account number through Squad. Squad needs the BVN (not NIN)
// and checks it strictly against name, date of birth and phone.
async function createSquadAccount(req, res) {
  const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
  if (customer.squadAccountRef) return res.json({ ...(await shown(customer.bankAccounts)), kycType: customer.kycType });
  const bvn = String(req.body.idNumber || req.body.bvn || '').replace(/\D/g, '');
  if (String(req.body.idType || 'BVN').toUpperCase() !== 'BVN') return res.status(400).json({ error: 'This account needs your BVN.' });
  if (bvn.length !== 11) return res.status(400).json({ error: 'Your BVN must be 11 digits.' });
  const gender = String(req.body.gender || '').toLowerCase();
  if (!['male', 'female'].includes(gender)) return res.status(400).json({ error: 'Choose male or female (as on your BVN).', code: 'GENDER_NEEDED' });
  const address = String(req.body.address || '').trim();
  if (address.length < 5) return res.status(400).json({ error: 'Enter your home address (street and town).', code: 'ADDRESS_NEEDED' });
  const phone = squad.localPhone(req.body.phone || customer.phone);
  if (!/^0\d{10}$/.test(phone)) return res.status(400).json({ error: 'Enter the phone number linked to your BVN (11 digits).', code: 'PHONE_NEEDED' });
  if (!req.body.consent) return res.status(400).json({ error: 'Tick the box to let us check your details with your BVN.', code: 'CONSENT_NEEDED' });
  let dob = customer.dateOfBirth;
  if (!dob) {
    const parsed = require('../lib/identity').parseDob(req.body.dateOfBirth);
    if (parsed.error) return res.status(400).json({ error: parsed.error, code: 'DOB_NEEDED' });
    dob = parsed.date;
  }

  // One BVN = one ZAPPI PAY account (only a keyed hash is kept).
  const kycHash = identityHash('BVN', bvn);
  const other = await prisma.customer.findFirst({ where: { kycHash, NOT: { id: customer.id } }, select: { id: true } });
  if (other) return res.status(409).json({ error: 'This BVN is already linked to another ZAPPI PAY account. Each person can have only one account — contact support if this is a mistake.', code: 'IDENTITY_IN_USE' });
  let claimed = false;
  if (!customer.kycHash) {
    try {
      await prisma.customer.update({ where: { id: customer.id }, data: { kycHash } });
      claimed = true;
    } catch (error) {
      if (error.code === 'P2002') return res.status(409).json({ error: 'This BVN is already linked to another ZAPPI PAY account.', code: 'IDENTITY_IN_USE' });
      throw error;
    }
  }
  let updated;
  try {
    updated = await squad.createVirtualAccount(customer, { bvn, dateOfBirth: dob, gender, address, phone });
  } catch (error) {
    if (claimed) await prisma.customer.update({ where: { id: customer.id }, data: { kycHash: null } }).catch(() => {});
    console.error('Squad account failed:', error.message, JSON.stringify(error.body || {}));
    if (error instanceof squad.SquadError && error.status && error.status < 500) return res.status(400).json({ error: `Could not create your account: ${error.message}` });
    return res.status(502).json({ error: 'Could not create your account number right now. Please try again shortly.' });
  }
  // Squad accepted the BVN with this name, date of birth and phone → verified.
  await prisma.customer.update({ where: { id: customer.id }, data: { kycVerifiedAt: customer.kycVerifiedAt || new Date(), ...(customer.dateOfBirth ? {} : { dateOfBirth: dob }) } }).catch((e) => console.warn('kyc lock failed:', e.message));
  require('../lib/referralPlus').payWelcome(customer.id).catch(() => {});
  return res.status(201).json({ ...(await shown(updated.bankAccounts)), kycType: updated.kycType, verified: true });
}

// Nomba account number. Takes BVN or NIN (like Monnify).
async function createNombaAccount(req, res) {
  const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
  if (customer.nombaAccountRef) return res.json({ ...(await shown(customer.bankAccounts)), kycType: customer.kycType });
  const idType = String(req.body.idType || '').toUpperCase();
  const idNumber = String(req.body.idNumber || '').replace(/\D/g, '');
  if (!['BVN', 'NIN'].includes(idType)) return res.status(400).json({ error: 'Choose BVN or NIN.' });
  if (idNumber.length !== 11) return res.status(400).json({ error: `Your ${idType} must be 11 digits.` });

  const kycHash = identityHash(idType, idNumber);
  const other = await prisma.customer.findFirst({ where: { kycHash, NOT: { id: customer.id } }, select: { id: true } });
  if (other) return res.status(409).json({ error: `This ${idType} is already linked to another ZAPPI PAY account. Each person can have only one account — contact support if this is a mistake.`, code: 'IDENTITY_IN_USE' });

  const settings = await getSettings();
  let verifiedDob = null;
  // Already passed with this same BVN/NIN → no need to check (or pay) again.
  if (settings.idMatchEnabled && !(customer.kycVerifiedAt && customer.kycHash === kycHash)) {
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
  let claimed = false;
  if (!customer.kycHash) {
    try {
      await prisma.customer.update({ where: { id: customer.id }, data: { kycHash } });
      claimed = true;
    } catch (error) {
      if (error.code === 'P2002') return res.status(409).json({ error: `This ${idType} is already linked to another ZAPPI PAY account.`, code: 'IDENTITY_IN_USE' });
      throw error;
    }
  }
  let updated;
  try {
    updated = await nomba.createVirtualAccount(customer, { idType, idNumber });
  } catch (error) {
    if (claimed) await prisma.customer.update({ where: { id: customer.id }, data: { kycHash: null } }).catch(() => {});
    console.error('Nomba account failed:', error.message, JSON.stringify(error.body || {}));
    if (error instanceof nomba.NombaError && error.status && error.status < 500) return res.status(400).json({ error: `Could not create your account: ${error.message}` });
    return res.status(502).json({ error: 'Could not create your account number right now. Please try again shortly.' });
  }
  if (verifiedDob) {
    await prisma.customer.update({ where: { id: customer.id }, data: { kycVerifiedAt: customer.kycVerifiedAt || new Date(), ...(customer.dateOfBirth ? {} : { dateOfBirth: verifiedDob }) } }).catch((e) => console.warn('kyc lock failed:', e.message));
  }
  require('../lib/referralPlus').payWelcome(customer.id).catch(() => {});
  return res.status(201).json({ ...(await shown(updated.bankAccounts)), kycType: updated.kycType, verified: Boolean(verifiedDob) });
}

// Nomba → us: money into an account number, or a transfer result.
// Signature-checked with our webhook key. Non-2xx makes Nomba retry
// (5 more times over about 1.5 hours).
router.post('/webhooks/nomba', async (req, res) => {
  try {
    if (!(await nomba.isValidSignature(req.body, req.headers))) {
      // Nomba checks the URL with a test call when the webhook is created.
      // A call with no transaction moves no money, so it gets a 200;
      // anything carrying a transaction must be signed.
      const t0 = req.body?.data?.transaction || {};
      if (!t0.transactionId && !t0.merchantTxRef && !t0.sessionId) return res.json({ ok: true, test: true });
      console.warn('Nomba webhook rejected: bad signature');
      require('../lib/attackWatch').record('WEBHOOK_BAD_SIGNATURE', req, { detail: 'Someone sent a payment message that was not signed by Nomba. It was rejected — no money moved.' });
      return res.status(401).json({ error: 'Invalid signature.' });
    }
    const ev = String(req.body?.event_type || '');
    const t = req.body?.data?.transaction || {};
    if (/^payout_/.test(ev)) {
      const ref = String(t.merchantTxRef || '');
      const transfer = ref ? await prisma.bankTransfer.findUnique({ where: { reference: ref } }) : null;
      if (transfer && transfer.provider === 'nomba') {
        // Only a hint — refreshStatus asks Nomba's API before any refund.
        const r = await require('../lib/disbursement').refreshStatus(transfer);
        console.log('Nomba transfer webhook:', ref, ev, JSON.stringify(r));
      }
      return res.json({ ok: true });
    }
    if (ev === 'payment_success' && (t.aliasAccountReference || t.aliasAccountNumber)) {
      let accountRef = t.aliasAccountReference;
      if (!accountRef && t.aliasAccountNumber) {
        const c = await prisma.customer.findFirst({ where: { nombaAccountRef: { not: null }, bankAccounts: { array_contains: [{ accountNumber: String(t.aliasAccountNumber) }] } }, select: { nombaAccountRef: true } }).catch(() => null);
        accountRef = c?.nombaAccountRef;
      }
      const r = await nomba.creditInflow({ transactionId: t.transactionId, sessionId: t.sessionId, amount: t.transactionAmount, accountRef, accountNumber: t.aliasAccountNumber }, { source: 'webhook' });
      console.log('Nomba webhook:', t.transactionId, JSON.stringify(r));
      if (!r.done) return res.status(500).json({ error: `Not processed: ${r.reason}` });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('POST /webhooks/nomba failed:', error.message);
    res.status(500).json({ error: 'Processing failed.' });
  }
});

// Squad calls this when money lands in a GTBank account number.
// Signature-checked with our secret key. Answering non-200 keeps it in
// Squad's error log, which lib/squad.js re-checks every 10 minutes.
router.post('/webhooks/squad', async (req, res) => {
  const ref = String(req.body?.transaction_reference || '');
  const reply = (code, description) => res.status(code).json({ response_code: code, transaction_reference: ref, response_description: description });
  try {
    if (!(await squad.isValidSignature(req.rawBody, req.body, req.headers['x-squad-signature']))) {
      console.warn('Squad webhook rejected: bad signature');
      require('../lib/attackWatch').record('WEBHOOK_BAD_SIGNATURE', req, { detail: 'Someone sent a payment message that was not signed by Squad. It was rejected — no money moved.' });
      return reply(401, 'Invalid signature');
    }
    // Send-to-Bank result: the body is only a hint — refreshStatus asks
    // Squad's API for the real status before anything is refunded.
    const transfer = ref ? await prisma.bankTransfer.findUnique({ where: { reference: ref } }) : null;
    if (transfer) {
      if (transfer.provider === 'squad') {
        const r = await require('../lib/disbursement').refreshStatus(transfer);
        console.log('Squad transfer webhook:', ref, JSON.stringify(r));
      }
      return reply(200, 'Success');
    }
    const result = await squad.creditPayment(req.body, { source: 'webhook' });
    console.log('Squad webhook:', ref, JSON.stringify(result));
    if (!result.done) return reply(400, `Not processed: ${result.reason}`);
    return reply(200, 'Success');
  } catch (error) {
    console.error('POST /webhooks/squad failed:', error.message);
    return reply(500, 'System malfunction');
  }
});

module.exports = router;
