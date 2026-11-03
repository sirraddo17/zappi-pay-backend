// Ledger Real / Test / All: purchase debits (no reference) follow their order's test flag, and totals match the rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path'); const Module = require('module');
const ROOT = path.resolve(__dirname, '..'); process.env.JWT_SECRET = 't';
const T0 = new Date('2026-11-03T10:00:00Z'), at = (ms) => new Date(T0.getTime() + ms);
const orders = [
  { id: 'o1', customerId: 'a', createdAt: at(30), amount: '50.25', cashbackUsed: null, isTest: false, vtpassRequestId: 'R1' },
  { id: 'o2', customerId: 'a', createdAt: at(60030), amount: '72.52', cashbackUsed: '2.52', isTest: true, vtpassRequestId: 'T1' },
  { id: 'o3', customerId: 'a', createdAt: at(120030), amount: '70', cashbackUsed: null, isTest: true, vtpassRequestId: 'T2' },
];
const rows = [
  { id: 1, customerId: 'a', type: 'FUND', amount: '100', status: 'APPROVED', reference: null, providerRef: 'SQ-1', createdAt: new Date() },     // live squad → real
  { id: 2, customerId: 'a', type: 'FUND', amount: '500', status: 'APPROVED', reference: null, providerRef: 'MNFY|1', createdAt: new Date() }, // sandbox → test
  { id: 3, customerId: 'a', type: 'DEBIT', amount: '50.25', status: 'APPROVED', reference: null, providerRef: null, createdAt: at(0) },      // real purchase, no reference
  { id: 4, customerId: 'a', type: 'DEBIT', amount: '70', status: 'APPROVED', reference: null, providerRef: null, createdAt: at(60000) },    // test purchase, part cashback
  { id: 5, customerId: 'a', type: 'DEBIT', amount: '70', status: 'APPROVED', reference: null, providerRef: null, createdAt: at(120000) },   // test purchase
  { id: 6, customerId: 'a', type: 'REFUND', amount: '70', status: 'APPROVED', reference: 'T2', providerRef: null, createdAt: at(125000) },  // its refund
  { id: 7, customerId: 'a', type: 'DEBIT', amount: '9', status: 'APPROVED', reference: 'MP-x', providerRef: 'MP-x', createdAt: at(200000) },// manual payout → real
];
const fakes = {
  'lib/prisma': { walletTransaction: { findMany: async () => rows }, order: { findMany: async ({ where }) => where.vtpassRequestId ? orders.filter((o) => o.isTest && where.vtpassRequestId.in.includes(o.vtpassRequestId)) : orders }, customer: { findMany: async () => [] } },
  'lib/goLive': { partnerModes: async () => ({ monnify: 'sandbox', squad: 'live', nomba: 'sandbox' }) },
  'lib/vtpass': { getSettings: async () => ({}) },
  'lib/features': { isOnFor: () => true },
  'lib/auth': { requireAdminAuth: (q, r, n) => n() },
};
const orig = Module._load;
Module._load = function (req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(ROOT, full).replace(/\.js$/, '');
  return fakes[rel] || orig.call(this, req, parent, ...rest);
};
const router = require(path.join(ROOT, 'routes/ledger.routes.js'));
const h = router.stack.find((l) => l.route?.path === '/admin/ledger').route.stack.at(-1).handle;
const run = (mode) => new Promise((done) => h({ query: { mode } }, { json: done, status() { return this; } }));
const tot = (b, type) => b.totals.find((t) => t.type === type) || { amount: 0, count: 0 };

test('ledger: purchase debits follow their order (real/test), totals match the rows', async () => {
  const real = await run('real');
  const tst = await run('test');
  const all = await run('all');
  assert.deepEqual(real.rows.map((r) => r.id), [1, 3, 7]);
  assert.deepEqual(tst.rows.map((r) => r.id), [2, 4, 5, 6]);
  for (const b of [real, tst, all]) {
    for (const t of b.totals) {
      const rs = b.rows.filter((r) => r.type === t.type);
      assert.equal(t.count, rs.length, `${b.mode} ${t.type} count`);
      assert.equal(t.amount, Math.round(rs.reduce((a, r) => a + r.amount * 100, 0)) / 100, `${b.mode} ${t.type} amount`);
    }
  }
  assert.equal(tot(real, 'DEBIT').amount, 59.25);
  assert.equal(tot(tst, 'DEBIT').amount, 140);
  assert.equal(tot(all, 'DEBIT').amount, 199.25);
});
