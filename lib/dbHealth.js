// Database monitor (Admin → Database).
//
// 1) Inside the database — no setup: size, biggest tables, connections,
//    how fast it answers. Checked on the quiet clock so it never keeps a
//    sleeping Neon database awake on its own.
// 2) Neon's own account figures — optional, needs NEON_API_KEY in the
//    server settings (.env), read-only key is enough; NEON_PROJECT_ID is
//    optional (found automatically when the key sees one project).
//    Neon API calls don't wake the database.
// Optional plan limits for warnings (server settings):
//    NEON_STORAGE_LIMIT_GB, NEON_COMPUTE_LIMIT_HOURS (per month).
// Optional prices for a bill estimate: NEON_PRICE_CU_HOUR (₦ or $ per
//    compute-hour), NEON_PRICE_GB_MONTH, NEON_PRICE_CURRENCY (default "$").
// Read-only: nothing here changes the database or the Neon account.

const prisma = require('./prisma');

const MIN = 60 * 1000;
const GB = 1024 ** 3;
const NEON = 'https://console.neon.tech/api/v2';
const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const n = (v) => Number(typeof v === 'bigint' ? v.toString() : v || 0);
const r1 = (x) => Math.round(x * 10) / 10;
const gbOf = (bytes) => Math.round((n(bytes) / GB) * 1000) / 1000;

const SLOW_MS = 1500;
const COOLDOWN = 12 * 60 * MIN;
const sent = new Map();

async function alertOnce(key, title, message) {
  const last = sent.get(key) || 0;
  if (Date.now() - last < COOLDOWN) return;
  sent.set(key, Date.now());
  await Promise.resolve(require('./adminAlert').alertAdmins(title, message, '/admin/database')).catch(() => {});
}

// ---- 1) inside the database -------------------------------------------------

async function inside() {
  const t0 = Date.now();
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
  } catch (e) {
    return { ok: false, error: 'The database did not answer.', detail: String(e?.message || e).slice(0, 200), checkedAt: new Date() };
  }
  const pingMs = Date.now() - t0;
  const [[size], tables, [conn]] = await Promise.all([
    prisma.$queryRawUnsafe('SELECT pg_database_size(current_database()) AS bytes, current_database() AS name, version() AS version'),
    prisma.$queryRawUnsafe(`SELECT relname AS name, pg_total_relation_size(relid) AS bytes, n_live_tup AS rows
      FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10`),
    prisma.$queryRawUnsafe(`SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS used,
      (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max,
      (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND now() - query_start > interval '30 seconds') AS slow`),
  ]);
  const limitGb = num(process.env.NEON_STORAGE_LIMIT_GB);
  const sizeGb = gbOf(size.bytes);
  return {
    ok: true,
    pingMs,
    speed: pingMs < 300 ? 'fast' : pingMs < SLOW_MS ? 'ok' : 'slow',
    database: size.name,
    postgres: String(size.version || '').split(' ').slice(0, 2).join(' '),
    sizeGb,
    sizeMb: Math.round(n(size.bytes) / 1024 / 1024),
    storageLimitGb: limitGb,
    storageUsedPct: limitGb ? r1((sizeGb / limitGb) * 100) : null,
    biggestTables: tables.map((t) => ({ name: t.name, mb: r1(n(t.bytes) / 1024 / 1024), rows: n(t.rows) })),
    connections: { used: n(conn.used), max: n(conn.max), longRunningQueries: n(conn.slow) },
    checkedAt: new Date(),
  };
}

// ---- 2) Neon account (optional) ---------------------------------------------

const key = () => String(process.env.NEON_API_KEY || '').trim();
let projectCache = null;

async function neonGet(path) {
  const res = await fetch(`${NEON}${path}`, { headers: { Authorization: `Bearer ${key()}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error('Neon refused the API key — create a new one in the Neon console (Account settings → API keys).'), { neon: true });
  if (!res.ok) throw Object.assign(new Error(`Neon answered ${res.status}.`), { neon: true });
  return res.json();
}

async function projectId() {
  const fixed = String(process.env.NEON_PROJECT_ID || '').trim();
  if (fixed) return fixed;
  if (projectCache) return projectCache;
  const { projects = [] } = await neonGet('/projects?limit=100');
  const pick = projects.length === 1 ? projects[0] : projects.find((p) => /zappi/i.test(p.name || ''));
  if (!pick) throw Object.assign(new Error(`The key can see ${projects.length} Neon projects — add NEON_PROJECT_ID to the server settings (.env) to pick one.`), { neon: true });
  projectCache = pick.id;
  return pick.id;
}

async function neon() {
  if (!key()) return { connected: false, howTo: 'Neon console → Account settings → API keys → Create (a read-only key is enough). Put it in the server settings (.env) as NEON_API_KEY=… then restart the server (pm2 restart zappi-pay-api).' };
  try {
    const id = await projectId();
    const [{ project: p }, eps] = await Promise.all([neonGet(`/projects/${id}`), neonGet(`/projects/${id}/endpoints`).catch(() => ({ endpoints: [] }))]);
    const computeHours = r1(n(p.compute_time_seconds) / 3600);
    const activeHours = r1(n(p.active_time_seconds) / 3600);
    const storageGb = gbOf(p.synthetic_storage_size);
    const transferGb = gbOf(p.data_transfer_bytes);
    const computeLimit = num(process.env.NEON_COMPUTE_LIMIT_HOURS);
    const storageLimit = num(process.env.NEON_STORAGE_LIMIT_GB) ?? (p.branch_logical_size_limit_bytes ? gbOf(p.branch_logical_size_limit_bytes) : null);
    const priceCu = num(process.env.NEON_PRICE_CU_HOUR);
    const priceGb = num(process.env.NEON_PRICE_GB_MONTH);
    const cur = process.env.NEON_PRICE_CURRENCY || '$';
    const start = p.consumption_period_start ? new Date(p.consumption_period_start) : null;
    const end = p.consumption_period_end ? new Date(p.consumption_period_end) : null;
    let estimate = null;
    if (priceCu !== null || priceGb !== null) {
      const sofar = (priceCu || 0) * computeHours + (priceGb || 0) * storageGb;
      const elapsed = start ? Math.max(1, (Date.now() - start.getTime()) / 86400000) : null;
      const length = start && end ? Math.max(elapsed, (end.getTime() - start.getTime()) / 86400000) : 30;
      estimate = { currency: cur, soFar: Math.round(sofar * 100) / 100, monthProjected: elapsed ? Math.round(((priceCu || 0) * computeHours * (length / elapsed) + (priceGb || 0) * storageGb) * 100) / 100 : null, note: 'Rough estimate from your prices in the server settings — Neon’s invoice is the real figure.' };
    }
    return {
      connected: true,
      project: { id: p.id, name: p.name, region: p.region_id, plan: p.owner?.subscription_type || null },
      period: { start, end },
      computeHours,
      activeHours,
      computeLimitHours: computeLimit,
      computeUsedPct: computeLimit ? r1((computeHours / computeLimit) * 100) : null,
      storageGb,
      storageLimitGb: storageLimit,
      storageUsedPct: storageLimit ? r1((storageGb / storageLimit) * 100) : null,
      transferGb,
      writtenGb: gbOf(p.written_data_bytes),
      lastActive: p.compute_last_active_at || null,
      computes: (eps.endpoints || []).map((e) => ({ type: e.type, state: e.current_state, size: e.autoscaling_limit_min_cu === e.autoscaling_limit_max_cu ? `${e.autoscaling_limit_max_cu} CU` : `${e.autoscaling_limit_min_cu}–${e.autoscaling_limit_max_cu} CU`, sleepsAfterSec: e.suspend_timeout_seconds ?? null })),
      estimate,
      note: 'Neon updates these figures every few minutes; your Neon invoice is the final word.',
    };
  } catch (e) {
    return { connected: false, error: e.neon ? e.message : 'Could not reach Neon right now.' };
  }
}

let lastNeon = null;
let lastNeonAt = 0;
async function neonCached(force) {
  if (!force && lastNeon && Date.now() - lastNeonAt < 10 * MIN) return lastNeon;
  lastNeon = await neon();
  lastNeonAt = Date.now();
  return lastNeon;
}

// ---- report + alerts --------------------------------------------------------

function warnings(db, nx) {
  const w = [];
  if (!db.ok) w.push({ level: 'bad', text: 'The database is not answering — customers can’t log in or buy. Check Neon’s status page and your Neon console.' });
  if (db.ok && db.speed === 'slow') w.push({ level: 'warn', text: `The database answered slowly (${db.pingMs} ms). Usually it’s waking from sleep; if it stays slow, check the Neon console.` });
  if (db.ok && db.connections.max && db.connections.used / db.connections.max >= 0.8) w.push({ level: 'warn', text: `${db.connections.used} of ${db.connections.max} database connections in use.` });
  if (db.ok && db.connections.longRunningQueries) w.push({ level: 'warn', text: `${db.connections.longRunningQueries} query(ies) running over 30 seconds.` });
  const sPct = nx?.storageUsedPct ?? db.storageUsedPct;
  if (sPct >= 95) w.push({ level: 'bad', text: `Storage is at ${sPct}% of your plan limit — upgrade or clean up old data now.` });
  else if (sPct >= 80) w.push({ level: 'warn', text: `Storage is at ${sPct}% of your plan limit.` });
  if (nx?.computeUsedPct >= 95) w.push({ level: 'bad', text: `Compute is at ${nx.computeUsedPct}% of this month’s allowance.` });
  else if (nx?.computeUsedPct >= 80) w.push({ level: 'warn', text: `Compute is at ${nx.computeUsedPct}% of this month’s allowance.` });
  if (nx && !nx.connected && nx.error) w.push({ level: 'info', text: nx.error });
  return w;
}

async function report({ fresh } = {}) {
  const [db, nx] = await Promise.all([inside(), neonCached(fresh)]);
  return { database: db, neon: nx, warnings: warnings(db, nx) };
}

// The watch: on the quiet clock (hourly when busy, spaced out when quiet),
// so it never wakes a sleeping database by itself more than other jobs do.
async function watch() {
  const r = await report({ fresh: true });
  for (const w of r.warnings) {
    if (w.level === 'info') continue;
    const k = w.text.replace(/[\d.,]+/g, '#').slice(0, 60);
    await alertOnce(k, w.level === 'bad' ? 'Database needs attention' : 'Database warning', w.text);
  }
  return r;
}

function start() {
  require('./quietClock').every('database watch', 60 * MIN, watch, { firstAfter: 10 * MIN });
}

module.exports = { report, inside, neon, watch, start, warnings };
