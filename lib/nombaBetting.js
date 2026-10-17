// Bet funding through Nomba (used when Settings → ClubKonnect / bet
// funding → "Bet funding supplier" is Nomba). Same pattern as
// ckBetting.js: companies appear to the app as serviceID "nb:<id>"
// (e.g. nb:bet9ja) so the normal Buy page, verify, purchase, requery and
// receipts all work unchanged; only the supplier call differs.
// Money comes out of ZAPPI PAY's Nomba wallet (parent account).
// Money safety:
//  • merchantTxRef = our order's request ID, so a retry can't pay twice;
//  • an order is refunded only when Nomba says REFUND / CANCELLED /
//    PAYMENT_FAILED-final, refuses it outright (400/401/403/404 before
//    anything happened), or has no record of it at all after 30 minutes.

const nomba = require('./nomba');
const { getSettings } = require('./vtpass');

const PREFIX = 'nb:';
const isNb = (serviceID) => String(serviceID || '').startsWith(PREFIX);
const codeOf = (serviceID) => String(serviceID).slice(PREFIX.length).toLowerCase();
const validCode = (code) => /^[a-z0-9_-]{2,40}$/.test(code);

class NbBetError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

async function useNb(settings) {
  const s = settings || (await getSettings());
  return s.bettingSupplier === 'NOMBA' && (await nomba.isConfigured());
}

const NAMES = { bet9ja: 'Bet9ja', sportybet: 'SportyBet', betking: 'BetKing', nairabet: 'NairaBet', merrybet: 'MerryBet', '1xbet': '1xBet', bangbet: 'BangBet', betway: 'Betway', msport: 'MSport', '1960bet': '1960Bet', betland: 'Betland', livescorebet: 'LiveScore Bet', supabet: 'SupaBet', naijabet: 'NaijaBet', cloudbet: 'CloudBet', paripesa: 'PariPesa', betbonanza: 'BetBonanza', scratch2win: 'Scratch2Win' };
function prettyName(id, given) {
  if (NAMES[id]) return NAMES[id];
  const g = String(given || '').trim();
  if (g && g.toUpperCase() !== g) return g; // already mixed case, e.g. "1960Bet"
  return id.charAt(0).toUpperCase() + id.slice(1);
}

let cache = { at: 0, list: null };
let lastInfo = { at: null, count: 0, error: null };

async function companies() {
  if (cache.list && Date.now() - cache.at < 6 * 3600 * 1000) return cache.list;
  try {
    const r = await nomba.api('GET', '/v1/bill/betting/providers', null, { timeoutMs: 20000 });
    const list = (Array.isArray(r.data) ? r.data : [])
      .map((p) => ({ code: String(p.id || p.biller_id || '').toLowerCase(), name: p.name }))
      .filter((p) => validCode(p.code))
      .map((p) => ({ code: p.code, name: prettyName(p.code, p.name) }));
    lastInfo = { at: new Date(), count: list.length, error: list.length ? null : 'no companies in the reply' };
    if (list.length) cache = { at: Date.now(), list };
    return list.length ? list : cache.list || [];
  } catch (error) {
    lastInfo = { at: new Date(), count: 0, error: error.message };
    return cache.list || [];
  }
}
const listInfo = () => ({ ...lastInfo, supplier: 'NOMBA' });

// Same shape as VTpass /services so the Buy page needs no special code.
async function servicesForApp() {
  const list = await companies();
  return { content: list.map((x) => ({ serviceID: PREFIX + x.code, name: x.name, minimium_amount: 100, maximum_amount: null })) };
}

async function verify(serviceID, customerId) {
  const code = codeOf(serviceID);
  if (!validCode(code)) throw new NbBetError('Unknown betting company.', 'BAD_CODE');
  const id = String(customerId || '').trim();
  if (!/^[A-Za-z0-9_.@+-]{2,40}$/.test(id)) throw new NbBetError('Enter a valid betting account ID.', 'BAD_ID');
  let r;
  try {
    r = await nomba.api('GET', `/v1/bill/betting/lookup?${new URLSearchParams({ providerId: code, customerId: id })}`, null, { timeoutMs: 20000 });
  } catch (error) {
    if (error.status === 404 || error.status === 400) throw new NbBetError(`That ${prettyName(code)} account ID was not found. Check it and try again.`, 'NOT_FOUND');
    throw new NbBetError(`Could not check this ${prettyName(code)} account right now. Please try again.`, 'DOWN');
  }
  const name = typeof r.data === 'string' ? r.data : r.data?.name || r.data?.customerName;
  if (!name || !String(name).trim()) throw new NbBetError(`That ${prettyName(code)} account ID was not found. Check it and try again.`, 'NOT_FOUND');
  return { content: { Customer_Name: String(name).trim().slice(0, 80) } };
}

// Returns Nomba's reply ({ httpStatus, status, ... }) or a refusal
// marker. Network trouble returns null (unknown → stays pending).
async function fund({ serviceID, customerId, amount, requestId, phone, payerName }) {
  try {
    const r = await nomba.api('POST', '/v2/bill/betting', {
      bettingProvider: codeOf(serviceID),
      merchantTxRef: requestId,
      phoneNumber: String(phone || '').replace(/\D/g, '').replace(/^234/, '0').slice(0, 11),
      payerName: String(payerName || 'ZAPPI PAY customer').slice(0, 60),
      amount: Math.round(Number(amount)),
      customerId: String(customerId).trim(),
    }, { timeoutMs: 45000 });
    return { httpStatus: r.status, status: String(r.data?.status || '').toUpperCase(), id: r.data?.id || null, description: r.description };
  } catch (error) {
    if (error.status === 502 || !error.status) return null; // couldn't reach Nomba: unknown
    // 400/401/403/404/429: refused before any money moved.
    if ([400, 401, 403, 404, 429].includes(error.status)) return { httpStatus: error.status, status: 'REFUSED', description: error.message };
    return null; // 5xx: unknown, re-check later
  }
}

// SUCCESS / FAILED / PENDING
function classify(r) {
  if (!r) return 'PENDING';
  const st = String(r.status || '').toUpperCase();
  if (st === 'SUCCESS') return 'SUCCESS';
  if (['REFUSED', 'REFUND', 'CANCELLED'].includes(st)) return 'FAILED';
  return 'PENDING'; // PENDING_BILLING, PAYMENT_FAILED, REVERSED_BY_VENDOR (may be retried by Nomba)
}

// Nomba's record of the order, or { status: 'NOT_FOUND' }.
async function query(requestId) {
  try {
    const r = await nomba.api('GET', `/v1/transactions/accounts/single?${new URLSearchParams({ merchantTxRef: requestId })}`, null, { timeoutMs: 20000 });
    return { status: String(r.data?.status || '').toUpperCase(), id: r.data?.id || null };
  } catch (error) {
    if (error.status === 404) return { status: 'NOT_FOUND' };
    throw error;
  }
}

// Why a refused order failed, in customer words.
function failText(r) {
  const d = String(r?.description || '');
  if (/insufficient|balance/i.test(d)) return '';
  if (/customer|account|not found/i.test(d)) return ' That betting account ID was not found.';
  if (/minimum|amount/i.test(d)) return ' The amount was not accepted by the betting company.';
  return '';
}

module.exports = { PREFIX, isNb, codeOf, useNb, NbBetError, companies, servicesForApp, verify, fund, classify, query, failText, listInfo, _reset: () => { cache = { at: 0, list: null }; } };
