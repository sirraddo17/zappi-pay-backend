// Safe rewards check (shown on Admin → 🚦 Go-live check → Rewards).
// Flags any reward setting that can pay out more than the purchases it
// needs actually earn. The rule of thumb: a reward should be no more than
// about 1% of the spending it requires (airtime/data earn ~2.5–3.7% after
// the deposit fee), so ZAPPI PAY keeps about two-thirds.
//
// "What you earn" = VTpass commission − the deposit fee paid on the money
// (the main account-number partner's charge, less any funding fee the
// customer pays). Airtime/data use MTN's rate (the lowest), so the check
// is on the safe side.

const prisma = require('./prisma');
const { getSettings } = require('./vtpass');
const { rateFor } = require('./earnings');
const { feeFor, PARTNER_COST } = require('./fundingFees');

const VAT = 0.075;
const SAFE_SHARE = 1; // % of required spend
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const naira = (n) => `₦${r2(n).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const pct = (n) => `${r2(n)}%`;

const LINKS = {
  split: '/admin/settings?tab=split',
  guard: '/admin/settings?tab=discount&sub=guard',
  referral: '/admin/settings?tab=referral&sub=settings',
  cashback: '/admin/settings?tab=cashback',
  loyalty: '/admin/settings?tab=loyalty',
  promise: '/admin/settings?tab=promise',
  shops: '/admin/settings?tab=shops',
  challenges: '/admin/challenges',
  contests: '/admin/contests',
  money: '/admin/money',
};

// Representative provider per service (lowest commission = safest).
const SAMPLE = { AIRTIME: 'mtn', DATA: 'mtn-data', CABLE: 'dstv', ELECTRICITY: 'ikeja-electric', INTERNET: 'smile-direct' };
const NAMES = { AIRTIME: 'airtime', DATA: 'data', CABLE: 'TV', ELECTRICITY: 'electricity', INTERNET: 'internet', EDUCATION: 'exam PINs' };

function mainPartner(s) {
  const p = String(s.fundingPrimary || '').toLowerCase();
  if (['monnify', 'squad', 'nomba'].includes(p)) return p;
  return s.squadPrimary ? 'squad' : 'monnify';
}

// Deposit fee as a % of the money, after what the customer pays.
function depositCostPct(s, partner = mainPartner(s)) {
  const cost = PARTNER_COST[partner] || PARTNER_COST.monnify; // unknown (Nomba) → assume Monnify's
  const theirs = cost.pct * (1 + VAT);
  const customer = feeFor(partner, s).pct || 0;
  return Math.max(0, theirs - customer);
}

// What ZAPPI PAY keeps on ₦100 of this service, in % (can be below 0).
function earnPct(service, s) {
  const rate = rateFor(service, SAMPLE[service]);
  const commission = rate.flat ? 0 : rate.pct;
  return r2(commission - depositCostPct(s));
}

const roundUp = (n, step = 500) => Math.ceil(n / step) * step;

async function check(settingsIn) {
  const s = settingsIn || (await getSettings());
  const out = [];
  const add = (title, status, detail, fix, link) => out.push({ title, status, detail, fix: fix || null, link: link || null });
  const guardOn = s.rewardSplitEnabled || s.rewardGuardEnabled !== false;
  const airData = Math.min(earnPct('AIRTIME', s), earnPct('DATA', s));
  const partner = mainPartner(s);

  // 1. Rewards split / safety limit ------------------------------------
  if (s.rewardSplitEnabled) {
    add('Rewards split', 'ok', `On: rewards are paid from ${pct(s.rewardSplitPct ?? 30)} of what you really earn, so they can never cost more than you make.`, null, LINKS.split);
  } else {
    add('Rewards split', 'warn', 'Off. Cashback, loyalty, referral bonuses, challenges and delivery bonuses are not limited to a share of your earnings.', 'Turn on Rewards split at about 30%.', LINKS.split);
    if (s.rewardGuardEnabled === false) add('Giveaway safety limit', 'bad', 'Off. One purchase can give away more (discount + promo + cashback + points) than it earns.', 'Turn the giveaway safety limit on (50% or less).', LINKS.guard);
    else if (Number(s.rewardGuardPercent ?? 50) > 60) add('Giveaway safety limit', 'warn', `Set to ${s.rewardGuardPercent}% — most of each sale's profit can be given away.`, 'Lower it to 50% or less.', LINKS.guard);
    else add('Giveaway safety limit', 'ok', `On at ${s.rewardGuardPercent ?? 50}%: no single purchase gives away more than that share of its profit.`, null, LINKS.guard);
  }

  // 2. Referrals ----------------------------------------------------------
  if (s.referralEnabled) {
    const need = Math.max(Number(s.referralMinPurchase || 0), Number(s.referralSpendTarget || 0));
    const testOne = (label, bonus, spend) => {
      if (!(bonus > 0)) return;
      const earn = (spend * airData) / 100;
      const safeSpend = roundUp((bonus * 100) / SAFE_SHARE);
      if (bonus > earn) add(label, 'bad', `${naira(bonus)} is paid after the friend spends ${naira(spend)}, which earns you only about ${naira(Math.max(0, earn))}. Each referral loses money.`, `Set the spend target to at least ${naira(safeSpend)}, or lower the bonus.`, LINKS.referral);
      else if (bonus > (spend * SAFE_SHARE) / 100) add(label, 'warn', `${naira(bonus)} after ${naira(spend)} of spending: you earn about ${naira(earn)}, so most of it goes back as the bonus.`, `A spend target of ${naira(safeSpend)} keeps about two-thirds for you.`, LINKS.referral);
      else add(label, 'ok', `${naira(bonus)} after ${naira(spend)} of spending — you earn about ${naira(earn)}.`, null, LINKS.referral);
    };
    testOne('Referral bonus', Number(s.referralBonusAmount || 0), need);
    const boostOn = s.referralBoostUntil && new Date(s.referralBoostUntil) > new Date() && Number(s.referralBoostAmount) > 0;
    if (boostOn) testOne('Referral boost', Number(s.referralBoostAmount), Math.max(need, Number(s.referralBoostTarget || 0)));
    const welcome = Number(s.referralWelcomeBonus || 0);
    if (welcome > 0) add('Welcome bonus', welcome > 50 ? 'bad' : 'warn', `${naira(welcome)} is given to each invited friend before they buy anything, which attracts fake sign-ups.`, 'Set it to ₦0, or keep it very small.', LINKS.referral);
  }

  // 3. Cashback -------------------------------------------------------------
  if (s.cashbackEnabled) {
    let map = s.cashbackPercentByService;
    if (typeof map === 'string') { try { map = JSON.parse(map); } catch { map = {}; } }
    const problems = [];
    let worst = 'ok';
    for (const [service, v] of Object.entries(map || {})) {
      const p = Number(v);
      if (!(p > 0)) continue;
      const earn = earnPct(service, s);
      const limit = Math.max(0, Math.min(SAFE_SHARE, earn / 2));
      const name = NAMES[service] || service.toLowerCase();
      if (p > earn) { problems.push(`${name} ${pct(p)} (${earn < 0 ? `you already lose about ${pct(-earn)}` : `you keep about ${pct(earn)}`})`); worst = guardOn && worst !== 'bad' ? 'warn' : 'bad'; }
      else if (p > limit) { problems.push(`${name} ${pct(p)} (safe: ${pct(limit)})`); if (worst === 'ok') worst = 'warn'; }
    }
    const max = Number(s.cashbackMaxPerOrder || 0);
    if (max > 100) { problems.push(`up to ${naira(max)} per order`); if (worst === 'ok') worst = 'warn'; }
    if (problems.length) add('Cashback', worst, `Too generous: ${problems.join('; ')}.${guardOn ? ' The safety limit trims it on each purchase, but customers see the bigger number.' : ''}`, 'Airtime/data 1% or less, TV and electricity 0% (unless funding is via Squad), and a ₦50 maximum per order.', LINKS.cashback);
    else add('Cashback', 'ok', 'Every service gives back less than half of what it earns.', null, LINKS.cashback);
  }

  // 4. Loyalty --------------------------------------------------------------
  if (s.loyaltyEnabled) {
    const back = Number(s.loyaltyPointsPer100 || 0) * Number(s.loyaltyPointValue || 0); // ₦ per ₦100 = %
    if (back > airData) add('Loyalty points', 'bad', `Points are worth ${pct(back)} of spending — more than airtime/data earn you (about ${pct(airData)}).`, 'Lower points per ₦100 or the value of each point (0.5% back is safe).', LINKS.loyalty);
    else if (back > SAFE_SHARE) add('Loyalty points', 'warn', `Points are worth ${pct(back)} of spending.`, 'Keep it at about 0.5–1%.', LINKS.loyalty);
    else add('Loyalty points', 'ok', `Points are worth ${pct(back)} of spending.`, null, LINKS.loyalty);
  }

  // 5. Delivery promise -----------------------------------------------------
  if (s.deliveryPromiseEnabled) {
    const bonus = Number(s.deliveryPromiseBonus || 0);
    const min = Number(s.deliveryPromiseMinAmount || 0);
    const earn = (min * airData) / 100;
    if (bonus > earn) add('Delivery promise bonus', 'warn', `${naira(bonus)} for a late delivery on purchases from ${naira(min)} (which earn about ${naira(Math.max(0, earn))}). Capped at ${naira(s.deliveryPromiseDailyBudget || 0)} a day.`, `Raise the minimum amount to about ${naira(roundUp((bonus * 100) / Math.max(airData, 0.5)))} or lower the bonus.`, LINKS.promise);
  }

  // 6. Agent shop commission ------------------------------------------------
  const shopPct = Number(s.shopCommissionPct ?? 1);
  if (shopPct > airData / 2) add('Agent shop commission', shopPct > airData ? 'bad' : 'warn', `Shops get ${pct(shopPct)} of each sale; airtime/data earn you about ${pct(airData)}.`, `Keep it at ${pct(Math.max(0, r2(airData / 2)))} or less.`, LINKS.shops);

  // 7. Active challenges ----------------------------------------------------
  const challenges = await prisma.challenge.findMany({ where: { active: true } }).catch(() => []);
  if (challenges.length) {
    const { preview } = require('./challenges');
    const bad = [];
    const warn = [];
    for (const ch of challenges) {
      if (ch.endsAt && new Date(ch.endsAt) < new Date()) continue;
      let p;
      try { p = preview({ ...ch, reward: Number(ch.reward) }, s); } catch { continue; }
      const reward = Number(ch.reward);
      // Same deposit partner as the rest of this check (markup ignored, so it's on the safe side).
      const earn = Math.max(0, r2((p.perBuy * p.buys * earnPct(ch.service || 'DATA', s)) / 100));
      const text = `"${ch.title}" pays ${naira(reward)}; a customer who finishes earns you about ${naira(earn)}`;
      if (reward > earn) bad.push(text);
      else if (reward > earn / 2) warn.push(text);
    }
    const noBudget = challenges.filter((c) => c.budget == null).length;
    if (bad.length) add('Challenges', 'bad', `${bad.join('; ')}.`, 'Raise the target or minimum amount, or lower the reward (about 1% of the spend it needs).', LINKS.challenges);
    else if (warn.length) add('Challenges', 'warn', `${warn.join('; ')}.`, 'Aim for a reward around 1% of the spend it needs.', LINKS.challenges);
    else add('Challenges', 'ok', `${challenges.length} active, each paying less than half of what it earns.`, null, LINKS.challenges);
    if (noBudget) add('Challenge budgets', 'warn', `${noBudget} active challenge${noBudget === 1 ? ' has' : 's have'} no total budget, so there's no limit on how much they can pay out.`, 'Set a budget on each challenge.', LINKS.challenges);
  }

  // 8. Contests + what rewards really cost (last 30 days) ------------------
  let since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  // Respect the profit panel's "Start fresh" date (test-time payouts don't count).
  if (s.profitCountFrom && new Date(s.profitCountFrom) > since) since = new Date(s.profitCountFrom);
  let rep = null;
  try { rep = await require('./earnings').earningsReport({ gte: since }); } catch { rep = null; }
  const earned = rep ? Number(rep.income.vtpassCommission || 0) + Number(rep.income.purchaseMarkup || 0) : null;
  const contests = await prisma.referralContest.findMany({ where: { status: 'ACTIVE' } }).catch(() => []);
  if (contests.length) {
    const { prizeList } = require('./contest');
    const prizes = contests.reduce((a, c) => a + prizeList(c).reduce((x, y) => x + y, 0), 0);
    const base = Math.max(0, earned ?? 0);
    const status = prizes > base ? 'bad' : prizes > base * 0.3 ? 'warn' : 'ok';
    add('Contest prizes', status, `${naira(prizes)} in prizes on ${contests.length} active contest${contests.length === 1 ? '' : 's'}; purchases earned you ${naira(base)} in the last 30 days.`, status === 'ok' ? null : 'Keep total prizes to about 20–30% of the commission you expect the contest to bring in.', LINKS.contests);
  }
  if (rep) {
    const given = Number(rep.costs.rewards || 0);
    if (given > 0) {
      const base = Math.max(0, earned);
      add('Rewards paid (last 30 days)', given > base * 0.5 ? 'warn' : 'ok', `${naira(given)} in rewards against ${naira(base)} earned on purchases.${given > base ? ' Rewards cost more than you earned — if most went to test accounts, this is not real customer behaviour.' : ''}`, given > base ? 'See who received them on the Money check, then tighten the settings above.' : null, LINKS.money);
    }
  }

  // 9. Where deposit fees eat the profit ------------------------------------
  const losers = ['CABLE', 'ELECTRICITY'].filter((x) => earnPct(x, s) <= 0);
  if (losers.length) add('TV & electricity', 'warn', `With ${partner === 'squad' ? 'Squad' : partner === 'nomba' ? 'Nomba' : 'Monnify'} deposits, ${losers.map((x) => NAMES[x]).join(' and ')} earn nothing after the deposit fee, so any reward on them is a loss.`, 'Give no rewards on them, add a small service charge, or make Squad the main account number.', LINKS.cashback);

  return out;
}

module.exports = { check, earnPct, depositCostPct, mainPartner };
