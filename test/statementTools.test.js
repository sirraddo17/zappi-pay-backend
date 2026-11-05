// Admin AI batch 2: partner statement matching (check_partner_statement)
// and release notes (get_release_notes). In-memory database only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { makeDb } = require('./helpers/memdb');

const ROOT = path.resolve(__dirname, '..');
let db = makeDb();
const fakes = {
  prisma: () => new Proxy({}, { get: (_, prop) => db[prop] }),
  adminAlert: () => ({ alertAdmins: async () => {} }),
};
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '');
  if (fakes[rel]) return fakes[rel]();
  return orig.call(this, req, parent, ...rest);
};

const sm = require('../lib/statementMatch');
const rn = require('../lib/releaseNotes');

const at = (s) => new Date(`${s}+01:00`); // Lagos time
const snapshot = () => JSON.stringify(db._tables);

test('statement: amounts, dates and credit/debit are read like the banks write them', () => {
  assert.deepEqual(sm.parseAmount('₦1,234.50'), { kobo: 123450, negative: false });
  assert.deepEqual(sm.parseAmount('(500.00)'), { kobo: 50000, negative: true });
  assert.deepEqual(sm.parseAmount('-2,000'), { kobo: 200000, negative: true });
  assert.deepEqual(sm.parseAmount(1500.1), { kobo: 150010, negative: false });
  assert.equal(sm.parseAmount('abc'), null);
  assert.equal(sm.parseDate('05/11/2026 10:30').toISOString(), '2026-11-05T09:30:00.000Z', 'day first, Lagos time');
  assert.equal(sm.parseDate('2026-11-05 10:30').toISOString(), '2026-11-05T09:30:00.000Z');
  assert.equal(sm.parseDate('2026-11-05T09:30:00Z').toISOString(), '2026-11-05T09:30:00.000Z');
  assert.equal(sm.direction('CR'), 'credit');
  assert.equal(sm.direction('Debit'), 'debit');
  assert.equal(sm.direction('', { negative: true }), 'debit');
  const big = Array.from({ length: 6000 }, (_, i) => ({ reference: `r${i}`, amount: '100' }));
  const c = sm.cleanRows(big);
  assert.equal(c.rows.length, sm.MAX_ROWS);
  assert.equal(c.truncated, true);
});

test('statement (Nomba): matched, missing both ways, different amount, unmatched, duplicates — nothing changed', async () => {
  db = makeDb();
  const fund = (ref, amount, note, when) => db.walletTransaction.create({ data: { customerId: 'c1', type: 'FUND', status: 'APPROVED', amount, note, providerRef: ref, createdAt: at(when) } });
  await fund('NB-S1', '4950.00', 'Bank transfer of ₦5,000 (₦50 bank processing fee)', '2026-11-05T09:00:00');
  await fund('NB-S2', '2000.00', 'Bank transfer', '2026-11-05T10:00:00');
  await fund('NB-S3', '1000.00', 'Bank transfer', '2026-11-05T11:00:00');
  await fund('NB-S9', '700.00', 'Bank transfer', '2026-11-05T12:00:00'); // not in statement
  await fund('NB-OLD', '700.00', 'Bank transfer', '2026-11-01T12:00:00'); // outside the statement's days
  await fund('SQ-S9', '700.00', 'Bank transfer', '2026-11-05T12:00:00'); // another partner
  await db.unmatchedPayment.create({ data: { provider: 'nomba', providerRef: 'NB-U1', amount: '300.00', status: 'OPEN' } });
  const before = snapshot();
  const r = await sm.check({
    partner: 'nomba',
    fileName: 'nomba-nov.xlsx',
    rows: [
      { date: '05/11/2026 10:00', reference: 'S1', amount: '5,000.00', type: 'Credit', narration: 'Transfer from ADA 08031234567' },
      { date: '05/11/2026 11:00', reference: 'S2', amount: '2000', type: 'CR' },
      { date: '05/11/2026 12:00', reference: 'S3', amount: '1500', type: 'CR' },
      { date: '05/11/2026 13:00', reference: 'S4', amount: '800', type: 'CR' },
      { date: '05/11/2026 13:30', reference: 'S4', amount: '800', type: 'CR' },
      { date: '05/11/2026 14:00', reference: 'U1', amount: '300', type: 'CR' },
      { date: '05/11/2026 15:00', reference: 'P1', amount: '-5000', type: 'Debit' },
      { date: '', reference: '', amount: '10' },
    ],
  });
  assert.equal(r.partner, 'nomba');
  assert.equal(r.rowsRead, 7);
  assert.equal(r.rowsSkipped, 1);
  assert.equal(r.matched.count, 2, 'S1 (sent amount incl. fee) and S2');
  assert.equal(r.differentAmount.count, 1);
  assert.equal(r.differentAmount.items[0].reference, 'S3');
  assert.equal(r.differentAmount.items[0].amountKobo, 150000);
  assert.equal(r.differentAmount.items[0].ourAmountKobo, 100000);
  assert.equal(r.notInOurRecords.count, 2, 'S4 twice');
  assert.equal(r.notInOurRecords.totalKobo, 160000);
  assert.equal(r.waitingInUnmatched.count, 1);
  assert.deepEqual(r.notInStatement.items.map((x) => x.reference), ['S9'], 'only Nomba, only the statement days');
  assert.equal(r.duplicatesInStatement.count, 1);
  assert.equal(r.duplicatesInStatement.items[0].times, 2);
  assert.equal(r.otherRows, 1, 'the debit is not checked against funding');
  assert.ok(!JSON.stringify(r).includes('08031234567'), 'narration is masked');
  assert.match(r.nextSteps, /Funding not showing\?/);
  assert.ok(r.links.includes('/admin/unmatched-payments'));
  assert.equal(snapshot(), before, 'read-only: nothing was written');
});

test('statement (VTpass): matched, charged for a failed order, reversal, different amount, not in statement', async () => {
  db = makeDb();
  const order = (id, status, amount, costAmount, when, extra = {}) => db.order.create({ data: { customerId: 'c1', service: 'DATA', provider: 'mtn-data', status, amount, costAmount, vtpassRequestId: id, createdAt: at(when), ...extra } });
  await order('R1', 'SUCCESS', '1050.00', '1000.00', '2026-11-05T09:00:00');
  await order('R2', 'FAILED', '500.00', '500.00', '2026-11-05T09:10:00');
  await order('R3', 'REFUNDED', '300.00', '300.00', '2026-11-05T09:20:00');
  await order('R4', 'SUCCESS', '200.00', '200.00', '2026-11-05T09:30:00');
  await order('R5', 'SUCCESS', '900.00', '900.00', '2026-11-05T10:00:00'); // not in statement
  await order('R6', 'SUCCESS', '900.00', '900.00', '2026-11-05T10:00:00', { isTest: true }); // sandbox: ignored
  await order('R7', 'SUCCESS', '900.00', '900.00', '2026-11-05T10:00:00', { responsePayload: { supplier: 'NOMBA' } }); // bet funding via Nomba: ignored
  const before = snapshot();
  const r = await sm.check({
    partner: 'vtpass',
    rows: [
      { date: '2026-11-05 09:00', reference: 'R1', amount: '-1000', type: 'debit' },
      { date: '2026-11-05 09:10', reference: 'R2', amount: '-500', type: 'debit' },
      { date: '2026-11-05 09:20', reference: 'R3', amount: '-300', type: 'debit' },
      { date: '2026-11-05 09:21', reference: 'R3', amount: '300', type: 'credit' },
      { date: '2026-11-05 09:30', reference: 'R4', amount: '-250', type: 'debit' },
      { date: '2026-11-05 11:00', reference: 'X9', amount: '-100', type: 'debit' },
      { date: '2026-11-05 12:00', reference: 'TOPUP', amount: '50000', type: 'credit' },
    ],
  });
  assert.deepEqual(r.matched.items.map((x) => x.reference).sort(), ['R1', 'R3']);
  assert.deepEqual(r.chargedForFailedOrder.items.map((x) => x.reference), ['R2'], 'failed, and VTpass did not reverse it');
  assert.deepEqual(r.reversals.items.map((x) => x.reference), ['R3']);
  assert.equal(r.differentAmount.items[0].reference, 'R4');
  assert.equal(r.differentAmount.items[0].ourCostKobo, 20000);
  assert.deepEqual(r.notInOurRecords.items.map((x) => x.reference), ['X9']);
  assert.deepEqual(r.notInStatement.items.map((x) => x.reference), ['R5']);
  assert.equal(r.duplicatesInStatement.count, 0, 'a debit and its reversal are not duplicates');
  assert.equal(r.otherRows, 1);
  assert.equal(snapshot(), before);
});

test('statement: wrong partner or no usable rows', async () => {
  assert.match((await sm.check({ partner: 'gtbank', rows: [] })).error, /Nomba, Squad, Monnify or VTpass/);
  assert.match((await sm.check({ partner: 'squad', rows: [{ reference: '', amount: '' }] })).error, /No usable rows/);
});

// --- release notes ----------------------------------------------------------

const LOG = [
  'abc1234\x1f2026-11-05\x1fAdd plan-code watch\x1fChecks VTpass plans daily.\n\nCo-Authored-By: Someone <x@y.z>\nClaude-Session: https://claude.ai/code/x\x1e',
  'def5678\x1f2026-11-04\x1fFix receipt wording for 08031234567\x1fapi_key=sk_live_123\x1e',
].join('\n');

test('release notes: commits since the previous version, noise dropped, secrets masked', () => {
  const calls = [];
  const list = rn.gitLog('1111111', '2222222', (args) => { calls.push(args); return LOG; });
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { hash: 'abc1234', date: '2026-11-05', subject: 'Add plan-code watch', details: ['Checks VTpass plans daily.'] });
  assert.ok(!JSON.stringify(list).includes('08031234567'));
  assert.ok(!JSON.stringify(list).includes('sk_live_123'));
  assert.ok(calls[0].includes('1111111..2222222'));
  assert.equal(rn.gitLog('bad ref; rm -rf', '2222222', () => LOG), null, 'only real commit ids reach git');
  assert.equal(rn.gitLog('1111111', '2222222', () => { throw new Error('unknown revision'); }), null);
});

test('release notes: saved only when the server starts on a new commit; the tool reads them', async () => {
  db = makeDb();
  const prev = await db.deployRecord.create({ data: { commit: '1111111', startedAt: new Date(Date.now() - 5000), nodeVersion: 'v22' } });
  const same = await db.deployRecord.create({ data: { commit: '1111111', startedAt: new Date(Date.now() - 4000), nodeVersion: 'v22' } });
  assert.equal(await rn.capture({ recordId: same.id, commit: '1111111', run: () => LOG }), null, 'restart on the same commit: nothing');
  const now = await db.deployRecord.create({ data: { commit: '2222222', startedAt: new Date(Date.now() - 1000), nodeVersion: 'v22' } });
  const saved = await rn.capture({ recordId: now.id, commit: '2222222', run: () => LOG });
  assert.equal(saved.sinceCommit, '1111111');
  assert.equal(saved.commits.length, 2);
  const n = await rn.notes();
  assert.equal(n.version, '2222222');
  assert.equal(n.previousVersion, '1111111');
  assert.equal(n.count, 2);
  assert.match(n.howToUse, /propose_broadcast/);
  assert.match((await rn.notes({ back: 1 })).note, /No earlier update/);
  assert.ok(prev.id);
});

// --- wiring -------------------------------------------------------------------

test('admin AI: the 2 tools are owner-only; the statement is only used for the owner', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/ai.routes.js'), 'utf8');
  const staff = /const STAFF_TOOL_NAMES = \[([^\]]*)\]/.exec(src)[1];
  const adminTools = src.slice(src.indexOf('const ADMIN_TOOLS = ['), src.indexOf('function adminHandlers('));
  for (const name of ['check_partner_statement', 'get_release_notes']) {
    assert.ok(adminTools.includes(`name: '${name}'`), `${name} in ADMIN_TOOLS`);
    assert.ok(!staff.includes(name), `${name} not for support staff`);
  }
  assert.match(src, /const statement = !staff && req\.body\?\.statement/);
  const fe = path.join(ROOT, '..', 'zappi-pay-frontend', 'src', 'components', 'admin', 'StatementAttach.jsx');
  if (fs.existsSync(fe)) assert.match(fs.readFileSync(fe, 'utf8'), /5000/);
});
