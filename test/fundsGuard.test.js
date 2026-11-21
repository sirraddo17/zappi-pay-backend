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

test('live VTpass counts towards customer money; only partner money is withdrawable', async () => {
  // Owed ₦50,000: Monnify ₦20,000 + VTpass ₦40,000 = ₦60,000 → covered.
  check = { at: new Date(), owed: { total: 50000, pendingTransfers: 0 }, real: { owed: 50000, testAccounts: { total: 0 } }, have: { monnify: 20000, vtpass: 40000, modes: { monnify: 'live', vtpass: 'live' } } };
  let c = await guard.coverage({ fresh: true });
  assert.equal(c.status, 'OK');
  assert.equal(c.held, 60000);
  assert.equal(c.vtpass, 40000);
  assert.equal(c.safeToWithdraw, 10000, 'the ₦10,000 extra');
  // Extra sits in VTpass: nothing can go to a bank beyond what Monnify holds.
  check = { at: new Date(), owed: { total: 10000, pendingTransfers: 0 }, real: { owed: 10000, testAccounts: { total: 0 } }, have: { monnify: 3000, vtpass: 40000, modes: { monnify: 'live', vtpass: 'live' } } };
  c = await guard.coverage({ fresh: true });
  assert.equal(c.safeToWithdraw, 3000, 'capped by the Monnify balance');
  // Sandbox VTpass never counts; unreadable live VTpass pauses (INCOMPLETE).
  check = { at: new Date(), owed: { total: 50000, pendingTransfers: 0 }, real: { owed: 50000, testAccounts: { total: 0 } }, have: { monnify: 20000, vtpass: 9e6, modes: { monnify: 'live', vtpass: 'sandbox' } } };
  assert.equal((await guard.coverage({ fresh: true })).status, 'SHORT');
  check = { at: new Date(), owed: { total: 50000, pendingTransfers: 0 }, real: { owed: 50000, testAccounts: { total: 0 } }, have: { monnify: 20000, vtpass: null, vtpassError: 'timeout', modes: { monnify: 'live', vtpass: 'live' } } };
  c = await guard.coverage({ fresh: true });
  assert.equal(c.status, 'INCOMPLETE');
  assert.match(c.errors.join(' '), /timeout/);
});
