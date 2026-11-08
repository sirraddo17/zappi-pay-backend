// Owner-hidden providers (JAMB, Spectranet by default): left out of the Buy
// page and refused at purchase until shown again on Admin → Partners.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { makeDb } = require('./helpers/memdb');

const ROOT = path.resolve(__dirname, '..');
let db = makeDb();
let settings = {};
const fakes = {
  prisma: () => new Proxy({}, { get: (_, prop) => db[prop] }),
  vtpass: () => ({ getSettings: async () => settings, invalidateSettings: () => {} }),
};
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '');
  if (fakes[rel]) return fakes[rel]();
  return orig.call(this, req, parent, ...rest);
};
const hp = require('../lib/hiddenProviders');

test('JAMB and Spectranet hidden by default (even before the setting exists)', () => {
  assert.equal(hp.isHidden({}, 'jamb'), true);
  assert.equal(hp.isHidden({}, 'spectranet'), true);
  assert.equal(hp.isHidden({}, 'waec'), false);
  assert.equal(hp.isHidden({ hiddenProviders: [] }, 'jamb'), false, 'owner showed them again');
});

test('owner can show and hide again; unknown services refused', async () => {
  db = makeDb();
  const row = await db.settings.create({ data: { hiddenProviders: ['jamb', 'spectranet'] } });
  settings = { id: row.id, hiddenProviders: ['jamb', 'spectranet'] };
  const shown = await hp.setHidden('jamb', false);
  assert.deepEqual((await db.settings.findUnique({ where: { id: row.id } })).hiddenProviders, ['spectranet']);
  assert.equal(shown.choices.find((c) => c.id === 'jamb').name, 'JAMB PINs');
  await assert.rejects(hp.setHidden('mtn', true), /Unknown service/);
});

test('wiring: Buy page list filtered, purchase refused, route owner-only and not for the AI', () => {
  const v = fs.readFileSync(path.join(ROOT, 'routes/vtpass.routes.js'), 'utf8');
  assert.match(v, /hp\.isHidden\(settings, p\.serviceID\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'lib/purchase.js'), 'utf8'), /hiddenProviders'\)\.isHidden\(rawSettings, serviceID\)/);
  const r = fs.readFileSync(path.join(ROOT, 'routes/partners.routes.js'), 'utf8');
  assert.match(r, /router\.put\('\/admin\/partners\/hidden\/:provider', requireAdminAuth, guard\(/);
  assert.ok(!fs.readFileSync(path.join(ROOT, 'lib/staffAccess.js'), 'utf8').includes('partners/hidden'));
});
