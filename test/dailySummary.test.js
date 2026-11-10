// The daily email's profit must be the same figure as Admin → Overview
// (lib/earnings.js), not a rough "paid − face value" that ignores VTpass
// commission. Test orders are left out.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const { makeDb } = require('./helpers/memdb');

const ROOT = path.resolve(__dirname, '..');
let db = makeDb();
let ranged = null;
const fakes = {
  prisma: () => new Proxy({}, { get: (_, prop) => db[prop] }),
  vtpass: () => ({ getSettings: async () => ({}), vtpassRequest: async () => ({ contents: { balance: 3951 } }) }),
  adminAlert: () => ({ emailAdmins: async () => ({ sent: 1 }) }),
  earnings: () => ({ earningsReport: async (range) => { ranged = range; return { profit: 26 }; } }),
};
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '');
  if (fakes[rel]) return fakes[rel]();
  return orig.call(this, req, parent, ...rest);
};
const { buildSummary } = require('../lib/dailySummary');

test('daily email profit = Overview profit (VTpass commission included); test orders left out', async () => {
  db = makeDb();
  // Yesterday at noon, Lagos time (the email covers the previous Lagos day).
  const todayLagos = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 10);
  const y = new Date(new Date(`${todayLagos}T12:00:00+01:00`).getTime() - 24 * 3600 * 1000);
  await db.order.create({ data: { customerId: 'c', service: 'DATA', status: 'SUCCESS', amount: '1485.00', costAmount: '1500.00', cashbackAmount: '4.00', isTest: false, vtpassRequestId: 'R1', createdAt: y } });
  await db.order.create({ data: { customerId: 'c', service: 'DATA', status: 'SUCCESS', amount: '9000.00', costAmount: '9000.00', isTest: true, vtpassRequestId: 'T1', createdAt: y } });
  const s = await buildSummary();
  assert.match(s.text, /Profit\D+26/, 'same ₦26 as the Overview, not −₦19');
  assert.match(s.text, /Sales\D+1,485 \(1 orders\)/, 'sandbox order not counted');
  assert.ok(ranged && ranged.gte && ranged.lt, 'profit computed for the same day');
});
