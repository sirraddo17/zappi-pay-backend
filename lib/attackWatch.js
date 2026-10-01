// Attack watch: the server notes warning signs (password guessing,
// scans for weak spots, forged logins, fake payment messages, calls from
// other websites, hammering the request limits), blocks the worst
// addresses for a while by fixed rules (instant, no AI), alerts the
// admins, and keeps a 30-day log the owner — and the AI assistant — can
// read. The AI can only explain and suggest; it can't block or unblock.
//
// Many Nigerian mobile users share one internet address, so blocks are
// short and the thresholds high; a whole network is never blocked just
// for a few wrong passwords.

const prisma = require('./prisma');
const { clientIp } = require('./protect');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Paths no real ZAPPI PAY user ever asks for — only scanners do.
const PROBE = /(\/\.(env|git|aws|ssh|htaccess|htpasswd|DS_Store)\b|\/wp-(admin|login|content|includes|json)|xmlrpc\.php|phpmyadmin|\/pma\b|\.php(\?|$)|\/cgi-bin|\/actuator|\/server-status|\/vendor\/phpunit|\/\.well-known\/security\.txt\.php|\/config\.(json|yml|yaml)$|\/backup\.(zip|sql|tar)|\.sql(\.gz)?$|\/etc\/passwd|\.\.\/|%2e%2e|\/boaform|\/HNAP1|\/owa\/|\/solr\/|\/console\/|\/jenkins)/i;

// kind: [label, alert admins?]
const KINDS = {
  PROBE: ['Scan for weak spots', false],
  LOGIN_FAIL: ['Wrong customer password', false],
  ACCOUNT_LOCKED: ['Customer account locked (too many wrong passwords)', false],
  ADMIN_LOGIN_FAIL: ['Wrong admin password', false],
  ADMIN_CODE_FAIL: ['Wrong admin login code', false],
  BACKUP_CODE_USED: ['Admin logged in with a backup code', false],
  BAD_TOKEN: ['Forged or broken login token', false],
  WEBHOOK_BAD_SIGNATURE: ['Fake payment message (bad signature)', true],
  CORS_BLOCKED: ['Call from another website', false],
  RATE_LIMITED: ['Too many requests', false],
  IP_BLOCKED: ['Address blocked', true],
};

// Rules: within `windowMs`, `count` events of `kind` from one address
// (optionally across `distinct` different accounts) → block.
const RULES = [
  { kind: 'PROBE', count: 3, windowMs: 10 * MIN, scope: 'ALL', hours: 1, repeatHours: 24, why: 'scanning for weak spots' },
  { kind: 'BAD_TOKEN', count: 10, windowMs: 10 * MIN, scope: 'ALL', hours: 1, repeatHours: 12, why: 'sending forged login tokens' },
  { kind: 'LOGIN_FAIL', count: 30, distinct: 5, windowMs: 15 * MIN, scope: 'ALL', hours: 0.5, repeatHours: 6, why: 'guessing passwords on many accounts' },
  { kind: 'ADMIN_LOGIN_FAIL', count: 5, windowMs: 15 * MIN, scope: 'ADMIN', hours: 0.5, repeatHours: 6, why: 'guessing the admin password' },
  { kind: 'ADMIN_CODE_FAIL', count: 8, windowMs: 15 * MIN, scope: 'ADMIN', hours: 0.5, repeatHours: 6, why: 'guessing admin login codes' },
  { kind: 'RATE_LIMITED', count: 20, windowMs: 10 * MIN, scope: 'ALL', hours: 0.25, repeatHours: 2, why: 'flooding the server with requests' },
];

const recent = new Map(); // `${kind}|${ip}` → [{ t, who }]
const blocks = new Map(); // ip → [{ id, scope, until }]
const written = new Map(); // `${kind}|${ip}` → { id, t, n } (one row per minute)
const alerted = new Map(); // key → time

const trusted = () => new Set(String(process.env.SECURITY_ALLOW_IPS || '').split(',').map((x) => x.trim()).filter(Boolean));
const enabled = async () => {
  try { return (await require('./vtpass').getSettings()).attackWatchEnabled !== false; } catch { return true; }
};

function prune(list, windowMs) {
  const cut = Date.now() - windowMs;
  while (list.length && list[0].t < cut) list.shift();
  return list;
}

// Save the event (one row per kind/address per minute, with a count, so
// a flood doesn't fill the database).
async function save(kind, ip, { path, detail, customerId, adminId } = {}) {
  const k = `${kind}|${ip}`;
  const w = written.get(k);
  if (w && Date.now() - w.t < MIN) {
    w.n += 1;
    prisma.securityEvent.update({ where: { id: w.id }, data: { count: w.n } }).catch(() => {});
    return;
  }
  try {
    const row = await prisma.securityEvent.create({ data: { kind, ip: ip || null, path: path ? String(path).slice(0, 200) : null, detail: detail ? String(detail).slice(0, 300) : null, customerId: customerId || null, adminId: adminId || null } });
    written.set(k, { id: row.id, t: Date.now(), n: 1 });
    if (written.size > 5000) written.delete(written.keys().next().value);
  } catch { /* logging is best-effort */ }
}

function alertOnce(key, title, message, everyMs = HOUR) {
  if (Date.now() - (alerted.get(key) || 0) < everyMs) return;
  alerted.set(key, Date.now());
  try { require('./adminAlert').alertAdmins(title, message, '/admin/security'); } catch { /* ignore */ }
}

async function blockIp(ip, { scope = 'ALL', hours = 1, reason, auto = true }) {
  if (!ip || ip === 'unknown' || trusted().has(ip)) return null;
  const until = new Date(Date.now() + hours * HOUR);
  const row = await prisma.ipBlock.create({ data: { ip, scope, reason: String(reason || 'blocked').slice(0, 200), auto, until } }).catch(() => null);
  const list = (blocks.get(ip) || []).filter((b) => b.until > Date.now());
  list.push({ id: row?.id, scope, until: until.getTime() });
  blocks.set(ip, list);
  await save('IP_BLOCKED', ip, { detail: `${scope === 'ADMIN' ? 'Admin pages' : 'Whole app'} for ${hours < 1 ? `${Math.round(hours * 60)} min` : `${hours} h`}: ${reason}` });
  alertOnce(`block|${ip}|${scope}`, `🛡️ Blocked an address: ${reason}`, `${ip} was blocked from ${scope === 'ADMIN' ? 'the admin login' : 'ZAPPI PAY'} until ${until.toLocaleString('en-NG', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })} for ${reason}. Nothing for you to do — you can unblock it in Admin → Security if it was a mistake.`, 30 * MIN);
  return row;
}

async function blockedBefore(ip) {
  return prisma.ipBlock.count({ where: { ip, createdAt: { gte: new Date(Date.now() - 7 * DAY) } } }).catch(() => 0);
}

// Note a warning sign. Never throws, never slows the request much.
async function record(kind, req, extra = {}) {
  try {
    const ip = extra.ip || (req ? clientIp(req) : null);
    const path = extra.path || (req ? String(req.originalUrl || req.url || '').split('?')[0] : null);
    await save(kind, ip, { ...extra, path });
    if (KINDS[kind]?.[1]) alertOnce(`${kind}`, `🛡️ ${KINDS[kind][0]}`, `${extra.detail || ''} From ${ip || 'unknown address'}.`.trim());
    if (!ip || ip === 'unknown' || trusted().has(ip)) return;
    const k = `${kind}|${ip}`;
    const list = recent.get(k) || [];
    list.push({ t: Date.now(), who: extra.customerId || extra.who || null });
    recent.set(k, list);
    if (recent.size > 20000) recent.delete(recent.keys().next().value);
    for (const r of RULES.filter((x) => x.kind === kind)) {
      prune(list, r.windowMs);
      if (list.length < r.count) continue;
      if (r.distinct && new Set(list.map((x) => x.who).filter(Boolean)).size < r.distinct) continue;
      if (isBlocked(ip, r.scope === 'ADMIN' ? '/api/admin/x' : '/api/x')) continue;
      if (!(await enabled())) {
        alertOnce(`warn|${ip}|${kind}`, `🛡️ Possible attack: ${r.why}`, `${list.length} times from ${ip} in ${Math.round(r.windowMs / MIN)} minutes. Automatic blocking is OFF (Settings → Security).`);
        continue;
      }
      const again = (await blockedBefore(ip)) > 0;
      await blockIp(ip, { scope: r.scope, hours: again ? r.repeatHours : r.hours, reason: r.why });
      list.length = 0;
    }
  } catch (e) {
    console.warn('attackWatch.record failed:', e.message);
  }
}

function isBlocked(ip, path) {
  const list = blocks.get(ip);
  if (!list) return null;
  const now = Date.now();
  const live = list.filter((b) => b.until > now);
  if (!live.length) { blocks.delete(ip); return null; }
  if (live.length !== list.length) blocks.set(ip, live);
  const admin = /^\/api\/admin(\/|$)/.test(path);
  return live.find((b) => b.scope === 'ALL' || (b.scope === 'ADMIN' && admin)) || null;
}

// First middleware: refuse blocked addresses, catch scanners.
function guard(req, res, next) {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  // Payment webhooks and the health check are never blocked.
  if (path.startsWith('/api/webhooks/') || path === '/api/health') return next();
  const ip = clientIp(req);
  const b = ip && isBlocked(ip, path);
  if (b) {
    res.set('Retry-After', String(Math.max(60, Math.ceil((b.until - Date.now()) / 1000))));
    return res.status(403).json({ error: 'For security, access from your network is paused for a short while. Please try again later, or use mobile data / another Wi-Fi.', code: 'IP_BLOCKED' });
  }
  if (PROBE.test(path) || PROBE.test(decodeURIComponentSafe(path))) {
    record('PROBE', req);
    return res.status(404).json({ error: 'Not found.' });
  }
  return next();
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// Load blocks that are still running after a restart.
async function loadBlocks() {
  const rows = await prisma.ipBlock.findMany({ where: { until: { gt: new Date() }, liftedAt: null } }).catch(() => []);
  blocks.clear();
  for (const r of rows) {
    const list = blocks.get(r.ip) || [];
    list.push({ id: r.id, scope: r.scope, until: new Date(r.until).getTime() });
    blocks.set(r.ip, list);
  }
  return rows.length;
}

async function unblock(blockId, adminId) {
  const row = await prisma.ipBlock.findUnique({ where: { id: String(blockId) } });
  if (!row) return null;
  await prisma.ipBlock.update({ where: { id: row.id }, data: { liftedAt: new Date() } });
  const list = (blocks.get(row.ip) || []).filter((b) => b.id !== row.id);
  if (list.length) blocks.set(row.ip, list); else blocks.delete(row.ip);
  for (const k of [...recent.keys()]) if (k.endsWith(`|${row.ip}`)) recent.delete(k);
  await prisma.auditLog.create({ data: { actorAdminId: adminId, action: 'IP_UNBLOCKED', details: { ip: row.ip, reason: row.reason } } }).catch(() => {});
  return row;
}

// What happened (for the Security page and the AI).
async function summary({ hours = 24 } = {}) {
  const since = new Date(Date.now() - Math.min(24 * 30, Math.max(1, hours)) * HOUR);
  const rows = await prisma.securityEvent.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 2000 });
  const byKind = {};
  const byIp = {};
  for (const r of rows) {
    const n = r.count || 1;
    byKind[r.kind] = (byKind[r.kind] || 0) + n;
    if (r.ip) {
      const x = byIp[r.ip] || { ip: r.ip, events: 0, kinds: {}, last: r.createdAt };
      x.events += n;
      x.kinds[r.kind] = (x.kinds[r.kind] || 0) + n;
      byIp[r.ip] = x;
    }
  }
  const active = await prisma.ipBlock.findMany({ where: { until: { gt: new Date() }, liftedAt: null }, orderBy: { createdAt: 'desc' }, take: 100 });
  const recentBlocks = await prisma.ipBlock.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 50 });
  const serious = ['WEBHOOK_BAD_SIGNATURE', 'BACKUP_CODE_USED', 'ADMIN_LOGIN_FAIL', 'ADMIN_CODE_FAIL'].filter((k) => byKind[k]);
  const level = (byKind.WEBHOOK_BAD_SIGNATURE || byKind.IP_BLOCKED >= 5 || byKind.ADMIN_LOGIN_FAIL >= 10) ? 'HIGH' : (byKind.IP_BLOCKED || byKind.PROBE || byKind.ADMIN_LOGIN_FAIL || byKind.BAD_TOKEN >= 5) ? 'MEDIUM' : 'LOW';
  return {
    hours,
    level,
    levelText: { HIGH: 'Something serious happened — read below', MEDIUM: 'Some attack attempts — blocked automatically', LOW: 'Quiet — nothing unusual' }[level],
    autoBlocking: await enabled(),
    counts: Object.entries(byKind).map(([kind, n]) => ({ kind, label: KINDS[kind]?.[0] || kind, count: n })).sort((a, b) => b.count - a.count),
    topAddresses: Object.values(byIp).sort((a, b) => b.events - a.events).slice(0, 10).map((x) => ({ ...x, kinds: Object.entries(x.kinds).map(([k, n]) => `${KINDS[k]?.[0] || k} ×${n}`).join(', ') })),
    activeBlocks: active.map((b) => ({ id: b.id, ip: b.ip, scope: b.scope, reason: b.reason, auto: b.auto, until: b.until, since: b.createdAt })),
    blocksInPeriod: recentBlocks.length,
    needsAttention: serious.map((k) => `${KINDS[k][0]}: ${byKind[k]}`),
    recent: rows.slice(0, 60).map((r) => ({ kind: r.kind, label: KINDS[r.kind]?.[0] || r.kind, ip: r.ip, path: r.path, detail: r.detail, count: r.count, at: r.createdAt })),
  };
}

async function cleanup() {
  await prisma.securityEvent.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 30 * DAY) } } }).catch(() => {});
  await prisma.ipBlock.deleteMany({ where: { until: { lt: new Date(Date.now() - 30 * DAY) } } }).catch(() => {});
}

function start() {
  if (process.env.DISABLE_SCHEDULER === '1') return;
  loadBlocks().catch(() => {});
  setInterval(() => { loadBlocks().catch(() => {}); }, 5 * MIN).unref?.();
  setInterval(() => { cleanup(); }, 12 * HOUR).unref?.();
}

function _reset() { recent.clear(); blocks.clear(); written.clear(); alerted.clear(); }

module.exports = { record, guard, blockIp, unblock, isBlocked, loadBlocks, summary, cleanup, start, KINDS, RULES, PROBE, _reset };
