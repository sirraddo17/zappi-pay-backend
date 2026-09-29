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
    where: { referredById: { not: null }, createdAt: { gte: start, lt: end }, deletedAt: null, active: true },
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


function normName(n) {
  return String(n || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
}

// Everyone who signed up under one contestant during the contest, with
// each check that decides whether they count, plus warning signs for a
// manual review (same network/phone as the contestant, repeated names,
// sign-ups seconds apart). Warning signs are hints, not proof.
async function friendsReport(contest, referrerId) {
  const start = new Date(contest.startsAt);
  const end = new Date(contest.endsAt);
  const until = new Date(Math.min(Date.now(), end.getTime()));
  const minAmt = Number(contest.minQualifyingAmount || 0);
  const out = new Set(Array.isArray(contest.disqualified) ? contest.disqualified : []);
  const needVerify = contest.requireVerified !== false;

  const referrer = await prisma.customer.findUnique({
    where: { id: referrerId },
    select: { id: true, name: true, phone: true, email: true, username: true, kycType: true, bankAccountAt: true, active: true, deletedAt: true, createdAt: true, signupIpHash: true, lastIpHash: true, signupDeviceHash: true, lastLoginFingerprint: true },
  });
  if (!referrer) return null;

  const friends = await prisma.customer.findMany({
    where: { referredById: referrerId, createdAt: { gte: start, lt: end } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, phone: true, email: true, username: true, active: true, deletedAt: true, createdAt: true, kycType: true, bankAccountAt: true, signupIpHash: true, lastIpHash: true, signupDeviceHash: true, lastLoginFingerprint: true },
  });
  const ids = friends.map((f) => f.id);

  const [orders, transfers, spend] = ids.length ? await Promise.all([
    prisma.order.findMany({ where: { customerId: { in: ids }, status: 'SUCCESS', createdAt: { gte: start, lte: until } }, orderBy: { createdAt: 'asc' }, select: { customerId: true, service: true, provider: true, amount: true, createdAt: true } }),
    prisma.bankTransfer.findMany({ where: { customerId: { in: ids }, status: 'SUCCESS', createdAt: { gte: start, lte: until } }, orderBy: { createdAt: 'asc' }, select: { customerId: true, amount: true, bankName: true, createdAt: true } }),
    prisma.order.groupBy({ by: ['customerId'], where: { customerId: { in: ids }, status: 'SUCCESS' }, _sum: { amount: true }, _count: { customerId: true } }),
  ]) : [[], [], []];
  const spendBy = new Map(spend.map((g) => [g.customerId, { total: Number(g._sum.amount || 0), count: g._count.customerId }]));

  const refIps = new Set([referrer.signupIpHash, referrer.lastIpHash].filter(Boolean));
  const refDevices = new Set([referrer.signupDeviceHash, referrer.lastLoginFingerprint].filter(Boolean));
  const refWords = normName(referrer.name);
  const ipCount = new Map();
  const nameCount = new Map();
  for (const f of friends) {
    for (const h of new Set([f.signupIpHash, f.lastIpHash].filter(Boolean))) ipCount.set(h, (ipCount.get(h) || 0) + 1);
    const key = normName(f.name).sort().join(' ');
    if (key) nameCount.set(key, (nameCount.get(key) || 0) + 1);
  }

  const rows = friends.map((f, i) => {
    const firstOrder = orders.find((o) => o.customerId === f.id && (!minAmt || Number(o.amount) >= minAmt));
    const firstTransfer = transfers.find((t) => t.customerId === f.id && (!minAmt || Number(t.amount) >= minAmt));
    const anyActivity = orders.some((o) => o.customerId === f.id) || transfers.some((t) => t.customerId === f.id);
    const firstQ = [firstOrder && { kind: 'Purchase', detail: `${firstOrder.service} ${firstOrder.provider}`, amount: Number(firstOrder.amount), at: firstOrder.createdAt },
      firstTransfer && { kind: 'Bank transfer', detail: firstTransfer.bankName || '', amount: Number(firstTransfer.amount), at: firstTransfer.createdAt }]
      .filter(Boolean).sort((a, b) => new Date(a.at) - new Date(b.at))[0] || null;
    const verifiedAt = f.kycType && f.bankAccountAt ? new Date(f.bankAccountAt) : null;

    const checks = [
      { label: 'Signed up during the contest with this code', ok: true },
      { label: 'Account active (not deactivated or deleted)', ok: f.active && !f.deletedAt },
      needVerify
        ? { label: verifiedAt ? `Verified with ${f.kycType} on ${verifiedAt.toLocaleDateString('en-NG')}` : 'Verified BVN/NIN', ok: Boolean(verifiedAt && verifiedAt <= until) }
        : { label: 'BVN/NIN verification (not required for this contest)', ok: true, optional: true },
      { label: firstQ ? `${firstQ.kind} of ₦${firstQ.amount.toLocaleString('en-NG')} on ${new Date(firstQ.at).toLocaleDateString('en-NG')}` : minAmt && anyActivity ? `Bought/sent something, but under ₦${minAmt.toLocaleString('en-NG')}` : 'Made a purchase or bank transfer', ok: Boolean(firstQ) },
      { label: 'Not removed by admin', ok: !out.has(f.id) && !out.has(referrerId) },
    ];
    const counted = checks.every((c) => c.ok);

    const flags = [];
    if ([f.signupIpHash, f.lastIpHash].some((h) => h && refIps.has(h))) flags.push('Same internet network as the contestant');
    if ([f.signupDeviceHash, f.lastLoginFingerprint].some((h) => h && refDevices.has(h))) flags.push('Same phone model & browser as the contestant (weak sign)');
    const sharedIp = Math.max(0, ...[f.signupIpHash, f.lastIpHash].filter(Boolean).map((h) => (ipCount.get(h) || 1) - 1));
    if (sharedIp > 0) flags.push(`Same internet network as ${sharedIp} other friend${sharedIp === 1 ? '' : 's'}`);
    const words = normName(f.name);
    if ((nameCount.get([...words].sort().join(' ')) || 0) > 1) flags.push('Same name as another friend');
    if (refWords.length > 1 && words.includes(refWords[refWords.length - 1])) flags.push('Shares a name with the contestant (could be family)');
    const prev = friends[i - 1];
    const next = friends[i + 1];
    const gap = (a, b) => Math.abs(new Date(a.createdAt) - new Date(b.createdAt));
    if ((prev && gap(prev, f) < 3 * 60 * 1000) || (next && gap(next, f) < 3 * 60 * 1000)) flags.push('Signed up within 3 minutes of another friend');
    const sp = spendBy.get(f.id) || { total: 0, count: 0 };
    if (counted && sp.count <= 1 && firstQ && firstQ.amount <= Math.max(minAmt, 200)) flags.push('Only one small purchase so far');

    return {
      id: f.id,
      name: f.name,
      phone: f.phone,
      email: f.email,
      username: f.username,
      joinedAt: f.createdAt,
      status: f.deletedAt ? 'deleted' : f.active ? 'active' : 'deactivated',
      verification: verifiedAt ? { type: f.kycType, at: verifiedAt } : null,
      firstQualifying: firstQ,
      lifetime: sp,
      checks,
      counted,
      excluded: out.has(f.id),
      flags,
    };
  });

  return {
    contestant: { id: referrer.id, name: referrer.name, phone: referrer.phone, email: referrer.email, username: referrer.username, verified: referrer.kycType || null, excluded: out.has(referrer.id) },
    summary: { total: rows.length, counted: rows.filter((r) => r.counted).length, flagged: rows.filter((r) => r.flags.length).length },
    friends: rows,
  };
}

module.exports = { friendsReport, standings, pickWinners, finalizeContest, payWinners, armContestTimer, phase, maskName, prizeList, ordinal };
