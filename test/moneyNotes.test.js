// Audit-friendly notes for manual money corrections (text only).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { makeDb } = require('./helpers/memdb');

const ROOT = path.resolve(__dirname, '..');
let db = makeDb();
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  if (path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '') === 'prisma') return new Proxy({}, { get: (_, p) => db[p] });
  return orig.call(this, req, parent, ...rest);
};
const notes = require('../lib/moneyNotes');

test('refund note names the order, amount and approver; warns on SUCCESS / already refunded', async () => {
  db = makeDb();
  const c = await db.customer.create({ data: { name: 'Ada', phone: '08030000001', passwordHash: 'x' } });
  const o = await db.order.create({ data: { customerId: c.id, service: 'DATA', provider: 'mtn-data', status: 'SUCCESS', amount: '1500.00', vtpassRequestId: '202611071504fb3fcd93' } });
  const r = await notes.suggest({ type: 'CREDIT', amount: 1500, customerId: c.id, reason: 'FAILED_ORDER', orderId: o.id, detail: 'VTpass confirmed not delivered', adminName: 'Ridwan' });
  assert.match(r.note, /^Refund: failed purchase not auto-refunded ₦1,500\.00 — order 202611071504fb3fcd93 \(data mtn-data, ₦1,500\.00, SUCCESS\); VTpass confirmed not delivered — approved by Ridwan \d{4}-\d{2}-\d{2}$/);
  assert.ok(r.note.length <= 200);
  assert.ok(r.warnings.some((w) => /SUCCESS/.test(w)));
  await db.walletTransaction.create({ data: { customerId: c.id, type: 'REFUND', status: 'APPROVED', amount: '1500.00', reference: '202611071504fb3fcd93' } });
  assert.ok((await notes.suggest({ type: 'CREDIT', reason: 'FAILED_ORDER', orderId: o.id })).warnings.some((w) => /already exists/.test(w)));
});

test('debit reasons, kind mismatch warning, no-evidence checklist', async () => {
  db = makeDb();
  const r = await notes.suggest({ type: 'DEBIT', amount: 0.53, reason: 'TEST_CLEANUP' });
  assert.match(r.note, /^Owner test balance cleared ₦0\.53 — approved by owner/);
  assert.ok(r.checklist.some((x) => /evidence/.test(x)));
  assert.ok((await notes.suggest({ type: 'DEBIT', reason: 'GOODWILL' })).warnings.some((w) => /normally a credit/.test(w)));
});

test('manual adjustments now need a reason; AI tool is owner-only', () => {
  const a = fs.readFileSync(path.join(ROOT, 'routes/admin.routes.js'), 'utf8');
  assert.match(a, /String\(note \|\| ''\)\.trim\(\)\.length < 8/);
  const src = fs.readFileSync(path.join(ROOT, 'routes/ai.routes.js'), 'utf8');
  assert.ok(src.includes("name: 'suggest_money_note'"));
  assert.ok(!/const STAFF_TOOL_NAMES = \[[^\]]*suggest_money_note/.test(src));
});
