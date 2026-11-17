// "Verify with BVN" + auto-fill with the TEST provider: nothing about the
// person before a correct code, wrong codes reveal nothing, a BVN already in
// use stops before the provider is called, details are locked, and the BVN
// is never stored or logged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { makeDb } = require('./helpers/memdb');

const ROOT = path.resolve(__dirname, '..');
let db = makeDb();
let settings = {};
let providerCalls = 0;
const fakes = {
  prisma: () => new Proxy({}, { get: (_, p) => db[p] }),
  vtpass: () => ({ getSettings: async () => settings, invalidateSettings: () => {} }),
};
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '');
  if (fakes[rel]) return fakes[rel]();
  return orig.call(this, req, parent, ...rest);
};
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
const testProvider = require('../lib/bvnProviders/test');
const realStart = testProvider.startConsent;
testProvider.startConsent = async (...a) => { providerCalls += 1; return realStart(...a); };
const B = require('../lib/bvnAutofill');
const { activeFor } = require('../lib/bvnProviders');
const idn = require('../lib/idNumber');

const BVN = '22212345678';
const logs = [];
const origWarn = console.warn; const origErr = console.error; const origLog = console.log;
console.warn = (...a) => { logs.push(a.join(' ')); }; console.error = (...a) => { logs.push(a.join(' ')); }; console.log = (...a) => { logs.push(a.join(' ')); };
test.after(() => { console.warn = origWarn; console.error = origErr; console.log = origLog; });

async function seed() {
  db = makeDb();
  providerCalls = 0;
  const c = await db.customer.create({ data: { name: 'ada okafor typo', phone: '08030000001', passwordHash: 'x' } });
  settings = { bvnAutofillMode: 'TESTERS', bvnProvider: 'test', featureTesters: [{ id: c.id }] };
  return c;
}

test('switch: OFF / testers only; TEST provider never for everyone', async () => {
  const c = await seed();
  assert.ok(activeFor(settings, c.id));
  assert.equal(activeFor(settings, 'someone-else'), null, 'not a tester');
  assert.equal(activeFor({ ...settings, bvnAutofillMode: 'OFF' }, c.id), null);
  assert.equal(activeFor({ ...settings, bvnAutofillMode: 'ON' }, 'someone-else'), null, 'ON with the TEST provider still helps nobody');
  assert.equal(activeFor({ ...settings, bvnProvider: 'dojah', bvnProviderKey: 'k' }, c.id), null, 'placeholder providers do nothing');
});

test('no details before the code; wrong code reveals nothing; right code fills and locks', async () => {
  const c = await seed();
  const s = await B.start(c, { bvn: BVN, consent: true, ip: '1.2.3.4' });
  assert.deepEqual(Object.keys(s).sort(), ['expiresInMinutes', 'phoneHint', 'sessionId']);
  assert.equal(s.phoneHint, '••••23');
  assert.ok(!JSON.stringify(s).match(/Adaeze|Okafor|1990/), 'nothing about the person yet');
  assert.equal((await db.customer.findUnique({ where: { id: c.id } })).kycVerifiedAt ?? null, null);

  const fresh = await db.customer.findUnique({ where: { id: c.id } });
  await assert.rejects(B.confirm(fresh, { sessionId: s.sessionId, otp: '000000', bvn: BVN }), (e) => {
    assert.match(e.message, /isn’t right/);
    assert.ok(!/Adaeze|Okafor|1990/.test(JSON.stringify(e)), 'wrong code: nothing about the person');
    return true;
  });
  await assert.rejects(B.confirm(fresh, { sessionId: s.sessionId, otp: '123456', bvn: '22299999999' }), /Start the BVN check again/, 'a different BVN cannot use this session');

  const ok = await B.confirm(fresh, { sessionId: s.sessionId, otp: '123456', bvn: BVN });
  assert.deepEqual(ok, { verified: true, firstName: 'Adaeze', middleName: 'Test', lastName: 'Okafor', dateOfBirth: '1990-05-14' });
  const after = await db.customer.findUnique({ where: { id: c.id } });
  assert.equal(after.name, 'Adaeze Test Okafor');
  assert.equal(new Date(after.dateOfBirth).toISOString().slice(0, 10), '1990-05-14');
  assert.equal(after.kycType, 'BVN');
  assert.equal(after.kycSource, 'BVN_AUTOFILL');
  assert.ok(after.kycVerifiedAt);
  assert.equal(after.kycHash, idn.identityHash('BVN', BVN));
  await assert.rejects(B.start(after, { bvn: BVN, consent: true }), /already verified/);
});

test('BVN already used by another account stops BEFORE the provider is called', async () => {
  const c = await seed();
  await db.customer.create({ data: { name: 'Other', phone: '08030000002', passwordHash: 'x', kycHash: idn.identityHash('BVN', BVN) } });
  await assert.rejects(B.start(c, { bvn: BVN, consent: true }), /already linked to another/);
  assert.equal(providerCalls, 0, 'no paid lookup');
});

test('limits: 3 starts a day, 5 wrong codes a day, consent required', async () => {
  const c = await seed();
  await assert.rejects(B.start(c, { bvn: BVN, consent: false }), /Tick the box/);
  const sessions = [];
  for (let i = 0; i < 3; i += 1) sessions.push(await B.start(c, { bvn: BVN, consent: true, ip: '5.5.5.5' }));
  await assert.rejects(B.start(c, { bvn: BVN, consent: true }), /3 times today/);
  for (let i = 0; i < 5; i += 1) await assert.rejects(B.confirm(c, { sessionId: sessions[i % 3].sessionId, otp: '111111', bvn: BVN }), /isn’t right/);
  await assert.rejects(B.confirm(c, { sessionId: sessions[0].sessionId, otp: '123456', bvn: BVN }), /Too many wrong codes/, 'even the right code is refused after 5 wrong ones');
});

test('the BVN is never stored or logged', async () => {
  const c = await seed();
  const s = await B.start(c, { bvn: BVN, consent: true, ip: '9.9.9.9' });
  await B.confirm(c, { sessionId: s.sessionId, otp: '123456', bvn: BVN }).catch(() => {});
  assert.ok(!JSON.stringify(db._tables).includes(BVN), 'not in any table');
  assert.ok(!logs.join('\n').includes(BVN), 'not in any log line');
});

test('locked: the customer can’t change the name; routes refuse the AI; admin is owner-only', () => {
  const auth = fs.readFileSync(path.join(ROOT, 'routes/auth.routes.js'), 'utf8');
  assert.match(auth, /cur\?\.kycVerifiedAt && clean !== cur\.name\) return res\.status\(400\)/);
  const r = fs.readFileSync(path.join(ROOT, 'routes/bvn.routes.js'), 'utf8');
  assert.equal((r.match(/if \(noAi\(req, res\)\) return;/g) || []).length, 3);
  assert.ok(!fs.readFileSync(path.join(ROOT, 'lib/staffAccess.js'), 'utf8').includes('bvn'), 'support staff can’t open the admin routes');
  // Account creation then skips the old name+DOB match (no money logic change).
  assert.match(fs.readFileSync(path.join(ROOT, 'routes/bankfunding.routes.js'), 'utf8'), /mustVerify\(settings\)\) && !\(customer\.kycVerifiedAt && customer\.kycHash === kycHash\)/);
});
