// Monnify live: creating a customer's account number when Monnify already
// has one under the same reference (after a BVN-check reset) must fetch
// that account, not fail. Fake Monnify API (global fetch), memdb.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const { makeDb } = require('./helpers/memdb');

const ROOT = path.resolve(__dirname, '..');
let db = makeDb();
const fakes = {
  prisma: () => new Proxy({}, { get: (_, prop) => db[prop] }),
  vtpass: () => ({ getSettings: async () => ({ monnifyApiKey: 'MK_PROD_X', monnifySecretKey: 'S', monnifyContractCode: '123', monnifyMode: 'live' }) }),
  notify: () => ({ notify: async () => {} }),
};
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '');
  if (fakes[rel]) return fakes[rel]();
  return orig.call(this, req, parent, ...rest);
};
const monnify = require('../lib/monnify');

const calls = [];
function fakeMonnify(postReply, getReply) {
  global.fetch = async (url, opts = {}) => {
    calls.push(`${opts.method || 'GET'} ${url.replace('https://api.monnify.com', '')}`);
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (url.endsWith('/api/v1/auth/login')) return json(200, { requestSuccessful: true, responseBody: { accessToken: 't', expiresIn: 3000 } });
    if (opts.method === 'POST') return json(...postReply);
    return json(...getReply);
  };
}
const ACCOUNTS = { requestSuccessful: true, responseBody: { accounts: [{ bankName: 'Moniepoint Microfinance Bank', bankCode: '50515', accountNumber: '5000012345', accountName: 'ZAP-ADEYEMO' }] } };

test('"same reference" (live code 99): fetches the customer\'s own existing account', async () => {
  db = makeDb();
  calls.length = 0;
  const c = await db.customer.create({ data: { name: 'ADEYEMO RIDWAN', phone: '08030000001', passwordHash: 'x' } });
  fakeMonnify([400, { requestSuccessful: false, responseMessage: 'You cannot reserve an account with the same reference', responseCode: '99' }], [200, ACCOUNTS]);
  const u = await monnify.createReservedAccount(c, { idType: 'BVN', idNumber: '22200000000' });
  assert.equal(u.bankAccountRef, `ZP-${c.id}`);
  assert.equal(u.bankAccounts[0].accountNumber, '5000012345');
  assert.equal(u.bankAccounts[0].mode, 'live');
  assert.equal(u.kycType, 'BVN');
  assert.ok(calls.includes(`GET /api/v2/bank-transfer/reserved-accounts/ZP-${c.id}`), 'only our own reference is looked up');
});

test('R42 "more than 1 account": uses ours if it exists, otherwise a clear message', async () => {
  db = makeDb();
  const c = await db.customer.create({ data: { name: 'Ada Obi', phone: '08030000002', passwordHash: 'x' } });
  const R42 = [400, { requestSuccessful: false, responseMessage: 'You cannot reserve more than 1 account(s) for a customer. Please contact support for assistance.', responseCode: 'R42' }];
  fakeMonnify(R42, [200, ACCOUNTS]);
  const u = await monnify.createReservedAccount(c, { idType: 'BVN', idNumber: '22200000000' });
  assert.equal(u.bankAccounts.length, 1);
  db = makeDb();
  const d = await db.customer.create({ data: { name: 'Bola Ade', phone: '08030000003', passwordHash: 'x' } });
  fakeMonnify(R42, [404, { requestSuccessful: false, responseMessage: 'Cannot find reserved account', responseCode: '99' }]);
  await assert.rejects(monnify.createReservedAccount(d, { idType: 'BVN', idNumber: '22200000000' }), /already has an account number for you/);
  assert.equal((await db.customer.findUnique({ where: { id: d.id } })).bankAccounts ?? null, null, 'nothing saved');
});

test('other Monnify errors still fail as before', async () => {
  db = makeDb();
  const c = await db.customer.create({ data: { name: 'Chi Eze', phone: '08030000004', passwordHash: 'x' } });
  fakeMonnify([400, { requestSuccessful: false, responseMessage: 'Invalid contract code', responseCode: '99' }], [200, ACCOUNTS]);
  await assert.rejects(monnify.createReservedAccount(c, { idType: 'BVN', idNumber: '22200000000' }), /Invalid contract code/);
});
