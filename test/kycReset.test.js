// Monnify went live: reset BVN/NIN checks and account numbers made before
// the cutoff. Only the KYC fields and account numbers are cleared; wallet
// balances, orders and history are untouched; old numbers are retired.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { makeDb } = require('./helpers/memdb');

const ROOT = path.resolve(__dirname, '..');
let db = makeDb();
const fakes = {
  prisma: () => new Proxy({}, { get: (_, prop) => db[prop] }),
  vtpass: () => ({ getSettings: async () => ({}), vtpassRequest: async () => ({}) }),
};
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '');
  if (fakes[rel]) return fakes[rel]();
  return orig.call(this, req, parent, ...rest);
};
const goLive = require('../lib/goLive');

const CUTOFF = new Date('2026-11-06T00:00:00+01:00');
const old = new Date('2026-11-01T10:00:00+01:00');
const fresh = new Date('2026-11-06T10:00:00+01:00');

test('reset: only KYC fields and account numbers of pre-cutoff customers are cleared; balances untouched', async () => {
  db = makeDb();
  const accounts = [{ provider: 'monnify', bankName: 'Wema bank', accountNumber: '5000000001' }, { provider: 'nomba', bankName: 'Nombank MFB', accountNumber: '5000000002' }];
  const a = await db.customer.create({ data: { name: 'Ada', phone: '08030000001', passwordHash: 'x', walletBalance: '12551.72', cashbackBalance: '2.52', savingsBalance: '100.00', loyaltyPoints: 40, kycType: 'BVN', kycHash: 'h1', kycVerifiedAt: old, bankAccounts: accounts, bankAccountRef: 'ZP-a', bankAccountAt: old, nombaAccountRef: 'NB-a', nombaAccountAt: old, dateOfBirth: '1990-01-01' } });
  const b = await db.customer.create({ data: { name: 'Bola', phone: '08030000002', passwordHash: 'x', walletBalance: '500.00', kycType: 'NIN', kycHash: 'h2', squadAccountRef: 'SQ-b', squadAccountAt: old, bankAccounts: [{ provider: 'squad', bankName: 'GTBank', accountNumber: '5000000003' }] } });
  const c = await db.customer.create({ data: { name: 'Chi', phone: '08030000003', passwordHash: 'x', walletBalance: '900.00', kycType: 'BVN', kycHash: 'h3', kycVerifiedAt: fresh, bankAccounts: [{ provider: 'monnify', accountNumber: '5000000004' }], bankAccountRef: 'ZP-c', bankAccountAt: fresh } });
  const d = await db.customer.create({ data: { name: 'Dayo', phone: '08030000004', passwordHash: 'x', walletBalance: '1.00' } });
  await db.order.create({ data: { customerId: a.id, service: 'DATA', status: 'SUCCESS', amount: '100.00', vtpassRequestId: 'R1' } });
  await db.walletTransaction.create({ data: { customerId: a.id, type: 'FUND', status: 'APPROVED', amount: '12651.72', providerRef: 'NB-x' } });
  const before = Object.fromEntries((await db.customer.findMany()).map((x) => [x.id, x]));
  const ordersBefore = JSON.stringify(await db.order.findMany());
  const txBefore = JSON.stringify(await db.walletTransaction.findMany());

  const r = await goLive.resetKycBefore(CUTOFF);
  assert.deepEqual(r, { customers: 2, wereVerified: 1, numbers: 3 });

  const after = Object.fromEntries((await db.customer.findMany()).map((x) => [x.id, x]));
  const CLEARED = ['kycVerifiedAt', 'kycHash', 'kycType', 'bankAccounts', 'bankAccountRef', 'bankAccountAt', 'squadAccountRef', 'squadAccountAt', 'nombaAccountRef', 'nombaAccountAt'];
  for (const id of [a.id, b.id]) {
    for (const f of CLEARED) assert.ok(after[id][f] === null || after[id][f] === undefined, `${f} cleared`);
    for (const f of Object.keys(before[id]).filter((k) => !CLEARED.includes(k))) assert.deepEqual(after[id][f], before[id][f], `${f} unchanged`);
  }
  assert.equal(after[a.id].walletBalance, before[a.id].walletBalance);
  assert.equal(after[a.id].cashbackBalance, before[a.id].cashbackBalance);
  assert.equal(after[a.id].savingsBalance, before[a.id].savingsBalance);
  assert.deepEqual(after[c.id], before[c.id], 'verified after the cutoff: untouched');
  assert.deepEqual(after[d.id], before[d.id], 'never verified: untouched');
  assert.equal(JSON.stringify(await db.order.findMany()), ordersBefore, 'orders untouched');
  assert.equal(JSON.stringify(await db.walletTransaction.findMany()), txBefore, 'wallet history untouched');

  // Old numbers are remembered, so later payments to them land in Unmatched payments.
  const retired = await db.retiredAccountRef.findMany();
  assert.deepEqual(retired.map((x) => `${x.provider}:${x.ref}`).sort(), ['monnify:ZP-a', 'nomba:NB-a', 'squad:SQ-b']);
  assert.ok(retired.every((x) => x.reason === 'BVN check reset (Monnify live)'));
});

test('reset route: owner only (typed RESET-KYC), never the AI assistant; audit logged', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/golive.routes.js'), 'utf8');
  const route = src.slice(src.indexOf("'/admin/go-live/reset-kyc'"), src.indexOf('// Owner\'s partner accounts'));
  assert.match(route, /x-admin-assistant/);
  assert.match(route, /RESET-KYC/);
  assert.match(route, /KYC_RESET_BEFORE_LIVE/);
  assert.ok(!fs.readFileSync(path.join(ROOT, 'lib/staffAccess.js'), 'utf8').includes('reset-kyc'), 'support staff cannot call it');
  // With kycVerifiedAt cleared, the real check runs again (no "already verified" skip).
  const bf = fs.readFileSync(path.join(ROOT, 'routes/bankfunding.routes.js'), 'utf8');
  assert.match(bf, /mustVerify\(settings\)\) && !\(customer\.kycVerifiedAt && customer\.kycHash === kycHash\)/);
});
