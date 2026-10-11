// Referral extras on top of lib/referral.js:
//  • welcome cashback for the invited friend once they verify BVN/NIN
//    (into the cashback balance, so it can only be spent on purchases);
//  • milestone bonuses for the referrer (e.g. 3 friends → +₦200), paid
//    from the referral pool so they never cost more than was set aside;
//  • boost weeks: a bigger bonus (with its own spend target) until a date;
//  • a ticker of real recent referral payouts, names masked.

const prisma = require('./prisma');
const { getSettings } = require('./vtpass');
const { notify } = require('./notify');

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG')}`;

function maskName(name) {
  const first = String(name || '').trim().split(/\s+/)[0] || 'Someone';
  return `${first.slice(0, 2)}${'*'.repeat(Math.max(3, Math.min(5, first.length - 2)))}`;
}

// Bonus and spend target in force right now (a running boost wins).
function effective(s, now = new Date()) {
  const until = s.referralBoostUntil ? new Date(s.referralBoostUntil) : null;
  const boostOn = Boolean(until && until > now && Number(s.referralBoostAmount) > 0);
  return {
    bonus: Number(boostOn ? s.referralBoostAmount : s.referralBonusAmount) || 0,
    target: Number(boostOn && Number(s.referralBoostTarget) > 0 ? s.referralBoostTarget : s.referralSpendTarget) || 0,
    boost: boostOn ? { until, bonus: Number(s.referralBoostAmount), normalBonus: Number(s.referralBonusAmount) } : null,
  };
}

function milestones(s) {
  let m = s.referralMilestones;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch { m = []; } }
  if (!Array.isArray(m)) return [];
  return m
    .map((x) => ({ count: Math.floor(Number(x?.count)), bonus: r2(x?.bonus) }))
    .filter((x) => x.count >= 2 && x.count <= 1000 && x.bonus > 0)
    .sort((a, b) => a.count - b.count)
    .slice(0, 6);
}

function cleanMilestones(list) {
  if (!Array.isArray(list)) throw new Error('Milestones must be a list.');
  const seen = new Set();
  return milestones({ referralMilestones: list }).filter((x) => !seen.has(x.count) && seen.add(x.count));
}

// Welcome cashback for a friend who joined with a code and has just
// verified BVN/NIN. Only into the separate cashback balance (spendable on
// purchases, never withdrawable), once per customer.
async function payWelcome(customerId) {
  try {
    const s = await getSettings();
    const amount = r2(s.referralWelcomeBonus);
    if (!s.referralEnabled || !(amount > 0) || !s.cashbackSeparate) return false;
    const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true, referredById: true, kycType: true, referralWelcomePaidAt: true } });
    if (!c?.referredById || !c.kycType || c.referralWelcomePaidAt) return false;
    const paid = await prisma.$transaction(async (tx) => {
      const claim = await tx.customer.updateMany({ where: { id: c.id, referralWelcomePaidAt: null }, data: { referralWelcomePaidAt: new Date() } });
      if (claim.count !== 1) return false;
      await require('./cashback').creditEarned(tx, s, { customerId: c.id, amount, note: 'Welcome bonus for joining with an invite' });
      return true;
    });
    if (paid) notify(c.id, 'Welcome bonus 🎁', `You got ${naira(amount)} cashback for joining with an invite. It's taken off your next purchases automatically when you switch on "Use cashback".`);
    return paid;
  } catch (error) {
    console.error('referralPlus.payWelcome:', error.message);
    return false;
  }
}

// Milestone bonuses for a referrer, after a referral bonus is paid.
async function checkMilestones(referrerId, settings) {
  try {
    const s = settings || (await getSettings());
    const list = milestones(s);
    if (!s.referralEnabled || !list.length) return [];
    const ref = await prisma.customer.findUnique({ where: { id: referrerId }, select: { id: true, active: true, referralMilestonesPaid: true } });
    if (!ref?.active) return [];
    const done = new Set((Array.isArray(ref.referralMilestonesPaid) ? ref.referralMilestonesPaid : []).map(Number));
    const rewarded = await prisma.customer.count({ where: { referredById: referrerId, referralBonusPaidAt: { not: null } } });
    const paidNow = [];
    for (const m of list) {
      if (rewarded < m.count || done.has(m.count)) continue;
      const ok = await prisma.$transaction(async (tx) => {
        const fresh = await tx.customer.findUnique({ where: { id: referrerId }, select: { referralMilestonesPaid: true } });
        const already = (Array.isArray(fresh?.referralMilestonesPaid) ? fresh.referralMilestonesPaid : []).map(Number);
        if (already.includes(m.count)) return false;
        if (s.rewardSplitEnabled) {
          const taken = await require('./rewardSplit').takeFromPool(tx, 'REFERRAL', m.bonus, `Referral milestone (${m.count} friends)`);
          if (!taken) return false; // waits for the pool
        }
        await tx.customer.update({ where: { id: referrerId }, data: { walletBalance: { increment: m.bonus }, referralMilestonesPaid: [...already, m.count] } });
        await tx.walletTransaction.create({ data: { customerId: referrerId, type: 'REFERRAL_BONUS', amount: m.bonus, status: 'APPROVED', note: `Referral milestone — ${m.count} friends joined and bought` } });
        return true;
      });
      if (ok) {
        done.add(m.count);
        paidNow.push(m);
        notify(referrerId, 'Milestone reached 🏆', `${m.count} friends you invited are now buying on ZAPPI PAY. You earned an extra ${naira(m.bonus)}!`);
      } else break; // pool short: try again later, in order
    }
    return paidNow;
  } catch (error) {
    console.error('referralPlus.checkMilestones:', error.message);
    return [];
  }
}

// Real recent referral payouts, names masked.
async function ticker(limit = 10) {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const rows = await prisma.walletTransaction.findMany({
    where: { type: 'REFERRAL_BONUS', status: 'APPROVED', createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { amount: true, createdAt: true, note: true, customer: { select: { name: true } } },
  });
  return rows.map((r) => ({ name: maskName(r.customer?.name), amount: Number(r.amount), at: r.createdAt, milestone: /milestone/i.test(r.note || '') }));
}

// Admin: every friend still working toward the bonus, with ₦ spent.
async function adminProgress(limit = 100) {
  const s = await getSettings();
  const { target } = effective(s);
  const { spentBy } = require('./referral');
  const waiting = await prisma.customer.findMany({
    where: { referredById: { not: null }, referralBonusPaidAt: null, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, name: true, createdAt: true, kycType: true, referredBy: { select: { name: true } } },
  });
  const rows = [];
  for (const w of waiting) {
    const spent = await spentBy(w.id).catch(() => 0);
    rows.push({ name: w.name, referrer: w.referredBy?.name || '—', joinedAt: w.createdAt, verified: Boolean(w.kycType), spent: r2(spent), target, pct: target > 0 ? Math.min(100, Math.floor((spent / target) * 100)) : null });
  }
  rows.sort((a, b) => b.spent - a.spent);
  return { target, rows };
}

module.exports = { effective, milestones, cleanMilestones, payWelcome, checkMilestones, ticker, adminProgress, maskName };
