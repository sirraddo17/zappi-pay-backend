// Connected business apps (e.g. StoreWatch) and their payment requests.
//
// Safety model:
//  - An app key can only CREATE a request and READ its status. It can
//    never move money by itself.
//  - Money moves only when the customer opens the request in ZAPPI PAY
//    and approves it with their PIN (or fingerprint).
//  - Every account name is checked with the bank when the request is
//    made; if the app sent the name it expected and the bank's name is
//    different, the item is flagged on the approval screen.
//  - Each item is paid with the normal Send to Bank rules (limits, KYC,
//    fraud holds, fees, balance check) from the customer's OWN wallet.
//  - Results are posted back to the app's callback URL, signed with a
//    secret only the app knows (HMAC-SHA256 of the raw body).

const crypto = require('crypto');
const prisma = require('./prisma');
const { notify } = require('./notify');

const APP_URL = (process.env.APP_URL || 'https://www.zappipay.com.ng').replace(/\/$/, '');
const MAX_ITEMS = 30;
const EXPIRES_HOURS = 72; // long enough for a weekend batch to be approved on Monday
const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');

class ConnectError extends Error {
  constructor(msg, status = 400, code) { super(msg); this.status = status; this.code = code; }
}

// Signing secret is derived (never stored): server secret + per-app salt.
function signingSecret(app) {
  const base = process.env.CONNECT_SECRET || process.env.JWT_SECRET || 'dev';
  return `whsec_${crypto.createHmac('sha256', base).update(`connected-app:${app.id}:${app.secretSalt}`).digest('base64url')}`;
}
function sign(app, body) {
  return crypto.createHmac('sha256', signingSecret(app)).update(body).digest('hex');
}

function cleanUrl(u) {
  const s = String(u || '').trim();
  if (!s) return null;
  try {
    const url = new URL(s);
    if (url.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) return null;
    return url.toString().slice(0, 500);
  } catch { return null; }
}

// --- Apps (customer side) ---

async function createApp(customerId, { name, callbackUrl } = {}) {
  const n = String(name || '').trim().slice(0, 40);
  if (n.length < 2) throw new ConnectError('Give the app a name, e.g. StoreWatch.');
  const count = await prisma.connectedApp.count({ where: { customerId, revokedAt: null } });
  if (count >= 5) throw new ConnectError('You can connect up to 5 apps. Remove one first.');
  const cb = callbackUrl ? cleanUrl(callbackUrl) : null;
  if (callbackUrl && !cb) throw new ConnectError('The callback URL must start with https://');
  const key = `zpk_live_${crypto.randomBytes(24).toString('base64url')}`;
  const app = await prisma.connectedApp.create({
    data: { customerId, name: n, keyHash: sha(key), keyHint: key.slice(-4), secretSalt: crypto.randomBytes(16).toString('hex'), callbackUrl: cb },
  });
  // Shown once — only the hash is kept.
  return { app: publicApp(app), apiKey: key, signingSecret: signingSecret(app) };
}

function publicApp(a) {
  return { id: a.id, name: a.name, keyHint: a.keyHint, callbackUrl: a.callbackUrl, lastUsedAt: a.lastUsedAt, createdAt: a.createdAt };
}

async function listApps(customerId) {
  const apps = await prisma.connectedApp.findMany({ where: { customerId, revokedAt: null }, orderBy: { createdAt: 'desc' } });
  return apps.map(publicApp);
}

async function revokeApp(customerId, id) {
  const r = await prisma.connectedApp.updateMany({ where: { id, customerId, revokedAt: null }, data: { revokedAt: new Date() } });
  if (!r.count) throw new ConnectError('App not found.', 404);
  // Anything still waiting from that app can no longer be approved.
  await prisma.payoutRequest.updateMany({ where: { appId: id, status: 'AWAITING_APPROVAL' }, data: { status: 'DECLINED', finishedAt: new Date() } });
}

async function updateApp(customerId, id, { callbackUrl } = {}) {
  const cb = callbackUrl ? cleanUrl(callbackUrl) : null;
  if (callbackUrl && !cb) throw new ConnectError('The callback URL must start with https://');
  const r = await prisma.connectedApp.updateMany({ where: { id, customerId, revokedAt: null }, data: { callbackUrl: cb } });
  if (!r.count) throw new ConnectError('App not found.', 404);
}

// --- App authentication (Bearer zpk_live_…) ---

async function appFromKey(header) {
  const h = String(header || '');
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!/^zpk_live_[A-Za-z0-9_-]{20,}$/.test(key)) return null;
  const app = await prisma.connectedApp.findUnique({ where: { keyHash: sha(key) } });
  if (!app || app.revokedAt) return null;
  const owner = await prisma.customer.findUnique({ where: { id: app.customerId }, select: { id: true, active: true } });
  if (!owner || owner.active === false) return null;
  prisma.connectedApp.update({ where: { id: app.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return app;
}

// --- Payment requests ---

async function createRequest(app, body = {}) {
  const d = require('./disbursement');
  const externalRef = String(body.reference || '').trim().slice(0, 80);
  if (!/^[A-Za-z0-9._:-]{4,80}$/.test(externalRef)) throw new ConnectError('reference is required (4–80 letters, numbers, . _ : -) and must be unique for each request.');
  const existing = await prisma.payoutRequest.findUnique({ where: { appId_externalRef: { appId: app.id, externalRef } } });
  if (existing) return { request: await view(existing), duplicate: true };

  const title = String(body.title || '').trim().slice(0, 100) || `Payments from ${app.name}`;
  const raw = Array.isArray(body.items) ? body.items : [];
  if (!raw.length) throw new ConnectError('items must have at least one payment.');
  if (raw.length > MAX_ITEMS) throw new ConnectError(`At most ${MAX_ITEMS} payments per request.`);

  const cfg = await d.transferSettings();
  if (!cfg.enabled) throw new ConnectError('Send to bank is not switched on in ZAPPI PAY yet.', 503, 'TRANSFERS_OFF');
  const banks = await d.listBanks().catch(() => []);

  const items = [];
  for (const [i, x] of raw.entries()) {
    const where = `Payment ${i + 1}`;
    const bankCode = String(x?.bankCode || '').trim();
    const accountNumber = String(x?.accountNumber || '').replace(/\D/g, '');
    const amount = Math.round(Number(x?.amount) * 100) / 100;
    if (!bankCode || accountNumber.length !== 10) throw new ConnectError(`${where}: bankCode and a 10-digit accountNumber are required.`);
    if (!(amount > 0)) throw new ConnectError(`${where}: amount must be more than 0.`);
    if (cfg.min && amount < cfg.min) throw new ConnectError(`${where}: the minimum transfer is ${naira(cfg.min)}.`);
    if (cfg.max && amount > cfg.max) throw new ConnectError(`${where}: the maximum per transfer is ${naira(cfg.max)}. Split it into smaller payments.`);
    let acct;
    try { acct = await d.lookupAccount(bankCode, accountNumber); } catch (e) { throw new ConnectError(`${where}: ${e.message || 'the account could not be checked.'}`); }
    const expectedName = String(x?.accountName || '').trim().slice(0, 100) || null;
    const words = (s) => String(s || '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
    const nameMismatch = expectedName ? !words(expectedName).some((w) => words(acct.accountName).includes(w)) : false;
    items.push({
      label: String(x?.label || '').trim().slice(0, 80) || `Payment ${i + 1}`,
      bankCode,
      bankName: banks.find((b) => b.code === bankCode)?.name || null,
      accountNumber: acct.accountNumber,
      accountName: acct.accountName,
      expectedName,
      nameMismatch,
      amount,
      fee: Number(cfg.feeFor(amount) || 0),
      narration: String(x?.narration || '').trim().slice(0, 60) || title.slice(0, 60),
      meta: x?.meta && typeof x.meta === 'object' ? JSON.parse(JSON.stringify(x.meta).slice(0, 2000)) : undefined,
    });
  }
  const total = items.reduce((a, x) => a + x.amount, 0);
  const fees = items.reduce((a, x) => a + x.fee, 0);
  const req = await prisma.payoutRequest.create({
    data: {
      appId: app.id, customerId: app.customerId, externalRef, title, items, total, fees,
      callbackUrl: cleanUrl(body.callbackUrl) || app.callbackUrl || null,
      returnUrl: cleanUrl(body.returnUrl),
      expiresAt: new Date(Date.now() + EXPIRES_HOURS * 3600 * 1000),
    },
  });
  notify(app.customerId, `${app.name}: approve ${naira(total)}`, `${app.name} sent ${items.length} payment${items.length === 1 ? '' : 's'} to approve (${title}). Nothing is paid until you approve with your PIN.`, { category: 'TRANSACTION', link: `/approve/${req.id}` });
  return { request: await view(req) };
}

async function expireIfDue(r) {
  if (r.status === 'AWAITING_APPROVAL' && new Date(r.expiresAt) < new Date()) {
    await prisma.payoutRequest.updateMany({ where: { id: r.id, status: 'AWAITING_APPROVAL' }, data: { status: 'EXPIRED', finishedAt: new Date() } });
    return { ...r, status: 'EXPIRED' };
  }
  return r;
}

// Live view: per-item status comes from the bank transfer itself, so a
// PROCESSING transfer shows SUCCESS once the bank confirms.
async function view(r0) {
  const r = await expireIfDue(r0);
  const results = Array.isArray(r.results) ? r.results : [];
  const ids = results.map((x) => x.transferId).filter(Boolean);
  const transfers = ids.length ? await prisma.bankTransfer.findMany({ where: { id: { in: ids } } }) : [];
  const d = require('./disbursement');
  const items = (Array.isArray(r.items) ? r.items : []).map((x, i) => {
    const res = results.find((y) => y.index === i) || null;
    const t = res?.transferId ? transfers.find((y) => y.id === res.transferId) : null;
    const pt = t ? d.publicTransfer(t) : null;
    return {
      index: i, label: x.label, bankCode: x.bankCode, bankName: x.bankName, accountNumber: x.accountNumber, accountName: x.accountName,
      expectedName: x.expectedName, nameMismatch: Boolean(x.nameMismatch), amount: x.amount, fee: x.fee, narration: x.narration, meta: x.meta,
      payment: res ? {
        status: pt ? pt.status : res.status, // SUCCESS | PROCESSING | UNDER_REVIEW | FAILED | REVERSED | NOT_SENT
        reference: res.reference || null,
        error: pt?.failureReason || res.error || null,
        completedAt: pt?.completedAt || null,
        receiptUrl: res.walletTxId ? `${APP_URL}/transactions/${res.walletTxId}` : null,
      } : null,
    };
  });
  const app = await prisma.connectedApp.findUnique({ where: { id: r.appId }, select: { name: true } });
  return {
    id: r.id, reference: r.externalRef, app: app?.name || 'App', title: r.title, status: r.status,
    total: Number(r.total), fees: Number(r.fees), totalWithFees: Number(r.total) + Number(r.fees),
    count: items.length, items, approveUrl: `${APP_URL}/approve/${r.id}`, returnUrl: r.returnUrl,
    expiresAt: r.expiresAt, approvedAt: r.approvedAt, finishedAt: r.finishedAt, createdAt: r.createdAt,
  };
}

async function getForApp(app, idOrRef) {
  const r = await prisma.payoutRequest.findFirst({ where: { appId: app.id, OR: [{ id: String(idOrRef) }, { externalRef: String(idOrRef) }] } });
  if (!r) throw new ConnectError('Request not found.', 404);
  return view(r);
}

async function getForCustomer(customerId, id) {
  const r = await prisma.payoutRequest.findFirst({ where: { id: String(id), customerId } });
  if (!r) throw new ConnectError('Request not found.', 404);
  return view(r);
}

async function listForCustomer(customerId) {
  const rows = await prisma.payoutRequest.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, take: 30 });
  return Promise.all(rows.map(view));
}

async function decline(customerId, id) {
  const r = await prisma.payoutRequest.updateMany({ where: { id, customerId, status: 'AWAITING_APPROVAL' }, data: { status: 'DECLINED', finishedAt: new Date() } });
  if (!r.count) throw new ConnectError('This request can’t be declined (already handled or expired).', 409);
  const row = await prisma.payoutRequest.findUnique({ where: { id } });
  callback(row).catch(() => {});
  return view(row);
}

// Approve = pay every item, one after another, with the normal Send to
// Bank checks. Call only after the PIN has been confirmed.
async function approve(customerId, id) {
  const d = require('./disbursement');
  const r0 = await prisma.payoutRequest.findFirst({ where: { id, customerId } });
  if (!r0) throw new ConnectError('Request not found.', 404);
  const r = await expireIfDue(r0);
  if (r.status !== 'AWAITING_APPROVAL') throw new ConnectError(r.status === 'EXPIRED' ? 'This request has expired. Send it again from the app.' : 'This request was already handled.', 409);
  const app = await prisma.connectedApp.findUnique({ where: { id: r.appId } });
  if (!app || app.revokedAt) throw new ConnectError('That app was disconnected.', 409);

  const need = Number(r.total) + Number(r.fees);
  const me = await prisma.customer.findUnique({ where: { id: customerId }, select: { walletBalance: true } });
  if (Number(me?.walletBalance || 0) < need) throw new ConnectError(`Insufficient balance — you need ${naira(need)} (including ${naira(r.fees)} fees) but have ${naira(me?.walletBalance)}.`, 402, 'INSUFFICIENT_BALANCE');

  // Claim it so a double tap can't pay twice.
  const claim = await prisma.payoutRequest.updateMany({ where: { id, status: 'AWAITING_APPROVAL' }, data: { status: 'PROCESSING', approvedAt: new Date() } });
  if (!claim.count) throw new ConnectError('This request was already handled.', 409);

  const results = [];
  for (const [i, x] of (r.items || []).entries()) {
    try {
      const out = await d.sendToBank(customerId, { bankCode: x.bankCode, accountNumber: x.accountNumber, amount: x.amount, narration: x.narration });
      const wt = await prisma.walletTransaction.findFirst({ where: { customerId, reference: out.transfer.reference }, select: { id: true } }).catch(() => null);
      results.push({ index: i, status: d.publicTransfer(out.transfer).status, transferId: out.transfer.id, reference: out.transfer.reference, walletTxId: wt?.id || null });
    } catch (e) {
      results.push({ index: i, status: 'NOT_SENT', error: String(e.message || 'Could not send').slice(0, 200) });
    }
  }
  const sent = results.filter((x) => x.status !== 'NOT_SENT').length;
  const status = sent === results.length ? 'DONE' : sent ? 'PARTIAL' : 'FAILED';
  const row = await prisma.payoutRequest.update({ where: { id }, data: { status, results, finishedAt: new Date() } });
  callback(row).catch(() => {});
  return view(row);
}

// POST the result to the app (best effort, 3 tries).
async function callback(row) {
  if (!row?.callbackUrl) return;
  const app = await prisma.connectedApp.findUnique({ where: { id: row.appId } });
  if (!app) return;
  const body = JSON.stringify({ event: 'payout_request.updated', data: await view(row) });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(row.callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-ZappiPay-Signature': sign(app, body), 'X-ZappiPay-Event': 'payout_request.updated' },
        body,
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
  }
}

module.exports = { ConnectError, createApp, listApps, revokeApp, updateApp, appFromKey, createRequest, getForApp, getForCustomer, listForCustomer, approve, decline, sign, signingSecret, MAX_ITEMS, EXPIRES_HOURS };
