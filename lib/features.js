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

async function requireOn(key) {
  const f = byKey(key);
  const s = await getSettings();
  if (!s[f.setting]) throw new FeatureError(`${f.name} isn’t available yet.`, 503, 'OFF');
  return s;
}

async function flags() {
  const s = await getSettings();
  return Object.fromEntries(FEATURES.map((f) => [f.key, Boolean(s[f.setting])]));
}

async function adminStatus() {
  const s = await getSettings();
  return FEATURES.map((f) => ({ key: f.key, name: f.name, emoji: f.emoji, about: f.about, risk: f.risk, warning: f.warning || null, on: Boolean(s[f.setting]) }));
}

async function setFeature(key, on, { acknowledged } = {}) {
  const f = byKey(key);
  if (!f) throw new FeatureError('Unknown feature.');
  if (on && f.warning && !acknowledged) throw new FeatureError('Read and accept the warning first.', 400, 'WARNING');
  const s = await getSettings();
  await prisma.settings.update({ where: { id: s.id }, data: { [f.setting]: Boolean(on) } });
  invalidateSettings();
  return adminStatus();
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

module.exports = { FEATURES, FeatureError, byKey, requireOn, flags, adminStatus, setFeature, newCode, r2, naira, move, credit, checkSpend };
