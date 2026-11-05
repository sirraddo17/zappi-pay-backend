// Admin AI batch 3: compliance summary (get_compliance_summary + CSV) and
// partner follow-ups (get_partner_followups, propose_partner_task).
// In-memory database only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { makeDb } = require('./helpers/memdb');

const ROOT = path.resolve(__dirname, '..');
let db = makeDb();
let settings = { complianceSingleFunding: '1000000.00', complianceDailyFunding: '5000000.00' };
const fakes = {
  prisma: () => new Proxy({}, { get: (_, prop) => db[prop] }),
  adminAlert: () => ({ alertAdmins: async () => {} }),
  vtpass: () => ({ getSettings: async () => settings, invalidateSettings: () => {}, vtpassRequest: async () => ({}) }),
  earnings: () => ({ estimateCommission: () => 0 }),
};
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '');
  if (fakes[rel]) return fakes[rel]();
  return orig.call(this, req, parent, ...rest);
};

const C = require('../lib/compliance');
const desk = require('../lib/partnerDesk');
const A = require('../lib/adminActions');

const at = (s) => new Date(`${s}+01:00`);

async function seed() {
  db = makeDb();
  const real = await db.customer.create({ data: { name: 'Ada Real', phone: '08031234567', passwordHash: 'x', isTestAccount: false } });
  const big = await db.customer.create({ data: { name: 'Bayo Big', phone: '08097654321', passwordHash: 'x', isTestAccount: false } });
  const tester = await db.customer.create({ data: { name: 'Owner Test', phone: '08011112222', passwordHash: 'x', isTestAccount: true } });
  const fund = (c, amount, when, ref) => db.walletTransaction.create({ data: { customerId: c.id, type: 'FUND', status: 'APPROVED', amount, providerRef: ref, createdAt: at(when) } });
  await fund(real, '5000.00', '2026-10-03T10:00:00', 'NB-1');
  await fund(big, '1200000.00', '2026-10-04T10:00:00', 'NB-2'); // single ≥ ₦1m
  await fund(big, '2000000.00', '2026-10-09T09:00:00', 'NB-3'); // same day: 2m + 3.5m = 5.5m
  await fund(big, '3500000.00', '2026-10-09T15:00:00', 'NB-4');
  await fund(tester, '9000000.00', '2026-10-05T10:00:00', 'NB-5'); // test account: kept apart
  await fund(real, '777.00', '2026-11-01T10:00:00', 'NB-6'); // next month
  await db.walletTransaction.create({ data: { customerId: real.id, type: 'FUND', status: 'PENDING', amount: '100.00', providerRef: 'NB-7', createdAt: at('2026-10-06T10:00:00') } });
  const order = (c, amount, cashbackUsed, isTest, ref, status = 'SUCCESS') => db.order.create({ data: { customerId: c.id, service: 'DATA', provider: 'mtn-data', amount, cashbackUsed, isTest, status, vtpassRequestId: ref, createdAt: at('2026-10-10T10:00:00') } });
  await order(real, '1000.00', '50.00', false, 'R1');
  await order(real, '500.00', null, true, 'R2'); // sandbox order
  await order(tester, '300.00', null, false, 'R3'); // test account
  await order(real, '200.00', null, false, 'R4', 'FAILED');
  await db.walletTransaction.create({ data: { customerId: real.id, type: 'REFUND', status: 'APPROVED', amount: '200.00', reference: 'R4', createdAt: at('2026-10-10T11:00:00') } });
  await db.walletTransaction.create({ data: { customerId: real.id, type: 'REFUND', status: 'APPROVED', amount: '500.00', reference: 'R2', createdAt: at('2026-10-10T11:00:00') } });
  await db.auditLog.create({ data: { action: 'CUSTOMER_DEACTIVATED', details: { customerId: big.id }, createdAt: at('2026-10-12T10:00:00') } });
  await db.riskFlag.create({ data: { key: 'k1', severity: 'HIGH', title: 'Fund then withdraw', detail: 'd', status: 'OPEN', createdAt: at('2026-10-12T10:00:00'), updatedAt: at('2026-10-12T10:00:00') } });
  await db.riskFlag.create({ data: { key: 'k2', severity: 'LOW', title: 'x', detail: 'd', status: 'DISMISSED', createdAt: at('2026-10-02T10:00:00'), updatedAt: at('2026-10-20T10:00:00') } });
  await db.scamReport.create({ data: { customerId: real.id, summary: 's', channel: 'WHATSAPP', lostMoney: true, createdAt: at('2026-10-15T10:00:00') } });
  await db.idCheck.create({ data: { customerId: real.id, idType: 'BVN', result: 'DUPLICATE_ID', createdAt: at('2026-10-16T10:00:00') } });
  await db.unmatchedPayment.create({ data: { provider: 'nomba', providerRef: 'NB-U1', amount: '300.00', status: 'OPEN', createdAt: at('2026-10-17T10:00:00') } });
  return { real, big, tester };
}

test('compliance: real vs test, large fundings, freezes, flags, scams, duplicate IDs, unmatched — in kobo, read-only', async () => {
  const { big, tester } = await seed();
  const before = JSON.stringify(db._tables);
  const s = await C.summary({ month: '2026-10' });
  assert.equal(s.month, '2026-10');
  assert.deepEqual(s.real.fundingInflows, { count: 4, totalKobo: (5000 + 1200000 + 2000000 + 3500000) * 100 });
  assert.deepEqual(s.test.fundingInflows, { count: 1, totalKobo: 900000000 });
  assert.equal(s.real.purchases.count, 1);
  assert.equal(s.real.purchases.totalKobo, 95000, 'cash part only (₦1,000 − ₦50 cashback)');
  assert.equal(s.test.purchases.count, 2, 'sandbox order + test account');
  assert.deepEqual(s.real.refunds, { count: 1, totalKobo: 20000 });
  assert.deepEqual(s.test.refunds, { count: 1, totalKobo: 50000 }, 'refund of a sandbox order is test');
  assert.equal(s.largeSingleFunding.count, 3, '₦1.2m, ₦2m and ₦3.5m are each ≥ ₦1m');
  assert.equal(s.largeSingleFunding.items[0].customerId, big.id);
  assert.deepEqual(s.largeSingleFunding.items.map((x) => x.amountKobo), [350000000, 200000000, 120000000], 'biggest first');
  assert.equal(s.largeSingleFunding.items[0].phone, '0809•••••21', 'phone masked');
  assert.equal(s.largeDailyFunding.count, 1);
  assert.deepEqual([s.largeDailyFunding.items[0].date, s.largeDailyFunding.items[0].totalKobo, s.largeDailyFunding.items[0].payments], ['2026-10-09', 550000000, 2]);
  assert.ok(!JSON.stringify(s).includes(tester.id), 'test account is not in the large-funding lists');
  assert.equal(s.accountsFrozen.byStaff, 1);
  assert.deepEqual([s.riskFlags.raised, s.riskFlags.dismissed, s.riskFlags.stillOpen], [2, 1, 1], "both flags were raised in October; one dismissed");
  assert.deepEqual([s.scamReports.count, s.scamReports.lostMoney], [1, 1]);
  assert.deepEqual([s.duplicateIdBlocked.attempts, s.duplicateIdBlocked.customers], [1, 1]);
  assert.deepEqual(s.unmatchedPayments.thisMonth.OPEN, { count: 1, totalKobo: 30000 });
  assert.match(s.disclaimer, /does not file or send/);
  assert.ok(!JSON.stringify(s).includes('08097654321'));
  assert.equal(JSON.stringify(db._tables), before, 'read-only');

  const rows = C.csvRows(s);
  assert.deepEqual(rows.find((r) => r[0] === 'Real' && r[1] === 'Funding inflows'), ['Real', 'Funding inflows', 4, '6705000.00', '']);
  assert.ok(rows.some((r) => r[0] === 'Large funding in one day'));
  assert.ok(!JSON.stringify(rows).includes('08097654321'), 'no full phone numbers in the CSV');
});

test('compliance: thresholds are settings', async () => {
  await seed();
  settings = { complianceSingleFunding: '5000000.00', complianceDailyFunding: '10000000.00' };
  const s = await C.summary({ month: '2026-10' });
  assert.equal(s.largeSingleFunding.count, 0, 'test account’s ₦9m is not counted');
  assert.equal(s.largeDailyFunding.count, 0);
  settings = {};
  const d = await C.thresholds();
  assert.deepEqual(d, { singleKobo: 100000000, dailyKobo: 500000000 }, 'defaults ₦1m / ₦5m');
  await db.settings.create({ data: {} });
  await assert.rejects(C.saveThresholds({ singleNaira: 5 }), /₦1,000/);
  settings = { complianceSingleFunding: '1000000.00', complianceDailyFunding: '5000000.00' };
  assert.match(C.monthRange().month, /^\d{4}-\d{2}$/);
});

test('compliance: blocked duplicate BVN/NIN is recorded and never uses up ID-check tries', () => {
  const route = fs.readFileSync(path.join(ROOT, 'routes/bankfunding.routes.js'), 'utf8');
  assert.match(route, /result: 'DUPLICATE_ID'/);
  const idc = fs.readFileSync(path.join(ROOT, 'lib/idCheck.js'), 'utf8');
  assert.match(idc, /const COUNTED = \['MISMATCH', 'NOT_FOUND'\]/);
});

// --- partner follow-ups --------------------------------------------------------

test('partner follow-ups: the 8 partners exist; overdue first with the last note', async () => {
  db = makeDb();
  const now = Date.now();
  await db.partnerTask.create({ data: { partnerKey: 'monnify', title: 'Send KYC', dueAt: new Date(now + 5 * 86400000), done: false, notes: null } });
  await db.partnerTask.create({ data: { partnerKey: 'nomba', title: 'Whitelist IP', dueAt: new Date(now - 2 * 86400000), done: false, notes: '1 Nov 2026: emailed\n4 Nov 2026: Next step: call Tobi' } });
  await db.partnerTask.create({ data: { partnerKey: 'vtpass', title: 'Old', dueAt: new Date(now - 9 * 86400000), done: true } });
  const f = await desk.followups({ now });
  const keys = f.partners.map((p) => p.partner);
  for (const k of ['vtpass', 'monnify', 'nomba', 'squad', 'fcmb', 'gtbank', 'clubkonnect', 'flutterwave']) assert.ok(keys.includes(k), `${k} in the desk`);
  assert.equal(f.partners.find((p) => p.partner === 'squad').name, 'Squad (GTBank)');
  assert.equal(f.partners[0].partner, 'nomba', 'overdue partner first');
  assert.equal(f.partners[0].tasks[0].overdue, true);
  assert.equal(f.partners[0].tasks[0].daysOverdue, 2);
  assert.equal(f.partners[0].tasks[0].lastNote, '4 Nov 2026: Next step: call Tobi');
  assert.equal(f.openTasks, 2, 'done tasks are left out');
  assert.equal(f.overdueTasks, 1);
});

test('propose_partner_task: an Apply card only; nothing saved until Apply; undo restores', async () => {
  db = makeDb();
  await desk.ensureDefaults();
  const tasksBefore = await db.partnerTask.count();
  const add = await A.proposePartnerTask('admin1', { partner: 'FCMB', pending: 'Account opening documents', dueDate: '2026-11-12', nextStep: 'Send board resolution' });
  assert.equal(add.kind, 'PARTNER');
  assert.equal(add.status, 'PENDING');
  assert.match(add.summary, /FCMB/);
  assert.equal(await db.partnerTask.count(), tasksBefore, 'nothing saved yet');
  const stored = await db.adminAction.findUnique({ where: { id: add.id } });
  assert.equal(stored.requests[0].method, 'POST');
  assert.equal(stored.requests[0].path, '/api/admin/partners/tasks');
  assert.equal(stored.requests[0].body.partnerKey, 'fcmb');
  assert.equal(new Date(stored.requests[0].body.dueAt).toISOString(), '2026-11-12T08:00:00.000Z', '9am Lagos');
  assert.match(stored.requests[0].body.notes, /Next step: Send board resolution/);
  assert.equal(stored.undo[0].method, 'DELETE');

  const t = await db.partnerTask.create({ data: { partnerKey: 'nomba', title: 'Whitelist IP', dueAt: new Date('2026-11-01T08:00:00Z'), done: false, notes: '1 Nov 2026: emailed' } });
  const upd = await A.proposePartnerTask('admin1', { taskId: t.id, nextStep: 'Call Tobi', dueDate: '2026-11-08' });
  const u = await db.adminAction.findUnique({ where: { id: upd.id } });
  assert.equal(u.requests[0].method, 'PATCH');
  assert.match(u.requests[0].body.notes, /^1 Nov 2026: emailed\n.+: Next step: Call Tobi$/);
  assert.equal(u.undo[0].body.notes, '1 Nov 2026: emailed');
  assert.equal((await db.partnerTask.findUnique({ where: { id: t.id } })).notes, '1 Nov 2026: emailed', 'unchanged until Apply');
  await assert.rejects(A.proposePartnerTask('admin1', { partner: 'nobody bank', pending: 'x' }), /Which partner/);
  await assert.rejects(A.proposePartnerTask('admin1', { taskId: t.id }), /Nothing to change/);
});

// --- wiring ---------------------------------------------------------------------

test('admin AI: compliance and follow-up tools are owner-only; only partner tasks accept Apply', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/ai.routes.js'), 'utf8');
  const staff = /const STAFF_TOOL_NAMES = \[([^\]]*)\]/.exec(src)[1];
  for (const name of ['get_compliance_summary', 'get_partner_followups', 'propose_partner_task']) {
    assert.ok(src.includes(`name: '${name}'`), `${name} declared`);
    assert.ok(!staff.includes(name), `${name} not for support staff`);
  }
  const partners = fs.readFileSync(path.join(ROOT, 'routes/partners.routes.js'), 'utf8');
  assert.match(partners, /router\.put\('\/admin\/partners\/contacts\/:key', requireAdminAuth, guard\(/, 'contacts still refuse the assistant');
  assert.match(partners, /router\.post\('\/admin\/partners\/tasks', requireAdminAuth, H\(/);
  const comp = fs.readFileSync(path.join(ROOT, 'routes/compliance.routes.js'), 'utf8');
  assert.match(comp, /if \(noAi\(req, res\)\) return;/, 'thresholds can only be changed by a person');
  const access = fs.readFileSync(path.join(ROOT, 'lib/staffAccess.js'), 'utf8');
  assert.ok(!access.includes('compliance'), 'support staff cannot open the compliance routes');
});
