// Switches for the newer features, and small helpers they share.
// Every feature starts OFF. Ones that need care (licence, money held for
// others) show a warning the owner must accept before switching on.

const crypto = require('crypto');
const prisma = require('./prisma');
const { getSettings, invalidateSettings } = require('./vtpass');

const FEATURES = [
  { key: 'spray', setting: 'sprayEnabled', name: 'Owambe Spray', emoji: '💃', link: '/spray', risk: 'medium',
    warning: 'Switch on “Pay straight to their bank” first (and make sure Monnify has enabled sub-accounts). Then this is paid by card / transfer straight to the receiver’s bank. Without it, it moves wallet money between customers, which needs a licensed wallet partner.',
    about: 'Guests at a party scan a QR and “spray” money to the celebrant, with a live screen and leaderboard.' },
  { key: 'dues', setting: 'duesEnabled', name: 'Association Dues', emoji: '🏘️', link: '/dues', risk: 'medium',
    warning: 'Switch on “Pay straight to their bank” first (and make sure Monnify has enabled sub-accounts). Then this is paid by card / transfer straight to the receiver’s bank. Without it, it moves wallet money between customers, which needs a licensed wallet partner.',
    about: 'Estates, churches, mosques, alumni and staff clubs collect dues from members, with reminders, auto-pay and a paid/unpaid list for the treasurer.' },
  { key: 'payForMe', setting: 'payForMeEnabled', name: 'Pay It For Me', emoji: '🙏', link: '/pay-for-me', risk: 'low',
    about: 'Share a link so someone else pays your airtime, data, light or TV — it goes straight to your number, meter or decoder.' },
  { key: 'sharedLight', setting: 'sharedLightEnabled', name: 'Shared Light', emoji: '💡', link: '/shared-light', risk: 'medium',
    warning: 'Shared Light holds members’ contributions in a pot until it is full, then buys the token. Make sure your terms say ZAPPI PAY only holds the money to buy the token, and test it with a real meter first.',
    about: 'Flatmates or tenants on one prepaid meter each pay their share; when the pot is full the token is bought automatically and everyone sees it.' },
  { key: 'safeBuy', setting: 'safeBuyEnabled', name: 'SafeBuy (buyer protection)', emoji: '🛡️', link: '/safebuy', risk: 'high',
    warning: 'SafeBuy holds a buyer’s money until they confirm delivery — this is ESCROW. In Nigeria, holding and releasing funds for third parties may need a CBN licence or a licensed partner (for example a bank or licensed payment company holding the funds). Do NOT switch this on for real customers until a lawyer confirms you are allowed to, or you have a licensed escrow partner. You will also need a clear dispute policy and staff to handle disputes.',
    about: 'Instagram/WhatsApp vendors: the buyer pays, the money is held, and it goes to the seller when the buyer confirms delivery. Disputes go to ZAPPI PAY.' },
  { key: 'payroll', setting: 'payrollEnabled', name: 'Payroll', emoji: '👷', link: '/payroll', risk: 'medium',
    warning: 'Payroll sends many payments at once (including to banks through Monnify). Check your Send-to-Bank limits and Monnify wallet balance first. ZAPPI PAY only moves money on the business owner’s instruction — it does not calculate tax or pension.',
    about: 'Small businesses pay staff salaries to ZAPPI PAY wallets or bank accounts in one tap, and staff get a payslip notification.' },
  { key: 'dailyRewards', setting: 'dailyRewardsEnabled', name: 'Daily rewards', emoji: '🎯', link: '/rewards', risk: 'medium',
    warning: 'Daily rewards give away cashback from your profit. A daily budget caps the total, and only verified customers can earn, but watch for people opening many accounts. Keep amounts small.',
    about: 'Daily check-in streaks and a quick daily quiz that earn small cashback, so people open the app every day.' },
  { key: 'sendMoney', setting: 'p2pEnabled', name: 'Send money to users', emoji: '💸', link: '/transfer', risk: 'high',
    warning: 'Wallet-to-wallet transfers moves money between customers’ wallets. Holding and moving other people’s money is mobile-money (MMO) territory in Nigeria. Only switch this on for everyone once a lawyer confirms your setup is allowed, or the money is held in a licensed partner’s wallet (for example Monnify Wallets).',
    about: 'Customers send wallet money to other ZAPPI PAY users by username, phone or QR code. (Send to Bank has its own switch in Settings.)' },
  { key: 'requests', setting: 'payRequestsEnabled', name: 'Request money', emoji: '🧾', link: '/requests', risk: 'high',
    warning: 'Pay-me links, split bills and group gifts moves money between customers’ wallets. Holding and moving other people’s money is mobile-money (MMO) territory in Nigeria. Only switch this on for everyone once a lawyer confirms your setup is allowed, or the money is held in a licensed partner’s wallet (for example Monnify Wallets).',
    about: 'Pay-me links, split a bill between friends, and group gifts. With “Pay straight to their bank” on, they’re paid by card straight to the requester’s bank (no wallet-to-wallet).' },
  { key: 'family', setting: 'familyEnabled', name: 'Family wallet', emoji: '👨‍👩‍👧', link: '/family', risk: 'high',
    warning: 'Family wallet allowances moves money between customers’ wallets. Holding and moving other people’s money is mobile-money (MMO) territory in Nigeria. Only switch this on for everyone once a lawyer confirms your setup is allowed, or the money is held in a licensed partner’s wallet (for example Monnify Wallets).',
    about: 'Parents give family members wallet money with spending limits and automatic allowances.' },
  { key: 'bulkSms', setting: 'bulkSmsEnabled', name: 'Bulk SMS', emoji: '📩', link: '/sms', risk: 'medium',
    warning: 'Customers send SMS to their own contacts under sender names. Only approve sender names you have checked (never a bank, government agency or another company’s name) and register each one on your VTpass Messaging dashboard first. NCC rules ban spam and impersonation, and you are responsible for what goes out under your account. Add VTpass Messaging keys and buy SMS units before switching on.',
    about: 'Shops, schools, churches and event planners send SMS to their customers or members, paid from their wallet per SMS page.' },
  { key: 'tickets', setting: 'ticketsEnabled', name: 'Event tickets', emoji: '🎟️', link: '/tickets', risk: 'medium',
    warning: 'Buyers pay by card or bank transfer through Monnify and the ticket money is split straight to the organiser’s bank account (a Monnify sub-account) — ZAPPI PAY never holds it, and only keeps the booking fee. Ask Monnify support to enable sub-accounts on your account first. Watch for fake events: organisers must be verified, and you should check big events before they go on sale.',
    about: 'Organisers sell tickets for owambes, concerts, church programmes and seminars; buyers get QR tickets, organisers check people in at the door.' },
  { key: 'moreBills', setting: 'moreBillsEnabled', name: 'More bills (tax, schools, waste…)', emoji: '🧾', link: '/bills', risk: 'medium',
    warning: 'These bills are paid through Flutterwave Bills from your Flutterwave balance, which you must keep funded. Flutterwave’s prohibited list includes wallet companies, so get written approval from Flutterwave for ZAPPI PAY before switching this on for everyone.',
    about: 'Tax, waste (LAWMA), water, tolls, schools & professional bodies, religious institutions and other billers — paid from the wallet.' },
  { key: 'circles', setting: 'circlesEnabled', name: 'Ajo Circle', emoji: '🔄', link: '/circles', risk: 'high',
    warning: 'Ajo Circle collects members’ contributions into a pot and pays it out in turn, with automatic debits, fees and spending limits on defaulters. Holding group money may need a licensed partner (a cooperative, microfinance bank or BaaS provider). Have a Nigerian lawyer review the member agreement and your terms before switching it on for everyone.',
    about: 'Rotating contributions (ajo / esusu / adashe): members pay the same amount each period and one member receives the pot in turn. Limits and running circles: Admin → Ajo Circles.' },
  { key: 'betFunding', setting: 'betFundingEnabled', name: 'Bet Funding', emoji: '🏆', link: '/buy/betting', risk: 'medium',
    warning: 'Your current suppliers (VTpass and ClubKonnect) do NOT sell bet funding, so purchases would fail. Only switch this on after a betting supplier is connected and tested. Also ask Monnify in writing whether wallet money may be used for betting top-ups, and never market it to under-18s.',
    about: 'Customers fund their betting wallets (Bet9ja, SportyBet, BetKing…) from their ZAPPI PAY wallet. The account name is checked before paying.' },
  { key: 'cardCheckout', setting: 'cardCheckoutEnabled', name: 'Pay by card at checkout', emoji: '💳', link: '/buy/airtime', risk: 'low',
    about: 'When the wallet is short, customers pay the difference by card, bank transfer or USSD (Monnify) on the Buy screen. It goes into their wallet and the purchase runs straight away. Uses the card fee from Settings → Wallet funding.' },
  { key: 'directPay', setting: 'directPayEnabled', name: 'Pay straight to their bank', emoji: '🏦', link: '/payout', risk: 'medium',
    warning: 'Dues, Owambe Spray and Request money payments will be made by card / transfer / USSD through Monnify and split straight into the receiver’s own bank account (a Monnify sub-account) — ZAPPI PAY only keeps the small fee and never holds the money. Ask Monnify to enable sub-accounts / transaction splitting first, and confirm in writing that this use is fine. Receivers must be verified and add their bank account.',
    about: 'When on, Association Dues, Owambe Spray and Request money are paid by card / transfer straight to the receiver’s bank (no wallet-to-wallet). Switch those features on as well. Fee: Admin → SMS, Tickets & Bills.' },
];

class FeatureError extends Error {
  constructor(msg, status = 400, code) { super(msg); this.status = status; this.code = code; }
}

const byKey = (key) => FEATURES.find((f) => f.key === key);

// A feature is ON for a customer when it's on for everyone, or it's in
// "testers only" mode and they're on the testers list.
const testMode = (s) => (s.featureTestMode && typeof s.featureTestMode === 'object' ? s.featureTestMode : {});
const testerIds = (s) => (Array.isArray(s.featureTesters) ? s.featureTesters.map((t) => t.id) : []);
const modeOf = (s, f) => (s[f.setting] ? 'ON' : testMode(s)[f.key] ? 'TESTERS' : 'OFF');
function isOnFor(s, key, customerId) {
  const f = byKey(key);
  if (!f) return false;
  const m = modeOf(s, f);
  return m === 'ON' || (m === 'TESTERS' && Boolean(customerId) && testerIds(s).includes(customerId));
}
// True when anyone at all can use it (for background jobs).
async function anyOn(key) {
  const s = await getSettings();
  return modeOf(s, byKey(key)) !== 'OFF';
}

async function requireOn(key, customerId) {
  const f = byKey(key);
  const s = await getSettings();
  if (!isOnFor(s, key, customerId)) throw new FeatureError(`${f.name} isn’t available yet.`, 503, 'OFF');
  return s;
}

// Express middleware: blocks a route unless the feature is on for this customer.
const gate = (key) => async (req, res, next) => {
  try { await requireOn(key, req.customer?.customerId); next(); } catch (e) { res.status(e.status || 503).json({ error: e.message, code: e.code }); }
};

async function flags(customerId) {
  const s = await getSettings();
  return Object.fromEntries(FEATURES.map((f) => [f.key, isOnFor(s, f.key, customerId)]));
}

// Plain-language list of what customers can't use right now, for AI
// prompts (help chat, ad writer, video scripts, social plans) so they
// never offer or promote something that is switched off.
const OFF_NAMES = { directPay: 'paying straight into someone’s bank by card (Dues / Spray / Request money)', cardCheckout: 'paying by card at checkout (customers fund their wallet first instead)', circles: 'Ajo Circle (group contributions)', sendMoney: 'sending money to other ZAPPI PAY users (including QR pay and pay links)', requests: 'Request money (pay-me links, split a bill, group gifts)', family: 'Family wallet', payroll: 'Payroll', safeBuy: 'SafeBuy', sharedLight: 'Shared Light', spray: 'Owambe Spray', dues: 'Association Dues', payForMe: 'Pay It For Me', dailyRewards: 'Daily rewards', bulkSms: 'Bulk SMS', tickets: 'Event tickets', moreBills: 'More bills (tax, waste, school fees…)' };
function offList(s, customerId) {
  const off = FEATURES.filter((f) => !isOnFor(s, f.key, customerId)).map((f) => OFF_NAMES[f.key] || f.name);
  if (!s.bankTransferEnabled) off.push('sending money to bank accounts / withdrawing to a bank (Send to Bank)');
  if (!s.savingsEnabled) off.push('Savings with interest');
  return off;
}
function offNote(s, customerId) {
  const off = offList(s, customerId);
  return off.length ? `\nNOT AVAILABLE right now (never offer, explain how to use, or promote these; if asked, say it isn't available on ZAPPI PAY yet): ${off.join('; ')}.\n` : '';
}

async function adminStatus() {
  const s = await getSettings();
  return FEATURES.map((f) => ({ key: f.key, name: f.name, emoji: f.emoji, about: f.about, risk: f.risk, warning: f.warning || null, mode: modeOf(s, f), on: Boolean(s[f.setting]) }));
}

// mode: 'OFF' | 'TESTERS' | 'ON'. Going ON for everyone needs the warning
// accepted; testers-only doesn't (only your own test accounts can use it).
async function setFeature(key, mode, { acknowledged } = {}) {
  const f = byKey(key);
  if (!f) throw new FeatureError('Unknown feature.');
  if (!['OFF', 'TESTERS', 'ON'].includes(mode)) throw new FeatureError('Choose Off, Testers only or On.');
  if (mode === 'ON' && f.warning && !acknowledged) throw new FeatureError('Read and accept the warning first.', 400, 'WARNING');
  const s = await getSettings();
  const tm = { ...testMode(s) };
  if (mode === 'TESTERS') tm[key] = true; else delete tm[key];
  await prisma.settings.update({ where: { id: s.id }, data: { [f.setting]: mode === 'ON', featureTestMode: tm } });
  invalidateSettings();
  return adminStatus();
}

async function testers() {
  const s = await getSettings();
  return Array.isArray(s.featureTesters) ? s.featureTesters : [];
}

async function addTester(who) {
  const t = String(who || '').trim().replace(/^@/, '');
  if (!t) throw new FeatureError('Enter a username or phone number.');
  const c = await prisma.customer.findFirst({ where: { OR: [{ username: t.toLowerCase() }, { phone: t }, { email: t.toLowerCase() }] }, select: { id: true, name: true, username: true, phone: true } });
  if (!c) throw new FeatureError('No customer with that username, phone or email.');
  const s = await getSettings();
  const list = Array.isArray(s.featureTesters) ? s.featureTesters : [];
  if (list.some((x) => x.id === c.id)) return list;
  if (list.length >= 20) throw new FeatureError('You can have up to 20 testers.');
  const next = [...list, { id: c.id, name: c.name, username: c.username || null, phone: c.phone }];
  await prisma.settings.update({ where: { id: s.id }, data: { featureTesters: next } });
  invalidateSettings();
  return next;
}

async function removeTester(id) {
  const s = await getSettings();
  const next = (Array.isArray(s.featureTesters) ? s.featureTesters : []).filter((x) => x.id !== id);
  await prisma.settings.update({ where: { id: s.id }, data: { featureTesters: next } });
  invalidateSettings();
  return next;
}

const newCode = (n = 6) => crypto.randomBytes(n).toString('base64url');
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

// Moves money between two wallets in one transaction (the debit only
// happens if the balance still covers it). Returns false if short.
async function move({ fromId, toId, amount, outType, inType, outNote, inNote, extra }) {
  const amt = r2(amount);
  if (!(amt > 0)) throw new FeatureError('Enter an amount.');
  try {
    await prisma.$transaction(async (tx) => {
      const d = await tx.customer.updateMany({ where: { id: fromId, walletBalance: { gte: amt } }, data: { walletBalance: { decrement: amt } } });
      if (d.count !== 1) throw Object.assign(new Error('short'), { short: true });
      await tx.walletTransaction.create({ data: { customerId: fromId, type: outType, amount: amt, status: 'APPROVED', note: outNote } });
      if (toId) {
        await tx.customer.update({ where: { id: toId }, data: { walletBalance: { increment: amt } } });
        await tx.walletTransaction.create({ data: { customerId: toId, type: inType, amount: amt, status: 'APPROVED', note: inNote } });
      }
      if (extra) await extra(tx);
    });
  } catch (e) {
    if (e.short) return false;
    throw e;
  }
  if (toId) require('./circles').onDeposit(toId).catch(() => {});
  return true;
}

// Credits a wallet (money coming out of a held pot).
async function credit(tx, customerId, amount, type, note) {
  await tx.customer.update({ where: { id: customerId }, data: { walletBalance: { increment: amount } } });
  await tx.walletTransaction.create({ data: { customerId, type, amount, status: 'APPROVED', note } });
}

// Blocks spending for members who owe an Ajo Circle (see lib/circles.js).
async function checkSpend(customerId) {
  const lock = await require('./circles').owingLock(customerId);
  if (lock) throw new FeatureError(lock, 403, 'CIRCLE_OWING');
}

module.exports = { FEATURES, FeatureError, byKey, requireOn, gate, offList, offNote, flags, isOnFor, anyOn, adminStatus, setFeature, testers, addTester, removeTester, newCode, r2, naira, move, credit, checkSpend };
