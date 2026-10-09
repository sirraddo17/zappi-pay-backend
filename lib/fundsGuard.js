// Customer-funds guard — the rules promised to Monnify:
//  1. Customer money is ring-fenced: only profit (what we hold above what
//     customers are owed) is "safe to withdraw".
//  2. Money held must always cover what customers are owed. If it doesn't
//     (or balances can't be read), money stops leaving: bank transfers
//     pause and the owner is alerted. Transfers also need enough free
//     money in the Monnify wallet itself.
//  3. Sending money (to a bank or another user) needs BVN/NIN, and the
//     daily limit for the customer's verification level always applies.

const prisma = require('./prisma');
const { getSettings } = require('./vtpass');

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const naira = (n) => `₦${Math.round(Number(n || 0)).toLocaleString('en-NG')}`;
const CACHE_MS = 60 * 1000;
const ALERT_EVERY = 3 * 60 * 60 * 1000;

class GuardError extends Error {
  constructor(msg, status = 503, code = 'FUNDS_GUARD') { super(msg); this.status = status; this.code = code; }
}

let cache = null;
let lastAlert = { key: null, at: 0 };

async function alertOnce(key, title, message) {
  if (lastAlert.key === key && Date.now() - lastAlert.at < ALERT_EVERY) return;
  lastAlert = { key, at: Date.now() };
  await Promise.resolve(require('./adminAlert').alertAdmins(title, message, '/admin/money')).catch(() => {});
}

// What we hold vs what customers are owed, and how much is truly ours.
async function coverage({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const m = await require('./moneyCheck').moneyCheck();
  const pending = r2(m.owed.pendingTransfers);
  const monnifyFree = m.have.monnify === null ? null : r2(m.have.monnify - pending);
  const value = {
    at: m.at,
    status: m.status, // OK | SHORT | INCOMPLETE
    owed: m.owed.total,
    have: m.have.total,
    monnify: m.have.monnify,
    vtpass: m.have.vtpass,
    pendingTransfers: pending,
    monnifyFree,
    shortBy: m.status === 'SHORT' ? r2(-m.difference) : 0,
    // Rule 1: only what's above customer money, and only from Monnify.
    safeToWithdraw: m.status === 'OK' ? Math.max(0, r2(Math.min(m.difference, monnifyFree ?? 0))) : 0,
    errors: [m.have.vtpassError, m.have.monnifyError].filter(Boolean),
  };
  cache = { at: Date.now(), value };
  return value;
}

// Rule 2: may this much money leave through a bank transfer right now?
async function checkPayout(amount, settings, { reserved = false } = {}) {
  const s = settings || (await getSettings());
  if (s.fundsGuardEnabled === false) return null;
  const c = await coverage();
  if (c.status === 'INCOMPLETE') {
    await alertOnce('incomplete', 'Bank transfers paused: balances unreadable', `The app couldn't read your balances (${c.errors.join('; ') || 'unknown error'}), so bank transfers are paused to protect customer money. They resume by themselves when balances can be read.`);
    throw new GuardError('Bank transfers are paused for a short check. Please try again in a few minutes — your money is safe in your wallet.');
  }
  if (c.status === 'SHORT') {
    await alertOnce('short', `Bank transfers paused: ${naira(c.shortBy)} short`, `Money held (${naira(c.have)}) is less than customers are owed (${naira(c.owed)}). Bank transfers are paused until it's covered. Top up your Monnify wallet or check Money check.`);
    throw new GuardError('Bank transfers are paused for a short check. Please try again later — your money is safe in your wallet.');
  }
  // Already-reserved transfers are inside pendingTransfers, so free must not go below 0.
  if (c.monnifyFree !== null && c.monnifyFree < (reserved ? 0 : Number(amount))) {
    await alertOnce('liquidity', 'Monnify wallet too low for a transfer', `A customer tried to send ${naira(amount)} but only ${naira(c.monnifyFree)} is free in the Monnify wallet. Top it up so withdrawals don't fail.`);
    throw new GuardError('This transfer can’t be sent right now. Please try a smaller amount or try again later — your money is safe in your wallet.');
  }
  return null;
}

// Rule 3: BVN/NIN required to send money; daily limit by level always on.
async function checkSender(customer, amount, settings) {
  const s = settings || (await getSettings());
  if (s.fundsGuardEnabled === false) return null;
  if (!customer?.kycType) throw new GuardError('To send money, first verify your BVN or NIN on the Wallet page. It keeps your money safe.', 403, 'KYC_REQUIRED');
  const msg = await require('./limits').checkDailyLimit(customer, amount, { ...s, kycLimitsEnabled: true, dailyLimitVerified: s.dailyLimitVerified ?? 1000000, dailyLimitUnverified: s.dailyLimitUnverified ?? 50000 });
  if (msg) throw new GuardError(msg, 403, 'DAILY_LIMIT');
  return null;
}

async function status() {
  const s = await getSettings();
  const c = await coverage({ fresh: true });
  return { enabled: s.fundsGuardEnabled !== false, ...c, transfersPaused: s.fundsGuardEnabled !== false && (c.status !== 'OK') };
}

// Every 15 minutes: warn the owner early if money held falls short.
let timer = null;
function start() {
  if (timer) return;
  const run = async () => {
    try {
      const s = await getSettings();
      if (s.fundsGuardEnabled === false || !s.bankTransferEnabled) return;
      const c = await coverage({ fresh: true });
      if (c.status === 'SHORT') await alertOnce('short', `Customer money not fully covered: ${naira(c.shortBy)} short`, `Money held (${naira(c.have)}) is less than customers are owed (${naira(c.owed)}). Bank transfers are paused until it's covered.`);
    } catch (error) {
      console.error('fundsGuard check failed:', error.message);
    }
  };
  timer = setInterval(run, 15 * 60 * 1000);
  timer.unref?.();
}

module.exports = { GuardError, coverage, checkPayout, checkSender, status, start, _reset: () => { cache = null; lastAlert = { key: null, at: 0 }; } };
