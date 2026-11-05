// The Monnify payout wallet (settings.monnifyWalletAccount) is Monnify's
// internal number, not a bank account: it must never be shown as a
// "Fund (top-up)" account or with a Copy button.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
let settings = {};
const fakes = {
  prisma: () => ({ settings: { update: async () => ({}) } }),
  vtpass: () => ({ getSettings: async () => settings, invalidateSettings: () => {} }),
};
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '');
  if (fakes[rel]) return fakes[rel]();
  return orig.call(this, req, parent, ...rest);
};
const pa = require('../lib/partnerAccounts');

test('Monnify payout wallet is shown as internal, never as somewhere to send money', async () => {
  settings = { monnifyWalletAccount: '8012345678', partnerAccounts: [{ id: 'abcdef12', partner: 'monnify', role: 'TOPUP', bankName: 'Wema', accountNumber: '1234567890' }] };
  const { accounts } = await pa.list();
  const w = accounts.find((a) => a.id === 'auto-monnify-wallet');
  assert.equal(w.role, 'INTERNAL');
  assert.equal(w.roleName, '🔒 Payout wallet (internal Monnify number, used by the app for Send to Bank)');
  assert.equal(w.whatItDoes, 'Do NOT send money to this number. To top up, use the Fund account from Monnify → Balances → Fund Balance.');
  assert.equal(w.noCopy, true);
  assert.ok(!/Fund \(top-up\)|top up your Monnify wallet/i.test(`${w.roleName} ${w.whatItDoes} ${w.bankName}`));
  const fund = accounts.find((a) => a.id === 'abcdef12');
  assert.equal(fund.roleName, 'Fund (top-up)', 'a real Fund account the owner saved is unchanged');
  assert.match(fund.whatItDoes, /Balances → Fund Balance/);
  assert.ok(!fund.noCopy);
});

test('the same number saved by hand is still shown as internal, with a warning and no Copy', async () => {
  settings = { monnifyWalletAccount: '8012345678', partnerAccounts: [{ id: 'abcdef12', partner: 'monnify', role: 'TOPUP', bankName: 'Monnify', accountNumber: '8012345678' }] };
  const { accounts } = await pa.list();
  assert.ok(accounts.some((a) => a.id === 'auto-monnify-wallet' && a.role === 'INTERNAL'));
  const saved = accounts.find((a) => a.id === 'abcdef12');
  assert.equal(saved.noCopy, true);
  assert.match(saved.whatItDoes, /do NOT send money to it/);
});

test('the internal role cannot be saved, and the setting is never changed', () => {
  assert.throws(() => pa.validate([{ partner: 'monnify', role: 'INTERNAL', bankName: 'x', accountNumber: '8012345678' }]), /choose what it is for/);
  const src = fs.readFileSync(path.join(ROOT, 'lib/partnerAccounts.js'), 'utf8');
  assert.ok(!/monnifyWalletAccount\s*:/.test(src), 'partnerAccounts never writes monnifyWalletAccount');
  const golive = fs.readFileSync(path.join(ROOT, 'lib/goLive.js'), 'utf8');
  assert.match(golive, /x\.role !== 'INTERNAL'/, 'the internal wallet does not count as a recorded Monnify account');
});
