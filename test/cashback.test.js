// Money tests for refunds and the cashback ledger. Run: npm test
// Uses an in-memory database (test/helpers/memdb.js) and fake partners,
// so nothing real is called.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const { makeDb, k } = require('./helpers/memdb');

const ROOT = path.resolve(__dirname, '..');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
process.env.DISABLE_SCHEDULER = '1';

const SETTINGS = {
  vtpassMode: 'live', cashbackSeparate: true, cashbackUseMaxPercent: '20', cashbackExpiryDays: 90,
  cashbackEnabled: true, loyaltyEnabled: true, loyaltyPointValue: '1', referralEnabled: false,
  rewardSplitEnabled: true, rewardSplitPct: 40, rewardMonthlyCapPercent: null, rewardUserMonthlyCap: '0',
  rewardSplitShares: { CASHBACK: 35, LOYALTY: 20, REFERRAL: 25, CHALLENGES: 10, PROMISE: 5, SHOP: 5 },
  bankFundingFeePercent: '1.5', bankFundingFeeCap: '2000', minPurchaseAmount: '50', markupPercentByService: {}, discountPercentByService: {},
};

let db;
let vtpassReply;
const alerts = [];

const fakes = {
  prisma: () => new Proxy({}, { get: (_, prop) => db[prop] }),
  vtpass: () => ({ getSettings: async () => SETTINGS, vtpassRequest: async (m, p) => { if (p === '/pay') { if (vtpassReply instanceof Error) throw vtpassReply; return vtpassReply; } return {}; }, invalidateSettings: () => {} }),
  notify: () => ({ notify: () => {} }),
  adminAlert: () => ({ alertAdmins: async (t, m) => { alerts.push(`${t}: ${m}`); } }),
  partnerHealth: () => ({ pauseFor: () => null, success: () => {}, failure: () => {}, nameOf: () => 'x' }),
  recovery: () => ({ orderInfo: () => ({ key: 'k', label: 'l' }), failed: () => {}, worked: () => {}, payloadCode: () => null, payloadReason: () => null }),
  deliveryPromise: () => ({ check: () => {} }),
  errorAlerts: () => ({ vtpassFailure: () => {} }),
  reminders: () => ({ afterPurchase: () => {} }),
  challenges: () => ({ checkAfterPurchase: () => {} }),
  referral: () => ({ maybePayReferralBonus: () => {} }),
  limits: () => ({ checkDailyLimit: async () => null }),
  family: () => ({ checkPurchase: async () => null }),
  circles: () => ({ owingLock: async () => null }),
  features: () => ({ isOnFor: () => true }),
  maintenance: () => ({ pauseMessage: () => null }),
  planFixes: () => ({ get: async () => null }),
  shop: () => ({ payCommission: async () => 0 }),
  quietClock: () => ({ every: () => {} }),
  goLive: () => ({ partnerModes: async () => ({ monnify: 'sandbox', squad: 'sandbox', nomba: 'sandbox' }) }),
  vtpassCodes: () => ({ customerText: () => '', alertIfAccount: () => {} }),
  auth: () => ({ requireAdminAuth: (req, res, next) => next(), requireCustomerAuth: (req, res, next) => next() }),
};
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '');
  if (fakes[rel]) return fakes[rel]();
  return orig.call(this, req, parent, ...rest);
};

const purchase = require('../lib/purchase');
const cb = require('../lib/cashback');
const cap = require('../lib/rewardCap');
const split = require('../lib/rewardSplit');
const M = require('../lib/money');

async function fresh({ wallet = '26322.54', cashback = '0' } = {}) {
  db = makeDb();
  alerts.length = 0;
  const c = await db.customer.create({ data: { name: 'Test', phone: `080${Math.floor(Math.random() * 1e8)}`, passwordHash: 'x', walletBalance: wallet, cashbackBalance: '0' } });
  if (Number(cashback) > 0) await db.$transaction((tx) => cb.creditEarned(tx, SETTINGS, { customerId: c.id, amount: cashback, note: 'seed' }));
  return c;
}
const bal = async (id) => { const c = await db.customer.findUnique({ where: { id } }); return { wallet: k(c.walletBalance), cashback: k(c.cashbackBalance) }; };
const ledger = (id, where = {}) => db.cashbackEntry.findMany({ where: { customerId: id, ...where } });
const buy = (id, amount, extra = {}) => purchase.performPurchase(id, { service: 'AIRTIME', serviceID: 'mtn', billersCode: '08012345678', phone: '08012345678', amount, useCashback: true, ...extra });
const DELIVERED = { code: '000', content: { transactions: { status: 'delivered', commission: 148.5 } } };
const FAILED = { code: '016', content: { transactions: { status: 'failed' } } };

test('money: kobo conversions are exact', () => {
  assert.equal(M.toKobo('4948.73'), 494873);
  assert.equal(M.toKobo(4948.73), 494873);
  assert.equal(M.toKobo('26322.54'), 2632254);
  assert.equal(M.toNaira(494873), '4948.73');
  assert.equal(M.toNaira(-127), '-1.27');
  assert.equal(M.toKobo(0.1 + 0.2), 30);
});

test('fix 1: N4,950 order paid N4,948.73 cash + N1.27 cashback, fails → refund is exact (no lost kobo)', async () => {
  const c = await fresh({ wallet: '26322.54', cashback: '1.27' });
  const before = await bal(c.id);
  vtpassReply = FAILED;
  const r = await buy(c.id, 4950);
  assert.equal(r.status, 502);
  const order = await db.order.findFirst({ where: { customerId: c.id } });
  assert.equal(k(order.cashbackUsed), 127);
  const after = await bal(c.id);
  assert.equal(after.wallet, before.wallet, 'wallet back to N26,322.54');
  assert.equal(after.cashback, before.cashback, 'cashback back to N1.27');
  const refund = await db.walletTransaction.findFirst({ where: { customerId: c.id, type: 'REFUND' } });
  assert.equal(k(refund.amount), 494873);
  const ret = await ledger(c.id, { type: 'RETURNED' });
  assert.equal(ret.length, 1);
  assert.equal(ret[0].amountKobo + k(refund.amount), 495000, 'refund_cash + cashback_returned = original debit');
});

test('spec 3: refundSplit adds up to the original debit (495,000 kobo)', () => {
  const s = cb.refundSplit({ id: 'o', amount: '4950.00', cashbackUsed: '1.27' });
  assert.equal(s.walletKobo, 494873);
  assert.equal(s.cashbackKobo, 127);
  assert.equal(s.walletKobo + s.cashbackKobo, 495000);
  // many awkward amounts: never a kobo lost
  for (let a = 100; a < 100000; a += 997) for (const used of [1, 27, 83, 127, 999]) {
    const amt = M.toNaira(a);
    const u = Math.min(used, Math.floor(a / 5));
    const x = cb.refundSplit({ id: 'o', amount: amt, cashbackUsed: M.toNaira(u) });
    assert.equal(x.walletKobo + x.cashbackKobo, a);
    assert.equal(x.cashbackKobo, u);
  }
});

test('spec 1: successful order → exactly one EARNED entry, amount matches the formula', async () => {
  const c = await fresh({ wallet: '5000' });
  vtpassReply = DELIVERED;
  const r = await buy(c.id, 1000, { useCashback: false });
  assert.equal(r.status, 201);
  const order = await db.order.findFirst({ where: { customerId: c.id } });
  const earned = await ledger(c.id, { type: 'EARNED' });
  assert.equal(earned.length, 1);
  const earnings = cap.orderEarningsKobo(order, SETTINGS);
  const pool = M.pctOf(earnings, 40);
  const expected = Math.floor((pool * 3500) / 10000);
  assert.ok(expected > 0);
  assert.equal(earned[0].amountKobo, expected);
  assert.equal(earned[0].orderId, order.id);
  const days = (new Date(earned[0].expiresAt) - Date.now()) / 86400000;
  assert.ok(days > 89.9 && days <= 90.01, 'expires in 90 days');
});

test('spec 2: failed order → no EARNED entry; balances back to before', async () => {
  const c = await fresh({ wallet: '3000', cashback: '50' });
  const before = await bal(c.id);
  vtpassReply = FAILED;
  await buy(c.id, 1000);
  assert.equal((await ledger(c.id, { type: 'EARNED', orderId: { not: null } })).length, 0);
  assert.deepEqual(await bal(c.id), before);
});

test('spec 4: duplicate webhook / retry → no second EARNED, USED or RETURNED entry', async () => {
  const c = await fresh({ wallet: '3000', cashback: '50' });
  vtpassReply = new Error('timeout'); // pending
  const r = await buy(c.id, 1000);
  assert.equal(r.status, 202);
  const order = await db.order.findFirst({ where: { customerId: c.id } });
  await purchase.settleOrder(order, 'SUCCESS', DELIVERED);
  await purchase.settleOrder(order, 'SUCCESS', DELIVERED);
  await purchase.settleOrder(order, 'FAILED', FAILED); // late failure after success: ignored
  for (const type of ['EARNED', 'USED', 'RETURNED']) assert.ok((await ledger(c.id, { type, orderId: order.id })).length <= 1, type);
  assert.equal((await ledger(c.id, { type: 'EARNED', orderId: order.id })).length, 1);
  // the database itself refuses a second EARNED for the order
  await assert.rejects(db.$transaction((tx) => cb.creditEarned(tx, SETTINGS, { customerId: c.id, kobo: 100, order })), (e) => e.code === 'P2002');
  // and a failed-then-retried refund pays once
  const c2 = await fresh({ wallet: '3000', cashback: '50' });
  vtpassReply = new Error('timeout');
  await buy(c2.id, 1000);
  const o2 = await db.order.findFirst({ where: { customerId: c2.id } });
  await purchase.settleOrder(o2, 'FAILED', FAILED);
  await purchase.settleOrder(o2, 'FAILED', FAILED);
  assert.equal((await db.walletTransaction.findMany({ where: { customerId: c2.id, type: 'REFUND' } })).length, 1);
  assert.equal((await ledger(c2.id, { type: 'RETURNED' })).length, 1);
});

test('spec 5: cashback used never exceeds 20% of the price or the balance', async () => {
  for (const [price, balance] of [[1000, 500], [1000, 50], [4950, 1.27], [333.33, 1000], [50, 9]]) {
    const c = await fresh({ wallet: '10000', cashback: String(balance) });
    vtpassReply = DELIVERED;
    await buy(c.id, price);
    const o = await db.order.findFirst({ where: { customerId: c.id } });
    const used = k(o.cashbackUsed || 0);
    assert.ok(used <= Math.floor(M.toKobo(o.amount) * 0.2), `≤20% for ${price}`);
    assert.ok(used <= M.toKobo(balance), `≤ balance for ${price}`);
    assert.equal(used, Math.min(M.toKobo(balance), Math.floor(M.toKobo(o.amount) * 0.2)));
  }
});

test('spec 6: monthly cap reached → new cashback is 0 and purchases still work', async () => {
  const c = await fresh({ wallet: '20000' });
  // A big manual reward this month uses up the whole cap.
  await db.$transaction((tx) => cb.creditEarned(tx, SETTINGS, { customerId: c.id, amount: '5000', note: 'big', type: 'ADJUSTMENT' }));
  vtpassReply = DELIVERED;
  const r = await buy(c.id, 1000, { useCashback: false });
  assert.equal(r.status, 201, 'purchase still works');
  const order = await db.order.findFirst({ where: { customerId: c.id }, orderBy: { createdAt: 'desc' } });
  assert.equal((await ledger(c.id, { type: 'EARNED', orderId: order.id })).length, 0);
  const m = await cap.month();
  assert.ok(m.reached);
});

test('spec 7: expired cashback leaves the usable balance and the liability', async () => {
  const c = await fresh({ wallet: '1000' });
  const old = new Date(Date.now() - 1000);
  await db.$transaction((tx) => cb.creditEarned(tx, SETTINGS, { customerId: c.id, amount: '30', note: 'old', expiresAt: old }));
  await db.$transaction((tx) => cb.creditEarned(tx, SETTINGS, { customerId: c.id, amount: '20', note: 'new' }));
  assert.equal((await bal(c.id)).cashback, 5000);
  const r = await cb.expireDue();
  assert.equal(r.kobo, 3000);
  assert.equal((await bal(c.id)).cashback, 2000, 'only unexpired N20 left');
  await cb.expireDue(); // running again changes nothing
  assert.equal((await bal(c.id)).cashback, 2000);
  assert.equal((await ledger(c.id, { type: 'EXPIRED' })).length, 1);
  const liab = await db.customer.aggregate({ where: { deletedAt: null }, _sum: { cashbackBalance: true } });
  assert.equal(k(liab._sum.cashbackBalance), 2000);
  const s = await cb.summary(c.id, SETTINGS);
  assert.ok(new Date(s.oldestExpiry) > new Date());
});

test('spec 8: cashback cannot be sent, withdrawn or paid out', async () => {
  const calls = [];
  const res = { status(n) { calls.push(n); return this; }, json(b) { calls.push(b.code); return this; } };
  for (const body of [{ source: 'cashback' }, { fromCashback: true }, { useCashback: true }, { balance: 'CASHBACK' }]) {
    calls.length = 0;
    let passed = false;
    cb.refuseOut({ body }, res, () => { passed = true; });
    assert.equal(passed, false);
    assert.deepEqual(calls, [400, 'CASHBACK_NOT_CASH']);
  }
  let ok = false;
  cb.refuseOut({ body: { amount: 500, accountNumber: '0123456789' } }, res, () => { ok = true; });
  assert.ok(ok, 'normal transfers still pass');
  // No route moves cashbackBalance out except a purchase.
  const fs = require('fs');
  const files = fs.readdirSync(path.join(ROOT, 'routes')).map((f) => path.join(ROOT, 'routes', f)).concat(fs.readdirSync(path.join(ROOT, 'lib')).map((f) => path.join(ROOT, 'lib', f))).filter((f) => f.endsWith('.js'));
  const outs = files.filter((f) => /cashbackBalance:\s*\{\s*decrement/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f)).sort();
  assert.deepEqual(outs, ['lib/cashback.js', 'lib/purchase.js']);
  // and the transfer routes are guarded
  for (const f of ['routes/wallet.routes.js', 'routes/banktransfer.routes.js']) assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /refuseOut/);
});

test('test orders earn nothing and are left out of the cap', async () => {
  SETTINGS.vtpassMode = 'sandbox';
  try {
    const c = await fresh({ wallet: '5000' });
    vtpassReply = DELIVERED;
    await buy(c.id, 1000, { useCashback: false });
    const o = await db.order.findFirst({ where: { customerId: c.id } });
    assert.equal(o.isTest, true);
    assert.equal((await ledger(c.id, { type: 'EARNED' })).length, 0);
    assert.equal((await cap.month()).earnedKobo, 0);
  } finally {
    SETTINGS.vtpassMode = 'live';
  }
});

test('rewards split: a programme that is off keeps its share (never moved to cashback)', () => {
  const c = split.config(SETTINGS);
  const p = split.parts(100000, c, { CASHBACK: true, LOYALTY: false, REFERRAL: false, CHALLENGES: false, PROMISE: false, SHOP: false });
  assert.equal(p.poolKobo, 40000);
  assert.equal(p.CASHBACK, 14000);
  assert.equal(p.LOYALTY, 0);
});

test('screens: refunds list, ledger, order history and owed totals (read-only, exact)', async () => {
  const c = await fresh({ wallet: '26322.54', cashback: '1.27' });
  vtpassReply = FAILED;
  await buy(c.id, 4950);
  const express = require('express');
  const app = express();
  app.use('/api', require('../routes/ledger.routes'));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  try {
    const refunds = await (await fetch(`${base}/admin/refunds`)).json();
    assert.equal(refunds.rows.length, 1);
    assert.equal(refunds.rows[0].cash, 4948.73);
    assert.equal(refunds.rows[0].cashbackReturned, 1.27);
    assert.equal(refunds.rows[0].orderPaid, 4950);
    assert.equal(refunds.rows[0].adds, true);
    assert.equal(refunds.rows[0].how, 'Automatic');
    const ledger = await (await fetch(`${base}/admin/ledger`)).json();
    assert.ok(ledger.rows.some((r) => r.type === 'REFUND' && r.amount === 4948.73));
    assert.ok(ledger.rows.some((r) => r.type === 'DEBIT' && r.amount === 4948.73));
    const order = await db.order.findFirst({ where: { customerId: c.id } });
    const tl = await (await fetch(`${base}/admin/orders/${order.id}/timeline`)).json();
    assert.equal(tl.providerReference, order.vtpassRequestId);
    assert.ok(tl.events.some((e) => /Refund to wallet/.test(e.what)));
    assert.ok(tl.events.some((e) => /Cashback returned/i.test(e.what)));
    assert.match(tl.events.at(-1).what, /Now: FAILED/);
    const totals = await (await fetch(`${base}/admin/overview-totals`)).json();
    assert.equal(totals.wallets, 26322.54);
    assert.equal(totals.cashback, 1.27);
    assert.equal(totals.owedTotal, 26323.81);
  } finally {
    srv.close();
  }
});
