// Admin AI ops: Apply-card proposals that touch money (nothing moves until
// the owner taps Apply), unmatched suggestions, payout runway, Monnify
// daily reconciliation, weekly report, and the customer chat funding check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { makeDb } = require('./helpers/memdb');

const ROOT = path.resolve(__dirname, '..');
let db = makeDb();
const alerts = [];
const emails = [];
let monnifyPages = [];
let fundingCalls = [];
const fakes = {
  prisma: () => new Proxy({}, { get: (_, prop) => db[prop] }),
  adminAlert: () => ({ alertAdmins: async (title, message, link) => { alerts.push({ title, link }); }, emailAdmins: async (subject, html, text) => { emails.push({ subject, text }); return { sent: 1 }; } }),
  vtpass: () => ({ getSettings: async () => ({ emailAlertsEnabled: true }), vtpassRequest: async () => ({}), invalidateSettings: () => {} }),
  earnings: () => ({ estimateCommission: () => 0, earningsReport: async () => ({ profit: 1234.5 }) }),
  fundsGuard: () => ({ coverage: async () => ({ payoutProvider: 'monnify', monnifyFree: 30000 }) }),
  monnify: () => ({ getConfig: async () => ({ mode: 'live' }), api: async () => monnifyPages.shift() || { content: [] } }),
  fundingCheck: () => ({ checkAll: async (c, ref) => { fundingCalls.push({ id: c.id, ref }); return { credited: 1, amount: 4950, checked: ['Monnify'], failed: [], notes: [], refFound: true, hasAccounts: true }; } }),
  partnerDesk: () => ({ followups: async () => ({ openTasks: 2, overdueTasks: 1, partners: [{ name: 'Nomba', overdue: 1 }] }) }),
  quietClock: () => ({ every: () => {} }),
  notify: () => ({ notify: async () => {} }),
};
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '');
  if (fakes[rel]) return fakes[rel]();
  return orig.call(this, req, parent, ...rest);
};

const A = require('../lib/adminActions');
const ops = require('../lib/aiOps');
const chatHelp = require('../lib/chatHelp');

async function seed() {
  db = makeDb();
  alerts.length = 0;
  emails.length = 0;
  const ada = await db.customer.create({ data: { name: 'Ada Obi', phone: '08031234567', passwordHash: 'x', walletBalance: '100.00', bankAccountRef: 'ZP-a' } });
  const bayo = await db.customer.create({ data: { name: 'Bayo Ade', phone: '08097654321', passwordHash: 'x', walletBalance: '50.00' } });
  const u1 = await db.unmatchedPayment.create({ data: { provider: 'monnify', providerRef: 'MNFY|1', amount: '5000.00', status: 'OPEN', payerName: 'OBI ADA', suggestedCustomerId: ada.id } });
  const u2 = await db.unmatchedPayment.create({ data: { provider: 'nomba', providerRef: 'NB-2', amount: '700.00', status: 'OPEN', payerName: 'BAYO ADE' } });
  const t = await db.bankTransfer.create({ data: { customerId: bayo.id, amount: '20000.00', fee: '25.00', status: 'HELD', accountName: 'JOHN DOE', bankName: 'OPAY', bankCode: '999992', accountNumber: '8000000000', reference: 'ZPT-1' } });
  const s = await db.scheduledPurchase.create({ data: { customerId: ada.id, service: 'DATA', serviceID: 'mtn-data', variationCode: 'old-1gb', billersCode: '08031234567', active: true } });
  await db.priceSnapshot.create({ data: { serviceID: 'mtn-data', variationCode: 'old-1gb', name: 'MTN 1GB - 30 days', amount: '1000.00', removedAt: new Date() } });
  await db.priceSnapshot.create({ data: { serviceID: 'mtn-data', variationCode: 'new-1gb', name: 'MTN 1GB Monthly', amount: '1050.00', removedAt: null } });
  const o = await db.order.create({ data: { customerId: ada.id, service: 'DATA', provider: 'mtn-data', status: 'PENDING', amount: '1050.00', recipient: '08031234567', vtpassRequestId: 'R1' } });
  return { ada, bayo, u1, u2, t, s, o };
}

test('proposals: Apply cards only — no money moves, nothing changes until Apply', async () => {
  const { ada, bayo, u1, t, s, o } = await seed();
  const before = JSON.stringify({ c: await db.customer.findMany(), u: await db.unmatchedPayment.findMany(), b: await db.bankTransfer.findMany(), s: await db.scheduledPurchase.findMany(), o: await db.order.findMany(), w: await db.walletTransaction.findMany() });
  const cards = [
    await A.proposeFundingCheck('owner', { customerId: ada.id, reference: '100004261105', amount: 5000 }),
    await A.proposeAssignUnmatched('owner', { paymentId: u1.id, customerId: ada.id, reason: 'Their old account number' }),
    await A.proposeHeldTransfer('owner', { transferId: t.id, action: 'CANCEL', reason: 'First transfer to a new account' }),
    await A.proposePlanSwitch('owner', { scheduleId: s.id, variationCode: 'new-1gb' }),
    await A.proposeOrderAction('owner', { orderId: o.id, action: 'RECHECK' }),
  ];
  for (const c of cards) assert.equal(c.status, 'PENDING');
  const after = JSON.stringify({ c: await db.customer.findMany(), u: await db.unmatchedPayment.findMany(), b: await db.bankTransfer.findMany(), s: await db.scheduledPurchase.findMany(), o: await db.order.findMany(), w: await db.walletTransaction.findMany() });
  assert.equal(after, before, 'nothing changed before Apply');
  const reqs = (await db.adminAction.findMany()).map((a) => `${a.requests[0].method} ${a.requests[0].path}`);
  assert.deepEqual(reqs, [
    `POST /api/admin/customers/${ada.id}/check-funding`,
    `POST /api/admin/unmatched-payments/${u1.id}/assign`,
    `POST /api/admin/bank-transfers/${t.id}/cancel`,
    `PATCH /api/admin/schedules/${s.id}/plan`,
    `POST /api/admin/orders/${o.id}/recheck`,
  ]);
  assert.ok(!JSON.stringify(cards).includes('08031234567'), 'phones masked on cards');
  assert.ok(bayo.id);
});

test('proposals refuse the wrong state', async () => {
  const { ada, u1, t, s, o } = await seed();
  await db.unmatchedPayment.update({ where: { id: u1.id }, data: { status: 'ASSIGNED' } });
  await assert.rejects(A.proposeAssignUnmatched('owner', { paymentId: u1.id, customerId: ada.id, reason: 'x' }), /already assigned/);
  await db.bankTransfer.update({ where: { id: t.id }, data: { status: 'SUCCESS' } });
  await assert.rejects(A.proposeHeldTransfer('owner', { transferId: t.id, action: 'RELEASE' }), /Only a HELD transfer/);
  await assert.rejects(A.proposePlanSwitch('owner', { scheduleId: s.id, variationCode: 'old-1gb' }), /not on VTpass/, 'removed code refused');
  await db.order.update({ where: { id: o.id }, data: { status: 'SUCCESS' } });
  await assert.rejects(A.proposeOrderAction('owner', { orderId: o.id, action: 'MARK_FAILED' }), /Only a PENDING order/);
});

test('unmatched suggestions: strong (old number) and possible (payer name); read-only', async () => {
  const { ada, bayo, u1, u2 } = await seed();
  const r = await ops.unmatchedSuggestions();
  assert.equal(r.open, 2);
  const a = r.payments.find((p) => p.paymentId === u1.id);
  assert.equal(a.candidates[0].customerId, ada.id);
  assert.equal(a.candidates[0].strength, 'strong');
  assert.equal(a.amountKobo, 500000);
  const b = r.payments.find((p) => p.paymentId === u2.id);
  assert.equal(b.candidates[0].customerId, bayo.id);
  assert.equal(b.candidates[0].strength, 'possible');
  assert.ok(!JSON.stringify(r).includes('08097654321'), 'phones masked');
});

test('payout runway: free balance ÷ average per day', async () => {
  await seed();
  for (let i = 0; i < 7; i += 1) await db.bankTransfer.create({ data: { customerId: 'c', amount: '2000.00', fee: '25.00', status: 'SUCCESS', provider: 'monnify', reference: `S${i}`, createdAt: new Date(Date.now() - i * 86400000) } });
  const r = await ops.payoutRunway();
  assert.equal(r.sentLastDays.totalKobo, 1400000);
  assert.equal(r.averagePerDayKobo, 100000, '₦14,000 over 14 days = ₦1,000 a day');
  assert.equal(r.freeInPayoutWalletKobo, 3000000);
  assert.equal(r.daysLeft, 30);
});

test('Monnify reconciliation: API payments matched to credits; missing ones reported', async () => {
  const { ada } = await seed();
  await db.walletTransaction.create({ data: { customerId: ada.id, type: 'FUND', status: 'APPROVED', amount: '4950.00', note: 'Bank transfer of ₦5,000 (₦50 bank processing fee)', providerRef: 'MNFY|A', createdAt: new Date('2026-11-05T10:00:00+01:00') } });
  monnifyPages = [{ content: [
    { transactionReference: 'MNFY|A', amountPaid: 5000, paymentStatus: 'PAID', completedOn: '2026-11-05 10:00:00' },
    { transactionReference: 'MNFY|B', amountPaid: 1200, paymentStatus: 'PAID', completedOn: '2026-11-05 11:00:00' },
  ], last: true }];
  const r = await ops.monnifyRecon({ day: '2026-11-05' });
  assert.equal(r.monnifyPayments, 2);
  assert.equal(r.matched.count, 1);
  assert.equal(r.notInOurRecords.count, 1);
  assert.equal(r.notInOurRecords.items[0].reference, 'MNFY|B');
});

test('weekly report: real customers only; daily jobs run once and alert on missing credits', async () => {
  const { ada } = await seed();
  const tester = await db.customer.create({ data: { name: 'T', phone: '08000000000', passwordHash: 'x', isTestAccount: true } });
  const monday = new Date('2026-11-09T08:00:00+01:00').getTime();
  const inWeek = new Date('2026-11-05T12:00:00+01:00');
  await db.order.create({ data: { customerId: ada.id, service: 'DATA', status: 'SUCCESS', amount: '1000.00', cashbackUsed: '50.00', isTest: false, vtpassRequestId: 'W1', createdAt: inWeek } });
  await db.order.create({ data: { customerId: tester.id, service: 'DATA', status: 'SUCCESS', amount: '9000.00', isTest: false, vtpassRequestId: 'W2', createdAt: inWeek } });
  const w = await ops.weeklyReport({ now: monday });
  assert.equal(w.purchases, 1, 'test account left out');
  assert.equal(w.salesKobo, 95000);
  assert.match(w.text, /Sales: ₦950\.00/);
  assert.match(w.text, /Estimated profit/);
  monnifyPages = [{ content: [{ transactionReference: 'MNFY|Z', amountPaid: 300, paymentStatus: 'PAID', completedOn: '2026-11-08 09:00:00' }], last: true }];
  const done = await ops.tick(monday);
  assert.ok(done.recon && done.weekly);
  assert.equal(emails.length, 1);
  assert.match(emails[0].subject, /weekly report/);
  assert.ok(alerts.some((a) => /not credited/.test(a.title) && a.link === '/admin/unmatched-payments'));
  const again = await ops.tick(monday + 60000);
  assert.deepEqual(again, {}, 'once a day');
  assert.equal(emails.length, 1);
});

test('customer chat: check_my_funding runs the safe partner check, at most once a minute', async () => {
  const { ada } = await seed();
  fundingCalls = [];
  const h = chatHelp.handlers(ada.id, {}, { cards: [], notes: [] });
  const r = await h.check_my_funding({ reference: '100004261105165544' });
  assert.equal(r.result, 'CREDITED');
  assert.deepEqual(fundingCalls, [{ id: ada.id, ref: '100004261105165544' }], 'only their own account is checked');
  assert.match((await h.check_my_funding({})).error, /less than a minute/);
});

test('wiring: owner-only tools; unmatched close still person-only; plan route checks the current list', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/ai.routes.js'), 'utf8');
  const staff = /const STAFF_TOOL_NAMES = \[([^\]]*)\]/.exec(src)[1];
  for (const n of ['get_unmatched_suggestions', 'get_payout_runway', 'get_monnify_reconciliation', 'get_weekly_report', 'propose_funding_check', 'propose_assign_unmatched', 'propose_held_transfer', 'propose_plan_switch', 'propose_order_action']) {
    assert.ok(src.includes(`name: '${n}'`), `${n} declared`);
    assert.ok(!staff.includes(n), `${n} not for support staff`);
  }
  const um = fs.readFileSync(path.join(ROOT, 'routes/unmatched.routes.js'), 'utf8');
  assert.match(um.slice(um.indexOf("'/admin/unmatched-payments/:id/close'")), /if \(noAi\(req, res\)\) return;/);
  const so = fs.readFileSync(path.join(ROOT, 'routes/supportops.routes.js'), 'utf8');
  assert.match(so, /removedAt: null/);
  assert.ok(!fs.readFileSync(path.join(ROOT, 'lib/staffAccess.js'), 'utf8').includes('/plan'), 'plan switch is owner-only');
});
