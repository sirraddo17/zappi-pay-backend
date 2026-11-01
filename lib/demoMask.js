// Demo / screenshot mode for the admin app. When the admin app sends
// "X-Demo-Mode: 1", every admin API answer is masked before it leaves the
// server: customer names, phone numbers, emails, account numbers, BVN/NIN,
// IP addresses, keys and secrets. Sandbox (test-money) partner balances
// are hidden and labelled. The Server & Database and code screens are
// refused. Nothing in the database changes — it only changes what is shown.

const PERSON_KEYS = /^(fullName|customerName|accountName|recipientName|payerName|senderName|beneficiaryName|receiverName|firstName|lastName|ownerName|holderName|displayName|staffName|adminName|creatorName|agentName|referrerName|realName|nameOnAccount)$/i;
const PHONE_KEYS = /(phone|msisdn|mobile|whatsapp)/i;
const EMAIL_KEYS = /email/i;
const ACCOUNT_KEYS = /^(accountNumber|account|accountNo|virtualAccount|accountRef|bvn|nin|bvnLast4|ninLast4|idNumber|smartcard|meterNumber|billersCode|iuc|cardLast4|walletAccount)$/i;
const IP_KEYS = /^(ip|ipAddress|lastIp|clientIp|address|sourceIp)$/i;
const SECRET_KEYS = /(secret|apikey|api_key|password|privatekey|webhookkey|signature|clientsecret|contractcode|merchantid|passhash|pinhash|authorization|bearer|accesstoken|refreshtoken|^token$|apiToken)/i;
const PHONE_IN_TEXT = /\b(?:\+?234|0)[789][01]\d{8}\b/g;
const EMAIL_IN_TEXT = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9])[A-Za-z0-9.-]*\.([A-Za-z]{2,})\b/g;
const IP_IN_TEXT = /\b(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}\b/g;
const HIDDEN = /^\/api\/admin\/(database|code)(\/|$)/;

const isOn = (req) => String(req.headers['x-demo-mode'] || '') === '1';

function maskName(v) {
  const s = String(v || '').trim();
  if (!s) return s;
  return s.split(/\s+/).map((w) => `${w[0].toUpperCase()}${'•'.repeat(Math.min(4, Math.max(2, w.length - 1)))}`).join(' ');
}
function maskDigits(v, keep = 3) {
  const s = String(v ?? '');
  const d = s.replace(/\D/g, '');
  if (d.length <= keep) return '•'.repeat(d.length || 3);
  return `${'•'.repeat(Math.min(8, d.length - keep))}${d.slice(-keep)}`;
}
const maskPhone = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length >= 7 ? `${d.slice(0, 4)}•••••${d.slice(-2)}` : maskDigits(v, 2); };
const maskEmail = (v) => String(v || '').replace(EMAIL_IN_TEXT, (_, a, b, c) => `${a}•••@${b}•••.${c}`);
const maskText = (v) => String(v).replace(PHONE_IN_TEXT, (m) => maskPhone(m)).replace(EMAIL_IN_TEXT, (_, a, b, c) => `${a}•••@${b}•••.${c}`).replace(IP_IN_TEXT, (_, a) => `${a}.•••.•••.•••`);

// A row about a person (customer, staff, recipient…): its plain "name" is
// masked too. Rows like partners, services or plans keep their names.
const personish = (o, parentKey) => ['phone', 'email', 'username', 'walletBalance', 'customerId', 'kycType', 'passwordHash', 'role'].some((k) => k in o) || /^(customer|sender|receiver|recipient|referrer|agent|staff|admin|creator|member|owner|payer|beneficiary|actor|from|to|user)s?$/i.test(String(parentKey || ''));

function mask(value, parentKey, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => mask(v, parentKey, depth + 1));
  if (value instanceof Date) return value;
  if (typeof value === 'string') return maskText(value);
  if (typeof value !== 'object') return value;
  if (typeof value.toFixed === 'function' && typeof value.toJSON === 'function') return value; // Prisma Decimal
  const out = {};
  const person = personish(value, parentKey);
  // A partner on sandbox keys (test money): its balances are hidden.
  const sandbox = /^sandbox$/i.test(String(value.mode || ''));
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' || typeof v === 'number') {
      if (SECRET_KEYS.test(k) && typeof v === 'string' && v) { out[k] = '••••••'; continue; }
      if (PERSON_KEYS.test(k) || (k === 'name' && person) || (k === 'username' && person)) { out[k] = maskName(v); continue; }
      if (PHONE_KEYS.test(k)) { out[k] = maskPhone(v); continue; }
      if (EMAIL_KEYS.test(k) && typeof v === 'string') { out[k] = maskEmail(v); continue; }
      if (ACCOUNT_KEYS.test(k)) { out[k] = maskDigits(v, 3); continue; }
      if (IP_KEYS.test(k) && typeof v === 'string' && /\d+\.\d+\.\d+\.\d+|:/.test(v)) { out[k] = maskText(v).replace(/[0-9a-f]{1,4}(:[0-9a-f]{0,4}){2,}/gi, '••••:••••'); continue; }
      if (k === 'recipient' && /^\+?\d{7,}$/.test(String(v).trim())) { out[k] = /^(\+?234|0)[789]/.test(String(v)) ? maskPhone(v) : maskDigits(v, 3); continue; }
    }
    if (sandbox && /balance$/i.test(k) && (typeof v === 'number' || (typeof v === 'string' && /^[\d.]+$/.test(v)))) { out[k] = null; continue; }
    out[k] = mask(v, k, depth + 1);
  }
  return out;
}

// Money check: sandbox partner balances hidden and labelled.
function maskMoney(body) {
  if (!body || !body.have || !body.owed) return body;
  const have = { ...body.have };
  for (const k of Object.keys(have.sandbox || {})) {
    have[k] = null;
    have[`${k}Error`] = 'SANDBOX (test money) — hidden in demo mode';
  }
  have.sandbox = {};
  return { ...body, have, demo: true };
}

function middleware(req, res, next) {
  if (!isOn(req) || !req.path.startsWith('/api/admin') && !req.originalUrl.startsWith('/api/admin')) return next();
  if (HIDDEN.test(req.originalUrl.split('?')[0])) return res.status(403).json({ error: 'Hidden in demo mode.', code: 'DEMO_MODE' });
  const json = res.json.bind(res);
  res.json = (body) => {
    try {
      return json(mask(maskMoney(JSON.parse(JSON.stringify(body ?? null)))));
    } catch {
      return json({ error: 'Hidden in demo mode.', code: 'DEMO_MODE' });
    }
  };
  return next();
}

module.exports = { middleware, mask, maskName, maskPhone, maskDigits, maskText, isOn };
