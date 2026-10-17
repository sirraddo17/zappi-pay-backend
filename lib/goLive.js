// Admin → Go-live check: one page that shows, with a green / amber / red
// light, everything that must be right before (and after) real
// customers use the app — partner modes, keys, wallets, which account
// numbers customers have, feature switches and security — so a test
// setting can't quietly reach real customers again.
//
// Also: removing test (sandbox) account numbers from customers, so they
// get real ones once a partner goes live.

const prisma = require('./prisma');
const { getSettings } = require('./vtpass');

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const PARTNER_NAMES = { monnify: 'Monnify', squad: 'Squad (GTBank)', nomba: 'Nomba' };
const SETTINGS = (tab, sub) => `/admin/settings?tab=${tab}${sub ? `&sub=${sub}` : ''}`;

// Which partner an account-number entry came from (Monnify entries
// predate the "provider" field).
const providerOf = (a) => (a && a.provider) || 'monnify';

async function partnerModes() {
  const out = {};
  try { out.monnify = (await require('./monnify').getConfig()).mode; } catch { out.monnify = 'sandbox'; }
  try { out.squad = (await require('./squad').getConfig()).mode; } catch { out.squad = 'sandbox'; }
  try { out.nomba = (await require('./nomba').getConfig()).mode; } catch { out.nomba = 'sandbox'; }
  return out;
}

// A test number: stamped "sandbox" when it was made, or (older numbers
// with no stamp) made by a partner that is still in sandbox mode.
const isTest = (a, modes) => (a.mode ? a.mode !== 'live' : modes[providerOf(a)] !== 'live');

async function accountNumberStats(modes) {
  const rows = await prisma.customer.findMany({ where: { bankAccounts: { not: null }, deletedAt: null }, select: { id: true, bankAccounts: true } });
  const by = { monnify: { customers: 0, test: 0, unknownAge: 0 }, squad: { customers: 0, test: 0, unknownAge: 0 }, nomba: { customers: 0, test: 0, unknownAge: 0 } };
  for (const r of rows) {
    const list = Array.isArray(r.bankAccounts) ? r.bankAccounts : [];
    const seen = new Set();
    for (const a of list) {
      const p = providerOf(a);
      if (!by[p] || seen.has(p)) continue;
      seen.add(p);
      by[p].customers += 1;
      if (isTest(a, modes)) by[p].test += 1;
      // Made before numbers were stamped, while the partner is now live:
      // can't tell automatically whether it's a real or a test number.
      if (!a.mode && modes[p] === 'live') by[p].unknownAge += 1;
    }
  }
  return by;
}

async function report() {
  const s = await getSettings();
  const modes = await partnerModes();
  const checks = [];
  const add = (group, title, status, detail, fix, link) => checks.push({ group, title, status, detail, fix: fix || null, link: link || null });

  // ---- Bill supplier ----------------------------------------------------
  const vtKeys = Boolean(s.vtpassApiKey && s.vtpassSecretKey && s.vtpassPublicKey);
  add('Bills', 'VTpass mode', !vtKeys ? 'bad' : s.vtpassMode === 'live' ? 'ok' : 'bad', !vtKeys ? 'VTpass keys are not saved.' : s.vtpassMode === 'live' ? 'Live — real airtime, data and bills are delivered.' : 'Sandbox — purchases are test-only and nothing real is delivered.', s.vtpassMode === 'live' ? null : 'Switch VTpass to Live with your live keys.', SETTINGS('vtpass', 'connection'));
  try {
    const rw = await require('./adminInsights').runway({ coverDays: 7 });
    const days = rw.daysLeft;
    add('Bills', 'VTpass wallet', rw.balance === null ? 'warn' : days !== null && days < 2 ? 'bad' : days !== null && days < 5 ? 'warn' : rw.balance <= 0 ? 'bad' : 'ok', rw.balance === null ? rw.note : `${naira(rw.balance)} — ${rw.note}`, rw.suggestedTopUp ? `Top up about ${naira(rw.suggestedTopUp)} to cover 7 days.` : null, '/admin/partners');
  } catch (e) {
    add('Bills', 'VTpass wallet', 'warn', `Could not read the balance (${e.message}).`, null, '/admin/partners');
  }
  const ckCreds = await require('./clubkonnect').creds(s).catch(() => null);
  if (ckCreds) {
    const bal = await require('./clubkonnect').balance(s).catch(() => null);
    add('Bills', 'ClubKonnect wallet', bal === null ? 'warn' : bal < 2000 ? 'warn' : 'ok', bal === null ? 'Could not read the ClubKonnect balance.' : `${naira(bal)} (card printing${s.bettingSupplier === 'CLUBKONNECT' ? ' and bet funding' : ''}).`, bal !== null && bal < 2000 ? 'Top up ClubKonnect before customers print cards.' : null, SETTINGS('epins'));
  }
  if (s.bettingSupplier === 'NOMBA' || s.bettingSupplier === 'CLUBKONNECT') {
    const sup = s.bettingSupplier === 'NOMBA' ? 'Nomba' : 'ClubKonnect';
    const live = s.bettingSupplier !== 'NOMBA' || modes.nomba === 'live';
    add('Bills', 'Bet funding supplier', live ? 'ok' : 'warn', `${sup}${s.bettingSupplier === 'NOMBA' ? ` (${modes.nomba})` : ''}.`, live ? null : 'Bet funding through Nomba is still on sandbox keys — keep Bet Funding on "Testers only" until Nomba is live.', SETTINGS('epins'));
  }

  // ---- Payment partners -------------------------------------------------
  const monnify = require('./monnify');
  const monnifyReady = await monnify.isConfigured().catch(() => false);
  const monnifyOn = s.monnifyFundingEnabled !== false;
  add('Payment partners', 'Monnify', !monnifyReady ? (monnifyOn ? 'bad' : 'info') : modes.monnify === 'live' ? 'ok' : monnifyOn ? 'bad' : 'warn', !monnifyReady ? 'Keys not saved.' : `${modes.monnify === 'live' ? 'Live' : 'Sandbox'} · account numbers ${monnifyOn ? 'ON for customers' : 'off'}.`, monnifyReady && modes.monnify !== 'live' ? (monnifyOn ? 'Customers are being given TEST account numbers that can’t receive real money. Switch Monnify to Live (or turn its account numbers off).' : 'Switch to Live keys before turning account numbers on.') : null, SETTINGS('monnify', 'monnify'));

  const squad = require('./squad');
  const squadReady = await squad.isConfigured().catch(() => false);
  const squadOn = await squad.fundingOn().catch(() => false);
  if (squadReady || s.squadFundingEnabled) {
    add('Payment partners', 'Squad (GTBank)', modes.squad === 'live' ? 'ok' : squadOn ? 'bad' : 'warn', `${modes.squad === 'live' ? 'Live' : 'Sandbox'} · GTBank numbers ${squadOn ? 'ON for customers' : 'off'}${s.payoutProvider === 'squad' ? ' · sends Send to Bank' : ''}.`, modes.squad !== 'live' ? (squadOn ? 'Customers are being given TEST GTBank numbers. Untick Squad until it is live.' : 'Fine for testing. Paste live keys when Squad approves you.') : null, SETTINGS('monnify', 'squad'));
  }
  const nomba = require('./nomba');
  const nombaReady = await nomba.isConfigured().catch(() => false);
  const nombaOn = await nomba.fundingOn().catch(() => false);
  if (nombaReady || s.nombaFundingEnabled) {
    const cfg = await nomba.getConfig().catch(() => ({}));
    add('Payment partners', 'Nomba', modes.nomba === 'live' ? (cfg.webhookKey ? 'ok' : 'warn') : nombaOn ? 'bad' : 'warn', `${modes.nomba === 'live' ? 'Live' : 'Sandbox'} · account numbers ${nombaOn ? 'ON for customers' : 'off'} · webhook key ${cfg.webhookKey ? 'saved' : 'NOT saved'}${s.payoutProvider === 'nomba' ? ' · sends Send to Bank' : ''}.`, modes.nomba !== 'live' ? (nombaOn ? 'Customers are being given TEST Nombank numbers. Untick Nomba until it is live.' : 'Fine for testing. Paste live keys when Nomba approves you.') : !cfg.webhookKey ? 'Save the webhook signature key, and set the same one in Nomba → Webhook Setup (Live).' : null, SETTINGS('monnify', 'nomba'));
  }
  const fw = await require('./flutterwave').config().catch(() => null);
  if (fw && (fw.secretKey || fw.enabled)) {
    add('Payment partners', 'Flutterwave (card)', fw.mode === 'live' ? 'ok' : fw.enabled ? 'bad' : 'warn', `${fw.mode === 'live' ? 'Live' : fw.mode === 'test' ? 'Test' : 'No keys'} · card funding ${fw.enabled ? 'ON' : 'off'}.`, fw.mode !== 'live' && fw.enabled ? 'Card funding is on with TEST keys — customers can’t really pay. Turn it off or use live keys.' : null, SETTINGS('monnify', 'flutterwave'));
  }
  const payVia = ['squad', 'nomba'].includes(s.payoutProvider) ? s.payoutProvider : 'monnify';
  add('Payment partners', 'Send to Bank goes through', modes[payVia] === 'live' ? 'ok' : s.bankTransferEnabled ? 'bad' : 'warn', `${PARTNER_NAMES[payVia]} (${modes[payVia]})${s.payoutFallback !== false ? ', with automatic backup' : ''}.`, modes[payVia] !== 'live' ? 'Bank transfers would go through a sandbox partner. Choose a live partner under Payment partners.' : null, SETTINGS('monnify', 'overview'));

  // ---- Money ------------------------------------------------------------
  try {
    const c = await require('./fundsGuard').coverage({ fresh: true });
    add('Money', 'Customer money covered', c.status === 'OK' ? 'ok' : c.status === 'SHORT' ? 'bad' : 'warn', c.status === 'INCOMPLETE' ? `Couldn’t read every partner wallet${c.errors.length ? ` (${c.errors.join('; ')})` : ''}.` : `Partner wallets hold ${naira(c.held)}; customers are owed ${naira(c.owed)}.`, c.status === 'SHORT' ? `Short by ${naira(c.shortBy)} — bank transfers pause until it’s covered.` : null, '/admin/money');
    if (s.payoutFallback !== false) {
      const low = Object.entries(c.freeBy || {}).filter(([p, v]) => v !== null && v < 5000 && (p === payVia || (p === 'squad' && squadReady) || (p === 'nomba' && nombaReady)));
      if (low.length) add('Money', 'Payout wallets', 'warn', low.map(([p, v]) => `${PARTNER_NAMES[p]}: ${naira(v)} free`).join(' · '), 'A partner with an empty wallet can’t send transfers (or act as the backup). Top it up.', '/admin/money');
    }
  } catch (e) {
    add('Money', 'Customer money covered', 'warn', `Could not check (${e.message}).`, null, '/admin/money');
  }

  // ---- Customer account numbers ----------------------------------------
  const stats = await accountNumberStats(modes);
  const accounts = [];
  for (const p of ['monnify', 'squad', 'nomba']) {
    const st = stats[p];
    accounts.push({ provider: p, name: PARTNER_NAMES[p], mode: modes[p], ...st });
    if (!st.customers) continue;
    add('Customer account numbers', `${PARTNER_NAMES[p]} numbers`, st.test ? 'bad' : st.unknownAge ? 'warn' : 'ok', `${st.customers} customer${st.customers === 1 ? ' has' : 's have'} one${st.test ? ` · ${st.test} ${st.test === 1 ? 'is a TEST number' : 'are TEST numbers'}` : ''}${st.unknownAge ? ` · ${st.unknownAge} were made before numbers were labelled, so check them` : ''}.`, st.test ? 'Test numbers can’t receive real money (or send it somewhere customers won’t see). Remove them below so these customers get real ones.' : null, null);
  }

  // ---- Features & security ---------------------------------------------
  const feats = await require('./features').adminStatus().catch(() => []);
  const testers = feats.filter((f) => f.mode === 'TESTERS');
  if (testers.length) add('Features', 'Still on “Testers only”', 'info', testers.map((f) => f.name).join(', '), 'Switch each one to On when it’s ready for everyone (or leave it for testing).', '/admin/features');
  if (s.idMatchEnabled) add('Security', 'BVN/NIN name check', modes.monnify === 'live' ? 'ok' : 'bad', modes.monnify === 'live' ? 'On, using Monnify live.' : 'On, but Monnify is in sandbox — every check fails and no one can get an account number.', modes.monnify === 'live' ? null : 'Turn it off until Monnify is live.', SETTINGS('security', 'id'));
  add('Security', 'Two-step admin login', s.adminTwoFactorEnabled ? 'ok' : 'warn', s.adminTwoFactorEnabled ? 'On.' : 'Off — anyone with the admin password can get in.', s.adminTwoFactorEnabled ? null : 'Turn it on (and make backup codes) before launch.', SETTINGS('security', 'login'));

  // ---- Hosting -----------------------------------------------------------
  if (process.env.RENDER || /onrender\.com/.test(process.env.PUBLIC_API_URL || '')) {
    add('Hosting', 'Backend server', 'warn', 'Running on Render. The free plan sleeps when idle, so the first request after a quiet spell is slow, and payment messages can arrive while it’s waking.', 'Move to the VPS before launch.', null);
  }

  const counts = { ok: 0, warn: 0, bad: 0, info: 0 };
  checks.forEach((c) => (counts[c.status] += 1));
  return { at: new Date(), counts, ready: counts.bad === 0, checks, accounts, modes };
}

// Removes TEST account numbers from one partner (or all) so customers can
// get real ones. Money already in wallets is untouched; only the number
// list changes. Returns how many customers were changed.
async function removeTestNumbers(provider) {
  const modes = await partnerModes();
  const which = provider === 'all' ? ['monnify', 'squad', 'nomba'] : [provider];
  if (!which.every((p) => PARTNER_NAMES[p])) throw new Error('Unknown partner.');
  const rows = await prisma.customer.findMany({ where: { bankAccounts: { not: null } }, select: { id: true, bankAccounts: true } });
  let changed = 0;
  let removed = 0;
  for (const r of rows) {
    const list = Array.isArray(r.bankAccounts) ? r.bankAccounts : [];
    const drop = list.filter((a) => which.includes(providerOf(a)) && isTest(a, modes));
    if (!drop.length) continue;
    const keep = list.filter((a) => !drop.includes(a));
    const gone = new Set(drop.map(providerOf));
    const stillHas = new Set(keep.map(providerOf));
    const data = { bankAccounts: keep.length ? keep : null };
    if (gone.has('monnify') && !stillHas.has('monnify')) data.bankAccountRef = null;
    if (gone.has('squad') && !stillHas.has('squad')) Object.assign(data, { squadAccountRef: null, squadAccountAt: null });
    if (gone.has('nomba') && !stillHas.has('nomba')) Object.assign(data, { nombaAccountRef: null, nombaAccountAt: null });
    if (!keep.length) data.bankAccountAt = null;
    await prisma.customer.update({ where: { id: r.id }, data });
    changed += 1;
    removed += drop.length;
  }
  return { customers: changed, numbers: removed };
}

module.exports = { report, removeTestNumbers, isTest, providerOf, partnerModes };
