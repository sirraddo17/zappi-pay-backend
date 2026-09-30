// ClubKonnect (Nellobytes Systems) API — used only for recharge card
// printing (airtime e-PINs). HTTPS GET, JSON replies. The URL carries
// the API key, so it is never logged.

const { getSettings } = require('./vtpass');

const BASE = 'https://www.nellobytesystems.com';

// ClubKonnect's own network codes.
const NETWORKS = {
  MTN: { code: '01', label: 'MTN', load: '*311*PIN#', color: '#FFCC00', ink: '#1a1a1a' },
  GLO: { code: '02', label: 'Glo', load: '*123*PIN#', color: '#1BA84A', ink: '#ffffff' },
  '9MOBILE': { code: '03', label: 'T2mobile (9mobile)', load: '*222*PIN#', color: '#006B3E', ink: '#ffffff' },
  AIRTEL: { code: '04', label: 'Airtel', load: '*126*PIN#', color: '#E40000', ink: '#ffffff' },
};
const VALUES = [100, 200, 500];
const MAX_PER_ORDER = 100;

class CkError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function creds(settings) {
  const s = settings || (await getSettings());
  const userId = String(s.ckUserId || process.env.CLUBKONNECT_USER_ID || '').trim();
  const apiKey = String(s.ckApiKey || process.env.CLUBKONNECT_API_KEY || '').trim();
  return userId && apiKey ? { userId, apiKey } : null;
}

async function call(path, params, settings, timeoutMs = 45000) {
  const c = await creds(settings);
  if (!c) throw new CkError('ClubKonnect is not set up yet.', 'NOT_SET_UP');
  const qs = new URLSearchParams({ UserID: c.userId, APIKey: c.apiKey, ...params });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let text;
  try {
    const res = await fetch(`${BASE}/${path}?${qs}`, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    text = await res.text();
  } catch (error) {
    // Network error / timeout: we don't know if the order went through.
    throw new CkError(error.name === 'AbortError' ? 'ClubKonnect took too long to answer.' : 'Could not reach ClubKonnect.', 'NO_RESPONSE');
  } finally {
    clearTimeout(t);
  }
  try {
    return JSON.parse(String(text).trim());
  } catch {
    throw new CkError('ClubKonnect sent an unreadable reply.', 'NO_RESPONSE');
  }
}

const buyEpins = ({ network, value, quantity, requestId, callbackUrl }, settings) => call('APIEPINV1.asp', {
  MobileNetwork: NETWORKS[network].code,
  Value: String(value),
  Quantity: String(quantity),
  RequestID: requestId,
  ...(callbackUrl ? { CallBackURL: callbackUrl } : {}),
}, settings);

const query = (requestId, settings) => call('APIQueryV1.asp', { RequestID: requestId }, settings, 30000);

async function balance(settings) {
  const r = await call('APIWalletBalanceV1.asp', {}, settings, 20000);
  if (r && r.balance !== undefined) return Number(String(r.balance).replace(/,/g, ''));
  throw new CkError(errorText(statusOf(r)) || 'Could not read the ClubKonnect balance.', statusOf(r) || 'UNKNOWN');
}

// --- Reading replies --------------------------------------------------

function statusOf(r) {
  return String(r?.status || r?.orderstatus || r?.Status || '').trim().toUpperCase();
}

// Cards in a reply (buy or query), whichever key they come under.
function cardsOf(r) {
  const list = r?.TXN_EPIN || r?.txn_epin || r?.TXN_EPIN_AIRTIME || [];
  return (Array.isArray(list) ? list : [])
    .map((c) => ({ pin: String(c.pin || c.PIN || '').replace(/\s/g, ''), serial: c.sno ? String(c.sno) : null, batchNo: c.batchno ? String(c.batchno) : null }))
    .filter((c) => /^\d{8,25}$/.test(c.pin));
}

// SUCCESS (cards in hand) / FAILED (definitely not charged) / PENDING.
function classify(r) {
  if (cardsOf(r).length) return 'SUCCESS';
  const st = statusOf(r);
  const code = Number(r?.statuscode);
  if (['ORDER_ERROR', 'ORDER_CANCELLED', 'ORDER_REFUNDED'].includes(st)) return 'FAILED';
  if (/^(INVALID_|MISSING_|INSUFFICIENT_|QUANTITY_|VALUE_|MOBILENETWORK_|NETWORK_)/.test(st)) return 'FAILED';
  if (Number.isFinite(code) && ((code >= 400 && code < 600) || code === 899)) return 'FAILED';
  return 'PENDING';
}

const MESSAGES = {
  INVALID_CREDENTIALS: 'ClubKonnect rejected the UserID / API key.',
  MISSING_CREDENTIALS: 'ClubKonnect UserID / API key missing.',
  INSUFFICIENT_WALLET_BALANCE: 'The ClubKonnect wallet does not have enough money.',
  QUANTITY_NOT_AVAILABLE: 'Not enough cards of that type are available right now.',
  VALUE_ALLOWED_100_200_500: 'Only ₦100, ₦200 and ₦500 cards are available.',
};
function errorText(st) {
  return MESSAGES[st] || (st ? st.replace(/_/g, ' ').toLowerCase() : '');
}

module.exports = { NETWORKS, VALUES, MAX_PER_ORDER, CkError, creds, buyEpins, query, balance, statusOf, cardsOf, classify, errorText };
