// Dev ops for the admin AI: pull request status with server commands, error
// watch, failure patterns, support quality — all read-only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { makeDb } = require('./helpers/memdb');

const ROOT = path.resolve(__dirname, '..');
let db = makeDb();
const alerts = [];
const fakes = {
  prisma: () => new Proxy({}, { get: (_, prop) => db[prop] }),
  adminAlert: () => ({ alertAdmins: async (title, message, link) => { alerts.push({ title, message, link }); } }),
  partnerHealth: () => ({ list: async () => [] }),
  quietClock: () => ({ every: () => {} }),
};
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '');
  if (fakes[rel]) return fakes[rel]();
  return orig.call(this, req, parent, ...rest);
};
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
const dev = require('../lib/devOps');

test('server steps: db push only when the schema changed; frontend needs no server', () => {
  const plain = dev.serverSteps('backend', ['lib/x.js']);
  assert.equal(plain.needsServer, true);
  assert.equal(plain.commands[0], 'cd /opt/zappi-pay-backend && git pull');
  assert.ok(!plain.commands.some((c) => /prisma db push/.test(c)));
  assert.match(plain.commands.at(-1), /pm2 restart zappi-pay-api .*api\/health/);
  const schema = dev.serverSteps('backend', [{ filename: 'prisma/schema.prisma' }]);
  assert.ok(schema.commands.some((c) => /for i in 1 2 3; do npx prisma db push/.test(c)));
  assert.match(schema.warning, /data loss/);
  assert.equal(dev.serverSteps('frontend', ['src/a.jsx']).needsServer, false);
});

test('PR status: tests passed / failed, files and after-merge commands (read-only GitHub calls)', async () => {
  const calls = [];
  const gh = async (url) => {
    calls.push(url);
    if (/\/pulls\?state=all/.test(url)) return [{ number: 7, title: '[AI] Fix receipt', html_url: 'https://github.com/x/pull/7', state: 'open', merged_at: null, head: { ref: 'ai/fix-receipt-1', sha: 'abc' } }, { number: 6, title: 'human', head: { ref: 'feature' } }];
    if (/check-runs/.test(url)) return { check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure' }] };
    if (/pulls\/7\/files/.test(url)) return [{ filename: 'prisma/schema.prisma' }, { filename: 'lib/x.js' }];
    return [];
  };
  const r = await dev.prStatus({ repo: 'backend' }, { gh });
  assert.equal(r.pullRequests.length, 1, 'only the AI’s (ai/ branches)');
  const p = r.pullRequests[0];
  assert.equal(p.tests, 'FAILED: test');
  assert.equal(p.afterMerge.databaseChange, true);
  assert.ok(calls.every((u) => !/merge|PUT|DELETE/i.test(u)), 'never merges');
});

test('error watch: new repeated error → one alert with an ask-the-AI link; quiet when nothing new', async () => {
  dev._reset();
  alerts.length = 0;
  const lines = ['ERR 2026-11-06T09:00:01: TypeError: Cannot read x of undefined at /lib/a.js:12', 'ERR 2026-11-06T09:05:02: TypeError: Cannot read x of undefined at /lib/a.js:12', 'ERR 2026-11-06T09:09:03: TypeError: Cannot read x of undefined at /lib/a.js:12'];
  const read = () => ({ lines, note: 'Read-only.' });
  const r1 = await dev.errorWatch({ now: Date.now(), read });
  assert.equal(r1.alerted, true);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].link, /^\/admin\/assistant\?ask=/);
  assert.match(alerts[0].message, /3× TypeError/);
  const r2 = await dev.errorWatch({ now: Date.now() + 2 * 3600 * 1000, read });
  assert.equal(r2.alerted, false, 'the same error is not alerted again the same day');
  assert.equal(dev.signature('ERR 2026-11-06T09:00:01: Order abc123def456 failed 500'), dev.signature('ERR 2026-11-07T10:00:00: Order 9f8e7d6c5b4a failed 502'));
});

test('failure patterns: per provider with reasons; support quality with masked phones', async () => {
  db = makeDb();
  const mk = (provider, status, customerId, why) => db.order.create({ data: { customerId, service: 'DATA', provider, status, amount: '100.00', isTest: false, vtpassRequestId: `${provider}${Math.random()}`, responsePayload: why ? { response_description: why } : null } });
  for (const c of ['a', 'b', 'c']) await mk('mtn-data', 'FAILED', c, 'LOW WALLET BALANCE');
  await mk('mtn-data', 'SUCCESS', 'd');
  await mk('glo-data', 'SUCCESS', 'e');
  const f = await dev.failurePatterns({ hours: 2 });
  assert.equal(f.providersWithFailures[0].provider, 'mtn-data');
  assert.equal(f.providersWithFailures[0].failRatePct, 75);
  assert.deepEqual(f.pattern, ['mtn-data']);
  assert.match(f.providersWithFailures[0].topReasons[0], /LOW WALLET BALANCE/);

  const now = Date.now();
  await db.supportTicket.create({ data: { customerId: 'a', message: 'My data not delivered to 08031234567', adminReply: 'Sorry, refunded.', repliedAt: new Date(now - 50 * 60000), status: 'RESOLVED', createdAt: new Date(now - 60 * 60000) } });
  await db.supportTicket.create({ data: { customerId: 'b', message: 'data not delivered', status: 'OPEN', createdAt: new Date(now - 30 * 3600000) } });
  const q = await dev.supportQuality({ days: 7 });
  assert.equal(q.tickets, 2);
  assert.equal(q.medianFirstReplyMinutes, 10);
  assert.equal(q.over24hWithoutReply, 1);
  assert.ok(!JSON.stringify(q).includes('08031234567'), 'phone masked');
  assert.ok(q.commonWords.some((w) => /^delivered/.test(w)));
});

test('wiring: owner-only tools; the AI can never edit the CI workflows; checks run on pull requests', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/ai.routes.js'), 'utf8');
  const staff = /const STAFF_TOOL_NAMES = \[([^\]]*)\]/.exec(src)[1];
  for (const n of ['get_pr_status', 'get_failure_patterns', 'get_support_quality']) {
    assert.ok(src.includes(`name: '${n}'`));
    assert.ok(!staff.includes(n));
  }
  assert.match(src, /const codeTask = !staff &&/, 'the stronger code model is owner-only');
  assert.match(fs.readFileSync(path.join(ROOT, 'lib/codePr.js'), 'utf8'), /\/\^\\\.github\\\/\//, 'AI pull requests can’t touch .github/');
  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /pull_request:/);
  assert.match(ci, /npm test/);
});
