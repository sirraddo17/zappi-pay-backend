// Wallet-funding fee per payment partner. Monnify uses the main
// "bank funding fee" setting; Squad and Nomba can have their own (empty =
// same as Monnify). The fee is only described to customers as "paid to
// our payment partner" when it is no more than that partner's own charge.

const VAT = 0.075;
// Partner's own charge for a bank-transfer inflow (before VAT).
const PARTNER_COST = {
  monnify: { pct: 1.5, cap: 2000 },
  squad: { pct: 0.25, cap: 1000 },
  nomba: { pct: 1, cap: 200, min: 10, noVat: true }, // confirmed by Nomba: virtual-account inflow 1%, min ₦10, cap ₦200, no VAT
};

// What a partner charges us on one inflow of this size (incl. VAT).
function partnerCost(provider, amount) {
  const c = PARTNER_COST[provider] || PARTNER_COST.monnify;
  let fee = (Number(amount) * c.pct) / 100;
  if (c.min) fee = Math.max(fee, c.min);
  if (c.cap) fee = Math.min(fee, c.cap);
  return Math.round(fee * (c.noVat ? 1 : 1 + VAT) * 100) / 100;
}
const PROVIDERS = ['monnify', 'squad', 'nomba'];

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

function feeFor(provider, s) {
  const base = { pct: Number(s.bankFundingFeePercent || 0), cap: Number(s.bankFundingFeeCap || 0) };
  if (provider === 'squad' || provider === 'nomba') {
    const pct = num(s[`${provider}FundingFeePercent`]);
    const cap = num(s[`${provider}FundingFeeCap`]);
    return { pct: pct === null ? base.pct : pct, cap: cap === null ? base.cap : cap, own: pct !== null || cap !== null };
  }
  return { ...base, own: true };
}

function computeFee(amount, s, provider = 'monnify') {
  const { pct, cap } = feeFor(provider, s);
  let fee = Math.round(Number(amount) * pct) / 100;
  if (cap > 0) fee = Math.min(fee, cap);
  return Math.max(0, Math.min(fee, Number(amount)));
}

function isPassThrough(provider, s) {
  const cost = PARTNER_COST[provider];
  const { pct, cap } = feeFor(provider, s);
  if (!cost || !(pct > 0)) return false;
  const v = cost.noVat ? 1 : 1 + VAT;
  return pct <= cost.pct * v + 0.02 && cap > 0 && cap <= cost.cap * v + 1;
}

// What the customer app needs, per partner.
function publicFees(s) {
  return Object.fromEntries(PROVIDERS.map((p) => {
    const f = feeFor(p, s);
    return [p, { feePercent: f.pct, feeCap: f.cap, feeIsPassThrough: isPassThrough(p, s) }];
  }));
}

// Admin save helper: '' / null = "same as Monnify".
function parseFee(b) {
  const out = {};
  for (const [k, max, label] of [['fundingFeePercent', 10, 'percent'], ['fundingFeeCap', 100000, 'cap']]) {
    if (b[k] === undefined) continue;
    if (b[k] === null || b[k] === '') { out[k] = null; continue; }
    const n = Number(b[k]);
    if (!Number.isFinite(n) || n < 0 || n > max) throw Object.assign(new Error(`The funding fee ${label} must be between 0 and ${max}.`), { status: 400 });
    out[k] = n;
  }
  return out;
}

module.exports = { PARTNER_COST, partnerCost, feeFor, computeFee, isPassThrough, publicFees, parseFee };
