// Direct pay ("pay straight to their bank"). For Association Dues, Owambe
// Spray and Request money: the payer pays by card / transfer / USSD on
// Monnify's page, and Monnify SPLITS it so the money goes straight into
// the receiver's own bank account (their Monnify sub-account). ZAPPI PAY
// only keeps a small fee and never holds anyone's money.

const crypto = require('crypto');
const prisma = require('./prisma');
const { getSettings } = require('./vtpass');
const { notify } = require('./notify');
const F = require('./features');

const APP_URL = (process.env.APP_URL || 'https://www.zappipay.com.ng').replace(/\/$/, '');
const monnify = () => require('./monnify');
const KINDS = ['DUES', 'SPRAY', 'REQUEST'];

const isOnFor = (s, customerId) => F.isOnFor(s, 'directPay', customerId);
async function on(customerId) { return isOnFor(await getSettings(), customerId); }

function feeFor(amount, s) {
  return Math.ceil(Number(s.directPayFeeFlat ?? 50) + (Number(amount) * Number(s.directPayFeePercent ?? 1)) / 100);
}

// --- The receiver's bank account ---
async function payout(customerId) {
  const p = await prisma.payoutAccount.findUnique({ where: { customerId } });
  return p ? { bankCode: p.bankCode, accountNumber: p.accountNumber, accountName: p.accountName } : null;
}

async function setPayout(customerId, { bankCode, accountNumber } = {}) {
  const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { name: true, email: true, phone: true, kycType: true, kycVerifiedAt: true } });
  if (!c) throw new F.FeatureError('Account not found.', 404);
  if (!c.kycType && !c.kycVerifiedAt) throw new F.FeatureError('Verify your account first (get your account number on the Wallet page).', 403, 'NOT_VERIFIED');
  const acct = String(accountNumber || '').replace(/\D/g, '');
  if (!bankCode || acct.length !== 10) throw new F.FeatureError('Choose your bank and enter the 10-digit account number.');
  const found = await require('./disbursement').lookupAccount(bankCode, acct).catch((e) => { throw new F.FeatureError(`We couldn’t find that account (${e.message}).`); });
  let sub;
  try {
    const r = await monnify().api('POST', '/api/v1/sub-accounts', [{ currencyCode: 'NGN', bankCode: String(bankCode), accountNumber: acct, email: c.email || `${String(c.phone).replace(/\D/g, '')}@customers.zappipay.com.ng`, defaultSplitPercentage: 100 }]);
    sub = Array.isArray(r) ? r[0] : r;
  } catch (e) {
    throw new F.FeatureError(`We couldn’t set up payments to that account (${e.message}). Please try again later.`, 502);
  }
  if (!sub?.subAccountCode) throw new F.FeatureError('We couldn’t set up payments to that account. Please try again later.', 502);
  const data = { bankCode: String(bankCode), accountNumber: acct, accountName: found.accountName, subAccountCode: sub.subAccountCode };
  await prisma.payoutAccount.upsert({ where: { customerId }, create: { customerId, ...data }, update: data });
  return { bankCode: data.bankCode, accountNumber: acct, accountName: found.accountName };
}

// --- Start a payment ---
async function start({ kind, refId, payerId, recipientId, amount, description, meta = {}, returnPath = '/' }) {
  const s = await getSettings();
  if (!KINDS.includes(kind)) throw new F.FeatureError('Unknown payment.');
  if (!isOnFor(s, payerId)) throw new F.FeatureError('Card payments for this aren’t available yet.', 503, 'OFF');
  if (!(await monnify().isConfigured())) throw new F.FeatureError('Card payment isn’t set up yet.', 503, 'NOT_CONFIGURED');
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!(amt >= 100 && amt <= 1000000)) throw new F.FeatureError('Card payments are between ₦100 and ₦1,000,000.');
  const p = await prisma.payoutAccount.findUnique({ where: { customerId: recipientId } });
  const who = await prisma.customer.findUnique({ where: { id: recipientId }, select: { name: true } });
  if (!p) throw new F.FeatureError(`${who?.name || 'They'} hasn’t added a bank account to receive payments yet. Ask them to add one in the app.`, 409, 'NO_PAYOUT');
  const fee = feeFor(amt, s);
  const reference = `DP-${crypto.randomBytes(8).toString('hex')}`;
  const payer = await prisma.customer.findUnique({ where: { id: payerId }, select: { name: true, email: true, phone: true } });
  const dp = await prisma.directPayment.create({ data: { reference, kind, refId: String(refId), payerId, recipientId, amount: amt, fee, status: 'PENDING', meta: { ...meta, returnPath, description } } });
  const cfg = await monnify().getConfig();
  let r;
  try {
    r = await monnify().api('POST', '/api/v1/merchant/transactions/init-transaction', {
      amount: amt + fee,
      customerName: payer.name,
      customerEmail: payer.email || `${String(payer.phone).replace(/\D/g, '')}@customers.zappipay.com.ng`,
      paymentReference: reference,
      paymentDescription: String(description || 'ZAPPI PAY payment').slice(0, 80),
      currencyCode: 'NGN',
      contractCode: cfg.contractCode,
      redirectUrl: `${APP_URL}/paid/${reference}`,
      paymentMethods: ['CARD', 'ACCOUNT_TRANSFER', 'USSD'],
      incomeSplitConfig: [{ subAccountCode: p.subAccountCode, splitAmount: amt, feePercentage: 0, feeBearer: false }],
    });
  } catch (e) {
    await prisma.directPayment.update({ where: { id: dp.id }, data: { status: 'FAILED' } });
    throw new F.FeatureError(`Payment couldn’t start (${e.message}). Please try again.`, 502);
  }
  await prisma.directPayment.update({ where: { id: dp.id }, data: { monnifyRef: r.transactionReference, checkoutUrl: r.checkoutUrl } });
  return { checkout: true, reference, checkoutUrl: r.checkoutUrl, total: amt + fee, fee };
}

// --- What happens once it's paid ---
const handlers = {
  async DUES(dp) {
    const a = await prisma.association.findUnique({ where: { id: dp.refId } });
    const period = dp.meta?.period;
    try { await prisma.duesPayment.create({ data: { assocId: dp.refId, customerId: dp.payerId, period, amount: dp.amount } }); } catch (e) { if (e.code !== 'P2002') throw e; }
    const payer = await prisma.customer.findUnique({ where: { id: dp.payerId }, select: { name: true } });
    notify(dp.payerId, 'Dues paid', `You paid ${F.naira(dp.amount)} dues to “${a?.name}” for ${dp.meta?.label || period}. ✅`, { category: 'TRANSACTION' });
    notify(dp.recipientId, 'Dues received', `${payer?.name} paid ${F.naira(dp.amount)} dues for “${a?.name}” (${dp.meta?.label || period}) — paid into your bank account.`, { category: 'TRANSACTION' });
  },
  async SPRAY(dp) {
    await prisma.spraySession.create({ data: { eventId: dp.refId, senderId: dp.payerId, budget: dp.amount, spent: 0, prepaid: true, expiresAt: new Date(Date.now() + 12 * 3600 * 1000) } });
    const e = await prisma.sprayEvent.findUnique({ where: { id: dp.refId } });
    const payer = await prisma.customer.findUnique({ where: { id: dp.payerId }, select: { name: true } });
    notify(dp.recipientId, 'Spray received 💃', `${payer?.name} sprayed ${F.naira(dp.amount)} at “${e?.title}” — paid into your bank account.`, { category: 'TRANSACTION' });
  },
  async REQUEST(dp) {
    const r = await prisma.moneyRequest.findUnique({ where: { id: dp.refId } });
    if (!r) return;
    const slotKey = r.kind === 'SPLIT' ? `u:${dp.payerId}` : r.kind === 'POOL' ? `p:${dp.reference}` : 'single';
    let done = false;
    let extra = false;
    try {
      await prisma.$transaction(async (tx) => {
        const where = { id: r.id };
        if (r.kind !== 'POOL') where.payments = { lt: r.slots || 1 };
        const claim = await tx.moneyRequest.updateMany({ where, data: { payments: { increment: 1 }, collected: { increment: dp.amount } } });
        if (claim.count !== 1) throw Object.assign(new Error('full'), { full: true });
        await tx.moneyRequestPayment.create({ data: { requestId: r.id, payerId: dp.payerId, slotKey, amount: dp.amount, message: dp.meta?.message || null, hideAmount: Boolean(dp.meta?.hideAmount) } });
        const fresh = await tx.moneyRequest.findUnique({ where: { id: r.id } });
        if (r.kind !== 'POOL' && fresh.payments >= (r.slots || 1)) { await tx.moneyRequest.update({ where: { id: r.id }, data: { status: 'DONE' } }); done = true; }
      });
    } catch (e) {
      if (!e.full && e.code !== 'P2002') throw e;
      // Already fully paid: the money still reached them — record it as extra.
      extra = true;
      await prisma.moneyRequestPayment.create({ data: { requestId: r.id, payerId: dp.payerId, slotKey: `x:${dp.reference}`, amount: dp.amount, message: dp.meta?.message || null } }).catch(() => {});
    }
    const payer = await prisma.customer.findUnique({ where: { id: dp.payerId }, select: { name: true } });
    notify(dp.recipientId, 'Money Received', `${payer?.name} paid ${F.naira(dp.amount)} for “${r.title}” into your bank account.${done ? ' Everyone has paid 🎉' : ''}${extra ? ' (It was already fully paid — sort out the extra with them.)' : ''}`);
    notify(dp.payerId, 'Payment made', `You paid ${F.naira(dp.amount)} for “${r.title}”.`);
  },
};

async function confirm(reference) {
  const dp = await prisma.directPayment.findUnique({ where: { reference: String(reference || '') } });
  if (!dp) return { status: 'UNKNOWN' };
  if (dp.status !== 'PENDING' || !dp.monnifyRef) return { status: dp.status };
  const txn = await monnify().api('GET', `/api/v2/transactions/${encodeURIComponent(dp.monnifyRef)}`).catch(() => null);
  if (!txn) return { status: 'PENDING' };
  if (txn.paymentStatus !== 'PAID') {
    if (['FAILED', 'EXPIRED', 'CANCELLED', 'ABANDONED'].includes(txn.paymentStatus) || Date.now() - new Date(dp.createdAt) > 3 * 3600 * 1000) {
      await prisma.directPayment.updateMany({ where: { id: dp.id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
      return { status: 'EXPIRED' };
    }
    return { status: 'PENDING' };
  }
  if (Number(txn.amountPaid) + 0.01 < Number(dp.amount) + Number(dp.fee)) {
    await prisma.directPayment.update({ where: { id: dp.id }, data: { status: 'FAILED' } });
    require('./adminAlert').alertAdmins('Direct payment short', `${dp.reference}: paid ${txn.amountPaid}, expected ${Number(dp.amount) + Number(dp.fee)}`, '/admin/extra-services').catch?.(() => {});
    return { status: 'FAILED' };
  }
  const lock = await prisma.directPayment.updateMany({ where: { id: dp.id, status: 'PENDING' }, data: { status: 'PAID', paidAt: new Date() } });
  if (lock.count !== 1) return { status: 'PAID' };
  await handlers[dp.kind]({ ...dp, amount: Number(dp.amount) }).catch((e) => console.error('direct pay handler failed:', dp.reference, e.message));
  return { status: 'PAID' };
}

async function view(customerId, reference) {
  let dp = await prisma.directPayment.findUnique({ where: { reference: String(reference || '') } });
  if (!dp || dp.payerId !== customerId) throw new F.FeatureError('Not found.', 404);
  if (dp.status === 'PENDING') { await confirm(dp.reference).catch(() => {}); dp = await prisma.directPayment.findUnique({ where: { id: dp.id } }); }
  const who = await prisma.customer.findUnique({ where: { id: dp.recipientId }, select: { name: true } });
  return { status: dp.status, kind: dp.kind, amount: Number(dp.amount), total: Number(dp.amount) + Number(dp.fee), to: who?.name, description: dp.meta?.description, returnPath: dp.meta?.returnPath || '/', checkoutUrl: dp.status === 'PENDING' ? dp.checkoutUrl : null };
}

async function sweep() {
  if (!(await F.anyOn('directPay'))) return;
  const list = await prisma.directPayment.findMany({ where: { status: 'PENDING', createdAt: { gte: new Date(Date.now() - 6 * 3600 * 1000) } }, take: 50 });
  for (const dp of list) await confirm(dp.reference).catch(() => {});
}

module.exports = { on, isOnFor, feeFor, payout, setPayout, start, confirm, view, sweep };
