// Switches for the newer features, and small helpers they share.
// Every feature starts OFF. Ones that need care (licence, money held for
// others) show a warning the owner must accept before switching on.

const crypto = require('crypto');
const prisma = require('./prisma');
const { getSettings, invalidateSettings } = require('./vtpass');

const FEATURES = [
  { key: 'spray', setting: 'sprayEnabled', name: 'Owambe Spray', emoji: '💃', link: '/spray', risk: 'low',
    about: 'Guests at a party scan a QR and “spray” money from their wallet to the celebrant, with a live screen and leaderboard.' },
  { key: 'dues', setting: 'duesEnabled', name: 'Association Dues', emoji: '🏘️', link: '/dues', risk: 'low',
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

async function flags(customerId) {
  const s = await getSettings();
  return Object.fromEntries(FEATURES.map((f) => [f.key, isOnFor(s, f.key, customerId)]));
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

module.exports = { FEATURES, FeatureError, byKey, requireOn, flags, isOnFor, anyOn, adminStatus, setFeature, testers, addTester, removeTester, newCode, r2, naira, move, credit, checkSpend };
