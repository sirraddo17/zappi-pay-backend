// Admin AI tools: plan-code watch (get_plan_changes), server logs
// (get_server_logs) and deploy check (get_deploy_status).
// In-memory database (test/helpers/memdb.js) and fake partners only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { makeDb } = require('./helpers/memdb');

const ROOT = path.resolve(__dirname, '..');
let db = makeDb();
const alerts = [];
let settings = { vtpassMode: 'live', monnifyFundingEnabled: true, squadFundingEnabled: false, nombaFundingEnabled: false, bankTransferEnabled: false, payoutProvider: 'monnify' };
let vtpassBalance = { contents: { balance: 5959 } };
const fakes = {
  // Forwards to whichever in-memory db the current test made.
  prisma: () => new Proxy({}, { get: (_, prop) => db[prop] }),
  adminAlert: () => ({ alertAdmins: async (title, message, link) => { alerts.push({ title, message, link }); } }),
  quietClock: () => ({ every: () => {} }),
  vtpass: () => ({
    getSettings: async () => settings,
    vtpassRequest: async (method, p) => {
      if (p === '/balance') { if (vtpassBalance instanceof Error) throw vtpassBalance; return vtpassBalance; }
      throw new Error('not faked');
    },
  }),
  monnify: () => ({ getConfig: async () => ({ mode: 'sandbox', apiKey: 'MK_TEST_abc', secretKey: 'sec' }), isConfigured: async () => true }),
  squad: () => ({ getConfig: async () => ({ mode: 'sandbox', secretKey: '' }), isConfigured: async () => false }),
  nomba: () => ({ getConfig: async () => ({ mode: 'sandbox' }), isConfigured: async () => false }),
};
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '');
  if (fakes[rel]) return fakes[rel]();
  return orig.call(this, req, parent, ...rest);
};

const planNames = require('../lib/planNames');
const planWatch = require('../lib/planWatch');
const serverLogs = require('../lib/serverLogs');
const deploy = require('../lib/deployCheck');

// --- plan names ------------------------------------------------------------

test('plan names: size and validity like the app shows them', () => {
  assert.equal(planNames.sizeGb('MTN N100 1GB - 1 day'), 1);
  assert.equal(planNames.sizeGb('Airtel 200MB - 14 days'), 0.195);
  assert.equal(planNames.sizeGb('MTN 6.5GB + 3.5GB YouTube - 30 days'), 10);
  assert.equal(planNames.sizeGb('MTN 3GB 5GB - 2,475 Naira'), 5);
  assert.equal(planNames.validityDays('Glo 1GB night - 1 day'), 1);
  assert.equal(planNames.validityDays('MTN 2GB Weekly'), 7);
  assert.equal(planNames.validityDays('MTN 1.5GB - 30 days'), 30);
  assert.equal(planNames.validityDays('Smile Unlimited'), null);
});

test('plan names: closest plan = same size and validity, nearest price', () => {
  const plans = [
    { variationCode: 'a', name: 'MTN 1GB - 1 day', priceKobo: 50000 },
    { variationCode: 'b', name: 'MTN 1.5GB - 30 days', priceKobo: 105000 },
    { variationCode: 'c', name: 'MTN 1.5GB Monthly', priceKobo: 99000 },
    { variationCode: 'd', name: 'MTN 2GB - 30 days', priceKobo: 120000 },
  ];
  const s = planNames.closestPlan({ name: 'MTN 1.5GB - 30 days (old)', priceKobo: 100000 }, plans);
  assert.equal(s.variationCode, 'c');
  assert.equal(s.match, 'same size and validity');
  const t = planNames.closestPlan({ name: 'MTN 1.8GB - 30 days', priceKobo: 110000 }, plans);
  assert.equal(t.variationCode, 'd');
  assert.match(t.match, /same validity/);
  assert.equal(planNames.closestPlan({ name: 'x', priceKobo: 1 }, []), null);
});

// --- plan-code watch ---------------------------------------------------------

const V = (code, name, amount) => ({ variationCode: code, name, priceKobo: Math.round(amount * 100) });
test('plan watch: removed / added / price changes, uses of removed codes, one alert, nothing changed', async () => {
  db = makeDb();
  alerts.length = 0;
  let lists = {
    'mtn-data': [V('mtn-1gb', 'MTN 1GB - 1 day', 500), V('mtn-15gb', 'MTN 1.5GB - 30 days', 1000), V('mtn-2gb', 'MTN 2GB - 30 days', 1200)],
  };
  const fetch = async (sid) => { if (sid === 'dstv') throw new Error('timeout'); return lists[sid] || []; };
  // Baseline: first time a service is seen → nothing is "added".
  const first = await planWatch.run({ fetch });
  assert.deepEqual(first.added, []);
  assert.deepEqual(first.removed, []);
  assert.ok(first.servicesChecked.includes('mtn-data'));
  assert.ok(first.skipped.some((s) => s.serviceID === 'dstv'), 'a failing service is skipped');
  assert.ok(first.skipped.some((s) => s.serviceID === 'gotv' && /no plans/.test(s.why)), 'an empty answer is skipped, never "all removed"');
  assert.equal(alerts.length, 0);

  // Things that use the code VTpass will remove.
  const sched = await db.scheduledPurchase.create({ data: { customerId: 'c1', serviceID: 'mtn-data', variationCode: 'mtn-15gb', billersCode: '08031234567', active: true } });
  await db.billReminder.create({ data: { customerId: 'c2', serviceID: 'mtn-data', variationCode: 'mtn-15gb', billersCode: '08031234567', label: 'x', active: true } });
  await db.payForMe.create({ data: { serviceID: 'mtn-data', variationCode: 'mtn-15gb', billersCode: '08031234567', label: 'x', status: 'OPEN' } });
  await db.payForMe.create({ data: { serviceID: 'mtn-data', variationCode: 'mtn-15gb', billersCode: '08031234567', label: 'paid', status: 'PAID' } });
  await db.planFix.create({ data: { serviceID: 'mtn-data', variationCode: 'mtn-15gb', note: 'n' } });
  await db.scheduledPurchase.create({ data: { customerId: 'c3', serviceID: 'mtn-data', variationCode: 'mtn-15gb', billersCode: '0803', active: false } });

  lists = { 'mtn-data': [V('mtn-1gb', 'MTN 1GB - 1 day', 550), V('mtn-2gb', 'MTN 2GB - 30 days', 1200), V('mtn-15gb-new', 'MTN 1.5GB Monthly', 1050), V('mtn-15gb-dear', 'MTN 1.5GB - 30 days', 1500)] };
  const r = await planWatch.run({ fetch });
  assert.equal(r.removed.length, 1);
  const rem = r.removed[0];
  assert.equal(rem.variationCode, 'mtn-15gb');
  assert.equal(rem.lastPriceKobo, 100000);
  assert.equal(rem.usedBy.count, 4, 'active schedule, active reminder, open Pay-for-me, plan fix (not the paid link or paused schedule)');
  assert.equal(rem.usedBy.scheduledTopUps[0].id, sched.id);
  assert.ok(!JSON.stringify(rem).includes('0803'), 'no phone/smartcard numbers in the report');
  assert.equal(rem.suggestion.variationCode, 'mtn-15gb-new');
  assert.equal(rem.suggestion.match, 'same size and validity');
  assert.deepEqual(r.added.map((a) => a.variationCode).sort(), ['mtn-15gb-dear', 'mtn-15gb-new']);
  assert.deepEqual(r.priceChanges, [{ serviceID: 'mtn-data', variationCode: 'mtn-1gb', name: 'MTN 1GB - 1 day', fromKobo: 50000, toKobo: 55000 }]);
  for (const x of [...r.added, ...r.priceChanges]) for (const k of Object.keys(x).filter((k) => /Kobo$/.test(k))) assert.ok(Number.isInteger(x[k]), `${k} is whole kobo`);
  assert.equal(r.stillUsed, 1);
  const used = alerts.filter((a) => /still use/.test(a.title));
  assert.equal(used.length, 1);
  assert.equal(used[0].link, '/admin/orders');
  assert.ok(alerts.some((a) => /changed 1 price/.test(a.title)));
  // Nothing was changed automatically.
  const after = await db.scheduledPurchase.findUnique({ where: { id: sched.id } });
  assert.equal(after.variationCode, 'mtn-15gb');
  assert.equal(after.active, true);

  // Next day: the same removal is not reported (or alerted) again.
  alerts.length = 0;
  const r3 = await planWatch.run({ fetch });
  assert.equal(r3.removed.length, 0);
  assert.equal(alerts.filter((a) => /still use/.test(a.title)).length, 0);

  const last = await planWatch.lastReport();
  assert.ok(last.checkedAt);
  assert.equal(last.removed.length, 0, 'the latest run removed nothing…');
  assert.equal(last.stillUsingRemovedCodesNow.length, 1, '…but the code removed earlier is still in use and still listed');
  assert.equal(last.stillUsingRemovedCodesNow[0].variationCode, 'mtn-15gb');
  assert.equal(last.stillUsingRemovedCodesNow[0].suggestion.variationCode, 'mtn-15gb-new');
  assert.match(last.rule, /Nothing is changed automatically/);
});

test('plan watch: runs once a day, after 6am Lagos', async () => {
  db = makeDb();
  planWatch._reset();
  const night = Date.UTC(2099, 0, 6, 3, 0); // 04:00 Lagos
  assert.equal(await planWatch.tick(night), null);
});

// --- server logs ---------------------------------------------------------------

function logs(outLines, errLines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-logs-'));
  const paths = { out: path.join(dir, 'zappi-pay-api-out.log'), err: path.join(dir, 'zappi-pay-api-error.log') };
  if (outLines) fs.writeFileSync(paths.out, `${outLines.join('\n')}\n`);
  if (errLines) fs.writeFileSync(paths.err, `${errLines.join('\n')}\n`);
  return paths;
}

test('server logs: secrets and personal data are masked', () => {
  const s = serverLogs.scrubLine('Authorization: Bearer abc.def-ghi api_key=sk_live_123456 password="hunter2" postgresql://u:p@host/db email ridwan.adeyemo@gmail.com phone 08167550937 +2348167550937 bvn 22212345678 account 0123456789 jwt eyJhbGciOi.eyJzdWIi.sig MK_PROD_ABC123 FLWSECK-abc123-X');
  for (const bad of ['abc.def-ghi', 'sk_live_123456', 'hunter2', 'u:p@host', 'ridwan.adeyemo', '08167550937', '2348167550937', '22212345678', '0123456789', 'eyJhbGciOi', 'MK_PROD_ABC123', 'FLWSECK-abc123']) assert.ok(!s.includes(bad), `${bad} hidden in: ${s}`);
  assert.match(s, /0816•••••37/);
  assert.match(s, /r•••@g•••\.com/);
  assert.match(s, /••••••6789/);
  assert.match(s, /•••••••5678/);
});

test('server logs: last N lines, errors only, search, since, read-only', () => {
  const now = Date.UTC(2026, 10, 5, 12, 0);
  const at = (min) => new Date(now - min * 60000).toISOString().slice(0, 19);
  const p = logs(
    [`${at(90)}: started on port 4000`, `${at(30)}: GET /api/orders 200`, `${at(5)}: purchase for 08031234567 ok`],
    [`${at(20)}: VTpass request failed: ETIMEDOUT`, '    at stack line', `${at(2)}: Unhandled error: boom`],
  );
  const before = fs.readFileSync(p.out, 'utf8') + fs.readFileSync(p.err, 'utf8');
  const all = serverLogs.read({}, { paths: p, now });
  assert.equal(all.shown, 6);
  assert.match(all.lines[0], /started/);
  assert.match(all.lines.at(-1), /^ERR .*Unhandled/);
  assert.equal(all.errorLines, 3);
  assert.ok(all.lines.some((l) => /0803•••••67/.test(l)));
  assert.equal(serverLogs.read({ errorsOnly: true }, { paths: p, now }).shown, 3);
  assert.equal(serverLogs.read({ search: 'vtpass' }, { paths: p, now }).shown, 1);
  const recent = serverLogs.read({ sinceMinutes: 10 }, { paths: p, now });
  assert.equal(recent.shown, 2);
  assert.equal(serverLogs.read({ lines: 2 }, { paths: p, now }).shown, 2);
  assert.equal(fs.readFileSync(p.out, 'utf8') + fs.readFileSync(p.err, 'utf8'), before, 'log files untouched');
});

test('server logs: limits and missing files', () => {
  const many = Array.from({ length: 1500 }, (_, i) => `line ${i}`);
  const p = logs(many, null);
  assert.equal(serverLogs.read({ lines: 5000 }, { paths: p }).shown, 1000, 'max 1000');
  assert.equal(serverLogs.read({}, { paths: p }).shown, 200, 'default 200');
  assert.match(serverLogs.read({ sinceMinutes: 5 }, { paths: p }).note, /no times/);
  const none = serverLogs.read({}, { paths: { out: '/nonexistent/a.log', err: '/nonexistent/b.log' } });
  assert.equal(none.lines.length, 0);
  assert.match(none.note, /No log files/);
  const env = serverLogs.logPaths({ pm_out_log_path: '/x/out.log', pm_err_log_path: '/x/err.log' });
  assert.deepEqual(env, { out: '/x/out.log', err: '/x/err.log' });
  assert.match(serverLogs.logPaths({}).out, /\.pm2\/logs\/zappi-pay-api-out\.log$/);
});

// --- deploy check ----------------------------------------------------------------

test('deploy check: records the commit, finds the previous good commit, self-check passes', async () => {
  db = makeDb();
  alerts.length = 0;
  deploy._reset();
  vtpassBalance = { contents: { balance: 5959 } };
  await db.deployRecord.create({ data: { commit: 'aaaaaaa', startedAt: new Date(Date.now() - 3000), nodeVersion: 'v22', ok: true } });
  await db.deployRecord.create({ data: { commit: 'bbbbbbb', startedAt: new Date(Date.now() - 2000), nodeVersion: 'v22', ok: false } });
  const s = await deploy.recordStart({ commit: 'ccccccc' });
  assert.equal(s.commit, 'ccccccc');
  assert.equal(s.previousCommit, 'aaaaaaa', 'skips the commit whose self-check failed');
  const r = await deploy.selfCheck({ health: async () => ({ ok: true }) });
  assert.equal(r.ok, true, JSON.stringify(r.failed));
  assert.deepEqual(r.checks.map((c) => c.name), ['database', 'VTpass /balance', 'monnify settings', '/api/health']);
  assert.equal(alerts.length, 0);
  const st = await deploy.status();
  assert.equal(st.commit, 'ccccccc');
  assert.equal(st.previousCommit, 'aaaaaaa');
  assert.equal(st.lastSelfCheck.ok, true);
  assert.equal(st.rollback, 'cd /opt/zappi-pay-backend && git checkout aaaaaaa && pm2 restart zappi-pay-api');
  assert.ok(!JSON.stringify(st).includes('MK_TEST_abc'), 'no keys in the result');
});

test('deploy check: a failed self-check alerts once with the rollback command', async () => {
  db = makeDb();
  alerts.length = 0;
  deploy._reset();
  settings = { ...settings, nombaFundingEnabled: true };
  vtpassBalance = new Error('VTpass timed out');
  await db.deployRecord.create({ data: { commit: 'aaaaaaa', startedAt: new Date(Date.now() - 3000), nodeVersion: 'v22', ok: true } });
  await deploy.recordStart({ commit: 'ddddddd' });
  const r = await deploy.selfCheck({ health: async () => ({ ok: false, why: 'HTTP 502' }) });
  assert.equal(r.ok, false);
  assert.ok(r.failed.some((f) => /VTpass/.test(f)));
  assert.ok(r.failed.some((f) => /nomba settings \(keys missing\)/.test(f)), 'switched-on partner with no keys fails');
  assert.ok(r.failed.some((f) => /health/.test(f)));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /git checkout aaaaaaa && pm2 restart zappi-pay-api/);
  await deploy.selfCheck({ health: async () => ({ ok: false }) });
  assert.equal(alerts.length, 1, 'only once per start');
  const rec = (await db.deployRecord.findMany({ where: { commit: 'ddddddd' } }))[0];
  assert.equal(rec.ok, false);
});

test('deploy check: switched-on partners', async () => {
  assert.deepEqual(await deploy.partnersOn({ monnifyFundingEnabled: true }), ['monnify']);
  assert.deepEqual(await deploy.partnersOn({ monnifyFundingEnabled: false, bankTransferEnabled: true, payoutProvider: 'squad' }), ['squad']);
  assert.deepEqual(await deploy.partnersOn({ monnifyFundingEnabled: false, nombaFundingEnabled: true }), ['nomba']);
});

// --- the admin AI wiring ------------------------------------------------------------

test('admin AI: the 3 tools are owner-only and wired to read-only handlers', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/ai.routes.js'), 'utf8');
  const staff = /const STAFF_TOOL_NAMES = \[([^\]]*)\]/.exec(src)[1];
  const adminTools = src.slice(src.indexOf('const ADMIN_TOOLS = ['), src.indexOf('function adminHandlers('));
  const handlers = src.slice(src.indexOf('function adminHandlers('), src.indexOf('function adminHandlers(') + 600);
  for (const name of ['get_plan_changes', 'get_server_logs', 'get_deploy_status']) {
    assert.ok(adminTools.includes(`name: '${name}'`), `${name} in ADMIN_TOOLS`);
    assert.ok(handlers.includes(`${name}:`), `${name} handler`);
    assert.ok(!staff.includes(name), `${name} not for support staff`);
  }
});
