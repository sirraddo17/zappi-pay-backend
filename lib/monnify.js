const crypto = require('crypto');
const prisma = require('./prisma');
const { getSettings } = require('./vtpass');
const { notify } = require('./notify');

// Monnify: personal bank account numbers ("reserved accounts") that
// fund a customer's wallet automatically. Keys come from Admin →
// Settings → Monnify; if no API key is saved there, these Render
// environment variables are used instead:
//   MONNIFY_BASE_URL       https://sandbox.monnify.com (test) or https://api.monnify.com (live)
//   MONNIFY_API_KEY, MONNIFY_SECRET_KEY, MONNIFY_CONTRACT_CODE
// Nothing here is shown to customers by name — the app just says
// "bank transfer" so other providers can be added later.

const BASE_URLS = { sandbox: 'https://sandbox.monnify.com', live: 'https://api.monnify.com' };
const clean = (v) => String(v || '').trim();

async function getConfig() {
  const s = await getSettings();
  if (clean(s.monnifyApiKey)) {
    return {
      source: 'admin',
      mode: s.monnifyMode === 'live' ? 'live' : 'sandbox',
      baseUrl: BASE_URLS[s.monnifyMode === 'live' ? 'live' : 'sandbox'],
      apiKey: clean(s.monnifyApiKey),
      secretKey: clean(s.monnifySecretKey),
      contractCode: clean(s.monnifyContractCode),
    };
  }
  const baseUrl = clean(process.env.MONNIFY_BASE_URL || BASE_URLS.sandbox).replace(/\/$/, '');
  return {
    source: 'env',
    mode: baseUrl.includes('sandbox') ? 'sandbox' : 'live',
    baseUrl,
    apiKey: clean(process.env.MONNIFY_API_KEY),
    secretKey: clean(process.env.MONNIFY_SECRET_KEY),
    contractCode: clean(process.env.MONNIFY_CONTRACT_CODE),
  };
}

async function isConfigured() {
  const c = await getConfig();
  return Boolean(c.apiKey && c.secretKey && c.contractCode);
}

class MonnifyError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// Token cache is tied to the keys it was issued for, so changing keys
// in Admin → Settings takes effect on the very next request.
let cachedToken = null;
let tokenExpiresAt = 0;
let tokenFor = '';

async function getToken(c) {
  const id = `${c.baseUrl}|${c.apiKey}|${c.secretKey}`;
  if (cachedToken && tokenFor === id && Date.now() < tokenExpiresAt) return cachedToken;
  const basic = Buffer.from(`${c.apiKey}:${c.secretKey}`).toString('base64');
  const res = await fetch(`${c.baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.requestSuccessful || !data.responseBody?.accessToken) {
    throw new MonnifyError(data.responseMessage || 'Could not log in to payment provider.', res.status, data);
  }
  cachedToken = data.responseBody.accessToken;
  tokenFor = id;
  // Refresh a minute early so a request never goes out with a token
  // that expires mid-flight.
  tokenExpiresAt = Date.now() + Math.max(60, Number(data.responseBody.expiresIn || 3000) - 60) * 1000;
  return cachedToken;
}

async function api(method, path, body) {
  const c = await getConfig();
  const send = async () => fetch(`${c.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await getToken(c)}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let res = await send();
  if (res.status === 401) {
    cachedToken = null;
    res = await send();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.requestSuccessful === false) {
    throw new MonnifyError(data.responseMessage || `Payment provider error (${res.status}).`, res.status, data);
  }
  return data.responseBody;
}

function accountRefFor(customer) {
  return `ZP-${customer.id}`;
}

function cleanAccounts(body) {
  return (body?.accounts || []).map((a) => ({
    bankName: a.bankName,
    bankCode: a.bankCode,
    accountNumber: a.accountNumber,
    accountName: a.accountName,
  }));
}

// Creates the customer's personal account numbers. The BVN/NIN goes
// straight to Monnify (it's required by CBN rules) and is not kept.
async function createReservedAccount(customer, { idType, idNumber }) {
  const accountReference = accountRefFor(customer);
  const body = {
    accountReference,
    accountName: customer.name.slice(0, 60),
    currencyCode: 'NGN',
    contractCode: (await getConfig()).contractCode,
    // Monnify requires an email; customers without one get a
    // placeholder on our own domain.
    customerEmail: customer.email || `${customer.id}@customers.zappipay.com.ng`,
    customerName: customer.name,
    getAllAvailableBanks: true,
    ...(idType === 'NIN' ? { nin: idNumber } : { bvn: idNumber }),
  };
  let result;
  try {
    result = await api('POST', '/api/v2/bank-transfer/reserved-accounts', body);
  } catch (error) {
    // Already created earlier (e.g. the save below failed last time) —
    // just fetch it instead of failing.
    if (/already|exist|duplicate/i.test(error.message)) {
      result = await api('GET', `/api/v2/bank-transfer/reserved-accounts/${encodeURIComponent(accountReference)}`);
    } else {
      throw error;
    }
  }
  const accounts = cleanAccounts(result);
  if (accounts.length === 0) throw new MonnifyError('No account numbers were returned. Please try again later.', 502, result);
  return prisma.customer.update({
    where: { id: customer.id },
    data: { bankAccountRef: accountReference, bankAccounts: accounts, kycType: idType, bankAccountAt: new Date() },
  });
}

function computeFee(amount, settings) {
  const pct = Number(settings.bankFundingFeePercent || 0);
  const cap = Number(settings.bankFundingFeeCap || 0);
  let fee = Math.round(amount * pct) / 100;
  if (cap > 0) fee = Math.min(fee, cap);
  return Math.max(0, Math.min(fee, amount));
}

// The single place a bank payment credits a wallet. Always re-checks
// the payment with Monnify's API (never trusts the webhook body alone),
// and relies on WalletTransaction.providerRef being unique so the same
// payment can't be credited twice, however many times this runs.
async function creditFromTransaction(transactionReference) {
  if (!transactionReference) return { credited: false, reason: 'missing reference' };
  const already = await prisma.walletTransaction.findUnique({ where: { providerRef: transactionReference } });
  if (already) return { credited: false, reason: 'already credited' };

  const txn = await api('GET', `/api/v2/transactions/${encodeURIComponent(transactionReference)}`);
  if (!txn || txn.paymentStatus !== 'PAID') return { credited: false, reason: `status ${txn?.paymentStatus}` };
  if (txn.product?.type !== 'RESERVED_ACCOUNT') return { credited: false, reason: 'not a reserved account payment' };

  const customer = await prisma.customer.findUnique({ where: { bankAccountRef: txn.product.reference } });
  if (!customer) return { credited: false, reason: 'no customer for account' };

  const amountPaid = Number(txn.amountPaid);
  if (!(amountPaid > 0)) return { credited: false, reason: 'zero amount' };
  const settings = await getSettings();
  const fee = computeFee(amountPaid, settings);
  const net = Math.round((amountPaid - fee) * 100) / 100;

  try {
    await prisma.$transaction([
      prisma.walletTransaction.create({
        data: {
          customerId: customer.id,
          type: 'FUND',
          amount: net,
          status: 'APPROVED',
          reference: txn.paymentReference || transactionReference,
          providerRef: transactionReference,
          note: fee > 0 ? `Bank transfer of ₦${amountPaid.toLocaleString()} (₦${fee.toLocaleString()} fee)` : 'Bank transfer',
          reviewedAt: new Date(),
        },
      }),
      prisma.customer.update({ where: { id: customer.id }, data: { walletBalance: { increment: net } } }),
    ]);
  } catch (error) {
    if (error.code === 'P2002') return { credited: false, reason: 'already credited' };
    throw error;
  }

  notify(customer.id, 'Wallet Funded', `Your bank transfer of ₦${amountPaid.toLocaleString()} was received. ₦${net.toLocaleString()} has been added to your wallet.`);
  return { credited: true, customerId: customer.id, amount: net };
}

// Backup for missed webhooks (e.g. the server was asleep): looks at the
// account's recent payments and credits any that haven't been.
async function syncCustomerPayments(customer) {
  if (!customer.bankAccountRef) return { credited: 0 };
  const page = await api(
    'GET',
    `/api/v1/bank-transfer/reserved-accounts/transactions?accountReference=${encodeURIComponent(customer.bankAccountRef)}&page=0&size=20`
  );
  let credited = 0;
  let amount = 0;
  for (const t of page?.content || []) {
    if (t.paymentStatus && t.paymentStatus !== 'PAID') continue;
    try {
      const r = await creditFromTransaction(t.transactionReference);
      if (r.credited) {
        credited += 1;
        amount += r.amount;
      }
    } catch (error) {
      console.error('syncCustomerPayments: credit failed for', t.transactionReference, error.message);
    }
  }
  return { credited, amount };
}

// Webhook signature: HMAC-SHA512 of the raw request body with the
// secret key, sent in the "monnify-signature" header.
async function isValidSignature(rawBody, signature) {
  const { secretKey } = await getConfig();
  if (!secretKey || !rawBody || !signature) return false;
  const expected = crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature).trim().toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Admin "Test connection": logs in with the saved keys and reports
// exactly what's wrong in plain words.
async function testConnection() {
  const c = await getConfig();
  if (!c.apiKey || !c.secretKey || !c.contractCode) {
    return { ok: false, error: 'API key, secret key and contract code are all required.' };
  }
  const hints = [];
  if (/^MK_TEST_/i.test(c.apiKey) && c.mode === 'live') hints.push('Your API key is a TEST key but mode is Live — switch mode to Sandbox.');
  if (/^MK_PROD_/i.test(c.apiKey) && c.mode === 'sandbox') hints.push('Your API key is a LIVE key but mode is Sandbox — switch mode to Live.');
  try {
    cachedToken = null;
    await getToken(c);
    return { ok: true, mode: c.mode, source: c.source };
  } catch (error) {
    return { ok: false, mode: c.mode, source: c.source, error: error.message, hints };
  }
}

module.exports = {
  isConfigured,
  testConnection,
  MonnifyError,
  createReservedAccount,
  creditFromTransaction,
  syncCustomerPayments,
  isValidSignature,
  computeFee,
};
