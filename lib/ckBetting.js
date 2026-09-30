// Bet funding through ClubKonnect (used when Settings → ClubKonnect →
// "Bet funding supplier" is ClubKonnect). Providers appear to the app
// as serviceID "ck:<CODE>" (e.g. ck:BET9JA) so the normal Buy page,
// verify, purchase, requery and receipts all work unchanged; only the
// supplier call differs.

const ck = require('./clubkonnect');
const { getSettings } = require('./vtpass');

const PREFIX = 'ck:';
const isCk = (serviceID) => String(serviceID || '').startsWith(PREFIX);
const codeOf = (serviceID) => String(serviceID).slice(PREFIX.length).toUpperCase();
const validCode = (code) => /^[A-Z0-9_-]{2,30}$/.test(code);

// VTpass IDs the Buy page used before (when VTpass is the supplier).
const VTPASS_BET_IDS = ['bet9ja', 'betking', 'sportybet', 'bangbet', '1xbet', 'nairabet', 'merrybet'];

async function useCk(settings) {
  const s = settings || (await getSettings());
  return s.bettingSupplier === 'CLUBKONNECT' && Boolean(await ck.creds(s));
}

// Nice names for common codes (the list from ClubKonnect may only give codes).
const NAMES = { BET9JA: 'Bet9ja', SPORTYBET: 'SportyBet', BETKING: 'BetKing', NAIRABET: 'NairaBet', MERRYBET: 'MerryBet', '1XBET': '1xBet', BANGBET: 'BangBet', BETWAY: 'Betway', MSPORT: 'MSport', BETLAND: 'Betland', LIVESCOREBET: 'LiveScore Bet', BETLION: 'BetLion', SUPABET: 'SupaBet', NAIJABET: 'NaijaBet', CLOUDBET: 'CloudBet', PARIPESA: 'PariPesa', BETBONANZA: 'BetBonanza', WAZOBET: 'WazoBet', '22BET': '22Bet', MELBET: 'MelBet' };
const prettyName = (code) => NAMES[code] || code.charAt(0) + code.slice(1).toLowerCase();

// ClubKonnect's list format isn't documented, so this accepts every
// shape their other V2 lists use: arrays of {PRODUCT_CODE|ID|…},
// wrappers {ID, PRODUCT:[…]}, and objects keyed by company code.
const STRUCTURAL = new Set(['BETTING_COMPANY', 'BETTING_COMPANIES', 'BETTING', 'BETTINGCOMPANY', 'PRODUCT', 'PRODUCTS', 'DATA', 'CONTENT', 'RESULT', 'STATUS', 'MOBILE_NETWORK', 'COMPANY', 'COMPANIES', 'LIST']);
const FIELD_KEYS = new Set(['ID', 'CODE', 'NAME', 'MIN', 'MAX', 'PRODUCT_CODE', 'PRODUCT_ID', 'PRODUCT_NAME', 'PRODUCT_SNO', 'PRODUCT_AMOUNT', 'MINIMUN_AMOUNT', 'MINIMUM_AMOUNT', 'MAXIMUM_AMOUNT', 'BETTINGCOMPANY', 'STATUSCODE', 'ORDERID', 'DATE']);
function looksLikeCompany(code) {
  const c = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
  return validCode(c) && /[A-Z]/.test(c) && !STRUCTURAL.has(c) && !FIELD_KEYS.has(c) ? c : null;
}
function parseCompanies(data) {
  const out = new Map();
  const add = (code, node = {}) => {
    const c = looksLikeCompany(code);
    if (!c) return;
    const min = Number(node.MINIMUN_AMOUNT || node.MINIMUM_AMOUNT || node.min || 0) || null;
    const max = Number(node.MAXIMUM_AMOUNT || node.max || 0) || null;
    const nm = node.PRODUCT_NAME || node.NAME || node.name;
    const prev = out.get(c) || {};
    out.set(c, { code: c, name: typeof nm === 'string' && nm.toUpperCase().replace(/\s+/g, '') !== c ? nm : prev.name || prettyName(c), min: min || prev.min || null, max: max || prev.max || null });
  };
  const walk = (node, key) => {
    if (Array.isArray(node)) {
      if (node.every((x) => typeof x === 'string')) node.forEach((x) => add(x));
      else node.forEach((x) => walk(x, key));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const own = node.PRODUCT_CODE || node.BettingCompany || node.BETTING_COMPANY || node.CODE || node.code || node.ID || node.id || node.PRODUCT_ID;
    if (typeof own === 'string' && looksLikeCompany(own)) add(own, node);
    else if (key && looksLikeCompany(key) && !Array.isArray(node.PRODUCT)) add(key, node);
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object') {
        if (looksLikeCompany(k) && Array.isArray(v) && v.every((x) => x && typeof x === 'object' && !looksLikeCompany(x.PRODUCT_CODE || x.ID || ''))) add(k, v[0] || {});
        walk(v, k);
      }
    }
  };
  walk(data);
  return [...out.values()];
}

// Used only if ClubKonnect's list can't be read. The account ID check
// runs before any money moves, so a wrong code can't cost anyone.
const FALLBACK = ['BET9JA', 'SPORTYBET', 'BETKING', 'NAIRABET', 'MERRYBET', '1XBET', 'BANGBET', 'BETWAY', 'MSPORT', 'BETLAND', 'LIVESCOREBET', 'NAIJABET', 'SUPABET', 'CLOUDBET', 'BETLION', 'PARIPESA', 'BETBONANZA'];

let cache = { at: 0, list: null };
let lastRaw = { at: null, sample: null, count: 0, source: null, error: null };
async function companies(settings) {
  if (cache.list && Date.now() - cache.at < 6 * 3600 * 1000) return cache.list;
  let list = [];
  try {
    const raw = await ck._call('APIBettingTypeV2.asp', {}, settings, 20000);
    list = parseCompanies(raw);
    lastRaw = { at: new Date(), sample: JSON.stringify(raw).slice(0, 1500), count: list.length, source: list.length ? 'clubkonnect' : 'fallback', error: null };
  } catch (e) {
    lastRaw = { at: new Date(), sample: null, count: 0, source: 'fallback', error: e.message };
  }
  if (!list.length) {
    list = FALLBACK.map((c) => ({ code: c, name: prettyName(c), min: 100, max: null }));
    cache = { at: Date.now() - 5.5 * 3600 * 1000, list }; // retry the real list in 30 min
    return list;
  }
  cache = { at: Date.now(), list };
  return list;
}
const listInfo = () => lastRaw;

// Same shape as VTpass /services so the Buy page needs no special code.
async function servicesForApp() {
  const list = await companies();
  return { content: list.map((x) => ({ serviceID: PREFIX + x.code, name: x.name, minimium_amount: x.min || 100, maximum_amount: x.max || null })) };
}

async function verify(serviceID, customerId) {
  const code = codeOf(serviceID);
  if (!validCode(code)) throw new ck.CkError('Unknown betting company.', 'BAD_CODE');
  const r = await callCk('APIVerifyBettingV1.asp', { BettingCompany: code, CustomerID: String(customerId).trim() });
  const name = r?.customer_name || r?.Customer_Name || r?.customername;
  const st = ck.statusOf(r);
  if (!name || /INVALID|ERROR|NOT_FOUND/i.test(String(name)) || /INVALID|MISSING/.test(st)) throw new ck.CkError('Could not find that betting account.', st || 'NOT_FOUND');
  return { content: { Customer_Name: String(name) } };
}

function callCk(path, params) {
  // Reuses clubkonnect.js's authenticated GET (keys never logged).
  return ck._call(path, params);
}

async function fund({ serviceID, customerId, amount, requestId }) {
  return callCk('APIBettingV1.asp', { BettingCompany: codeOf(serviceID), CustomerID: String(customerId).trim(), Amount: String(Math.round(amount)), RequestID: requestId });
}

// SUCCESS / FAILED / PENDING for a fund or query reply.
function classify(r) {
  const st = ck.statusOf(r);
  const code = Number(r?.statuscode);
  if (st === 'ORDER_COMPLETED' || (code >= 200 && code < 300)) return 'SUCCESS';
  if (['ORDER_ERROR', 'ORDER_CANCELLED', 'ORDER_REFUNDED'].includes(st)) return 'FAILED';
  if (/^(INVALID_|MISSING_|INSUFFICIENT_|MINIMUM_|MAXIMUM_)/.test(st)) return 'FAILED';
  if (Number.isFinite(code) && ((code >= 400 && code < 600) || code === 899)) return 'FAILED';
  return 'PENDING';
}

const query = (requestId) => ck.query(requestId);

module.exports = { listInfo, PREFIX, isCk, codeOf, useCk, VTPASS_BET_IDS, parseCompanies, companies, servicesForApp, verify, fund, classify, query, _reset: () => { cache = { at: 0, list: null }; } };
