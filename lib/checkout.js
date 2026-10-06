// Pay by card / transfer / USSD at checkout. When a customer's wallet is
// short, they pay the shortfall through Monnify; once Monnify confirms it,
// the money is added to THEIR wallet (like any funding) and the purchase
// runs straight away. If the purchase then fails, the money stays in their
// wallet, so nothing is ever held for anyone else.

const crypto = require('crypto');
const prisma = require('./prisma');
const { getSettings } = require('./vtpass');
const { notify } = require('./notify');
const F = require('./features');

const APP_URL = (process.env.APP_URL || 'https://www.zappipay.com.ng').replace(/\/$/, '');
const SERVICES = ['AIRTIME', 'DATA', 'ELECTRICITY', 'CABLE', 'EDUCATION', 'INTERNET', 'BETTING'];
const monnify = () => require('./monnify');
const r2 = (n) => Math.round(Number(n) * 100) / 100;

function feeFor(amount, s) {
  let fee = (Number(amount) * Number(s.cardFundingFeePercent || 0)) / 100;
  const cap = Number(s.cardFundingFeeCap || 0);
  if (cap > 0) fee = Math.min(fee, cap);
  return Math.ceil(fee);
}

async function quote(customerId, needed) {
  const s = await F.requireOn('cardCheckout', customerId);
  const amt = Math.ceil(Number(needed));
  return { needed: amt, fee: feeFor(amt, s), total: amt + feeFor(amt, s) };
}

async function start(customerId, { purchase, needed, label } = {}) {
  const s = await F.requireOn('cardCheckout', customerId);
  if (!(await monnify().isConfigured())) throw new F.FeatureError('Card payment isn’t set up yet. Please fund your wallet instead.', 503, 'NOT_CONFIGURED');
  const p = purchase || {};
  if (!SERVICES.includes(p.service) || !p.serviceID || !p.billersCode || !p.phone) throw new F.FeatureError('Fill in the purchase details first.');
  const amt = Math.ceil(Number(needed));
  if (!(amt >= 100 && amt <= 500000)) throw new F.FeatureError('Card payments are between ₦100 and ₦500,000. For less than ₦100, fund your wallet by transfer.');
  const open = await prisma.checkoutIntent.count({ where: { customerId, status: 'PENDING', createdAt: { gte: new Date(Date.now() - 3600 * 1000) } } });
  if (open >= 5) throw new F.FeatureError('You have several unfinished card payments. Finish one or try again in an hour.');
  const fee = feeFor(amt, s);
  const input = { service: p.service, serviceID: String(p.serviceID), variationCode: p.variationCode || undefined, billersCode: String(p.billersCode).slice(0, 40), phone: String(p.phone).slice(0, 20), amount: p.amount ? Number(p.amount) : undefined, meterType: p.meterType === 'postpaid' ? 'postpaid' : p.meterType ? 'prepaid' : undefined, promoCode: p.promoCode || undefined, useCashback: Boolean(p.useCashback) };
  const reference = `CHK-${crypto.randomBytes(8).toString('hex')}`;
  const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { name: true, email: true, phone: true } });
  const intent = await prisma.checkoutIntent.create({ data: { reference, customerId, input, label: String(label || p.service).slice(0, 80), needed: amt, fee, status: 'PENDING' } });
  const cfg = await monnify().getConfig();
  let r;
  try {
    r = await monnify().api('POST', '/api/v1/merchant/transactions/init-transaction', {
      amount: amt + fee,
      customerName: c.name,
      customerEmail: c.email || `${String(c.phone).replace(/\D/g, '')}@customers.zappipay.com.ng`,
      paymentReference: reference,
      paymentDescription: `ZAPPI PAY: ${intent.label}`.slice(0, 80),
      currencyCode: 'NGN',
      contractCode: cfg.contractCode,
      redirectUrl: `${APP_URL}/checkout/${reference}`,
      paymentMethods: ['CARD', 'ACCOUNT_TRANSFER', 'USSD'],
    });
  } catch (e) {
    await prisma.checkoutIntent.update({ where: { id: intent.id }, data: { status: 'FAILED', message: String(e.message).slice(0, 200) } });
    throw new F.FeatureError(`Card payment couldn’t start (${e.message}). Please try again or fund your wallet.`, 502);
  }
  await prisma.checkoutIntent.update({ where: { id: intent.id }, data: { monnifyRef: r.transactionReference, checkoutUrl: r.checkoutUrl } });
  return { reference, checkoutUrl: r.checkoutUrl, total: amt + fee, fee };
}

// Asks Monnify if it was paid; if so funds the wallet and runs the purchase.
async function confirm(reference) {
  const it = await prisma.checkoutIntent.findUnique({ where: { reference: String(reference || '') } });
  if (!it) return { status: 'UNKNOWN' };
  if (it.status !== 'PENDING' || !it.monnifyRef) return { status: it.status, orderId: it.orderId };
  const txn = await monnify().api('GET', `/api/v2/transactions/${encodeURIComponent(it.monnifyRef)}`).catch(() => null);
  if (!txn) return { status: 'PENDING' };
  if (txn.paymentStatus !== 'PAID') {
    if (['FAILED', 'EXPIRED', 'CANCELLED', 'ABANDONED'].includes(txn.paymentStatus) || Date.now() - new Date(it.createdAt) > 3 * 3600 * 1000) {
      await prisma.checkoutIntent.updateMany({ where: { id: it.id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
      return { status: 'EXPIRED' };
    }
    return { status: 'PENDING' };
  }
  const lock = await prisma.checkoutIntent.updateMany({ where: { id: it.id, status: 'PENDING' }, data: { status: 'PAID', paidAt: new Date() } });
  if (lock.count !== 1) return { status: 'PAID' };
  const paid = Number(txn.amountPaid || 0);
  // The wallet gets what was paid minus the card fee (never more than paid).
  const credit = r2(Math.max(0, paid - Number(it.fee)));
  try {
    await prisma.$transaction([
      prisma.walletTransaction.create({ data: { customerId: it.customerId, type: 'FUND', amount: credit, status: 'APPROVED', reference: it.reference, providerRef: it.monnifyRef, note: Number(it.fee) > 0 ? `Card / transfer payment at checkout (₦${Number(it.fee).toLocaleString()} card fee)` : 'Card / transfer payment at checkout', reviewedAt: new Date() } }),
      prisma.customer.update({ where: { id: it.customerId }, data: { walletBalance: { increment: credit } } }),
    ]);
  } catch (e) {
    if (e.code !== 'P2002') throw e; // already credited (e.g. by the reserved-account path)
  }
  await require('./circles').onDeposit(it.customerId).catch(() => {});
  const result = await require('./purchase').performPurchase(it.customerId, it.input, { source: 'app' }).catch((e) => ({ status: 500, body: { error: e.message } }));
  if (result.status === 201 || result.status === 202) {
    const orderId = result.body?.order?.id || null;
    await prisma.checkoutIntent.update({ where: { id: it.id }, data: { status: 'DONE', orderId } });
    return { status: 'DONE', orderId };
  }
  const msg = String(result.body?.error || 'The purchase didn’t go through.').slice(0, 200);
  await prisma.checkoutIntent.update({ where: { id: it.id }, data: { status: 'PURCHASE_FAILED', message: msg } });
  notify(it.customerId, 'Payment received — purchase not completed', `We received ${'₦' + credit.toLocaleString()} and added it to your wallet, but ${it.label} didn’t go through (${msg}). Your money is safe in your wallet — try again any time.`, { category: 'TRANSACTION' });
  return { status: 'PURCHASE_FAILED', message: msg };
}

async function view(customerId, reference) {
  let it = await prisma.checkoutIntent.findUnique({ where: { reference: String(reference || '') } });
  if (!it || it.customerId !== customerId) throw new F.FeatureError('Not found.', 404);
  if (it.status === 'PENDING') { await confirm(it.reference).catch(() => {}); it = await prisma.checkoutIntent.findUnique({ where: { id: it.id } }); }
  return { status: it.status, orderId: it.orderId, label: it.label, total: r2(Number(it.needed) + Number(it.fee)), message: it.message, checkoutUrl: it.status === 'PENDING' ? it.checkoutUrl : null };
}

async function sweep() {
  if (!(await F.anyOn('cardCheckout'))) return;
  const list = await prisma.checkoutIntent.findMany({ where: { status: 'PENDING', createdAt: { gte: new Date(Date.now() - 6 * 3600 * 1000) } }, take: 50 });
  for (const it of list) await confirm(it.reference).catch(() => {});
}

module.exports = { feeFor, quote, start, confirm, view, sweep };
