// Request limits and security headers for the whole API.
//
// Limits are kept in memory (one server). They are generous, because
// many Nigerian mobile users share one IP address through their
// network — the per-account login lock in auth.routes.js is what stops
// someone guessing one customer's password.

// Render adds the real address at the END of X-Forwarded-For; earlier
// entries can be typed in by the caller, so they're not trusted here.
function clientIp(req) {
  const parts = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return parts[parts.length - 1] || req.socket?.remoteAddress || 'unknown';
}

// Who is asking: the logged-in customer/admin if there's a token,
// otherwise the IP. The token isn't verified here (the route does
// that) — it's only used to group requests.
function whoKey(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) {
    try {
      const payload = JSON.parse(Buffer.from(h.slice(7).split('.')[1], 'base64url').toString());
      if (payload?.sub) return `u:${payload.sub}`;
    } catch { /* fall back to IP */ }
  }
  return `ip:${clientIp(req)}`;
}

const RULES = [
  // Logging in, signing up, password reset, admin login codes.
  { name: 'auth', test: (p) => /^\/api\/(auth\/(login|signup|forgot-password|reset-password|quick\/)|admin\/login)/.test(p), limit: 60, windowMs: 10 * 60 * 1000, key: (req) => `ip:${clientIp(req)}`, message: 'Too many attempts. Please wait a few minutes and try again.' },
  // Moving money.
  { name: 'money', test: (p, m) => m === 'POST' && /^\/api\/(vtpass\/purchase|wallet\/transfer|wallet\/bank-transfer|savings\/(deposit|withdraw)|vtpass\/bulk)/.test(p), limit: 20, windowMs: 60 * 1000, key: whoKey, message: 'You’re doing that too fast. Please wait a minute and try again.' },
  // Everything else.
  { name: 'all', test: () => true, limit: 1200, windowMs: 60 * 1000, key: (req) => `ip:${clientIp(req)}`, message: 'Too many requests. Please slow down.' },
];

const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
}, 60 * 1000).unref();

function hit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= now) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return { ok: b.count <= limit, retryAfter: Math.ceil((b.reset - now) / 1000) };
}

function rateLimit(req, res, next) {
  const path = req.originalUrl.split('?')[0];
  // Payment providers retry webhooks in bursts; never block them.
  if (path.startsWith('/api/webhooks/') || path === '/api/health' || req.method === 'OPTIONS') return next();
  for (const rule of RULES) {
    if (!rule.test(path, req.method)) continue;
    const r = hit(`${rule.name}:${rule.key(req)}`, rule.limit, rule.windowMs);
    if (!r.ok) {
      try { require('./attackWatch').record('RATE_LIMITED', req, { detail: rule.name }); } catch { /* ignore */ }
      res.set('Retry-After', String(r.retryAfter));
      return res.status(429).json({ error: rule.message, code: 'RATE_LIMITED' });
    }
    if (rule.name !== 'all') {
      // Specific rules also count towards the general limit.
      const g = hit(`all:ip:${clientIp(req)}`, RULES[RULES.length - 1].limit, RULES[RULES.length - 1].windowMs);
      if (!g.ok) return res.status(429).json({ error: RULES[RULES.length - 1].message, code: 'RATE_LIMITED' });
    }
    return next();
  }
  return next();
}

// Standard protections for an API that only returns JSON.
function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  res.removeHeader('X-Powered-By');
  next();
}

function resetLimits() {
  buckets.clear();
}

module.exports = { rateLimit, securityHeaders, resetLimits, clientIp };
