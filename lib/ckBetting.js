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

// Pulls {code, min, max} out of whatever shape ClubKonnect's list uses.
function parseCompanies(data) {
  const out = new Map();
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const code = node.PRODUCT_CODE || node.PRODUCT_ID || node.BETTING_COMPANY || node.BettingCompany || node.code || node.ID || node.id;
    if (typeof code === 'string' && validCode(code.toUpperCase()) && !Array.isArray(node.PRODUCT)) {
      const c = code.toUpperCase();
      const min = Number(node.MINIMUN_AMOUNT || node.MINIMUM_AMOUNT || node.min || 0) || null;
      const max = Number(node.MAXIMUM_AMOUNT || node.max || 0) || null;
      const name = typeof (node.PRODUCT_NAME || node.name) === 'string' ? (node.PRODUCT_NAME || node.name) : null;
      out.set(c, { code: c, name: name && name.toUpperCase() !== c ? name : prettyName(c), min, max });
    }
    Object.values(node).forEach((v) => { if (v && typeof v === 'object') walk(v); });
  };
  walk(data);
  return [...out.values()];
}

let cache = { at: 0, list: null };
async function companies(settings) {
  if (cache.list && Date.now() - cache.at < 6 * 3600 * 1000) return cache.list;
  const list = parseCompanies(await ck._call('APIBettingTypeV2.asp', {}, settings, 20000));
  if (!list.length) throw new Error('ClubKonnect sent no betting companies.');
  cache = { at: Date.now(), list };
  return list;
}

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

module.exports = { PREFIX, isCk, codeOf, useCk, VTPASS_BET_IDS, parseCompanies, companies, servicesForApp, verify, fund, classify, query, _reset: () => { cache = { at: 0, list: null }; } };
