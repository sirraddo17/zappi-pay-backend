// Customer-funds guard: only LIVE partner wallets count, and owner-marked
// test accounts aren't real money owed. (Bug: ₦10m of Nomba sandbox money
// showed as "yours to move out of Monnify".)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
let check;
const fakes = {
  moneyCheck: () => ({ moneyCheck: async () => check }),
  vtpass: () => ({ getSettings: async () => ({ payoutProvider: 'monnify' }) }),
  adminAlert: () => ({ alertAdmins: async () => {} }),
  quietClock: () => ({ every: () => {} }),
};
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '');
  if (fakes[rel]) return fakes[rel]();
  return orig.call(this, req, parent, ...rest);
};
const guard = require('../lib/fundsGuard');

test('sandbox Nomba money never counts; test accounts not owed', async () => {
  check = {
    at: new Date(),
    owed: { total: 25935.89, pendingTransfers: 0 },
    real: { owed: 484.53, testAccounts: { total: 25451.36 } },
    have: { monnify: 1179.72, squad: 0, nomba: 10095630, modes: { monnify: 'live', squad: 'sandbox', nomba: 'sandbox' } },
  };
  const c = await guard.coverage({ fresh: true });
  assert.equal(c.nomba, null, 'sandbox Nomba not counted');
  assert.equal(c.held, 1179.72);
  assert.equal(c.owed, 484.53);
  assert.equal(c.testAccountsNotCounted, 25451.36);
  assert.equal(c.status, 'OK');
  assert.equal(c.safeToWithdraw, 695.19, 'not ₦10,070,873.83');
});

test('without real Monnify cover it is SHORT', async () => {
  check = { at: new Date(), owed: { total: 5000, pendingTransfers: 0 }, real: { owed: 5000, testAccounts: { total: 0 } }, have: { monnify: 1000, nomba: 9e6, modes: { monnify: 'live', nomba: 'sandbox' } } };
  const c = await guard.coverage({ fresh: true });
  assert.equal(c.status, 'SHORT');
  assert.equal(c.shortBy, 4000);
  assert.equal(c.safeToWithdraw, 0);
});
