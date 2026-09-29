const jwt = require('jsonwebtoken');
const prisma = require('./prisma');

// Support staff (role SUPPORT) can only use the admin routes listed
// here — everything else (money, passwords, settings, reports) is
// refused and must go through an Escalation for an OWNER to approve.
// Deny by default: a new admin route is owner-only until added here.
const SUPPORT_ALLOWED = [
  ['GET', /^\/admin\/me$/],
  ['PATCH', /^\/admin\/password$/],
  ['GET', /^\/admin\/customers\/list$/],
  ['GET', /^\/admin\/customers\/[^/]+$/],
  ['POST', /^\/admin\/customers\/[^/]+\/verify-identity$/],
  ['POST', /^\/admin\/customers\/[^/]+\/check-funding$/],
  ['GET', /^\/admin\/support\/tickets$/],
  ['POST', /^\/admin\/support\/tickets\/[^/]+\/reply$/],
  ['PATCH', /^\/admin\/support\/tickets\/[^/]+\/resolve$/],
  ['GET', /^\/admin\/support\/attachments\/[^/]+$/],
  ['GET', /^\/admin\/ai\/status$/],
  ['POST', /^\/admin\/ai\/draft-reply$/],
  ['GET', /^\/admin\/orders$/],
  ['POST', /^\/admin\/orders\/[^/]+\/recheck$/],
  ['POST', /^\/admin\/orders\/[^/]+\/vtpass-escalate$/],
  ['GET', /^\/admin\/bank-transfers$/],
  ['POST', /^\/admin\/bank-transfers\/[^/]+\/check$/],
  ['GET', /^\/admin\/escalations$/],
  ['POST', /^\/admin\/escalations$/],
];

// Protective action allowed straight away: freezing an account that
// looks hacked. Unfreezing needs an owner.
function allowedWithBody(method, path, body) {
  return method === 'PATCH' && /^\/admin\/customers\/[^/]+$/.test(path) && body && body.active === false;
}

const cache = new Map();
async function roleOf(adminId) {
  const hit = cache.get(adminId);
  if (hit && Date.now() - hit.at < 30 * 1000) return hit.role;
  const a = await prisma.adminUser.findUnique({ where: { id: adminId }, select: { role: true, active: true } });
  const role = !a || !a.active ? 'INACTIVE' : a.role || 'OWNER';
  cache.set(adminId, { role, at: Date.now() });
  if (cache.size > 500) cache.clear();
  return role;
}
function forget(adminId) {
  cache.delete(adminId);
}

// Express middleware, mounted on /api before the routers.
async function staffGate(req, res, next) {
  const path = req.path;
  if (!path.startsWith('/admin/') || path === '/admin/login' || path === '/admin/login/verify') return next();
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(); // the route's own auth answers 401
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return next();
  }
  if (payload.kind !== 'admin') return next();
  try {
    const role = await roleOf(payload.sub);
    if (role === 'INACTIVE') return res.status(403).json({ error: 'This admin account has been deactivated.' });
    req.adminRole = role;
    if (role !== 'SUPPORT') return next();
    const ok = SUPPORT_ALLOWED.some(([m, re]) => m === req.method && re.test(path)) || allowedWithBody(req.method, path, req.body);
    if (ok) return next();
    return res.status(403).json({ error: 'Support staff can’t do this. Use “Request admin approval” instead.', code: 'NEEDS_OWNER' });
  } catch (error) {
    console.error('staffGate failed:', error.message);
    return res.status(500).json({ error: 'Could not check your access.' });
  }
}

module.exports = { staffGate, roleOf, forget, SUPPORT_ALLOWED };
