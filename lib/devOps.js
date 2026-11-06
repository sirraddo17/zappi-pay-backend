// Helpers so the owner's admin AI can look after the app between updates.
// All READ-ONLY: nothing here merges, deploys, changes data or sends
// anything except an alert to the owner.
//  • prStatus        — the AI's GitHub pull requests: tests ✅/❌, merged?, and
//                      the exact server commands to run after merging
//  • errorWatch      — hourly: new or many errors in the server log → one
//                      alert with an "Ask the AI to fix this" link
//  • failurePatterns — purchases failing on one provider right now
//  • supportQuality  — reply times, unanswered tickets, repeated questions

const prisma = require('./prisma');

const HOUR = 60 * 60 * 1000;
const askLink = (q) => `/admin/assistant?ask=${encodeURIComponent(String(q).slice(0, 400))}`;

// --- server commands after a merge ------------------------------------------------
const BACKEND_DIR = '/opt/zappi-pay-backend';
const HEALTH = 'curl -s https://api.zappipay.com.ng/api/health';
function serverSteps(repo, files = []) {
  const names = files.map((f) => (typeof f === 'string' ? f : f.filename || f.path || ''));
  if (repo === 'frontend') return { needsServer: false, note: 'Frontend only: Vercel builds it by itself 1–3 minutes after merging. Reload the app twice.', commands: [] };
  const schema = names.some((n) => n === 'prisma/schema.prisma');
  const env = names.some((n) => /(^|\/)\.env/.test(n));
  const commands = [`cd ${BACKEND_DIR} && git pull`];
  if (schema) commands.push('for i in 1 2 3; do npx prisma db push && break; sleep 5; done');
  commands.push(`npm ci && npx prisma generate && pm2 restart zappi-pay-api && sleep 5 && ${HEALTH}`);
  return {
    needsServer: true,
    databaseChange: schema,
    commands,
    good: 'The last command should end with {"ok":true,"service":"zappi-pay-backend"}. Then ask "is the new code live?" to see the self-check.',
    ...(schema ? { warning: 'If prisma db push asks about data loss, answer no and ask for help.' } : {}),
    ...(env ? { warning: 'This change mentions .env — server settings are edited by hand on the VPS, never through a pull request.' } : {}),
  };
}

// --- pull request status ------------------------------------------------------------
async function prStatus({ repo, number } = {}, { gh } = {}) {
  const code = require('./codeAccess');
  const call = gh || code.gh;
  const repos = repo ? [String(repo).toLowerCase().startsWith('f') ? 'frontend' : 'backend'] : ['backend', 'frontend'];
  const out = [];
  for (const r of repos) {
    const full = code.REPOS[r];
    const pulls = number ? [await call(`/repos/${full}/pulls/${parseInt(number, 10)}`)] : (await call(`/repos/${full}/pulls?state=all&per_page=10&sort=updated&direction=desc`)).filter((p) => String(p.head?.ref || '').startsWith('ai/')).slice(0, 3);
    for (const p of pulls) {
      const sha = p.head?.sha;
      const [checks, files] = await Promise.all([
        sha ? call(`/repos/${full}/commits/${sha}/check-runs`).catch(() => ({ check_runs: [] })) : { check_runs: [] },
        call(`/repos/${full}/pulls/${p.number}/files?per_page=50`).catch(() => []),
      ]);
      const runs = (checks.check_runs || []).map((c) => ({ name: c.name, status: c.status, result: c.conclusion || null }));
      const failed = runs.filter((c) => c.result && !['success', 'skipped', 'neutral'].includes(c.result));
      const running = runs.filter((c) => c.status !== 'completed');
      out.push({
        repo: r,
        number: p.number,
        title: p.title,
        link: p.html_url,
        state: p.merged_at ? 'MERGED' : p.state === 'closed' ? 'CLOSED' : 'OPEN',
        tests: !runs.length ? 'no checks yet (they start a minute after the pull request opens)' : running.length ? 'running' : failed.length ? `FAILED: ${failed.map((c) => c.name).join(', ')}` : 'passed',
        checks: runs,
        files: (Array.isArray(files) ? files : []).map((f) => f.filename),
        afterMerge: serverSteps(r, Array.isArray(files) ? files : []),
      });
    }
  }
  if (!out.length) return { note: 'No pull requests from the AI yet.' };
  return { pullRequests: out, rule: 'Only the owner merges, on GitHub. Merge only when tests passed. If tests failed, read the failing check and propose a corrected change.' };
}

// --- error watch ------------------------------------------------------------------------
// Same error with different numbers/ids counts as one kind.
function signature(line) {
  return String(line)
    .replace(/^ERR\s+/, '')
    .replace(/^\d{4}-\d{2}-\d{2}[T ][\d:.]+\S*:?\s*/, '')
    .replace(/\b[0-9a-f]{8,}\b/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

const seen = new Map(); // signature → first seen time (memory; resets on restart)
let lastAlertAt = 0;
async function errorWatch({ now = Date.now(), read } = {}) {
  const r = (read || require('./serverLogs').read)({ errorsOnly: true, lines: 1000, sinceMinutes: 60 }, { now });
  const timed = !/no times/.test(r.note || '');
  const counts = new Map();
  for (const l of r.lines || []) {
    if (!/^ERR\s|error|failed|exception|unhandled/i.test(l)) continue;
    const s = signature(l);
    if (s) counts.set(s, (counts.get(s) || 0) + 1);
  }
  for (const [s, t] of seen) if (now - t > 24 * HOUR) seen.delete(s);
  const fresh = [...counts.entries()].filter(([s, n]) => !seen.has(s) && n >= 3);
  for (const [s] of counts) if (!seen.has(s)) seen.set(s, now);
  const total = [...counts.values()].reduce((a, n) => a + n, 0);
  const many = timed && total >= 25;
  if ((fresh.length || many) && now - lastAlertAt >= HOUR) {
    lastAlertAt = now;
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, n]) => `• ${n}× ${s}`).join('\n');
    await Promise.resolve(require('./adminAlert').alertAdmins(
      fresh.length ? `New server error${fresh.length === 1 ? '' : 's'} (${fresh.length} kind${fresh.length === 1 ? '' : 's'})` : `${total} server errors in the last hour`,
      `${top}\nTap to ask the AI assistant to find the cause and propose a fix (nothing changes until you approve).`,
      askLink('Why are there server errors in the last hour? Find the cause in the logs and the code, and propose a fix.'),
    )).catch(() => {});
    return { alerted: true, total, fresh: fresh.length };
  }
  return { alerted: false, total, fresh: fresh.length };
}

// --- purchases failing on one provider -----------------------------------------------------
async function failurePatterns({ hours = 2 } = {}) {
  const since = new Date(Date.now() - Math.min(48, Math.max(1, Number(hours) || 2)) * HOUR);
  const orders = await prisma.order.findMany({ where: { createdAt: { gte: since }, isTest: false }, select: { status: true, service: true, provider: true, customerId: true, responsePayload: true } });
  const by = new Map();
  for (const o of orders) {
    const k = o.provider || o.service;
    const e = by.get(k) || { provider: k, service: o.service, total: 0, failed: 0, customers: new Set(), reasons: new Map() };
    e.total += 1;
    if (['FAILED', 'REFUNDED'].includes(o.status)) {
      e.failed += 1;
      e.customers.add(o.customerId);
      const p = o.responsePayload || {};
      const why = String(p.response_description || p.description || p.message || p.content?.errors || p.status || 'unknown').slice(0, 80);
      e.reasons.set(why, (e.reasons.get(why) || 0) + 1);
    }
    by.set(k, e);
  }
  const paused = await require('./partnerHealth').list().catch(() => null);
  const rows = [...by.values()].filter((e) => e.failed > 0).map((e) => ({ provider: e.provider, service: e.service, failed: e.failed, of: e.total, failRatePct: Math.round((e.failed / e.total) * 100), customers: e.customers.size, topReasons: [...e.reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${n}× ${r}`) })).sort((a, b) => b.failed - a.failed);
  return {
    hours: Math.round((Date.now() - since.getTime()) / HOUR),
    providersWithFailures: rows,
    pattern: rows.filter((r) => r.failed >= 3 && r.customers >= 2 && r.failRatePct >= 30).map((r) => r.provider),
    autoPause: paused,
    howToUse: 'If one provider keeps failing for several customers, explain the likely cause (the top reasons; VTpass LOW WALLET BALANCE means top up VTpass) and offer propose_service_notice. Failed purchases were refunded automatically.',
  };
}

// --- support quality ----------------------------------------------------------------------------
const STOP = new Set('the a an and or to of in on for my is it i me was have has not no but with this that from at be you your we our please pls sir ma help am are what why how when did do does can cant can’t still yet been'.split(' '));
const mask = (t) => String(t || '').replace(/(?<!\d)(?:\+?234|0)[789][01]\d{8}(?!\d)/g, (m) => `${m.slice(0, 4)}•••••${m.slice(-2)}`).replace(/\d{10,}/g, (m) => `••••${m.slice(-4)}`);
async function supportQuality({ days = 7 } = {}) {
  const since = new Date(Date.now() - Math.min(90, Math.max(1, Number(days) || 7)) * 24 * HOUR);
  const tickets = await prisma.supportTicket.findMany({ where: { createdAt: { gte: since } }, select: { message: true, adminReply: true, repliedAt: true, autoReply: true, status: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 500 });
  const replied = tickets.filter((t) => t.repliedAt);
  const mins = replied.map((t) => (new Date(t.repliedAt) - new Date(t.createdAt)) / 60000).sort((a, b) => a - b);
  const median = mins.length ? Math.round(mins[Math.floor(mins.length / 2)]) : null;
  const waiting = tickets.filter((t) => !t.repliedAt && t.status !== 'RESOLVED' && Date.now() - new Date(t.createdAt) > 24 * HOUR).length;
  const words = new Map();
  for (const t of tickets) for (const w of new Set(String(t.message).toLowerCase().match(/[a-z]{4,}/g) || [])) if (!STOP.has(w)) words.set(w, (words.get(w) || 0) + 1);
  return {
    days: Math.round((Date.now() - since.getTime()) / (24 * HOUR)),
    tickets: tickets.length,
    replied: replied.length,
    medianFirstReplyMinutes: median,
    over24hWithoutReply: waiting,
    automaticReplies: tickets.filter((t) => t.autoReply).length,
    commonWords: [...words.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w, n]) => `${w} (${n})`),
    recentReplies: replied.slice(0, 10).map((t) => ({ customerSaid: mask(t.message).slice(0, 240), weReplied: mask(t.adminReply).slice(0, 240), minutes: Math.round((new Date(t.repliedAt) - new Date(t.createdAt)) / 60000) })),
    howToUse: 'Score the replies (fast? clear? kind? solved it?) with one tip each; group repeated questions and offer propose_faq for them.',
  };
}

let started = false;
function start() {
  if (started || process.env.DISABLE_SCHEDULER === '1') return;
  started = true;
  require('./quietClock').every('error watch', HOUR, () => errorWatch(), { firstAfter: 10 * 60 * 1000 });
}

module.exports = { prStatus, serverSteps, errorWatch, signature, failurePatterns, supportQuality, askLink, start, _reset: () => { seen.clear(); lastAlertAt = 0; } };
