// Admin → Subscriptions: validation, countdowns, totals, reminders.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
let settings = { id: 1, subscriptions: null };
const alerts = [];
const fakes = {
  prisma: () => ({ settings: { update: async ({ data }) => { settings = { ...settings, ...data }; return settings; } } }),
  vtpass: () => ({ getSettings: async () => settings, invalidateSettings: () => {} }),
  adminAlert: () => ({ alertAdmins: async (title, text) => { alerts.push({ title, text }); } }),
};
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '');
  if (fakes[rel]) return fakes[rel]();
  return orig.call(this, req, parent, ...rest);
};
const subs = require('../lib/subscriptions');
const NOW = new Date('2026-11-01T10:00:00Z'); // 11:00 Lagos

test('starter list until saved; it validates as-is', async () => {
  const l = await subs.list(NOW);
  assert.equal(l.starter, true);
  assert.ok(l.rows.some((r) => r.provider === 'Whogohost' && r.period === 'YEARLY'));
  assert.ok(l.rows.some((r) => r.provider === 'RackNerd' && r.amount === '21.99' && r.currency === 'USD'));
  assert.equal(subs.validate(subs.STARTER).length, subs.STARTER.length);
  assert.deepEqual(l.totals.yearly, { USD: 21.99 });
});

test('countdown, due levels, missing fields and totals after saving', async () => {
  const l = await subs.save([
    { name: 'Domain', provider: 'Whogohost', period: 'YEARLY', amount: '15,000', currency: 'NGN', nextRenewal: '2026-11-04' },
    { name: 'VPS', period: 'YEARLY', amount: '21.99', currency: 'USD', nextRenewal: '2026-10-30' },
    { name: 'DB', period: 'MONTHLY', amount: '19', currency: 'USD' },
    { name: 'Old', period: 'YEARLY', amount: '5', status: 'CANCELLED', nextRenewal: '2026-10-01', notes: 'Director +234 811 299 9073' },
  ], NOW);
  assert.equal(l.starter, false);
  const by = Object.fromEntries(l.rows.map((r) => [r.name, r]));
  assert.equal(by.Domain.amount, '15000');
  assert.equal(by.Domain.daysLeft, 3);
  assert.equal(by.Domain.due, 'urgent');
  assert.equal(by.VPS.due, 'overdue');
  assert.deepEqual(by.DB.missing, ['next renewal date']);
  assert.equal(by.Old.daysLeft, null, 'cancelled plans have no countdown');
  assert.deepEqual(l.totals.yearly, { NGN: 15000, USD: 21.99 + 228 });
  assert.deepEqual(l.upcoming.map((u) => u.name), ['VPS', 'Domain']);
});

test('refuses bad input and anything that looks secret', () => {
  assert.throws(() => subs.validate('x'), subs.SubscriptionError);
  assert.throws(() => subs.validate([{ name: '' }]), /name/);
  assert.throws(() => subs.validate([{ name: 'A', amount: 'ten' }]), /number/);
  assert.throws(() => subs.validate([{ name: 'A', nextRenewal: '31/01/2027' }]), /dates/);
  assert.throws(() => subs.validate([{ name: 'A', notes: 'key sk_live_abcdefghijklmnop' }]), /secrets/);
  assert.throws(() => subs.validate([{ name: 'A', notes: 'card 4111 1111 1111 1111' }]), /secrets/);
  assert.throws(() => subs.validate([{ name: 'A', notes: 'password: hunter2' }]), /secrets/);
  assert.equal(subs.validate([{ name: 'A', loginUrl: 'javascript:alert(1)' }])[0].loginUrl, '');
  assert.equal(subs.validate([{ name: 'A', loginUrl: 'my.racknerd.com' }])[0].loginUrl, 'https://my.racknerd.com');
});

test('reminder: once a day, for 14/7/3/1/0 days or overdue', async () => {
  subs._reset(); alerts.length = 0;
  const hit = await subs.remind(NOW);
  assert.deepEqual(hit.sort(), [settings.subscriptions[0].id, settings.subscriptions[1].id].sort());
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /Domain.*renews in 3 day/);
  assert.match(alerts[0].text, /overdue by 2 day/);
  assert.equal(await subs.remind(NOW), null, 'not twice the same day');
  assert.equal(alerts.length, 1);
});
