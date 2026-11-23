// Launch waitlist: the welcome-page form, admin list/CSV, launch emails.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { makeDb } = require('./helpers/memdb');

const ROOT = path.resolve(__dirname, '..');
const db = makeDb();
let emailOn = true;
const fakes = {
  prisma: () => new Proxy({}, { get: (_, prop) => db[prop] }),
  email: () => ({ isEmailConfigured: () => emailOn, sendEmail: async () => {} }),
};
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '');
  if (fakes[rel]) return fakes[rel]();
  return orig.call(this, req, parent, ...rest);
};
const w = require('../lib/waitlist');

test('phone numbers are cleaned to 11 digits; bad ones refused', () => {
  assert.equal(w.cleanPhone('+234 803 123 4567'), '08031234567');
  assert.equal(w.cleanPhone('2348031234567'), '08031234567');
  assert.equal(w.cleanPhone('0803-123-4567'), '08031234567');
  for (const p of ['12345', '0603123456', '0803123456', '080312345678', '']) assert.equal(w.cleanPhone(p), null, p);
});

test('join: saves once per phone, updates on repeat, ignores robots and checks fields', async () => {
  assert.deepEqual(await w.join({ name: ' Ada  Obi ', phone: '+2348031234567', email: 'ADA@x.com', interests: ['data', 'hack', 'data'], source: 'tiktok' }), { ok: true });
  assert.deepEqual(await w.join({ name: 'Ada Obi', phone: '08031234567', interests: ['airtime'] }), { ok: true, already: true });
  const rows = await db.waitlistEntry.findMany({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Ada Obi');
  assert.equal(rows[0].email, 'ada@x.com', 'email kept when not given again');
  assert.deepEqual(rows[0].interests, ['airtime']);
  assert.deepEqual(await w.join({ name: 'Bot', phone: '08031111111', website: 'spam.com' }), { ok: true });
  assert.equal((await db.waitlistEntry.findMany({})).length, 1, 'robot not saved');
  await assert.rejects(w.join({ name: 'A', phone: '08031234568' }), /name/);
  await assert.rejects(w.join({ name: 'Bola', phone: '123' }), /phone/);
  await assert.rejects(w.join({ name: 'Bola', phone: '08031234568', email: 'nope' }), /email/);
});

test('CSV escapes commas/quotes and blocks spreadsheet formulas', async () => {
  await w.join({ name: '=HYPERLINK("x") Ben', phone: '08051234567' });
  await w.join({ name: 'Chi, "Boss"', phone: '09061234567', email: 'chi@x.com' });
  const out = await w.csv();
  assert.match(out, /^name,phone,email,interests,source,joined,emailed\n/);
  assert.match(out, /"'=HYPERLINK\(""x""\) Ben"/);
  assert.match(out, /"Chi, ""Boss"""/);
});

test('launch emails go once to people with an email; overview counts them', async () => {
  const sent = [];
  let r = await w.notify({}, { send: async (m) => sent.push(m) });
  assert.equal(r.sent, 2); assert.equal(r.left, 0);
  assert.deepEqual(sent.map((m) => m.to).sort(), ['ada@x.com', 'chi@x.com']);
  assert.match(sent[0].text, /^Hi (Ada|Chi),/);
  assert.ok(!sent.some((m) => /"Boss"/.test(m.html)), 'names are escaped in html');
  r = await w.notify({}, { send: async (m) => sent.push(m) });
  assert.equal(r.sent, 0, 'nobody emailed twice');
  const o = await w.overview();
  assert.equal(o.total, 3); assert.equal(o.withEmail, 2); assert.equal(o.notified, 2);
  assert.deepEqual(await w.phones(), ['08031234567', '08051234567', '09061234567']);
  emailOn = false;
  await assert.rejects(w.notify({}), /Email isn/);
});

test('wiring: public form route is rate-limited; admin routes need an admin and stay owner-only', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/waitlist.routes.js'), 'utf8');
  assert.match(src, /router\.post\('\/waitlist', limit,/);
  for (const r of ["get('/admin/waitlist'", "get('/admin/waitlist/export'", "post('/admin/waitlist/notify'", "delete('/admin/waitlist/:id'", "get('/admin/waitlist/phones'"]) assert.ok(src.includes(`router.${r}, requireAdminAuth`), r);
  assert.ok(!/waitlist/.test(fs.readFileSync(path.join(ROOT, 'lib/staffAccess.js'), 'utf8')), 'support staff cannot see the list');
  assert.match(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'), /require\('\.\/routes\/waitlist\.routes'\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8'), /model WaitlistEntry \{[\s\S]*phone\s+String\s+@unique/);
});
