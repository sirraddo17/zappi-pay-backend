// Customer-funds guard — the rules promised to Monnify:
//  1. Customer money is ring-fenced: only what is held above customer
//     balances is "safe to withdraw" (and only from a partner wallet).
//  2. The live partner wallets (Monnify, Squad, Nomba) PLUS the live VTpass
//     wallet must always hold at least everything customers are owed. The
//     owner tops up VTpass from Monnify with customer money, so VTpass counts.
//     If they don't (or a balance can't be read), bank transfers pause and
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
  // Customer money sits in the partner wallets (Monnify, and Squad/Nomba
  // when used) AND in the VTpass wallet, which the owner tops up from
  // Monnify. Together they must cover every customer balance. Only partner
  // wallets can pay out to a bank, so "safe to withdraw" never counts
  // VTpass money, and liquidity ("free") is checked on the payout partner.
  // Owner-marked test accounts hold sandbox money, so they aren't owed real
  // money (the Money check shows them apart). If that view isn't available,
  // everyone counts.
  const owed = r2(m.real ? m.real.owed : m.owed.total);
  const testOwed = m.real ? r2(m.real.testAccounts.total) : 0;
  const pending = r2(m.owed.pendingTransfers);
  const s = await getSettings();
  const payVia = ['squad', 'nomba'].includes(s.payoutProvider) ? s.payoutProvider : 'monnify';
  const viaSquad = payVia === 'squad';
  // Only LIVE partner wallets hold real money; sandbox balances are test
  // money and never count (they once made ₦10m of Nomba test money look safe
  // to withdraw).
  const live = (k) => (m.have.modes || {})[k] === 'live';
  const monnify = live('monnify') ? m.have.monnify : null;
  const squad = live('squad') ? m.have.squad ?? null : null;
  const nomba = live('nomba') ? m.have.nomba ?? null : null;
  const squadUsed = squad !== null || nomba !== null || payVia !== 'monnify';
  // VTpass counts only on LIVE keys and when its balance could be read.
  const vtLive = live('vtpass');
  const vtpass = vtLive ? m.have.vtpass ?? null : null;
  const byP = { monnify, squad, nomba };
  const partners = monnify === null || byP[payVia] === null ? null : r2(monnify + (squad || 0) + (nomba || 0));
  const held = partners === null || (vtLive && vtpass === null) ? null : r2(partners + (vtpass || 0));
  const status = held === null ? 'INCOMPLETE' : held >= owed ? 'OK' : 'SHORT';
  const payoutWallet = byP[payVia];
  const value = {
    at: m.at,
    status, // OK | SHORT | INCOMPLETE
    basis: 'PARTNERS_AND_VTPASS',
    owed,
    testAccountsNotCounted: testOwed,
    monnify,
    squad,
    nomba,
    held,
    partnerWallets: partners,
    payoutProvider: payVia,
    vtpass, // live VTpass balance, counted towards customer money
    vtpassCounted: vtLive,
    pendingTransfers: pending,
    monnifyFree: payoutWallet === null ? null : r2(payoutWallet - pending),
    // Free money in each partner's wallet (for the automatic backup).
    freeBy: { monnify: monnify === null ? null : r2(monnify - pending), squad: squad === null ? null : r2(squad - pending), nomba: nomba === null ? null : r2(nomba - pending) },
    shortBy: status === 'SHORT' ? r2(owed - held) : 0,
    // Rule 1: only what's above customer money is the owner's to move out,
    // and only partner-wallet money can go to a bank.
    safeToWithdraw: status === 'OK' ? r2(Math.max(0, Math.min(held - owed, partners - pending))) : 0,
    errors: [vtLive && vtpass === null ? (m.have.vtpassError || 'VTpass balance unreadable') : null, m.have.monnifyError, viaSquad ? m.have.squadError : null, payVia === 'nomba' ? m.have.nombaError : null].filter(Boolean),
  };
  cache = { at: Date.now(), value };
  return value;
}

// Rule 2: may this much money leave through a bank transfer right now?
// provider: check the free balance of this partner instead of the main one.
async function checkPayout(amount, settings, { reserved = false, provider } = {}) {
  const s = settings || (await getSettings());
  if (s.fundsGuardEnabled === false) return null;
  const c = await coverage();
  if (c.status === 'INCOMPLETE') {
    await alertOnce('incomplete', 'Bank transfers paused: partner balance unreadable', `The app couldn't read your ${c.payoutProvider === 'squad' ? 'Monnify/Squad' : c.payoutProvider === 'nomba' ? 'Monnify/Nomba' : 'Monnify'} or VTpass wallet balance (${c.errors.join('; ') || 'unknown error'}), so bank transfers are paused to protect customer money. They resume by themselves when it can be read.`);
    throw new GuardError('Bank transfers are paused for a short check. Please try again in a few minutes — your money is safe in your wallet.');
  }
  if (c.status === 'SHORT') {
    await alertOnce('short', `Bank transfers paused: ${naira(c.shortBy)} short`, `Your wallets (${naira(c.held)} = Monnify ${naira(c.monnify)}${(c.squad ?? null) !== null ? ` + Squad ${naira(c.squad)}` : ''}${(c.nomba ?? null) !== null ? ` + Nomba ${naira(c.nomba)}` : ''}${c.vtpassCounted ? ` + VTpass ${naira(c.vtpass)}` : ''}) hold less than customers are owed (${naira(c.owed)}). Bank transfers are paused until it's covered — fund the Monnify wallet or VTpass.`);
    throw new GuardError('Bank transfers are paused for a short check. Please try again later — your money is safe in your wallet.');
  }
  // Already-reserved transfers are inside pendingTransfers, so free must not go below 0.
  const which = provider || c.payoutProvider;
  const free = provider ? c.freeBy?.[provider] ?? null : c.monnifyFree;
  if (provider && free === null) throw new GuardError('This transfer can’t be sent right now. Please try again later — your money is safe in your wallet.', 503, 'PAYOUT_WALLET_LOW');
  if (free !== null && free < (reserved ? 0 : Number(amount))) {
    const w = { squad: 'Squad', nomba: 'Nomba' }[which] || 'Monnify';
    await alertOnce('liquidity', `${w} wallet too low for a transfer`, `A customer tried to send ${naira(amount)} but only ${naira(free)} is free in the ${w} wallet. Top it up so withdrawals don't fail.`);
    throw new GuardError('This transfer can’t be sent right now. Please try a smaller amount or try again later — your money is safe in your wallet.', 503, 'PAYOUT_WALLET_LOW');
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
      if (c.status === 'SHORT') await alertOnce('short', `Customer money not fully covered: ${naira(c.shortBy)} short`, `Monnify${c.vtpassCounted ? ' + VTpass' : ''} (${naira(c.held)}) hold less than customers are owed (${naira(c.owed)}). Bank transfers are paused until it's covered.`);
    } catch (error) {
      console.error('fundsGuard check failed:', error.message);
    }
  };
  timer = true;
  require('./quietClock').every('fundsGuard check', 15 * 60 * 1000, run);
}

module.exports = { GuardError, coverage, checkPayout, checkSender, status, start, _reset: () => { cache = null; lastAlert = { key: null, at: 0 }; } };
