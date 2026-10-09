// Customer-funds guard — the rules promised to Monnify:
//  1. Customer money is ring-fenced: only what the Monnify wallet holds
//     above customer balances is "safe to withdraw".
//  2. The Monnify wallet ALONE must always hold at least everything
//     customers are owed (VTpass is funded by the owner and never counted).
//     If it doesn't (or Monnify can't be read), bank transfers pause and
//     the owner is alerted.
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
  // The Monnify wallet ALONE must cover every customer balance. VTpass is
  // funded by the owner, so it's never counted for customers; money in
  // Monnify above what customers are owed is the owner's (VTpass refunds
  // for purchases already made, plus profit).
  const owed = r2(m.owed.total);
  const pending = r2(m.owed.pendingTransfers);
  const monnify = m.have.monnify;
  const status = monnify === null ? 'INCOMPLETE' : monnify >= owed ? 'OK' : 'SHORT';
  const value = {
    at: m.at,
    status, // OK | SHORT | INCOMPLETE
    basis: 'MONNIFY_ONLY',
    owed,
    monnify,
    vtpass: m.have.vtpass, // shown for information only
    pendingTransfers: pending,
    monnifyFree: monnify === null ? null : r2(monnify - pending),
    shortBy: status === 'SHORT' ? r2(owed - monnify) : 0,
    // Rule 1: only what's above customer money is the owner's to move out.
    safeToWithdraw: status === 'OK' ? r2(monnify - owed) : 0,
    errors: [m.have.monnifyError].filter(Boolean),
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
    await alertOnce('incomplete', 'Bank transfers paused: Monnify balance unreadable', `The app couldn't read your Monnify wallet balance (${c.errors.join('; ') || 'unknown error'}), so bank transfers are paused to protect customer money. They resume by themselves when it can be read.`);
    throw new GuardError('Bank transfers are paused for a short check. Please try again in a few minutes — your money is safe in your wallet.');
  }
  if (c.status === 'SHORT') {
    await alertOnce('short', `Bank transfers paused: ${naira(c.shortBy)} short`, `Your Monnify wallet (${naira(c.monnify)}) holds less than customers are owed (${naira(c.owed)}). Bank transfers are paused until it's covered — put money back into the Monnify wallet.`);
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
      if (c.status === 'SHORT') await alertOnce('short', `Customer money not fully covered: ${naira(c.shortBy)} short`, `Your Monnify wallet (${naira(c.monnify)}) holds less than customers are owed (${naira(c.owed)}). Bank transfers are paused until it's covered.`);
    } catch (error) {
      console.error('fundsGuard check failed:', error.message);
    }
  };
  timer = setInterval(run, 15 * 60 * 1000);
  timer.unref?.();
}

module.exports = { GuardError, coverage, checkPayout, checkSender, status, start, _reset: () => { cache = null; lastAlert = { key: null, at: 0 }; } };
