// Review items 9–12: delivery promise badge, BVN/NIN checks, account names.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
let paidTotal = 0;
let pool = 100;
let monnifyMode = 'sandbox';
const fakes = {
  prisma: () => ({ walletTransaction: { count: async () => 0, aggregate: async () => ({ _sum: { amount: String(paidTotal) } }) } }),
  vtpass: () => ({ getSettings: async () => ({}) }),
  notify: () => ({ notify: () => {} }),
  rewardSplit: () => ({ poolBalance: async () => pool }),
  monnify: () => ({ getConfig: async () => ({ mode: monnifyMode }) }),
};
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '');
  if (fakes[rel]) return fakes[rel]();
  return orig.call(this, req, parent, ...rest);
};
const dp = require('../lib/deliveryPromise');
const idn = require('../lib/idNumber');

const S = { deliveryPromiseEnabled: true, deliveryPromiseSeconds: 90, deliveryPromiseBonus: 5, deliveryPromiseDailyBudget: 100, rewardSplitEnabled: true };

test('fix 9: delivery promise badge only shows while the bonus can really be paid', async () => {
  paidTotal = 0; pool = 100;
  assert.equal((await dp.publicInfo(S)).bonus, 5);
  paidTotal = 98; // today's budget used up
  assert.equal(await dp.publicInfo(S), null);
  paidTotal = 0; pool = 2; // promise pool can't pay ₦5
  assert.equal(await dp.publicInfo(S), null);
  pool = 100;
  assert.equal(await dp.publicInfo({ ...S, deliveryPromiseEnabled: false }), null);
  const buy = fs.readFileSync(path.join(ROOT, '..', 'zappi-pay-frontend', 'src', 'pages', 'Buy.jsx'), 'utf8');
  assert.doesNotMatch(buy, /Delivered in \{/, 'no unconditional "Delivered in Xs or ₦Y back" claim');
});

test('fix 10: BVN/NIN must be 11 real-looking digits', () => {
  assert.equal(idn.check('BVN', '22212345678').number, '22212345678');
  assert.equal(idn.check('nin', '123 4567 8912').number, '12345678912');
  for (const bad of ['', '1234', '222123456789', '11111111111', '12345678901', '00000123456', '2221234567a', 'abcdefghijk']) assert.ok(idn.check('BVN', bad).error, bad);
  assert.ok(idn.check('PASSPORT', '22212345678').error);
});

test('fix 10: the real check is required once Monnify is live', async () => {
  monnifyMode = 'sandbox';
  assert.equal(await idn.mustVerify({ idMatchEnabled: false }), false);
  assert.equal(await idn.mustVerify({ idMatchEnabled: true }), true);
  monnifyMode = 'live';
  assert.equal(await idn.mustVerify({ idMatchEnabled: false }), true, 'cannot be skipped when live');
});

test('fix 10: BVN/NIN never stored or logged', () => {
  assert.equal(idn.scrub('Monnify said bvn 22212345678 invalid'), 'Monnify said bvn •••••••5678 invalid');
  assert.doesNotMatch(idn.scrub({ bvn: '22212345678' }), /22212345678/);
  const schema = fs.readFileSync(path.join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
  assert.doesNotMatch(schema, /^\s+(bvn|nin|idNumber)\s+String/m, 'no column holds the number');
  const routes = fs.readFileSync(path.join(ROOT, 'routes', 'bankfunding.routes.js'), 'utf8');
  for (const line of routes.split('\n').filter((l) => /console\.(log|error|warn)/.test(l))) assert.doesNotMatch(line.replace(/lib\/idNumber/g, ''), /idNumber|\bbvn\b|req\.body/, line.trim());
});

test('fix 11: one account-name format in the app', () => {
  const routes = fs.readFileSync(path.join(ROOT, 'routes', 'bankfunding.routes.js'), 'utf8');
  assert.match(routes, /ZAPPI PAY \/ \$\{titleName\(customerName\)\}/);
  assert.equal((routes.match(/shown\((customer|updated)\.bankAccounts\)/g) || []).length, 0, 'every list passes the customer name');
  assert.match(fs.readFileSync(path.join(ROOT, 'lib', 'nomba.js'), 'utf8'), /`ZAPPI PAY\/\$\{clean\(customer\.name\)\}`/);
});
