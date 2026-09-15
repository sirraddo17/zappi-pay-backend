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

function signCustomerToken(customer) {
  return jwt.sign({ sub: customer.id, kind: 'customer' }, JWT_SECRET, { expiresIn: '30d' });
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
    req.customer = { customerId: payload.sub };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

module.exports = {
  hashPassword,
  comparePassword,
  signAdminToken,
  signCustomerToken,
  requireAdminAuth,
  requireCustomerAuth,
};
