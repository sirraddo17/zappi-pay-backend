// Demo mode masking, the customer test-mode banner and Money check rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
let modes = { monnify: 'sandbox', squad: 'sandbox', nomba: 'sandbox' };
let settings = { vtpassMode: 'live', monnifyFundingEnabled: true, payoutProvider: 'monnify' };
let fundingOn = { squad: true, nomba: false };
const fakes = {
  goLive: () => ({ partnerModes: async () => modes }),
  vtpass: () => ({ getSettings: async () => settings, vtpassRequest: async () => ({ contents: { balance: 5959 } }) }),
  squad: () => ({ fundingOn: async () => fundingOn.squad, isConfigured: async () => true, walletBalance: async () => 1000 }),
  nomba: () => ({ fundingOn: async () => fundingOn.nomba, isConfigured: async () => true, walletBalance: async () => 5010049890.57 }),
  monnify: () => ({ isConfigured: async () => true, api: async () => ({ availableBalance: 4999992500 }) }),
  disbursement: () => ({ transferSettings: async () => ({ walletAccount: '123' }) }),
  disputes: () => ({ heldTotal: async () => 0 }),
  prisma: () => ({
    customer: { aggregate: async ({ _sum }) => ({ _count: 7, _sum: Object.fromEntries(Object.keys(_sum).map((f) => [f, { walletBalance: '44195.91', cashbackBalance: '2.52', savingsBalance: '0' }[f]])) }), count: async () => 0 },
    order: { aggregate: async () => ({ _count: 0, _sum: { amount: null } }) },
    bankTransfer: { aggregate: async () => ({ _count: 0, _sum: { amount: null, fee: null } }) },
    walletTransaction: { aggregate: async () => ({ _count: 0, _sum: { amount: null } }) },
  }),
};
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '');
  if (fakes[rel]) return fakes[rel]();
  return orig.call(this, req, parent, ...rest);
};

const demo = require('../lib/demoMask');
const testMode = require('../lib/testMode');
const { moneyCheck } = require('../lib/moneyCheck');

test('fix 2: banner never says live services are not real', async () => {
  const t = await testMode.state(settings);
  assert.equal(t.testMode, true);
  assert.doesNotMatch(t.text, /not real/i);
  assert.match(t.text, /Airtime, data and bills are live/);
  assert.match(t.text, /test money/);
  assert.match(t.text, /Send to Bank/);
  modes = { monnify: 'live', squad: 'live', nomba: 'live' };
  assert.equal((await testMode.state(settings)).testMode, false, 'all live → no banner');
  settings = { ...settings, vtpassMode: 'sandbox' };
  assert.match((await testMode.state(settings)).text, /not real yet/, 'only when purchases really are on test keys');
  settings = { ...settings, vtpassMode: 'live' };
  modes = { monnify: 'sandbox', squad: 'sandbox', nomba: 'sandbox' };
});

test('fix 7: Money check rows add up to Total owed; sandbox money is not counted', async () => {
  const m = await moneyCheck();
  assert.equal(m.owed.total, 44198.43);
  assert.equal(m.owed.partsTotal, m.owed.total);
  assert.ok(m.owed.parts.find((p) => p.key === 'cashback' && p.amount === 2.52), 'the N2.52 is cashback');
  assert.equal(m.have.total, 5959, 'only live VTpass counts, not N4,999,992,500 sandbox Monnify');
  assert.ok(m.have.sandbox.monnify > 0);
  assert.match(m.have.sandboxNote, /SANDBOX/);
});

test('fix 6: demo mode masks names, phones, keys and sandbox balances', () => {
  const body = {
    customers: [{ id: 'c1', name: 'Adeyemo Ridwan', phone: '08167550937', email: 'ridwan@gmail.com', walletBalance: '100.00' }],
    order: { recipient: '08012345678', provider: 'mtn-data', service: 'DATA', customer: { name: 'Bola Ade' } },
    partners: [{ key: 'vtpass', name: 'VTpass' }],
    settings: { monnifySecretKey: 'sk_live_abc123456789', vtpassApiKey: 'abc', ip: '102.89.84.78' },
    note: 'Call 08167550937 or mail ridwan@gmail.com from 102.89.84.78',
    accountName: 'SIRRADDO/ADEYEMO RIDWAN', accountNumber: '0123456789',
  };
  const out = demo.mask(JSON.parse(JSON.stringify(body)));
  const text = JSON.stringify(out);
  for (const secret of ['Adeyemo', 'Ridwan', '08167550937', 'ridwan@gmail.com', 'sk_live', '102.89.84.78', '0123456789', '08012345678', 'Bola']) assert.ok(!text.includes(secret), `${secret} hidden`);
  assert.equal(out.partners[0].name, 'VTpass', 'partner names stay');
  assert.equal(out.order.provider, 'mtn-data');
  assert.match(out.customers[0].phone, /^0816•+37$/);
});

test('fix 6: demo mode hides the Server & Database screen and sandbox figures', async () => {
  const calls = [];
  const res = { status(n) { calls.push(n); return this; }, json(b) { calls.push(b); return this; } };
  demo.middleware({ headers: { 'x-demo-mode': '1' }, path: '/api/admin/database', originalUrl: '/api/admin/database' }, res, () => calls.push('next'));
  assert.equal(calls[0], 403);
  const sent = [];
  const res2 = { json: (b) => sent.push(b) };
  demo.middleware({ headers: { 'x-demo-mode': '1' }, path: '/api/admin/money-check', originalUrl: '/api/admin/money-check' }, res2, () => {});
  const m = await moneyCheck();
  res2.json(m);
  assert.equal(sent[0].have.monnify, null);
  assert.match(sent[0].have.monnifyError, /SANDBOX \(test money\)/);
  assert.ok(!JSON.stringify(sent[0]).includes('4999992500'));
  assert.ok(!JSON.stringify(sent[0]).includes('5010049890'));
  // off → untouched
  const res3 = { json: (b) => b };
  let nexted = false;
  demo.middleware({ headers: {}, path: '/api/admin/customers', originalUrl: '/api/admin/customers' }, res3, () => { nexted = true; });
  assert.ok(nexted);
});
