// Monnify charges for every BVN/NIN lookup. A passed check must be kept even
// if creating the account number then fails (no paid re-check on retry), and
// paid lookups are capped per customer per day.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { makeDb } = require('./helpers/memdb');

const ROOT = path.resolve(__dirname, '..');
let db = makeDb();
let lookups = 0;
const fakes = {
  prisma: () => new Proxy({}, { get: (_, prop) => db[prop] }),
  adminAlert: () => ({ alertAdmins: async () => {} }),
  monnify: () => ({ getConfig: async () => ({ mode: 'live' }), MonnifyError: class extends Error {}, api: async () => { lookups += 1; return { name: { matchStatus: 'FULL_MATCH' }, dateOfBirth: 'FULL_MATCH' }; } }),
};
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '');
  if (fakes[rel]) return fakes[rel]();
  return orig.call(this, req, parent, ...rest);
};
const idCheck = require('../lib/idCheck');

test('paid lookups are capped per day, passes included', async () => {
  db = makeDb();
  lookups = 0;
  const c = await db.customer.create({ data: { name: 'Ada Obi', phone: '08030000001', passwordHash: 'x' } });
  for (let i = 0; i < idCheck.MAX_PAID_CHECKS_PER_DAY; i += 1) await db.idCheck.create({ data: { customerId: c.id, idType: 'BVN', result: 'PASS' } });
  await assert.rejects(idCheck.verify(c, { idType: 'BVN', idNumber: '22212345678', dateOfBirth: '1990-01-01' }), /checked several times today/);
  assert.equal(lookups, 0, 'Monnify was not called (no charge)');
});

test('routes keep a passed check when account creation fails', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/bankfunding.routes.js'), 'utf8');
  const mon = src.slice(src.indexOf('const passed = Boolean(verifiedDob)'), src.indexOf('// Invited friend just verified'));
  assert.match(mon, /kycVerifiedAt: new Date\(\)/, 'saved before the account is created');
  assert.match(mon, /if \(!passed\) await prisma\.customer\.update\(\{ where: \{ id: customer\.id \}, data: \{ kycHash: null \} \}\)/, 'only an unverified claim is freed');
  assert.ok(mon.indexOf('kycVerifiedAt: new Date()') < mon.indexOf('createReservedAccount'), 'verified is recorded before creating the account');
  // The skip rule that avoids a second paid check:
  assert.match(src, /mustVerify\(settings\)\) && !\(customer\.kycVerifiedAt && customer\.kycHash === kycHash\)/);
  assert.match(src, /claimed = !verifiedDob;/, 'Nomba: a verified claim is kept on failure');
});
