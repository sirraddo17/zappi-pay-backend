const prisma = require('./prisma');
const { getSettings } = require('./vtpass');
const { notify } = require('./notify');
const guard = require('./rewardGuard');

// Activity rewards: "buy data 5 times this month, get ₦50 back",
// "spend ₦10,000 on electricity this month", "buy something 5 days in
// a row". Checked after every successful purchase and paid straight
// into the wallet once per period.
//
// Paid from what you earn: with the giveaway safety limit on, a reward
// is never more than rewardGuardPercent % of what you earned on the
// purchases that completed it (after cashback, points and any other
// challenge rewards already paid on them).

const LAGOS = 60 * 60 * 1000;
const DAY = 24 * LAGOS;
const lagosYmd = (d) => new Date(new Date(d).getTime() + LAGOS).toISOString().slice(0, 10);
const startOfLagosDay = (ymd) => new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() - LAGOS);
const kobo = (n) => Math.floor(Number(n) * 100) / 100;
const naira = (n) => `₦${Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

const KINDS = ['COUNT', 'SPEND', 'STREAK'];
const PERIODS = ['WEEKLY', 'MONTHLY', 'ONCE'];
const SERVICES = ['AIRTIME', 'DATA', 'ELECTRICITY', 'CABLE', 'EDUCATION', 'INTERNET', 'BETTING'];

class ChallengeError extends Error {}

// Current window for a challenge: { from, to, key } or null if not running.
function windowFor(ch, now = new Date()) {
  const t = now.getTime();
  if (!ch.active) return null;
  if (ch.startsAt && t < new Date(ch.startsAt).getTime()) return null;
  if (ch.endsAt && t >= new Date(ch.endsAt).getTime()) return null;
  let from;
  let to;
  let key;
  const ymd = lagosYmd(now);
  if (ch.period === 'MONTHLY') {
    from = startOfLagosDay(`${ymd.slice(0, 7)}-01`);
    const [y, m] = ymd.slice(0, 7).split('-').map(Number);
    to = startOfLagosDay(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`);
    key = `M-${ymd.slice(0, 7)}`;
  } else if (ch.period === 'WEEKLY') {
    const day = new Date(`${ymd}T00:00:00.000Z`).getUTCDay(); // 0 = Sunday
    const monday = new Date(startOfLagosDay(ymd).getTime() - ((day + 6) % 7) * DAY);
    from = monday;
    to = new Date(monday.getTime() + 7 * DAY);
    key = `W-${lagosYmd(monday)}`;
  } else {
    from = ch.startsAt ? new Date(ch.startsAt) : new Date(ch.createdAt);
    to = ch.endsAt ? new Date(ch.endsAt) : new Date(8640000000000000);
    key = 'ONCE';
  }
  if (ch.startsAt && new Date(ch.startsAt) > from) from = new Date(ch.startsAt);
  if (ch.endsAt && new Date(ch.endsAt) < to) to = new Date(ch.endsAt);
  return { from, to, key };
}

function qualifies(ch, order) {
  if (order.status !== 'SUCCESS') return false;
  if (ch.service && order.service !== ch.service) return false;
  return Number(order.amount) >= Number(ch.minAmount || 0);
}

// Days in a row with a qualifying purchase, ending today or yesterday.
function streakOf(orders, now) {
  const days = new Set(orders.map((o) => lagosYmd(o.createdAt)));
  let cursor = startOfLagosDay(lagosYmd(now));
  if (!days.has(lagosYmd(cursor))) cursor = new Date(cursor.getTime() - DAY);
  let n = 0;
  while (days.has(lagosYmd(cursor))) {
    n += 1;
    cursor = new Date(cursor.getTime() - DAY);
  }
  return n;
}

function progressOf(ch, orders, now) {
  const list = orders.filter((o) => qualifies(ch, o));
  if (ch.kind === 'COUNT') return { current: list.length, orders: list };
  if (ch.kind === 'SPEND') return { current: Math.floor(list.reduce((s, o) => s + Number(o.amount), 0)), orders: list };
  return { current: streakOf(list, now), orders: list };
}

const ORDER_SELECT = { id: true, customerId: true, service: true, provider: true, amount: true, costAmount: true, discountAmount: true, promoDiscount: true, cashbackAmount: true, pointsEarned: true, responsePayload: true, status: true, createdAt: true, shopCommission: true };

async function ordersSince(customerId, from, to) {
  return prisma.order.findMany({ where: { customerId, status: 'SUCCESS', createdAt: { gte: from, lt: to } }, select: ORDER_SELECT, orderBy: { createdAt: 'asc' }, take: 2000 });
}

// ₦ the safety limit still allows on these purchases. null = no limit.
async function roomFor(customerId, orders, from, settings) {
  if (!guard.enabled(settings)) return null;
  const pointValue = Number(settings.loyaltyPointValue || 0);
  const room = orders.reduce((s, o) => s + (guard.roomForOrder(o, settings, Number(o.cashbackAmount || 0) + Number(o.pointsEarned || 0) * pointValue + Number(o.shopCommission || 0)) || 0), 0);
  const paid = await prisma.challengeReward.aggregate({ where: { customerId, createdAt: { gte: from } }, _sum: { amount: true } });
  return Math.max(0, kobo(room - Number(paid._sum.amount || 0)));
}

async function pay(ch, customerId, win, orders, settings) {
  const full = Number(ch.reward);
  let amount = full;
  const split = Boolean(settings.rewardSplitEnabled);
  // Rewards split on: challenge rewards come out of the challenges pool.
  const room = split ? await require('./rewardSplit').poolBalance('CHALLENGES') : await roomFor(customerId, orders, win.from, settings);
  if (room !== null) amount = Math.min(amount, room);
  if (ch.budget != null) amount = Math.min(amount, Number(ch.budget) - Number(ch.paidTotal));
  amount = kobo(amount);
  if (amount < 1) return 0; // try again after their next purchase
  try {
    await prisma.$transaction(async (tx) => {
      await tx.challengeReward.create({ data: { challengeId: ch.id, customerId, periodKey: win.key, amount, fullAmount: full } });
      const claim = await tx.challenge.updateMany({
        where: { id: ch.id, active: true, ...(ch.budget != null ? { paidTotal: { lte: Number(ch.budget) - amount } } : {}) },
        data: { paidTotal: { increment: amount } },
      });
      if (claim.count !== 1) throw new ChallengeError('budget used up');
      if (split && !(await require('./rewardSplit').takeFromPool(tx, 'CHALLENGES', amount, `Challenge: ${ch.title}`))) throw new ChallengeError('pool short');
      await tx.customer.update({ where: { id: customerId }, data: { walletBalance: { increment: amount } } });
      await tx.walletTransaction.create({ data: { customerId, type: 'CHALLENGE_REWARD', amount, status: 'APPROVED', reference: `CH-${ch.id}-${win.key}`, note: `Challenge reward: ${ch.title}` } });
    });
  } catch (error) {
    if (error.code === 'P2002' || error instanceof ChallengeError) return 0;
    throw error;
  }
  notify(customerId, 'Challenge complete! 🎯', `You completed “${ch.title}” and got ${naira(amount)} in your wallet.`);
  return amount;
}

// Called after a purchase succeeds. Never throws.
async function checkAfterPurchase(order) {
  try {
    if (!order || order.status !== 'SUCCESS') return [];
    const now = new Date();
    const live = (await prisma.challenge.findMany({ where: { active: true } })).filter((ch) => windowFor(ch, now) && qualifies(ch, order));
    if (!live.length) return [];
    const settings = await getSettings();
    const paid = [];
    for (const ch of live) {
      const win = windowFor(ch, now);
      const done = await prisma.challengeReward.findUnique({ where: { challengeId_customerId_periodKey: { challengeId: ch.id, customerId: order.customerId, periodKey: win.key } } });
      if (done) continue;
      const orders = await ordersSince(order.customerId, win.from, win.to);
      const p = progressOf(ch, orders, now);
      if (p.current < ch.target) continue;
      const amt = await pay(ch, order.customerId, win, p.orders, settings);
      if (amt) paid.push({ challengeId: ch.id, amount: amt });
    }
    return paid;
  } catch (error) {
    console.error('challenge check failed:', error.message);
    return [];
  }
}

// Customer view: running challenges with progress.
async function forCustomer(customerId, now = new Date()) {
  const live = (await prisma.challenge.findMany({ where: { active: true }, orderBy: { createdAt: 'desc' } }))
    .map((ch) => ({ ch, win: windowFor(ch, now) }))
    .filter((x) => x.win && (x.ch.budget == null || Number(x.ch.paidTotal) < Number(x.ch.budget)));
  if (!live.length) return [];
  const from = new Date(Math.min(...live.map((x) => x.win.from.getTime())));
  const [orders, rewards] = await Promise.all([
    ordersSince(customerId, from, new Date(now.getTime() + 1000)),
    prisma.challengeReward.findMany({ where: { customerId, challengeId: { in: live.map((x) => x.ch.id) } } }),
  ]);
  return live.map(({ ch, win }) => {
    const inWin = orders.filter((o) => new Date(o.createdAt) >= win.from && new Date(o.createdAt) < win.to);
    const got = rewards.find((r) => r.challengeId === ch.id && r.periodKey === win.key);
    const p = progressOf(ch, inWin, now);
    return {
      id: ch.id,
      title: ch.title,
      description: ch.description,
      kind: ch.kind,
      service: ch.service,
      target: ch.target,
      minAmount: ch.minAmount,
      reward: Number(ch.reward),
      period: ch.period,
      endsAt: win.to.getTime() > 8.6e15 ? null : win.to,
      current: Math.min(p.current, ch.target),
      completed: Boolean(got),
      paid: got ? Number(got.amount) : 0,
    };
  });
}

// Rough "what does a customer finishing this earn me" for the admin.
function preview(input, settings) {
  const { computePrice } = require('./pricing');
  const { estimateCommission } = require('./earnings');
  const service = input.service || 'DATA';
  const perBuy = input.kind === 'SPEND' ? Number(input.target) : Math.max(Number(input.minAmount || 0), 500);
  const buys = input.kind === 'SPEND' ? 1 : Number(input.target);
  const priced = computePrice(perBuy, service, settings);
  const commission = estimateCommission(service, null, perBuy);
  const earn = guard.earningsBeforeRewards({ service, face: perBuy, markedUp: priced.markedUp, commission }) - priced.discountAmount;
  let room = guard.room({ service, face: perBuy, markedUp: priced.markedUp, commission, alreadyGiven: priced.discountAmount }, settings);
  if (room !== null && settings.cashbackEnabled) {
    const pct = Number(settings.cashbackPercentByService?.[service] || 0);
    room -= Math.min((priced.chargeAmount * pct) / 100, Number(settings.cashbackMaxPerOrder || Infinity));
  }
  if (room !== null && settings.loyaltyEnabled) room -= Math.floor((priced.chargeAmount / 100) * Number(settings.loyaltyPointsPer100 || 0)) * Number(settings.loyaltyPointValue || 0);
  const totalEarn = kobo(Math.max(0, earn) * buys);
  const totalRoom = room === null ? null : kobo(Math.max(0, room) * buys);
  const reward = Number(input.reward);
  const what = input.service ? service.toLowerCase() : 'purchases (worked out as data)';
  const label = input.kind === 'SPEND' ? `${naira(perBuy)} of ${what}` : `${buys} × ${naira(perBuy)} ${what}`;
  let note = `A customer who finishes with ${label} earns you about ${naira(totalEarn)}.`;
  if (totalRoom !== null) {
    note += reward > totalRoom
      ? ` Your ${settings.rewardGuardPercent ?? 50}% safety limit allows about ${naira(totalRoom)}, so they'd get that instead of ${naira(reward)} — raise the minimum amount or the target, or lower the reward.`
      : ` The reward fits inside your ${settings.rewardGuardPercent ?? 50}% safety limit (up to ${naira(totalRoom)}).`;
  } else if (reward > totalEarn) {
    note += ` The safety limit is off and the reward is more than you earn — you'd lose money.`;
  }
  return { perBuy, buys, estimatedEarnings: totalEarn, estimatedRoom: totalRoom, fits: totalRoom === null ? reward <= totalEarn : reward <= totalRoom, note };
}

function validate(body, existing) {
  const out = {};
  const pick = (k) => (body[k] !== undefined ? body[k] : existing?.[k]);
  const title = String(pick('title') || '').trim();
  if (title.length < 3 || title.length > 80) throw new ChallengeError('Give it a title (3–80 characters).');
  out.title = title;
  if (body.description !== undefined) out.description = String(body.description || '').trim().slice(0, 200) || null;
  const kind = pick('kind');
  if (!KINDS.includes(kind)) throw new ChallengeError('Choose what customers have to do.');
  out.kind = kind;
  const period = pick('period');
  if (!PERIODS.includes(period)) throw new ChallengeError('Choose how often it resets.');
  out.period = period;
  const service = pick('service') || null;
  if (service && !SERVICES.includes(service)) throw new ChallengeError('Unknown service.');
  out.service = service;
  const target = parseInt(pick('target'), 10);
  const maxTarget = kind === 'SPEND' ? 100000000 : kind === 'STREAK' ? (period === 'WEEKLY' ? 7 : period === 'MONTHLY' ? 31 : 366) : 1000;
  if (!(target >= (kind === 'SPEND' ? 100 : 1) && target <= maxTarget)) throw new ChallengeError(kind === 'STREAK' ? `Days in a row must be between 1 and ${maxTarget}.` : kind === 'SPEND' ? 'Spend target must be at least ₦100.' : 'Number of purchases must be between 1 and 1000.');
  out.target = target;
  const minAmount = parseInt(pick('minAmount') ?? 0, 10) || 0;
  if (minAmount < 0 || minAmount > 10000000) throw new ChallengeError('Minimum purchase is not valid.');
  out.minAmount = minAmount;
  const reward = kobo(pick('reward'));
  if (!(reward >= 1 && reward <= 1000000)) throw new ChallengeError('Reward must be between ₦1 and ₦1,000,000.');
  out.reward = reward;
  const budget = pick('budget');
  out.budget = budget === '' || budget == null ? null : kobo(budget);
  if (out.budget !== null && !(out.budget >= reward)) throw new ChallengeError('The total budget must be at least one reward.');
  for (const k of ['startsAt', 'endsAt']) {
    const v = pick(k);
    out[k] = v ? new Date(v) : null;
    if (out[k] && Number.isNaN(out[k].getTime())) throw new ChallengeError('Enter a valid date.');
  }
  if (period === 'ONCE' && !out.endsAt) throw new ChallengeError('A one-off challenge needs an end date.');
  if (out.startsAt && out.endsAt && out.endsAt <= out.startsAt) throw new ChallengeError('The end date must be after the start date.');
  if (body.active !== undefined) out.active = Boolean(body.active);
  return out;
}

module.exports = { checkAfterPurchase, forCustomer, preview, validate, windowFor, progressOf, streakOf, ChallengeError, KINDS, PERIODS };
