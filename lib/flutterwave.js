// Flutterwave: card and USSD wallet funding (Flutterwave Standard — the
// customer pays on Flutterwave's own secure page, so card details never
// touch ZAPPI PAY). Works alongside Monnify bank transfer; each has its
// own on/off switch in Admin → Settings → Wallet funding.
//
// Safety:
//  - The wallet is credited only after Flutterwave's API confirms the
//    payment (status successful, NGN, amount ≥ what we asked for).
//  - The webhook is checked with the secret hash; its body is only a hint.
//  - CardPayment.status moves PENDING → PAID once, and the wallet row has a
//    unique providerRef, so a payment can never be credited twice.

const crypto = require('crypto');
const fetch = require('node-fetch');
const prisma = require('./prisma');
const { getSettings, invalidateSettings } = require('./vtpass');
const { notify } = require('./notify');

const BASE = 'https://api.flutterwave.com/v3';
const APP_URL = (process.env.APP_URL || 'https://www.zappipay.com.ng').replace(/\/$/, '');
const MAX_AMOUNT = 500000;
const clean = (v) => String(v || '').trim();

class FlutterwaveError extends Error {
  constructor(msg, status = 400, code) { super(msg); this.status = status; this.code = code; }
}

async function config() {
  const s = await getSettings();
  const secretKey = clean(s.flutterwaveSecretKey) || clean(process.env.FLW_SECRET_KEY);
  return {
    secretKey,
    publicKey: clean(s.flutterwavePublicKey) || clean(process.env.FLW_PUBLIC_KEY),
    secretHash: clean(s.flutterwaveSecretHash) || clean(process.env.FLW_SECRET_HASH),
    mode: /_TEST/i.test(secretKey) ? 'test' : secretKey ? 'live' : null,
    enabled: Boolean(s.flutterwaveEnabled),
    feePercent: Number(s.cardFundingFeePercent || 0),
    feeCap: Number(s.cardFundingFeeCap || 0),
    minAmount: Math.max(100, Number(s.minFundingAmount || 100)),
  };
}

// Customers can use it: switched on and keys saved.
async function available() {
  const c = await config();
  return c.enabled && Boolean(c.secretKey);
}

// Fee added on top of what the customer wants in the wallet.
function feeFor(amount, c) {
  let fee = Math.round(Number(amount) * c.feePercent) / 100;
  if (c.feeCap > 0) fee = Math.min(fee, c.feeCap);
  return Math.max(0, Math.round(fee * 100) / 100);
}

async function api(method, path, body) {
  const c = await config();
  if (!c.secretKey) throw new FlutterwaveError('Card payments are not set up yet.', 503, 'NOT_CONFIGURED');
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${c.secretKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new FlutterwaveError(data.message || `Flutterwave error (${res.status})`, res.status >= 500 ? 502 : 400, 'PROVIDER');
  return data;
}

// Starts a payment and returns Flutterwave's checkout link.
async function start(customerId, amountWanted) {
  const c = await config();
  if (!c.enabled || !c.secretKey) throw new FlutterwaveError('Card / USSD funding is not available right now. Please use bank transfer.', 503, 'OFF');
  const amount = Math.round(Number(amountWanted) * 100) / 100;
  if (!(amount >= c.minAmount)) throw new FlutterwaveError(`The minimum is ₦${c.minAmount.toLocaleString()}.`);
  if (amount > MAX_AMOUNT) throw new FlutterwaveError(`The maximum per payment is ₦${MAX_AMOUNT.toLocaleString()}.`);
  const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true, name: true, email: true, phone: true, selfFrozenAt: true, active: true } });
  if (!customer) throw new FlutterwaveError('Account not found.', 404);
  if (customer.selfFrozenAt || customer.active === false) throw new FlutterwaveError('Your account is frozen or not active. Unfreeze it first.', 403);
  // Not too many open attempts at once.
  const open = await prisma.cardPayment.count({ where: { customerId, status: 'PENDING', createdAt: { gt: new Date(Date.now() - 30 * 60 * 1000) } } });
  if (open >= 5) throw new FlutterwaveError('You have several card payments still open. Finish or wait a few minutes, then try again.', 429);

  const fee = feeFor(amount, c);
  const total = Math.round((amount + fee) * 100) / 100;
  const txRef = `zpfw_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
  await prisma.cardPayment.create({ data: { txRef, customerId, amount, fee, total, status: 'PENDING' } });
  const data = await api('POST', '/payments', {
    tx_ref: txRef,
    amount: total,
    currency: 'NGN',
    redirect_url: `${APP_URL}/wallet?card=${encodeURIComponent(txRef)}`,
    payment_options: 'card,ussd',
    customer: { email: customer.email || `${customer.phone}@customers.zappipay.com.ng`, phonenumber: customer.phone, name: customer.name },
    customizations: { title: 'ZAPPI PAY wallet', description: `Add ₦${amount.toLocaleString()} to your wallet`, logo: `${APP_URL}/icon-192.png` },
    meta: { customerId },
  });
  const link = data?.data?.link;
  if (!link) throw new FlutterwaveError('Could not open the payment page. Please try again.', 502);
  return { link, txRef, amount, fee, total };
}

// The one place a card payment credits a wallet.
async function verifyAndCredit(txRef) {
  if (!/^zpfw_[a-z0-9_]+$/i.test(String(txRef || ''))) return { credited: false, reason: 'bad reference' };
  const p = await prisma.cardPayment.findUnique({ where: { txRef } });
  if (!p) return { credited: false, reason: 'unknown payment' };
  if (p.status === 'PAID') return { credited: false, already: true, amount: Number(p.amount), status: 'PAID' };
  if (p.status === 'FAILED') return { credited: false, status: 'FAILED' };

  let v;
  try {
    v = await api('GET', `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`);
  } catch (e) {
    // Not found yet = customer hasn't paid (or closed the page).
    if (/no transaction/i.test(e.message)) return { credited: false, status: 'PENDING' };
    throw e;
  }
  const t = v?.data || {};
  const st = String(t.status || '').toLowerCase();
  if (st === 'failed' || st === 'cancelled') {
    await prisma.cardPayment.updateMany({ where: { id: p.id, status: 'PENDING' }, data: { status: 'FAILED', providerId: t.id ? String(t.id) : null } });
    return { credited: false, status: 'FAILED' };
  }
  if (st !== 'successful') return { credited: false, status: 'PENDING' };
  if (String(t.currency || '').toUpperCase() !== 'NGN' || String(t.tx_ref) !== txRef) return { credited: false, reason: 'mismatch' };
  const paid = Number(t.amount ?? t.charged_amount);
  if (!(paid + 0.001 >= Number(p.total))) {
    console.error('Flutterwave underpaid:', txRef, paid, String(p.total));
    require('./adminAlert').alertAdmins('Card payment amount did not match', `A card payment (${txRef}) was ₦${paid} but ₦${p.total} was expected. It was NOT credited — check it in Flutterwave.`, '/admin/money').catch?.(() => {});
    return { credited: false, reason: 'amount mismatch' };
  }

  const amount = Number(p.amount);
  const fee = Number(p.fee);
  let claimed = false;
  try {
    await prisma.$transaction(async (tx) => {
      const r = await tx.cardPayment.updateMany({ where: { id: p.id, status: 'PENDING' }, data: { status: 'PAID', paidAt: new Date(), providerId: t.id ? String(t.id) : null } });
      if (r.count !== 1) return;
      claimed = true;
      await tx.walletTransaction.create({
        data: {
          customerId: p.customerId,
          type: 'FUND',
          amount,
          status: 'APPROVED',
          reference: txRef,
          providerRef: `fw:${t.id || txRef}`,
          note: fee > 0 ? `Card / USSD payment of ₦${Number(p.total).toLocaleString()} (₦${fee.toLocaleString()} card processing fee)` : 'Card / USSD payment',
          reviewedAt: new Date(),
        },
      });
      await tx.customer.update({ where: { id: p.customerId }, data: { walletBalance: { increment: amount } } });
    });
  } catch (error) {
    if (error.code === 'P2002') return { credited: false, already: true, status: 'PAID' };
    throw error;
  }
  if (!claimed) return { credited: false, already: true, status: 'PAID' };
  notify(p.customerId, 'Wallet Funded', `Your card / USSD payment was received. ₦${amount.toLocaleString()} has been added to your wallet.`);
  return { credited: true, amount, status: 'PAID' };
}

// Webhook: Flutterwave sends the secret hash we set in its dashboard.
async function validHash(header) {
  const { secretHash } = await config();
  if (!secretHash || !header) return false;
  const a = Buffer.from(String(header));
  const b = Buffer.from(secretHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Picks up payments whose webhook was missed or whose customer closed the
// page; gives up on attempts older than a day.
async function sweep() {
  if (!(await config()).secretKey) return;
  const list = await prisma.cardPayment.findMany({ where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - 2 * 60 * 1000), gt: new Date(Date.now() - 24 * 3600 * 1000) } }, take: 20, orderBy: { createdAt: 'asc' } });
  for (const p of list) await verifyAndCredit(p.txRef).catch((e) => console.error('card sweep failed:', e.message));
  await prisma.cardPayment.updateMany({ where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - 24 * 3600 * 1000) } }, data: { status: 'FAILED' } }).catch(() => {});
}

function startSweeper() {
  if (process.env.DISABLE_SCHEDULER === '1') return;
  setInterval(() => sweep().catch((e) => console.error('card sweep failed:', e.message)), 10 * 60 * 1000).unref?.();
}

const mask = (v) => (v ? `${'•'.repeat(8)}${String(v).slice(-4)}` : null);

// Admin view: never returns the keys themselves.
async function status() {
  const s = await getSettings();
  const c = await config();
  return {
    flutterwaveEnabled: Boolean(s.flutterwaveEnabled),
    monnifyFundingEnabled: s.monnifyFundingEnabled !== false,
    monnifyReady: await require('./monnify').isConfigured().catch(() => false),
    cardFundingFeePercent: c.feePercent,
    cardFundingFeeCap: c.feeCap,
    keys: { publicKey: mask(c.publicKey), secretKey: mask(c.secretKey), secretHash: mask(c.secretHash) },
    mode: c.mode,
    webhookUrl: `${(process.env.PUBLIC_API_URL || 'https://zappi-pay-backend.onrender.com').replace(/\/$/, '')}/api/webhooks/flutterwave`,
  };
}

async function updateSettings(b = {}) {
  const data = {};
  if (b.flutterwaveEnabled !== undefined) data.flutterwaveEnabled = Boolean(b.flutterwaveEnabled);
  if (b.monnifyFundingEnabled !== undefined) data.monnifyFundingEnabled = Boolean(b.monnifyFundingEnabled);
  if (b.cardFundingFeePercent !== undefined) {
    const v = Number(b.cardFundingFeePercent);
    if (!(v >= 0 && v <= 5)) throw new FlutterwaveError('The card fee must be between 0% and 5%.');
    data.cardFundingFeePercent = v;
  }
  if (b.cardFundingFeeCap !== undefined) {
    const v = Number(b.cardFundingFeeCap);
    if (!(v >= 0 && v <= 10000)) throw new FlutterwaveError('The fee cap must be between ₦0 and ₦10,000.');
    data.cardFundingFeeCap = v;
  }
  const key = (v, re, label) => {
    const x = clean(v);
    if (x && !re.test(x)) throw new FlutterwaveError(`That doesn't look like a Flutterwave ${label}.`);
    return x || null;
  };
  if (b.publicKey !== undefined) data.flutterwavePublicKey = key(b.publicKey, /^FLWPUBK(_TEST)?-[A-Za-z0-9-]+$/, 'public key (starts with FLWPUBK)');
  if (b.secretKey !== undefined) data.flutterwaveSecretKey = key(b.secretKey, /^FLWSECK(_TEST)?-[A-Za-z0-9-]+$/, 'secret key (starts with FLWSECK)');
  if (b.secretHash !== undefined) {
    const x = clean(b.secretHash);
    if (x && x.length < 12) throw new FlutterwaveError('Make the webhook secret hash at least 12 characters.');
    data.flutterwaveSecretHash = x || null;
  }
  const after = { ...(await getSettings()), ...data };
  if (after.flutterwaveEnabled && !clean(after.flutterwaveSecretKey) && !clean(process.env.FLW_SECRET_KEY)) throw new FlutterwaveError('Save your Flutterwave secret key before turning card funding on.');
  if (after.flutterwaveEnabled && !clean(after.flutterwaveSecretHash) && !clean(process.env.FLW_SECRET_HASH)) throw new FlutterwaveError('Set a webhook secret hash (and the same in Flutterwave → Settings → Webhooks) before turning card funding on.');
  if (Object.keys(data).length) {
    const s = await getSettings();
    await prisma.settings.update({ where: { id: s.id }, data });
    invalidateSettings();
  }
  return status();
}

module.exports = { FlutterwaveError, config, available, feeFor, start, verifyAndCredit, validHash, sweep, startSweeper, status, updateSettings, MAX_AMOUNT };
