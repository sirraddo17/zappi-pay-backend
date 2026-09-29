const crypto = require('crypto');

// Scrambled fingerprints of where a request came from, used only to
// spot one person making many accounts (e.g. for referral contests).
// The real IP address is never stored — just a keyed hash of it.
const SECRET = process.env.KYC_HASH_SECRET || process.env.JWT_SECRET || 'zappipay';

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || '';
}

function ipHash(req) {
  const ip = clientIp(req);
  return ip ? crypto.createHmac('sha256', SECRET).update(`ip:${ip}`).digest('hex').slice(0, 32) : null;
}

// Same formula as the login "new device" check: phone model + browser.
function deviceHash(req) {
  return crypto.createHash('sha256').update(String(req.headers['user-agent'] || 'unknown')).digest('hex').slice(0, 32);
}

module.exports = { ipHash, deviceHash };
