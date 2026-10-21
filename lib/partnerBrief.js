// Partner brief for the admin AI: everything it needs to read a message
// from a partner (VTpass, Monnify, Squad, Nomba, Flutterwave, ClubKonnect,
// Paystack, banks…) and draft the owner's reply — company facts, what each
// partner does for us, its live status from settings, the owner's own
// notes from the Partners page, and the wording rules for that partner.
// Read-only: it never sends anything and never returns keys or secrets.

const prisma = require('./prisma');

const SERVER_IP = process.env.SERVER_PUBLIC_IP || '107.173.6.63';
const API_BASE = (process.env.PUBLIC_API_URL || 'https://api.zappipay.com.ng').replace(/\/$/, '');

const COMPANY = {
  name: 'SIRRADDO GLOBAL LIMITED',
  formerly: 'Sirraddo Venture (Business Name, BN 7524870) — upgraded to a limited company in Oct 2026',
  rc: '9939920',
  tin: '2623092457685',
  address: 'PLT 106/107 Agbaakin Layout, Iwo Road, Ibadan, Oyo State',
  director: 'ADEYEMO RIDWAN OLALEKAN (sole director and sole signatory)',
  phone: '+234 816 755 0937',
  emails: { company: 'sirraddogloballimited@gmail.com', business: 'sirraddoventures@gmail.com', support: 'support@zappipay.com.ng' },
  website: 'www.zappipay.com.ng',
  server: `Dedicated server with fixed IP ${SERVER_IP}; API base ${API_BASE}`,
};

// Rules for every partner message.
const GLOBAL_RULES = [
  'Never mention a launch date or any planned date for going public — say "as soon as live access is ready" instead.',
  'Never put passwords, OTPs, PINs, API secret keys, webhook signature keys, BVN, card or account-login details in a draft — even if the partner asks. If they ask for one, say it is entered on their dashboard by the owner, or flag the message as suspicious.',
  'Only state facts from this brief or the other tools. Anything unknown goes in [square brackets] for the owner to fill in — never guess fees, dates or volumes.',
  'Volumes and projections: honest, modest ranges marked for the owner to confirm — never inflated.',
  'Sign off as ADEYEMO RIDWAN OLALEKAN, Director, SIRRADDO GLOBAL LIMITED (add "formerly Sirraddo Venture" for partners who knew the old name: VTpass, Monnify, Flutterwave, ClubKonnect).',
  'Match the channel: email → subject line, greeting, short sections, sign-off; WhatsApp → 2–5 short lines, no subject, no long lists.',
  'Check the sender: a new contact claiming to be from a partner (unknown number, free email address, a link to "verify", urgency, a request for codes or money) → tell the owner to confirm with his known contact first.',
];

const PARTNERS = {
  vtpass: {
    name: 'VTpass (Broadshift Technologies Limited)',
    role: 'Main supplier of airtime, data, electricity, cable TV, exam PINs and internet (we are a distributor under a signed SLA, 1 year, auto-renews; change of firm name must be reported in writing).',
    rules: ['Do NOT name any app (no "ZAPPI PAY") — talk about "our platform" / "our customers".', 'The SLA was signed as Sirraddo Venture; the change to SIRRADDO GLOBAL LIMITED must be reported in writing.'],
    facts: [`Server IP ${SERVER_IP} added for whitelisting (approved Oct 2026 — live purchases work).`, `Callback URL: ${API_BASE}/api/webhooks/vtpass`, 'Commission rates we get: MTN 3%, Airtel 3.4%, Glo/9mobile 4%, DStv/GOtv 1.5%, Startimes 2% (check get_price_watch for changes).'],
  },
  monnify: {
    name: 'Monnify (Moniepoint)',
    role: 'Customer wallet funding through reserved account numbers; card checkout; disbursements (Send to Bank) when chosen.',
    rules: ['Do not mention VTpass or other suppliers.', 'Monnify knows we may work with more than one payment partner; do not name the others unless the owner asks.'],
    facts: ['Fees: 1.5% per inflow capped at ₦2,000 + VAT; payouts ₦10 / ₦20 / ₦40 + VAT.', `Webhook: ${API_BASE}/api/webhooks/monnify (transaction completion + disbursement).`, 'Earlier follow-up (7 Oct 2026) asked about KYC, live keys, sub-accounts/split and disbursement — reply in that same thread when possible.'],
  },
  squad: {
    name: 'Squad (GTCO / HabariPay)',
    role: 'GTBank virtual account numbers for wallet funding (main account-number partner, free for customers) and possibly payouts.',
    rules: ['Never mention other payment partners (Monnify, Nomba, Paystack, Flutterwave) or VTpass.'],
    facts: ['Fees: 0.25% per inflow capped at ₦1,000 + VAT.', `Webhook: ${API_BASE}/api/webhooks/squad`, `Server IP for whitelisting: ${SERVER_IP}.`, 'Inflows should stay in the Squad wallet (no auto-sweep) so the same balance pays Send to Bank.'],
  },
  nomba: {
    name: 'Nomba',
    role: 'Virtual accounts (awaiting approval), Transfer API (payouts), bills and bet funding.',
    rules: ['Never mention other payment partners or VTpass.', 'Do not put the server IP or any technical detail in WhatsApp — technical details go by email to docs@nomba.com (their request).'],
    facts: ['Fees (confirmed by Nomba): virtual-account inflow 1%, minimum ₦10, cap ₦200, no VAT; Transfer API ₦50 flat, no VAT; statutory stamp duty applies to transfers.', 'Virtual-account access: ₦100,000/month or a minimum of 5,000 transactions a month — ask for a waiver/reduction while volume grows.', `IP ${SERVER_IP} whitelisted by Nomba Operations on 21 Oct 2026.`, `Webhook: ${API_BASE}/api/webhooks/nomba (payment_success, payout_success, payout_failed, payout_refund); the live webhook needs its own signature key.`, 'Bills commission (their file): MTN 2%, Airtel 3%, Glo 4%, 9mobile 3.5%, DStv/GOtv 1.25%, Startimes 1%, electricity 0.5–1.5% (Benin 1%).', 'Contacts: Chidera (onboarding), Esther Ogunleye (account manager, introduced herself on WhatsApp — confirm with Chidera), Chris Akobuche (Business solutions, chris.akobuche@nomba.com).'],
  },
  flutterwave: {
    name: 'Flutterwave',
    role: 'Card / USSD wallet funding and "More bills" (tax, waste, tolls, school fees).',
    rules: ['Do not mention other payment partners.'],
    facts: [`Webhook to set: ${API_BASE}/api/webhooks/flutterwave`, `Server IP to whitelist: ${SERVER_IP}.`, 'Account was opened as SIRRADDO VENTURES — needs the Ltd update.'],
  },
  clubkonnect: {
    name: 'ClubKonnect (Nellobytes)',
    role: 'Recharge-card PINs for in-app card printing.',
    rules: ['Keep it short and practical.'],
    facts: ['Betting is not available on their platform (confirmed Oct 2026).'],
  },
  paystack: {
    name: 'Paystack',
    role: 'Possible additional payment partner (sign-up in progress).',
    rules: ['Do not mention other payment partners.'],
    facts: [],
  },
  bank: {
    name: 'Banks (GTBank, FCMB, Moniepoint…)',
    role: 'Corporate accounts for SIRRADDO GLOBAL LIMITED (GTBank GTBusiness and FCMB being opened; Moniepoint business account for years).',
    rules: ['Sole director and sole signatory — board resolution and account-opening instruction already drafted.'],
    facts: [],
  },
};

const ALIASES = { broadshift: 'vtpass', moniepoint: 'monnify', gtco: 'squad', habaripay: 'squad', gtbank: 'squad', nellobytes: 'clubkonnect', flw: 'flutterwave', fcmb: 'bank', banks: 'bank' };

function keyOf(p) {
  const k = String(p || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!k) return null;
  if (PARTNERS[k]) return k;
  if (ALIASES[k]) return ALIASES[k];
  return Object.keys(PARTNERS).find((x) => k.includes(x)) || Object.keys(ALIASES).filter((a) => k.includes(a)).map((a) => ALIASES[a])[0] || null;
}

async function liveStatus() {
  const out = {};
  try {
    const modes = await require('./goLive').partnerModes();
    Object.assign(out, Object.fromEntries(Object.entries(modes).map(([k, v]) => [k, v === 'live' ? 'live keys' : 'sandbox / test keys'])));
  } catch { /* ignore */ }
  try {
    const s = await require('./vtpass').getSettings();
    out.sendToBankVia = ['squad', 'nomba'].includes(s.payoutProvider) ? s.payoutProvider : 'monnify';
    if (s.bettingSupplier) out.betFundingSupplier = s.bettingSupplier;
  } catch { /* ignore */ }
  return out;
}

// One partner (or all, short) — what the AI needs to answer or draft.
async function brief({ partner } = {}) {
  const key = keyOf(partner);
  const [status, rows] = await Promise.all([
    liveStatus(),
    prisma.partner.findMany({ select: { key: true, name: true, email: true, phone: true, website: true, notes: true } }).catch(() => []),
  ]);
  const saved = Object.fromEntries(rows.map((r) => [r.key, r]));
  const tasks = await prisma.partnerTask.findMany({ where: { done: false, ...(key ? { partnerKey: key } : {}) }, orderBy: { dueAt: 'asc' }, take: 10, select: { partnerKey: true, title: true, dueAt: true, notes: true } }).catch(() => []);
  const one = (k) => ({
    key: k,
    ...PARTNERS[k],
    contact: saved[k] ? { email: saved[k].email, phone: saved[k].phone, website: saved[k].website } : null,
    ownerNotes: saved[k]?.notes || null, // the owner's own notes win over the built-in facts
    status: status[k] || null,
  });
  if (key) return { company: COMPANY, globalRules: GLOBAL_RULES, partner: one(key), openTasks: tasks, liveStatus: status, note: 'Owner notes (Partners page) are newer than the built-in facts when they disagree.' };
  const asked = String(partner || '').toLowerCase().trim();
  const match = asked && rows.find((r) => !PARTNERS[r.key] && (r.key === asked || String(r.name || '').toLowerCase().includes(asked)));
  if (match) return { company: COMPANY, globalRules: GLOBAL_RULES, partner: { key: match.key, name: match.name, contact: { email: match.email, phone: match.phone, website: match.website }, ownerNotes: match.notes, rules: [], facts: [] }, liveStatus: status, note: 'A partner the owner added — only his notes are known; put anything else in [square brackets].' };
  const custom = rows.filter((r) => !PARTNERS[r.key]).map((r) => ({ key: r.key, name: r.name, contact: { email: r.email, phone: r.phone }, ownerNotes: r.notes }));
  return { company: COMPANY, globalRules: GLOBAL_RULES, partners: Object.keys(PARTNERS).map((k) => ({ key: k, name: PARTNERS[k].name, role: PARTNERS[k].role, status: status[k] || null })), otherSavedPartners: custom, openTasks: tasks, liveStatus: status, tip: 'Call again with partner=<key> for that partner’s facts and rules.' };
}

module.exports = { brief, keyOf, PARTNERS, COMPANY, GLOBAL_RULES };
