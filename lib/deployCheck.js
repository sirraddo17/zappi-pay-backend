// Deploy check. On server start: note the git commit that is running, the
// start time and the Node version (DeployRecord). 60 seconds later run a
// self-check — database, VTpass /balance, each switched-on payment
// partner's settings, and /api/health — and save the result. If anything
// fails, alert the owner once with what failed and the previous commit to
// roll back to. Read-only: it never changes settings, money or code.
// The admin AI reads it with get_deploy_status.

const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const prisma = require('./prisma');

const ROOT = path.resolve(__dirname, '..');
const SHA = /^[0-9a-f]{7,40}$/i;

function git(args) {
  try {
    const out = execFileSync('git', args, { cwd: ROOT, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return SHA.test(out) ? out : null;
  } catch {
    return null;
  }
}
const currentCommit = () => git(['rev-parse', '--short', 'HEAD']) || (SHA.test(String(process.env.GIT_COMMIT || '')) ? String(process.env.GIT_COMMIT).slice(0, 12) : 'unknown');

const state = { commit: null, startedAt: null, nodeVersion: process.version, recordId: null, previousCommit: null, lastCheck: null };

// The last different commit that started and passed (or wasn't checked);
// falls back to where HEAD was before the last pull (git reflog).
async function findPrevious(commit) {
  const rows = await prisma.deployRecord.findMany({ where: { commit: { not: commit } }, orderBy: { startedAt: 'desc' }, take: 20 }).catch(() => []);
  const good = rows.find((r) => r.ok !== false);
  if (good) return good.commit;
  const before = git(['rev-parse', '--short', 'HEAD@{1}']);
  return before && before !== commit ? before : null;
}

async function recordStart({ commit = currentCommit(), now = new Date() } = {}) {
  state.commit = commit;
  state.startedAt = now;
  state.previousCommit = await findPrevious(commit);
  const row = await prisma.deployRecord.create({ data: { commit, startedAt: now, nodeVersion: process.version } }).catch((e) => { console.error('deploy check: could not save start:', e.message); return null; });
  state.recordId = row?.id || null;
  // New version? Save the commits since the previous one (release notes).
  if (state.recordId) await require('./releaseNotes').capture({ recordId: state.recordId, commit }).catch((e) => console.error('release notes failed:', e.message));
  await prisma.deployRecord.deleteMany({ where: { startedAt: { lt: new Date(now.getTime() - 90 * 24 * 3600 * 1000) } } }).catch(() => {});
  return { ...state };
}

function getHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
      res.on('end', () => {
        let ok = false;
        try { ok = res.statusCode === 200 && JSON.parse(body).ok === true; } catch { ok = false; }
        resolve(ok ? { ok: true } : { ok: false, why: `HTTP ${res.statusCode}` });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, why: 'no answer in 5s' }); });
    req.on('error', (e) => resolve({ ok: false, why: e.code || e.message }));
  });
}

const short = (e) => String(e?.message || e || 'failed').replace(/\s+/g, ' ').slice(0, 140);
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { name, ok: r?.ok !== false, ms: Date.now() - t0, ...(r?.why ? { why: r.why } : {}), ...(r?.mode ? { mode: r.mode } : {}) };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, why: short(e) };
  }
}

// Which payment partners are switched on (funding or Send to Bank).
async function partnersOn(s) {
  const payVia = ['squad', 'nomba'].includes(s.payoutProvider) ? s.payoutProvider : 'monnify';
  const sends = Boolean(s.bankTransferEnabled);
  const on = [];
  if (s.monnifyFundingEnabled !== false || (sends && payVia === 'monnify')) on.push('monnify');
  if (s.squadFundingEnabled || (sends && payVia === 'squad')) on.push('squad');
  if (s.nombaFundingEnabled || (sends && payVia === 'nomba')) on.push('nomba');
  return on;
}

async function selfCheck({ port = process.env.PORT || 4000, health = getHealth } = {}) {
  const checks = [];
  checks.push(await step('database', async () => { await prisma.$queryRawUnsafe('SELECT 1'); return { ok: true }; }));
  checks.push(await step('VTpass /balance', async () => {
    const b = await require('./vtpass').vtpassRequest('GET', '/balance');
    const n = Number(b?.contents?.balance ?? b?.content?.balance ?? b?.balance);
    return Number.isFinite(n) ? { ok: true } : { ok: false, why: 'no balance in the reply' };
  }));
  const s = await require('./vtpass').getSettings().catch(() => ({}));
  for (const p of await partnersOn(s)) {
    checks.push(await step(`${p} settings`, async () => {
      const lib = require(`./${p}`);
      const c = await lib.getConfig();
      const has = p === 'squad' ? Boolean(c.secretKey) : p === 'monnify' ? Boolean(c.apiKey && c.secretKey) : await lib.isConfigured();
      return has ? { ok: true, mode: c.mode } : { ok: false, why: 'keys missing', mode: c.mode };
    }));
  }
  checks.push(await step('/api/health', () => health(port)));
  const failed = checks.filter((c) => !c.ok);
  const result = { at: new Date(), ok: failed.length === 0, checks, failed: failed.map((c) => `${c.name}${c.why ? ` (${c.why})` : ''}`) };
  state.lastCheck = result;
  if (state.recordId) await prisma.deployRecord.update({ where: { id: state.recordId }, data: { ok: result.ok, checkedAt: result.at, check: JSON.parse(JSON.stringify(result)) } }).catch(() => {});
  if (!result.ok) await alertFailed(result);
  return result;
}

const rollbackCommand = (prev) => (prev ? `cd /opt/zappi-pay-backend && git checkout ${prev} && pm2 restart zappi-pay-api` : null);

let alerted = false; // once per start
async function alertFailed(result) {
  if (alerted) return;
  alerted = true;
  const prev = state.previousCommit;
  const msg = [
    `Running commit ${state.commit || 'unknown'} (started ${state.startedAt ? state.startedAt.toISOString() : 'just now'}).`,
    `Failed: ${result.failed.join('; ')}.`,
    prev ? `To roll back to the previous commit ${prev}, on the VPS run: ${rollbackCommand(prev)}` : 'No previous commit recorded to roll back to.',
    prev ? 'Afterwards, to return to the latest code: git checkout main && git pull' : '',
  ].filter(Boolean).join('\n');
  console.error(`Deploy self-check failed: ${result.failed.join('; ')}`);
  await Promise.resolve(require('./adminAlert').alertAdmins('⚠️ Server self-check failed after restart', `${msg}\nTap to ask the AI assistant what went wrong.`, require('./devOps').askLink('The server self-check failed after the last restart. What failed, why, and what should I do (rollback or a fix)?'))).catch(() => {});
}

async function status() {
  let last = state.lastCheck;
  if (!last && state.recordId) {
    const row = await prisma.deployRecord.findUnique({ where: { id: state.recordId } }).catch(() => null);
    last = row?.check || null;
  }
  return {
    commit: state.commit || currentCommit(),
    startedAt: state.startedAt,
    nodeVersion: state.nodeVersion,
    lastSelfCheck: last || (state.startedAt ? 'Not run yet (it runs 60 seconds after the server starts).' : 'Not recorded.'),
    previousCommit: state.previousCommit,
    rollback: rollbackCommand(state.previousCommit),
    note: 'Read-only. Rolling back is done by the owner on the VPS; afterwards return to the latest code with: git checkout main && git pull',
  };
}

let started = false;
function start() {
  if (started || process.env.DISABLE_SCHEDULER === '1' || process.env.ZP_TEST === '1') return;
  started = true;
  recordStart()
    .catch((e) => console.error('deploy check start failed:', e.message))
    .finally(() => {
      const t = setTimeout(() => selfCheck().catch((e) => console.error('deploy self-check failed:', e.message)), 60 * 1000);
      t.unref?.();
    });
}

module.exports = { start, recordStart, selfCheck, status, currentCommit, partnersOn, rollbackCommand, _state: state, _reset: () => { alerted = false; started = false; Object.assign(state, { commit: null, startedAt: null, recordId: null, previousCommit: null, lastCheck: null }); } };
