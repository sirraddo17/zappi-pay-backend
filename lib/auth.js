const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set — refusing to start without it.');
}

function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// Admin and customer are two distinct account types — not one User table
// with a role flag — so each gets its own token shape and its own auth
// middleware rather than a single requireRole() that has to know about
// both.
function signAdminToken(admin) {
  return jwt.sign({ sub: admin.id, kind: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
}

function signCustomerToken(customer, sid) {
  return jwt.sign({ sub: customer.id, kind: 'customer', ...(sid ? { sid } : {}) }, JWT_SECRET, { expiresIn: '30d' });
}

// Creates a login session (lib/sessions.js) and returns its token.
async function issueCustomerToken(customer, req, method, deviceId = null) {
  const sid = await require('./sessions').startSession(customer, req, method, deviceId);
  return signCustomerToken(customer, sid);
}

function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.kind !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
    req.admin = { adminId: payload.sub };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

function requireCustomerAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.kind !== 'customer') return res.status(403).json({ error: 'Customer access required.' });
    req.customer = { customerId: payload.sub, sessionId: payload.sid || null };
    require('./sessions').isValid(payload).then((ok) => {
      if (!ok) return res.status(401).json({ error: 'You were logged out. Please log in again.', code: 'SESSION_ENDED' });
      next();
    }).catch((error) => {
      console.error('session check failed:', error.message);
      res.status(500).json({ error: 'Could not check your login. Please try again.' });
    });
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

module.exports = {
  hashPassword,
  comparePassword,
  signAdminToken,
  signCustomerToken,
  issueCustomerToken,
  requireAdminAuth,
  requireCustomerAuth,
};
