// Owner's runbook (lib/opsGuide.md): servers, Neon, Vercel, GitHub pushes,
// DNS, email, uptime and partner dashboards — used by the admin AI (tool
// get_ops_guide) to walk the owner through setup and fixes step by step.
// Live facts are added: which server settings are SET (names only, never
// values), server uptime/Node version, and a quick database check.

const fs = require('fs');
const path = require('path');

let cache = null;
function load() {
  if (cache) return cache;
  const raw = fs.readFileSync(path.join(__dirname, 'opsGuide.md'), 'utf8').replace(/^<!--[\s\S]*?-->\s*/, '');
  const [, ...rest] = raw.split(/\n(?=## )/);
  cache = rest.map((s) => ({ title: s.split('\n')[0].replace(/^##\s*/, '').trim(), body: s.trim() }));
  return cache;
}

const STOP = new Set('the a an and or of to for in on with my is it how do does what why can i me you your we our they this that where'.split(' '));
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9.\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
const SYN = { database: 'neon', db: 'neon', compute: 'neon', storage: 'neon', server: 'vps', ssh: 'vps', pm2: 'vps', racknerd: 'vps', env: '.env', key: '.env', deploy: 'vercel', frontend: 'vercel', build: 'vercel', dns: 'whogohost', domain: 'whogohost', webhook: 'partner', whitelist: 'partner', ip: 'partner', push: 'pushing', update: 'pushing', github: 'pushing', email: 'resend', uptime: 'cron-job', down: 'wrong', error: 'wrong' };

function lookup(topic) {
  const secs = load();
  const q = words(topic).flatMap((w) => (SYN[w] ? [w, SYN[w]] : [w]));
  const rules = secs[0];
  if (!q.length) return { sections: secs.map((s) => s.body).join('\n\n'), index: secs.map((s) => s.title) };
  const hits = secs.map((s) => {
    const hay = s.body.toLowerCase();
    let score = 0;
    for (const w of q) if (hay.includes(w)) score += w.length > 4 ? 2 : 1;
    if (q.some((w) => s.title.toLowerCase().includes(w))) score += 4;
    return { s, score };
  }).filter((x) => x.score > 0 && x.s !== rules).sort((a, b) => b.score - a.score).slice(0, 3).map((x) => x.s);
  return { sections: [rules, ...hits].map((s) => s.body).join('\n\n'), index: secs.map((s) => s.title) };
}

// Names only — never values.
const WATCH = ['DATABASE_URL', 'JWT_SECRET', 'BACKUP_PASSWORD', 'RESEND_API_KEY', 'EMAIL_FROM', 'ADMIN_ALERT_EMAIL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NEON_API_KEY', 'NEON_PROJECT_ID', 'NEON_STORAGE_LIMIT_GB', 'NEON_COMPUTE_LIMIT_HOURS', 'NEON_PRICE_CU_HOUR', 'NEON_PRICE_GB_MONTH', 'SQUAD_SECRET_KEY', 'NOMBA_CLIENT_ID', 'NOMBA_WEBHOOK_KEY', 'FLW_SECRET_KEY', 'MONNIFY_API_KEY', 'CLUBKONNECT_API_KEY', 'PUBLIC_API_URL', 'APP_URL', 'ADMIN_APP_URL'];

async function live() {
  const set = WATCH.filter((k) => String(process.env[k] || '').trim());
  const out = {
    serverSettingsSet: set,
    serverSettingsMissing: WATCH.filter((k) => !set.includes(k)),
    neonLimits: { storageGb: process.env.NEON_STORAGE_LIMIT_GB || null, computeHours: process.env.NEON_COMPUTE_LIMIT_HOURS || null },
    server: { node: process.version, upMinutes: Math.round(process.uptime() / 60), onRender: Boolean(process.env.RENDER), memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024) },
    note: 'Setting names only — values are never shown. Some keys (VTpass, Monnify/Squad/Nomba live keys, AI keys) may live in Admin → Settings instead of .env.',
  };
  try {
    const d = await require('./dbHealth').report();
    out.database = { ok: d.database.ok, pingMs: d.database.pingMs, sizeMb: d.database.sizeMb, storageUsedPct: d.database.storageUsedPct, neon: d.neon.connected ? { computeHours: d.neon.computeHours, computeUsedPct: d.neon.computeUsedPct, storageGb: d.neon.storageGb } : (d.neon.error || 'Neon figures not connected'), warnings: d.warnings.map((w) => w.text) };
  } catch { out.database = 'could not check'; }
  return out;
}

async function guide({ topic } = {}) {
  return { ...lookup(topic), live: await live() };
}

module.exports = { guide, lookup, load, live, _reset: () => { cache = null; } };
