// Owner dashboard summary: key check and the numbers it reports.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const counts = { order: 0 };
const fakes = {
  prisma: () => ({
    order: { findMany: async () => [{ amount: 500 }, { amount: 1000 }], count: async ({ where }) => (where.status === 'FAILED' ? 1 : 2) },
    customer: { count: async (a) => (a ? 3 : 40) },
    walletTransaction: { aggregate: async () => ({ _sum: { amount: 7000 } }), count: async () => 1 },
    bankTransfer: { count: async ({ where }) => (where.status === 'HELD' ? 0 : 2) },
    supportTicket: { count: async () => 4 },
  }),
  vtpass: () => ({ vtpassRequest: async () => ({ contents: { balance: 12345 } }) }),
};
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '');
  if (fakes[rel]) return fakes[rel]();
  return orig.call(this, req, parent, ...rest);
};
const { buildOwnerSummary, ownerKeyOk } = require('../lib/ownerSummary');

test('owner key: needs a long key and an exact match', () => {
  process.env.OWNER_KEY = 'k'.repeat(32);
  assert.equal(ownerKeyOk({ headers: { 'x-owner-key': 'k'.repeat(32) } }), true);
  assert.equal(ownerKeyOk({ headers: { 'x-owner-key': 'k'.repeat(31) + 'x' } }), false);
  assert.equal(ownerKeyOk({ headers: {} }), false);
  process.env.OWNER_KEY = 'short';
  assert.equal(ownerKeyOk({ headers: { 'x-owner-key': 'short' } }), false, 'too short a key is refused');
});

test('summary: today sales, users, VTpass balance and what needs attention', async () => {
  const s = await buildOwnerSummary();
  assert.equal(s.app, 'ZAPPI PAY');
  assert.deepEqual(s.today, { orders: 2, salesNGN: 1500, failed: 1, fundedNGN: 7000 });
  assert.deepEqual(s.users, { total: 40, newToday: 3 });
  assert.equal(s.balances.vtpassNGN, 12345);
  assert.ok(s.attention.some((a) => /4 open support/.test(a)));
  assert.ok(s.attention.some((a) => /2 bank transfer\(s\) waiting/.test(a)));
  assert.ok(!s.attention.some((a) => /held/.test(a)), 'zero counts are left out');
});
