const crypto = require('crypto');
const prisma = require('./prisma');
const { getSettings, invalidateSettings } = require('./vtpass');
const { notify } = require('./notify');

// Squad (GTCO): personal GTBank account numbers ("static virtual
// accounts") that fund a customer's wallet automatically — same idea
// as Monnify reserved accounts, cheaper per payment.
// Keys come from Admin → Settings → Wallet funding → Squad; if no key
// is saved there, these environment variables are used instead:
//   SQUAD_SECRET_KEY   sandbox_sk_… (test) or sk_… (live)
//   SQUAD_MODE         sandbox | live
// Money safety (same rules as Monnify):
//  • a payment is only credited from a message signed with OUR secret
//    key (HMAC-SHA512) or from Squad's own API answer;
//  • WalletTransaction.providerRef is unique ("SQ-<ref>"), so the same
//    payment can't be credited twice however many times it arrives;
//  • frozen payments (Squad's fraud hold) are never credited — the
//    owner is alerted instead.
// Customers never see the partner's name — just "GTBank".

const BASE_URLS = { sandbox: 'https://sandbox-api-d.squadco.com', live: 'https://api-d.squadco.com' };
const clean = (v) => String(v || '').trim();
const r2 = (n) => Math.round(Number(n) * 100) / 100;

class SquadError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function getConfig() {
  const s = await getSettings();
  const adminKey = clean(s.squadSecretKey);
  const secretKey = adminKey || clean(process.env.SQUAD_SECRET_KEY);
  let mode = adminKey ? s.squadMode : clean(process.env.SQUAD_MODE);
  if (mode !== 'live' && mode !== 'sandbox') mode = /^sandbox_/i.test(secretKey) ? 'sandbox' : secretKey ? 'live' : 'sandbox';
  return {
    source: adminKey ? 'admin' : secretKey ? 'env' : 'none',
    mode,
    baseUrl: BASE_URLS[mode],
    secretKey,
    beneficiaryAccount: clean(s.squadBeneficiaryAccount).replace(/\D/g, ''),
  };
}

async function isConfigured() {
  return Boolean((await getConfig()).secretKey);
}

// Squad switched on in admin AND keys present.
async function fundingOn() {
  const s = await getSettings();
  return Boolean(s.squadFundingEnabled) && (await isConfigured());
}

async function api(method, path, body, { timeoutMs = 30000 } = {}) {
  const c = await getConfig();
  if (!c.secretKey) throw new SquadError('Squad is not set up yet.', 503);
  let res;
  try {
    res = await fetch(`${c.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${c.secretKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new SquadError('Could not reach the payment partner. Please try again.', 502);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const msg = data.message || `Payment partner error (${res.status}).`;
    throw new SquadError(Array.isArray(msg) ? msg.join(' ') : String(msg), res.status || 502, data);
  }
  return data.data;
}

// --- Account numbers ----------------------------------------------

// Squad's customer ID for us. Letters and numbers only.
function identifierFor(customer) {
  return `ZP${String(customer.id).replace(/[^A-Za-z0-9]/g, '')}`;
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '', middle: '' };
  if (parts.length === 1) return { first: parts[0], last: parts[0], middle: '' };
  return { first: parts[0], last: parts[parts.length - 1], middle: parts.slice(1, -1).join(' ') };
}

// Nigerian number as 11 digits (080…), which is what Squad wants.
function localPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('234') && d.length === 13) return `0${d.slice(3)}`;
  if (d.length === 10) return `0${d}`;
  return d;
}

function fmtDob(date, order) {
  const d = new Date(date);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return order === 'dmy' ? `${dd}/${mm}/${yyyy}` : `${mm}/${dd}/${yyyy}`;
}

function toAccount(data, fallbackName) {
  const name = clean(data?.account_name) || [data?.first_name, data?.last_name].filter(Boolean).join(' ') || fallbackName;
  return { bankName: 'GTBank', bankCode: String(data?.bank_code || '058'), accountNumber: String(data.virtual_account_number), accountName: name, provider: 'squad' };
}

// Plain-words reasons for Squad's refusals.
function friendly(error) {
  const m = String(error.message || '');
  if (error.status === 424 || /bvn|identity|mismatch|match/i.test(m)) {
    return 'Your details don’t match your BVN. Your first name, last name, date of birth and phone number must be exactly as on your BVN.';
  }
  return m;
}

// Creates the customer's GTBank account number. The BVN goes straight
// to Squad (CBN rules) and is not kept by us.
async function createVirtualAccount(customer, { bvn, dateOfBirth, gender, address, phone, firstName, lastName, middleName }) {
  const c = await getConfig();
  const identifier = identifierFor(customer);
  const names = splitName(customer.name);
  const body = {
    first_name: clean(firstName) || names.first,
    last_name: clean(lastName) || names.last,
    ...(clean(middleName) || names.middle ? { middle_name: clean(middleName) || names.middle } : {}),
    mobile_num: localPhone(phone || customer.phone),
    email: customer.email || `${customer.id}@customers.zappipay.com.ng`,
    bvn: String(bvn),
    gender: gender === 'female' || gender === '2' ? '2' : '1',
    address: clean(address).slice(0, 200),
    customer_identifier: identifier,
    ...(c.beneficiaryAccount.length === 10 ? { beneficiary_account: c.beneficiaryAccount } : {}),
  };
  let data;
  const create = (order) => api('POST', '/virtual-account', { ...body, dob: fmtDob(dateOfBirth, order) });
  try {
    try {
      data = await create('mdy');
    } catch (error) {
      // Squad's docs disagree on the date order; try the other one once.
      if (error.status === 400 && /dob|date/i.test(error.message)) data = await create('dmy');
      else throw error;
    }
  } catch (error) {
    // Already made earlier (e.g. our save failed last time) — fetch it.
    if (/already|exist|duplicate/i.test(error.message)) {
      data = await api('GET', `/virtual-account/${encodeURIComponent(identifier)}`);
    } else {
      throw new SquadError(friendly(error), error.status, error.body);
    }
  }
  if (!data?.virtual_account_number) throw new SquadError('No account number was returned. Please try again later.', 502, data);
  const account = toAccount(data, customer.name);
  const fresh = await prisma.customer.findUnique({ where: { id: customer.id } });
  const others = (Array.isArray(fresh.bankAccounts) ? fresh.bankAccounts : []).filter((a) => a.provider !== 'squad');
  return prisma.customer.update({
    where: { id: customer.id },
    // GTBank first: it's the cheapest way for us to receive money.
    data: { squadAccountRef: identifier, squadAccountAt: new Date(), bankAccounts: [account, ...others], ...(fresh.kycType ? {} : { kycType: 'BVN' }), ...(fresh.bankAccountAt ? {} : { bankAccountAt: new Date() }) },
  });
}

// --- Crediting -----------------------------------------------------

const isFrozen = (p) => Boolean(p?.meta && (clean(p.meta.freeze_transaction_ref) || clean(p.meta.reason_for_frozen_transaction)));

// The single place a Squad payment credits a wallet. `p` is either a
// signed webhook body or a row from Squad's own API.
async function creditPayment(p, { source = 'webhook' } = {}) {
  const ref = clean(p?.transaction_reference);
  if (!ref) return { credited: false, reason: 'missing reference', done: true };
  if (p.transaction_indicator && String(p.transaction_indicator).toUpperCase() !== 'C') return { credited: false, reason: 'not a credit', done: true };
  if (p.currency && String(p.currency).toUpperCase() !== 'NGN') return { credited: false, reason: 'not naira', done: true };
  const providerRef = `SQ-${ref}`;
  if (await prisma.walletTransaction.findUnique({ where: { providerRef } })) return { credited: false, reason: 'already credited', done: true };

  const customer = clean(p.customer_identifier) ? await prisma.customer.findUnique({ where: { squadAccountRef: clean(p.customer_identifier) } }) : null;
  if (!customer) return { credited: false, reason: 'no customer for account', done: false };

  const amount = r2(p.principal_amount ?? p.amount);
  if (!(amount > 0)) return { credited: false, reason: 'zero amount', done: true };

  if (isFrozen(p)) {
    await alertOnce(`frozen:${ref}`, 'Bank payment frozen by Squad', `₦${amount.toLocaleString()} from ${p.sender_name || 'a sender'} to ${customer.name}'s GTBank account was FROZEN by Squad (${p.meta.reason_for_frozen_transaction || 'fraud check'}). It was NOT added to the wallet. Ref ${ref}. Check with Squad, then fund the wallet manually if they release it.`);
    return { credited: false, reason: 'frozen', done: true };
  }

  // Webhook: cross-check the amount with Squad's API when it answers.
  if (source === 'webhook') {
    const row = await findCustomerTransaction(clean(p.customer_identifier), ref).catch(() => null);
    if (row && r2(row.principal_amount ?? row.amount) !== amount) {
      await alertOnce(`mismatch:${ref}`, 'Bank payment amount mismatch', `A Squad payment message said ₦${amount.toLocaleString()} but Squad's records say ₦${r2(row.principal_amount ?? row.amount).toLocaleString()} (ref ${ref}, ${customer.name}). Nothing was credited — check it in the Squad dashboard.`);
      return { credited: false, reason: 'amount mismatch', done: true };
    }
  }

  const settings = await getSettings();
  const fee = require('./monnify').computeFee(amount, settings);
  const net = r2(amount - fee);
  try {
    await prisma.$transaction([
      prisma.walletTransaction.create({
        data: {
          customerId: customer.id,
          type: 'FUND',
          amount: net,
          status: 'APPROVED',
          reference: ref,
          providerRef,
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

const alerted = new Map();
async function alertOnce(key, title, message) {
  if (alerted.has(key)) return;
  alerted.set(key, Date.now());
  if (alerted.size > 2000) alerted.clear();
  await require('./adminAlert').alertAdmins(title, message, '/admin/settings').catch(() => {});
}

// Squad's answers come in a few shapes; pull out the list.
function rowsOf(data) {
  if (Array.isArray(data)) return data;
  for (const k of ['rows', 'transactions', 'data', 'items']) if (Array.isArray(data?.[k])) return data[k];
  return [];
}

async function customerTransactions(identifier) {
  return rowsOf(await api('GET', `/virtual-account/customer/transactions/${encodeURIComponent(identifier)}`));
}

async function findCustomerTransaction(identifier, ref) {
  if (!identifier) return null;
  return (await customerTransactions(identifier)).find((t) => clean(t.transaction_reference) === ref) || null;
}

// "I've sent money — check now": credits anything the webhook missed.
async function syncCustomerPayments(customer) {
  if (!customer.squadAccountRef) return { credited: 0, amount: 0 };
  let credited = 0;
  let amount = 0;
  for (const t of (await customerTransactions(customer.squadAccountRef)).slice(0, 30)) {
    try {
      const r = await creditPayment({ customer_identifier: customer.squadAccountRef, ...t }, { source: 'api' });
      if (r.credited) {
        credited += 1;
        amount += r.amount;
      }
    } catch (error) {
      console.error('squad sync: credit failed for', t.transaction_reference, error.message);
    }
  }
  return { credited, amount: r2(amount) };
}

// Squad keeps webhooks we didn't answer properly in an error log. Go
// through it, credit what's due, and clear what's been handled.
async function processMissedWebhooks() {
  if (!(await isConfigured())) return { checked: 0, credited: 0 };
  const data = await api('GET', '/virtual-account/webhook/logs?page=1&perPage=100');
  const rows = rowsOf(data);
  let credited = 0;
  for (const row of rows) {
    let payload = row.payload;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { payload = null; }
    }
    if (!payload) continue;
    try {
      // The log is fetched from Squad's API with our key, so it's trusted.
      const r = await creditPayment(payload, { source: 'api' });
      if (r.credited) credited += 1;
      if (r.done) await deleteLog(row.transaction_ref || payload.transaction_reference);
    } catch (error) {
      console.error('squad missed webhook failed:', row.transaction_ref, error.message);
    }
  }
  return { checked: rows.length, credited };
}

async function deleteLog(ref) {
  if (!ref) return;
  try {
    await api('DELETE', `/virtual-account/webhook/logs/${encodeURIComponent(ref)}`);
  } catch (error) {
    if (error.status === 404 || error.status === 405) await api('GET', `/virtual-account/webhook/logs/${encodeURIComponent(ref)}`).catch(() => {});
  }
}

function startSweeper() {
  if (process.env.DISABLE_SCHEDULER === '1') return;
  const run = () => processMissedWebhooks().then((r) => { if (r.credited) console.log('Squad missed payments credited:', r.credited); }).catch((e) => { if (e.status !== 503) console.error('squad sweep failed:', e.message); });
  setTimeout(run, 3 * 60 * 1000).unref?.();
  setInterval(run, 10 * 60 * 1000).unref?.();
}

// --- Webhook signature ---------------------------------------------

// x-squad-signature = HMAC-SHA512(secret key, body), hex. Squad's own
// samples hash the re-serialised JSON, so accept either form.
async function isValidSignature(rawBody, parsedBody, signature) {
  const { secretKey } = await getConfig();
  const sig = clean(signature).toLowerCase();
  if (!secretKey || !sig) return false;
  const candidates = [];
  if (rawBody) candidates.push(rawBody);
  if (parsedBody && typeof parsedBody === 'object') candidates.push(Buffer.from(JSON.stringify(parsedBody)));
  return candidates.some((body) => {
    const expected = Buffer.from(crypto.createHmac('sha512', secretKey).update(body).digest('hex'));
    const got = Buffer.from(sig);
    return expected.length === got.length && crypto.timingSafeEqual(expected, got);
  });
}

// --- Admin ---------------------------------------------------------

const mask = (v) => (v ? `${'•'.repeat(8)}${String(v).slice(-4)}` : null);
const webhookUrl = () => `${(process.env.PUBLIC_API_URL || 'https://zappi-pay-backend.onrender.com').replace(/\/$/, '')}/api/webhooks/squad`;

async function status() {
  const s = await getSettings();
  const c = await getConfig();
  const accounts = await prisma.customer.count({ where: { squadAccountRef: { not: null } } }).catch(() => 0);
  return {
    squadFundingEnabled: Boolean(s.squadFundingEnabled),
    squadPrimary: Boolean(s.squadPrimary),
    mode: c.mode,
    source: c.source,
    secretKey: mask(c.secretKey),
    beneficiaryAccount: c.beneficiaryAccount || '',
    accounts,
    webhookUrl: webhookUrl(),
  };
}

async function updateSettings(b = {}) {
  const data = {};
  if (b.squadFundingEnabled !== undefined) data.squadFundingEnabled = Boolean(b.squadFundingEnabled);
  if (b.squadPrimary !== undefined) data.squadPrimary = Boolean(b.squadPrimary);
  if (b.mode !== undefined) {
    if (!['sandbox', 'live'].includes(b.mode)) throw new SquadError('Mode must be sandbox or live.', 400);
    data.squadMode = b.mode;
  }
  if (b.secretKey !== undefined) {
    const k = clean(b.secretKey);
    if (k && (k.length < 20 || /\s/.test(k))) throw new SquadError('That doesn’t look like a Squad secret key.', 400);
    data.squadSecretKey = k || null;
    if (k && b.mode === undefined) data.squadMode = /^sandbox_/i.test(k) ? 'sandbox' : 'live';
  }
  if (b.beneficiaryAccount !== undefined) {
    const n = String(b.beneficiaryAccount || '').replace(/\D/g, '');
    if (n && n.length !== 10) throw new SquadError('The GTBank settlement account must be 10 digits (or leave it empty).', 400);
    data.squadBeneficiaryAccount = n || null;
  }
  const after = { ...(await getSettings()), ...data };
  if (after.squadFundingEnabled && !clean(after.squadSecretKey) && !clean(process.env.SQUAD_SECRET_KEY)) {
    throw new SquadError('Save your Squad secret key before turning Squad on.', 400);
  }
  if (Object.keys(data).length) {
    const s = await getSettings();
    await prisma.settings.update({ where: { id: s.id }, data });
    invalidateSettings();
  }
  return status();
}

async function testConnection() {
  const c = await getConfig();
  if (!c.secretKey) return { ok: false, error: 'No Squad secret key saved yet.' };
  const hints = [];
  if (/^sandbox_/i.test(c.secretKey) && c.mode === 'live') hints.push('This is a SANDBOX key but mode is Live — switch mode to Sandbox.');
  if (!/^sandbox_/i.test(c.secretKey) && c.mode === 'sandbox') hints.push('This looks like a LIVE key but mode is Sandbox — switch mode to Live.');
  try {
    await api('GET', '/merchant/balance?currency_id=NGN', null, { timeoutMs: 20000 });
    return { ok: true, mode: c.mode, source: c.source, hints };
  } catch (error) {
    return { ok: false, mode: c.mode, source: c.source, error: error.message, hints };
  }
}

// Sandbox only: pretend someone paid into an account number.
async function simulatePayment(accountNumber, amount) {
  const c = await getConfig();
  if (c.mode !== 'sandbox') throw new SquadError('Test payments only work in sandbox mode.', 400);
  return api('POST', '/virtual-account/simulate/payment', { virtual_account_number: String(accountNumber), amount: String(amount) });
}

module.exports = {
  SquadError,
  getConfig,
  isConfigured,
  fundingOn,
  api,
  identifierFor,
  splitName,
  localPhone,
  fmtDob,
  createVirtualAccount,
  creditPayment,
  syncCustomerPayments,
  processMissedWebhooks,
  startSweeper,
  isValidSignature,
  status,
  updateSettings,
  testConnection,
  simulatePayment,
};
