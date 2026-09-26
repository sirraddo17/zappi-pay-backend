const prisma = require('./prisma');
const { notify } = require('./notify');
const { alertAdmins } = require('./adminAlert');

// Referral contests.
// A friend counts for the person who referred them only if:
//   1. they SIGNED UP between the contest's start and end, and
//   2. they made a successful purchase or bank transfer (of at least
//      minQualifyingAmount) before the contest ended.
// Contests never overlap, so each contest starts counting from zero.
// Ranking: most qualified friends; a tie goes to whoever reached that
// number first.

const money = (n) => `₦${Number(n || 0).toLocaleString('en-NG')}`;

function maskName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0] || 'Customer';
}

function prizeList(contest) {
  return (Array.isArray(contest.prizes) ? contest.prizes : []).map(Number).filter((n) => n > 0);
}

function phase(contest, now = new Date()) {
  if (contest.status === 'CANCELLED') return 'CANCELLED';
  if (contest.status === 'PAID') return 'PAID';
  if (contest.status === 'AWAITING_PAYOUT' || contest.status === 'PAYING') return 'ENDED';
  if (now < new Date(contest.startsAt)) return 'UPCOMING';
  if (now >= new Date(contest.endsAt)) return 'ENDED';
  return 'LIVE';
}

// Full standings, best first: [{ customerId, name, phone, username, qualified, pending, reachedAt }]
async function standings(contest) {
  const start = new Date(contest.startsAt);
  const end = new Date(contest.endsAt);
  const until = new Date(Math.min(Date.now(), end.getTime()));
  const minAmt = Number(contest.minQualifyingAmount || 0);
  const out = new Set(Array.isArray(contest.disqualified) ? contest.disqualified : []);

  const friends = await prisma.customer.findMany({
    where: { referredById: { not: null }, createdAt: { gte: start, lt: end }, deletedAt: null },
    select: { id: true, referredById: true, kycType: true, bankAccountAt: true },
  });
  if (!friends.length) return [];
  const ids = friends.map((f) => f.id);

  const [orders, transfers] = await Promise.all([
    prisma.order.groupBy({
      by: ['customerId'],
      where: { customerId: { in: ids }, status: 'SUCCESS', createdAt: { gte: start, lte: until }, ...(minAmt ? { amount: { gte: minAmt } } : {}) },
      _min: { createdAt: true },
    }),
    prisma.bankTransfer.groupBy({
      by: ['customerId'],
      where: { customerId: { in: ids }, status: 'SUCCESS', createdAt: { gte: start, lte: until }, ...(minAmt ? { amount: { gte: minAmt } } : {}) },
      _min: { createdAt: true },
    }),
  ]);
  const firstQualifying = new Map();
  for (const g of [...orders, ...transfers]) {
    const t = g._min.createdAt;
    const prev = firstQualifying.get(g.customerId);
    if (t && (!prev || t < prev)) firstQualifying.set(g.customerId, t);
  }

  const byReferrer = new Map();
  for (const f of friends) {
    if (out.has(f.referredById) || out.has(f.id)) continue;
    const row = byReferrer.get(f.referredById) || { customerId: f.referredById, qualified: 0, pending: 0, reachedAt: null };
    let q = firstQualifying.get(f.id);
    // Real people only: the friend must also have verified BVN/NIN
    // before the contest ended. They count from whichever came last.
    if (q && contest.requireVerified !== false) {
      const v = f.kycType && f.bankAccountAt ? new Date(f.bankAccountAt) : null;
      q = v && v <= until ? (v > q ? v : q) : null;
    }
    if (q) {
      row.qualified += 1;
      if (!row.reachedAt || q > row.reachedAt) row.reachedAt = q;
    } else {
      row.pending += 1;
    }
    byReferrer.set(f.referredById, row);
  }

  const referrers = await prisma.customer.findMany({
    where: { id: { in: [...byReferrer.keys()] }, active: true, deletedAt: null },
    select: { id: true, name: true, phone: true, username: true },
  });
  const info = new Map(referrers.map((r) => [r.id, r]));
  return [...byReferrer.values()]
    .filter((r) => info.has(r.customerId))
    .map((r) => ({ ...r, name: info.get(r.customerId).name, phone: info.get(r.customerId).phone, username: info.get(r.customerId).username }))
    .sort((a, b) => b.qualified - a.qualified || (a.reachedAt && b.reachedAt ? a.reachedAt - b.reachedAt : 0) || b.pending - a.pending);
}

function pickWinners(contest, rows) {
  const prizes = prizeList(contest);
  const min = Math.max(1, contest.minReferrals || 1);
  return rows
    .filter((r) => r.qualified >= min)
    .slice(0, prizes.length)
    .map((r, i) => ({ rank: i + 1, customerId: r.customerId, name: r.name, displayName: maskName(r.name), qualified: r.qualified, prize: prizes[i] }));
}

// Ends a contest whose time is up: records the winners, then pays them
// straight away (autoPay) or waits for an admin to press "Pay winners".
async function finalizeContest(contestId) {
  const contest = await prisma.referralContest.findUnique({ where: { id: contestId } });
  if (!contest || contest.status !== 'ACTIVE' || new Date(contest.endsAt) > new Date()) return contest;
  const winners = pickWinners(contest, await standings(contest));
  const r = await prisma.referralContest.updateMany({
    where: { id: contest.id, status: 'ACTIVE' },
    data: { status: 'AWAITING_PAYOUT', winners },
  });
  if (r.count !== 1) return prisma.referralContest.findUnique({ where: { id: contest.id } });
  if (contest.autoPay && winners.length) return payWinners(contest.id);
  alertAdmins(
    `Referral contest ended: ${contest.title}`,
    winners.length
      ? `Winners:\n${winners.map((w) => `${w.rank}. ${w.name} — ${w.qualified} friends — ${money(w.prize)}`).join('\n')}\nReview and press "Pay winners" under Contests.`
      : 'Nobody reached the minimum number of friends, so there are no winners.',
    '/admin/contests'
  );
  return prisma.referralContest.findUnique({ where: { id: contest.id } });
}

// Credits each winner's wallet exactly once.
async function payWinners(contestId) {
  const claim = await prisma.referralContest.updateMany({ where: { id: contestId, status: 'AWAITING_PAYOUT' }, data: { status: 'PAYING' } });
  if (claim.count !== 1) throw new Error('This contest is not waiting for payout.');
  const contest = await prisma.referralContest.findUnique({ where: { id: contestId } });
  const winners = (Array.isArray(contest.winners) ? contest.winners : []).map((w) => ({ ...w }));
  try {
    for (const w of winners) {
      if (!(w.prize > 0) || w.paidAt) continue;
      try {
        await prisma.$transaction([
          // providerRef is unique, so a prize can never be credited twice.
          prisma.walletTransaction.create({
            data: {
              customerId: w.customerId,
              type: 'CONTEST_PRIZE',
              amount: w.prize,
              status: 'APPROVED',
              providerRef: `contest:${contest.id}:${w.rank}`,
              reference: `CONTEST-${contest.id.slice(-8)}-${w.rank}`,
              note: `${ordinal(w.rank)} place — ${contest.title}`,
            },
          }),
          prisma.customer.update({ where: { id: w.customerId }, data: { walletBalance: { increment: w.prize } } }),
        ]);
        notify(w.customerId, 'Contest Prize', `🏆 You came ${ordinal(w.rank)} in "${contest.title}" with ${w.qualified} friends! ${money(w.prize)} has been added to your wallet. Share your win from the Refer & Earn page.`);
      } catch (error) {
        if (error.code !== 'P2002') throw error; // P2002 = already paid earlier
      }
      w.paidAt = new Date().toISOString();
      await prisma.referralContest.update({ where: { id: contest.id }, data: { winners } });
    }
  } catch (error) {
    // Let the admin retry; winners already paid are marked and skipped.
    await prisma.referralContest.update({ where: { id: contest.id }, data: { status: 'AWAITING_PAYOUT', winners } });
    throw error;
  }
  return prisma.referralContest.update({ where: { id: contest.id }, data: { status: 'PAID', paidAt: new Date(), winners } });
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

// Wakes up exactly when the next contest ends (no polling, so the
// database can sleep in between).
let timer = null;
async function armContestTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
  try {
    const overdue = await prisma.referralContest.findMany({ where: { status: 'ACTIVE', endsAt: { lte: new Date() } }, select: { id: true } });
    for (const c of overdue) await finalizeContest(c.id).catch((e) => console.error('finalizeContest failed:', e.message));
    const next = await prisma.referralContest.findFirst({ where: { status: 'ACTIVE' }, orderBy: { endsAt: 'asc' }, select: { endsAt: true } });
    if (!next) return;
    const ms = Math.min(Math.max(new Date(next.endsAt).getTime() - Date.now() + 2000, 1000), 24 * 3600 * 1000);
    timer = setTimeout(() => armContestTimer(), ms);
    if (timer.unref) timer.unref();
  } catch (error) {
    console.error('armContestTimer failed:', error.message);
    timer = setTimeout(() => armContestTimer(), 30 * 60 * 1000);
    if (timer.unref) timer.unref();
  }
}

module.exports = { standings, pickWinners, finalizeContest, payWinners, armContestTimer, phase, maskName, prizeList, ordinal };
