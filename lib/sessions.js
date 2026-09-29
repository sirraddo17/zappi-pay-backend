const prisma = require('./prisma');

// Customer login sessions: every login gets a row, the token carries
// its id (sid), and a session that's been logged out stops working
// within a few seconds. Checks are cached for 30 seconds so this adds
// no noticeable delay.

function deviceLabel(ua = '') {
  const s = String(ua);
  const os = /iPhone|iPad/.test(s) ? (/iPad/.test(s) ? 'iPad' : 'iPhone')
    : /Android/.test(s) ? 'Android phone'
      : /Windows/.test(s) ? 'Windows computer'
        : /Macintosh|Mac OS X/.test(s) ? 'Mac'
          : /Linux/.test(s) ? 'Linux computer' : 'Unknown device';
  const browser = /OPR\/|Opera/.test(s) ? 'Opera'
    : /Edg\//.test(s) ? 'Edge'
      : /; wv\)/.test(s) ? 'ZappiPay app'
        : /CriOS|Chrome\//.test(s) ? 'Chrome'
          : /FxiOS|Firefox\//.test(s) ? 'Firefox'
            : /Safari\//.test(s) ? 'Safari' : 'browser';
  return `${os} · ${browser}`;
}

async function startSession(customer, req, method, deviceId = null) {
  if (deviceId) {
    await prisma.loginSession.updateMany({ where: { customerId: customer.id, deviceId, revokedAt: null }, data: { revokedAt: new Date() } });
    forgetCustomer(customer.id);
  }
  const session = await prisma.loginSession.create({
    data: { customerId: customer.id, label: deviceLabel(req.headers['user-agent']).slice(0, 80), method, deviceId },
  });
  // Keep the list short: drop logged-out/old rows beyond the latest 30.
  prisma.loginSession.findMany({ where: { customerId: customer.id }, orderBy: { lastSeenAt: 'desc' }, skip: 30, select: { id: true } })
    .then((old) => old.length && prisma.loginSession.deleteMany({ where: { id: { in: old.map((o) => o.id) } } }))
    .catch(() => {});
  return session.id;
}

const cache = new Map();
const TTL = 30 * 1000;

// true when the token may be used.
async function isValid(payload) {
  const key = `${payload.sub}:${payload.sid || '-'}`;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TTL) return hit.ok;
  let ok = true;
  const customer = await prisma.customer.findUnique({ where: { id: payload.sub }, select: { tokensValidAfter: true } });
  if (!customer) ok = false;
  // Older tokens without a session id are cut off by tokensValidAfter;
  // tokens with one are governed by their own session row.
  else if (!payload.sid && customer.tokensValidAfter && payload.iat * 1000 < new Date(customer.tokensValidAfter).getTime()) ok = false;
  if (ok && payload.sid) {
    const s = await prisma.loginSession.findUnique({ where: { id: payload.sid }, select: { revokedAt: true, customerId: true, lastSeenAt: true } });
    if (!s || s.revokedAt || s.customerId !== payload.sub) ok = false;
    // "Last active" is updated at most every 10 minutes.
    else if (now - new Date(s.lastSeenAt).getTime() > 10 * 60 * 1000) {
      prisma.loginSession.update({ where: { id: payload.sid }, data: { lastSeenAt: new Date() } }).catch(() => {});
    }
  }
  cache.set(key, { ok, at: now });
  if (cache.size > 5000) cache.clear();
  return ok;
}

function forgetCustomer(customerId) {
  for (const k of cache.keys()) if (k.startsWith(`${customerId}:`)) cache.delete(k);
}

async function list(customerId, currentSid) {
  const rows = await prisma.loginSession.findMany({ where: { customerId, revokedAt: null }, orderBy: { lastSeenAt: 'desc' }, take: 20 });
  return rows.map((r) => ({ id: r.id, label: r.label, method: r.method, createdAt: r.createdAt, lastSeenAt: r.lastSeenAt, current: r.id === currentSid }));
}

async function revoke(customerId, sid) {
  const r = await prisma.loginSession.updateMany({ where: { id: sid, customerId, revokedAt: null }, data: { revokedAt: new Date() } });
  forgetCustomer(customerId);
  return r.count;
}

// Logs out everywhere except the current session (and every older
// token from before sessions existed).
async function revokeOthers(customerId, keepSid) {
  const now = new Date();
  await prisma.$transaction([
    prisma.loginSession.updateMany({ where: { customerId, revokedAt: null, ...(keepSid ? { id: { not: keepSid } } : {}) }, data: { revokedAt: now } }),
    prisma.customer.update({ where: { id: customerId }, data: { tokensValidAfter: now } }),
  ]);
  forgetCustomer(customerId);
}

module.exports = { startSession, isValid, list, revoke, revokeOthers, forgetCustomer, deviceLabel };
