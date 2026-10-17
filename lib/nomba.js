const crypto = require('crypto');
const prisma = require('./prisma');
const { getSettings, invalidateSettings } = require('./vtpass');
const { notify } = require('./notify');

// Nomba: personal account numbers ("virtual accounts") for wallet
// funding, and Send to Bank (transfers) as another payout partner.
// Keys come from Admin → Settings → Wallet funding → Nomba; if none are
// saved there, these environment variables are used instead:
//   NOMBA_CLIENT_ID, NOMBA_CLIENT_SECRET, NOMBA_ACCOUNT_ID (parent account),
//   NOMBA_WEBHOOK_KEY (webhook signature key), NOMBA_MODE = sandbox | live
// Money safety (same rules as Monnify/Squad):
//  • a payment is only credited from a webhook signed with our webhook
//    key (HMAC-SHA256) — cross-checked with Nomba's API when it answers —
//    or from Nomba's own API answer;
//  • WalletTransaction.providerRef ("NB-<sessionId or id>") is unique,
//    so the same payment can't be credited twice;
//  • a transfer is only treated as failed when Nomba says REFUND (their
//    rule) — or when Nomba has no record of it at all after 10 minutes.
// Customers never see the partner's name.

const BASE_URLS = { sandbox: 'https://sandbox.nomba.com', live: 'https://api.nomba.com' };
const clean = (v) => String(v || '').trim();
const r2 = (n) => Math.round(Number(n) * 100) / 100;

class NombaError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function getConfig() {
  const s = await getSettings();
  const admin = clean(s.nombaClientId);
  const pick = (k, env) => (admin ? clean(s[k]) : clean(process.env[env]));
  let mode = admin ? s.nombaMode : clean(process.env.NOMBA_MODE);
  if (mode !== 'live') mode = 'sandbox';
  return {
    source: admin ? 'admin' : clean(process.env.NOMBA_CLIENT_ID) ? 'env' : 'none',
    mode,
    baseUrl: BASE_URLS[mode],
    clientId: pick('nombaClientId', 'NOMBA_CLIENT_ID'),
    clientSecret: pick('nombaClientSecret', 'NOMBA_CLIENT_SECRET'),
    accountId: pick('nombaAccountId', 'NOMBA_ACCOUNT_ID'),
    webhookKey: pick('nombaWebhookKey', 'NOMBA_WEBHOOK_KEY'),
  };
}

async function isConfigured() {
  const c = await getConfig();
  return Boolean(c.clientId && c.clientSecret && c.accountId);
}

async function fundingOn() {
  const s = await getSettings();
  return Boolean(s.nombaFundingEnabled) && (await isConfigured());
}

// --- Token -----------------------------------------------------------

let token = null;
let tokenFor = '';
let tokenUntil = 0;

async function getToken(c, force = false) {
  const id = `${c.baseUrl}|${c.clientId}|${c.accountId}`;
  if (!force && token && tokenFor === id && Date.now() < tokenUntil) return token;
  let res;
  try {
    res = await fetch(`${c.baseUrl}/v1/auth/token/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accountId: c.accountId },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new NombaError('Could not reach the payment partner. Please try again.', 502);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.data?.access_token) throw new NombaError(data.description || data.message || 'Could not log in to the payment partner.', res.status || 502, data);
  token = data.data.access_token;
  tokenFor = id;
  const exp = Date.parse(data.data.expiresAt);
  // Refresh a minute early; if the expiry can't be read, keep it 20 minutes.
  tokenUntil = Number.isFinite(exp) && exp > Date.now() + 120000 ? exp - 60000 : Date.now() + 20 * 60000;
  return token;
}

// Returns { status, code, description, data }. Throws NombaError for
// HTTP errors (status = HTTP code; 502 = couldn't reach Nomba).
async function api(method, path, body, { timeoutMs = 30000 } = {}) {
  const c = await getConfig();
  if (!c.clientId || !c.clientSecret || !c.accountId) throw new NombaError('Nomba is not set up yet.', 503);
  const send = async (force) => {
    try {
      return await fetch(`${c.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${await getToken(c, force)}`, accountId: c.accountId, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof NombaError) throw error;
      throw new NombaError('Could not reach the payment partner. Please try again.', 502);
    }
  };
  let res = await send(false);
  if (res.status === 401) res = await send(true);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new NombaError(clean(data.description || data.message) || `Payment partner error (${res.status}).`, res.status, data);
  return { status: res.status, code: data.code, description: clean(data.description || data.message), data: data.data };
}

// --- Account numbers ---------------------------------------------------

const refFor = (customer) => `ZPN-${String(customer.id).replace(/[^A-Za-z0-9-]/g, '')}`.padEnd(16, '0');

function toAccount(d) {
  return { bankName: clean(d.bankName) || 'Nombank MFB', bankCode: '', accountNumber: String(d.bankAccountNumber), accountName: clean(d.bankAccountName) || clean(d.accountName), provider: 'nomba' };
}

// Creates the customer's account number. The BVN/NIN goes straight to
// Nomba (CBN rules) and is not kept by us.
async function createVirtualAccount(customer, { idType, idNumber }) {
  const accountRef = refFor(customer);
  let name = clean(customer.name).slice(0, 64);
  if (name.length < 8) name = `${name} Wallet`.slice(0, 64);
  let data;
  try {
    ({ data } = await api('POST', '/v1/accounts/virtual', {
      accountRef,
      accountName: name,
      ...(idType === 'NIN' ? { nin: String(idNumber) } : { bvn: String(idNumber) }),
    }));
  } catch (error) {
    if (/already|exist|duplicate/i.test(error.message)) {
      ({ data } = await api('GET', `/v1/accounts/virtual/${encodeURIComponent(accountRef)}`));
    } else {
      throw error;
    }
  }
  if (!data?.bankAccountNumber) throw new NombaError('No account number was returned. Please try again later.', 502, data);
  const account = { ...toAccount(data), mode: (await getConfig()).mode };
  const fresh = await prisma.customer.findUnique({ where: { id: customer.id } });
  const others = (Array.isArray(fresh.bankAccounts) ? fresh.bankAccounts : []).filter((a) => a.provider !== 'nomba');
  return prisma.customer.update({
    where: { id: customer.id },
    data: {
      nombaAccountRef: accountRef,
      nombaAccountAt: new Date(),
      bankAccounts: [...others, account],
      ...(fresh.kycType ? {} : { kycType: idType }),
      ...(fresh.bankAccountAt ? {} : { bankAccountAt: new Date() }),
    },
  });
}

// --- Crediting ---------------------------------------------------------

const alerted = new Map();
async function alertOnce(key, title, message) {
  if (alerted.has(key)) return;
  alerted.set(key, Date.now());
  if (alerted.size > 2000) alerted.clear();
  await require('./adminAlert').alertAdmins(title, message, '/admin/settings').catch(() => {});
}

// Nomba's single-transaction lookup. null = Nomba has no such record.
async function fetchTransaction(query) {
  try {
    const { data } = await api('GET', `/v1/transactions/accounts/single?${new URLSearchParams(query)}`);
    return data || null;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

// p: { transactionId, sessionId, amount, accountRef, accountNumber, senderName }
async function creditInflow(p, { source = 'webhook' } = {}) {
  const id = clean(p.transactionId);
  const key = clean(p.sessionId) || id;
  if (!key) return { credited: false, reason: 'missing reference', done: true };
  const refs = [`NB-${key}`, ...(id && id !== key ? [`NB-${id}`] : [])];
  if (await prisma.walletTransaction.findFirst({ where: { providerRef: { in: refs } } })) return { credited: false, reason: 'already credited', done: true };

  let customer = clean(p.accountRef) ? await prisma.customer.findUnique({ where: { nombaAccountRef: clean(p.accountRef) } }) : null;
  if (!customer && p.customerId) customer = await prisma.customer.findUnique({ where: { id: p.customerId } });
  if (!customer) return { credited: false, reason: 'no customer for account', done: false };

  let amount = r2(p.amount);
  if (source === 'webhook' && id) {
    // Cross-check with Nomba's records when they answer.
    const row = await fetchTransaction({ transactionRef: id }).catch(() => undefined);
    if (row) {
      if (row.status && String(row.status).toUpperCase() !== 'SUCCESS') return { credited: false, reason: `status ${row.status}`, done: false };
      if (row.amount !== undefined && r2(row.amount) !== amount) {
        await alertOnce(`mismatch:${key}`, 'Bank payment amount mismatch', `A Nomba payment message said ₦${amount.toLocaleString()} but Nomba's records say ₦${r2(row.amount).toLocaleString()} (ref ${id}, ${customer.name}). Nothing was credited — check it in the Nomba dashboard.`);
        return { credited: false, reason: 'amount mismatch', done: true };
      }
    }
  }
  if (!(amount > 0)) return { credited: false, reason: 'zero amount', done: true };

  const settings = await getSettings();
  const fee = require('./fundingFees').computeFee(amount, settings, 'nomba');
  const net = r2(amount - fee);
  try {
    await prisma.$transaction([
      prisma.walletTransaction.create({
        data: {
          customerId: customer.id,
          type: 'FUND',
          amount: net,
          status: 'APPROVED',
          reference: id || key,
          providerRef: refs[0],
          note: fee > 0 ? `Bank transfer of ₦${amount.toLocaleString()} (₦${fee.toLocaleString()} bank processing fee)` : 'Bank transfer',
          reviewedAt: new Date(),
        },
      }),
      prisma.customer.update({ where: { id: customer.id }, data: { walletBalance: { increment: net } } }),
    ]);
  } catch (error) {
    if (error.code === 'P2002') return { credited: false, reason: 'already credited', done: true };
    throw error;
  }
  notify(customer.id, 'Wallet Funded', fee > 0
    ? `Your bank transfer of ₦${amount.toLocaleString()} was received. Bank processing fee: ₦${fee.toLocaleString()}. ₦${net.toLocaleString()} has been added to your wallet.`
    : `Your bank transfer of ₦${amount.toLocaleString()} was received. ₦${net.toLocaleString()} has been added to your wallet.`);
  require('./circles').onDeposit(customer.id).catch(() => {});
  return { credited: true, customerId: customer.id, amount: net, done: true };
}

// "I've sent money — check now": credits anything the webhook missed.
async function syncCustomerPayments(customer) {
  const acct = (Array.isArray(customer.bankAccounts) ? customer.bankAccounts : []).find((a) => a.provider === 'nomba');
  if (!customer.nombaAccountRef || !acct) return { credited: 0, amount: 0 };
  const from = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
  const { data } = await api('GET', `/v1/transactions/virtual?${new URLSearchParams({ virtual_account: acct.accountNumber, dateFrom: from })}`);
  let credited = 0;
  let amount = 0;
  for (const t of (data?.results || []).slice(0, 30)) {
    if (String(t.status || '').toUpperCase() !== 'SUCCESS') continue;
    if (t.entryType && !/credit/i.test(t.entryType)) continue;
    try {
      const r = await creditInflow({ transactionId: t.id, sessionId: t.sessionId, amount: t.amount, customerId: customer.id }, { source: 'api' });
      if (r.credited) {
        credited += 1;
        amount += r.amount;
      }
    } catch (error) {
      console.error('nomba sync: credit failed for', t.id, error.message);
    }
  }
  return { credited, amount: r2(amount) };
}

// --- Webhook signature -------------------------------------------------

// HMAC-SHA256 (our webhook key) over
// event_type:requestId:userId:walletId:transactionId:type:time:responseCode:timestamp
// → base64, in the "nomba-signature" header.
async function isValidSignature(body, headers) {
  const { webhookKey } = await getConfig();
  const sig = clean(headers?.['nomba-signature'] || headers?.['nomba-sig-value']);
  const ts = clean(headers?.['nomba-timestamp']);
  if (!webhookKey || !sig || !body) return false;
  const m = body.data?.merchant || {};
  const t = body.data?.transaction || {};
  const rc = String(t.responseCode ?? '') === 'null' ? '' : String(t.responseCode ?? '');
  const text = [body.event_type, body.requestId, m.userId, m.walletId, t.transactionId, t.type, t.time, rc, ts].map((x) => (x === undefined || x === null ? '' : String(x))).join(':');
  const expected = Buffer.from(crypto.createHmac('sha256', webhookKey).update(text).digest('base64'));
  const got = Buffer.from(sig);
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

// --- Send to Bank ------------------------------------------------------

let banksCache = null;
let banksAt = 0;
async function listBanks() {
  if (banksCache && Date.now() - banksAt < 24 * 3600e3) return banksCache;
  const { data } = await api('GET', '/v1/transfers/banks');
  const banks = (Array.isArray(data) ? data : []).map((b) => ({ code: String(b.code), name: clean(b.name) })).filter((b) => b.code && b.name).sort((a, b) => a.name.localeCompare(b.name));
  if (banks.length) {
    banksCache = banks;
    banksAt = Date.now();
  }
  return banks;
}

async function lookupAccount(bankCode, accountNumber) {
  const { data } = await api('POST', '/v1/transfers/bank/lookup', { accountNumber: String(accountNumber), bankCode: String(bankCode) });
  if (!clean(data?.accountName)) throw new NombaError('Could not verify that account number.', 400, data);
  return { accountName: clean(data.accountName), accountNumber: clean(data.accountNumber) || String(accountNumber) };
}

// Nomba's words → our transfer states. Only REFUND means it failed.
function stateOf(status) {
  const s = clean(status).toUpperCase();
  if (s === 'SUCCESS') return 'SUCCESS';
  if (s === 'REFUND') return 'FAILED';
  if (s === 'REVERSED_BY_VENDOR') return 'REVERSED';
  return 'PROCESSING';
}

async function sendTransfer({ reference, amount, bankCode, accountNumber, accountName, narration }) {
  try {
    const r = await api('POST', '/v2/transfers/bank', {
      amount: r2(amount),
      accountNumber: String(accountNumber),
      accountName: String(accountName),
      bankCode: String(bankCode),
      merchantTxRef: reference,
      senderName: 'ZAPPI PAY',
      narration: String(narration || 'ZappiPay transfer').slice(0, 60),
    }, { timeoutMs: 60000 });
    if (r.status === 201) return { state: 'PROCESSING', description: 'Processing' };
    return { state: stateOf(r.data?.status), description: r.description || null };
  } catch (error) {
    if (!(error instanceof NombaError)) throw error;
    // A "duplicate reference" means a transfer with it already exists — never refund on that.
    if (/duplicate/i.test(error.message)) return { state: 'PROCESSING', description: 'Checking with the bank' };
    // Clear refusals — nothing was sent.
    if ([400, 401, 403, 404, 429].includes(error.status)) return { state: 'FAILED', description: error.message, refused: true };
    throw error;
  }
}

async function requeryTransfer(reference, { createdAt } = {}) {
  const row = await fetchTransaction({ merchantTxRef: reference });
  if (!row) {
    const oldEnough = !createdAt || Date.now() - new Date(createdAt).getTime() > 10 * 60 * 1000;
    return oldEnough ? { state: 'FAILED', description: 'Transfer was not created by the bank partner.' } : { state: 'PROCESSING', description: null };
  }
  if (String(row.status || '').toUpperCase() === 'CANCELLED') {
    await alertOnce(`cancelled:${reference}`, 'Bank transfer cancelled by Nomba', `Nomba marked transfer ${reference} as CANCELLED. Contact Nomba support to confirm whether the money left; the app has not refunded the customer.`);
  }
  return { state: stateOf(row.status), description: clean(row.gatewayMessage) || null };
}

async function walletBalance() {
  const { data } = await api('GET', '/v1/accounts/balance', null, { timeoutMs: 20000 });
  const n = Number(data?.amount);
  if (!Number.isFinite(n)) throw new NombaError('Nomba balance could not be read.', 502, data);
  return r2(n);
}

// --- Admin -------------------------------------------------------------

const mask = (v) => (v ? `${'•'.repeat(8)}${String(v).slice(-4)}` : null);
const webhookUrl = () => `${(process.env.PUBLIC_API_URL || 'https://zappi-pay-backend.onrender.com').replace(/\/$/, '')}/api/webhooks/nomba`;

async function status() {
  const s = await getSettings();
  const c = await getConfig();
  const accounts = await prisma.customer.count({ where: { nombaAccountRef: { not: null } } }).catch(() => 0);
  return {
    nombaFundingEnabled: Boolean(s.nombaFundingEnabled),
    mode: c.mode,
    source: c.source,
    keys: { clientId: mask(c.clientId), clientSecret: mask(c.clientSecret), accountId: mask(c.accountId), webhookKey: mask(c.webhookKey) },
    ready: await isConfigured(),
    accounts,
    webhookUrl: webhookUrl(),
    fundingFeePercent: s.nombaFundingFeePercent === null || s.nombaFundingFeePercent === undefined ? '' : Number(s.nombaFundingFeePercent),
    fundingFeeCap: s.nombaFundingFeeCap === null || s.nombaFundingFeeCap === undefined ? '' : Number(s.nombaFundingFeeCap),
  };
}

async function updateSettings(b = {}) {
  const data = {};
  if (b.nombaFundingEnabled !== undefined) data.nombaFundingEnabled = Boolean(b.nombaFundingEnabled);
  if (b.mode !== undefined) {
    if (!['sandbox', 'live'].includes(b.mode)) throw new NombaError('Mode must be sandbox or live.', 400);
    data.nombaMode = b.mode;
  }
  try {
    const f = require('./fundingFees').parseFee(b);
    if ('fundingFeePercent' in f) data.nombaFundingFeePercent = f.fundingFeePercent;
    if ('fundingFeeCap' in f) data.nombaFundingFeeCap = f.fundingFeeCap;
  } catch (e) {
    throw new NombaError(e.message, 400);
  }
  const key = (v, label, re) => {
    const x = clean(v);
    if (x && (!re.test(x) || /\s/.test(x))) throw new NombaError(`That doesn’t look like a Nomba ${label}.`, 400);
    return x || null;
  };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (b.clientId !== undefined) data.nombaClientId = key(b.clientId, 'client ID', /^.{20,64}$/);
  if (b.clientSecret !== undefined) data.nombaClientSecret = key(b.clientSecret, 'client secret', /^.{20,100}$/);
  if (b.accountId !== undefined) data.nombaAccountId = key(b.accountId, 'account ID (a long code with dashes)', UUID);
  if (b.webhookKey !== undefined) data.nombaWebhookKey = key(b.webhookKey, 'webhook signature key', /^.{8,200}$/);
  const after = { ...(await getSettings()), ...data };
  if (after.nombaFundingEnabled) {
    const ok = clean(after.nombaClientId) ? clean(after.nombaClientSecret) && clean(after.nombaAccountId) : clean(process.env.NOMBA_CLIENT_ID);
    if (!ok) throw new NombaError('Save your Nomba client ID, client secret and account ID before turning Nomba on.', 400);
    if (!clean(after.nombaWebhookKey) && !clean(process.env.NOMBA_WEBHOOK_KEY)) throw new NombaError('Save your Nomba webhook signature key first, so payments can be checked.', 400);
  }
  if (Object.keys(data).length) {
    const s = await getSettings();
    await prisma.settings.update({ where: { id: s.id }, data });
    invalidateSettings();
    token = null;
  }
  return status();
}

async function testConnection() {
  const c = await getConfig();
  if (!c.clientId || !c.clientSecret || !c.accountId) return { ok: false, error: 'Client ID, client secret and account ID are all needed.' };
  try {
    token = null;
    await getToken(c, true);
    const balance = await walletBalance().catch(() => null);
    return { ok: true, mode: c.mode, source: c.source, balance };
  } catch (error) {
    return { ok: false, mode: c.mode, source: c.source, error: error.message };
  }
}

module.exports = {
  NombaError,
  getConfig,
  isConfigured,
  fundingOn,
  api,
  refFor,
  createVirtualAccount,
  creditInflow,
  syncCustomerPayments,
  isValidSignature,
  listBanks,
  lookupAccount,
  stateOf,
  sendTransfer,
  requeryTransfer,
  walletBalance,
  status,
  updateSettings,
  testConnection,
};
