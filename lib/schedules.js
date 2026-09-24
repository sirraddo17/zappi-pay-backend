const prisma = require('./prisma');
const { notify } = require('./notify');
const { performPurchase } = require('./purchase');

const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY'];
const MAX_SCHEDULES = 20;
const MAX_BENEFICIARIES = 50;
const PAUSE_AFTER_FAILURES = 3;

// Next run after `from`, keeping the same time of day. Monthly runs on
// the same date, clamped to the last day of shorter months (31st → 30th
// / 28th) so it never skips a month.
function nextRunAfter(from, frequency, anchorDay) {
  const d = new Date(from);
  if (frequency === 'DAILY') {
    d.setDate(d.getDate() + 1);
  } else if (frequency === 'WEEKLY') {
    d.setDate(d.getDate() + 7);
  } else {
    const day = anchorDay || d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
  }
  return d;
}

async function createSchedule(customerId, input) {
  const count = await prisma.scheduledPurchase.count({ where: { customerId } });
  if (count >= MAX_SCHEDULES) throw new Error('Schedule limit reached');
  const now = new Date();
  setImmediate(() => module.exports.kickScheduler());
  return prisma.scheduledPurchase.create({
    data: {
      customerId,
      service: input.service,
      serviceID: input.serviceID,
      variationCode: input.variationCode || null,
      meterType: input.meterType || null,
      billersCode: input.billersCode,
      phone: input.phone,
      amount: input.variationCode ? null : Number(input.amount),
      frequency: input.frequency,
      anchorDay: now.getDate(),
      nickname: input.nickname ? String(input.nickname).slice(0, 40) : null,
      nextRunAt: nextRunAfter(now, input.frequency, now.getDate()),
    },
  });
}

async function upsertBeneficiary(customerId, { service, serviceID, billersCode, meterType, nickname }) {
  const clean = String(billersCode).trim();
  const existing = await prisma.beneficiary.findFirst({ where: { customerId, service, serviceID, billersCode: clean } });
  const data = {
    nickname: nickname ? String(nickname).trim().slice(0, 40) || null : existing?.nickname || null,
    meterType: meterType || existing?.meterType || null,
    lastUsedAt: new Date(),
  };
  if (existing) return prisma.beneficiary.update({ where: { id: existing.id }, data });
  const count = await prisma.beneficiary.count({ where: { customerId } });
  if (count >= MAX_BENEFICIARIES) throw new Error('Beneficiary limit reached');
  return prisma.beneficiary.create({ data: { customerId, service, serviceID, billersCode: clean, ...data } });
}

function describe(s) {
  return s.nickname || `${s.service.toLowerCase()} for ${s.billersCode}`;
}

// Runs every due schedule once. Each schedule is "claimed" by moving
// its nextRunAt forward in a conditional update before buying, so even
// if two server instances ran this at the same moment, a top-up can
// never be bought twice for the same slot.
async function runDueSchedules() {
  const now = new Date();
  const due = await prisma.scheduledPurchase.findMany({
    where: { active: true, nextRunAt: { lte: now } },
    orderBy: { nextRunAt: 'asc' },
    take: 25,
  });

  for (const s of due) {
    // If the server was asleep for days, skip missed slots rather than
    // buying several at once — one purchase now, next one on schedule.
    let next = nextRunAfter(s.nextRunAt, s.frequency, s.anchorDay);
    while (next <= now) next = nextRunAfter(next, s.frequency, s.anchorDay);

    const claim = await prisma.scheduledPurchase.updateMany({
      where: { id: s.id, nextRunAt: s.nextRunAt, active: true },
      data: { nextRunAt: next, lastRunAt: now },
    });
    if (claim.count !== 1) continue;

    let result;
    try {
      result = await performPurchase(
        s.customerId,
        {
          service: s.service,
          serviceID: s.serviceID,
          variationCode: s.variationCode || undefined,
          meterType: s.meterType || undefined,
          billersCode: s.billersCode,
          phone: s.phone,
          amount: s.amount ? Number(s.amount) : undefined,
        },
        { source: 'schedule' }
      );
    } catch (error) {
      console.error('runDueSchedules purchase crashed:', error);
      result = { status: 500, body: { error: 'Unexpected error.' } };
    }

    if (result.status === 201) {
      await prisma.scheduledPurchase.update({
        where: { id: s.id },
        data: { lastStatus: 'SUCCESS', lastError: null, failCount: 0 },
      });
      continue;
    }

    const failCount = s.failCount + 1;
    const pause = failCount >= PAUSE_AFTER_FAILURES || result.status === 403 || result.status === 404;
    await prisma.scheduledPurchase.update({
      where: { id: s.id },
      data: { lastStatus: 'FAILED', lastError: String(result.body?.error || 'Failed').slice(0, 200), failCount, active: pause ? false : undefined },
    });

    if (result.body?.code === 'INSUFFICIENT_BALANCE') {
      notify(
        s.customerId,
        'Scheduled Top-up Skipped',
        `Your scheduled ${describe(s)} couldn't run because your wallet balance is too low. Fund your wallet so the next one goes through.${pause ? ' It has been paused after 3 misses — resume it under Saved & Scheduled.' : ''}`
      );
    } else if (pause) {
      notify(s.customerId, 'Scheduled Top-up Paused', `Your scheduled ${describe(s)} has been paused after repeated failures: ${result.body?.error || 'unknown error'}. You can resume it under Saved & Scheduled.`);
    }
    // Other failures already sent a "Purchase Failed / refunded" notice.
  }
  return due.length;
}

// Smart timer instead of polling: the free Neon database sleeps after
// 5 idle minutes and only has a limited number of compute hours a
// month. Querying it every few minutes would keep it awake 24/7 and use
// up the month's hours in about two weeks (then the whole app goes down
// until the next month). So we only touch the database when a schedule
// is actually due, plus a light check every 6 hours as a safety net.
const MAX_SLEEP_MS = 6 * 60 * 60 * 1000;
const MIN_SLEEP_MS = 30 * 1000;
let timer = null;
let running = false;

function arm(ms) {
  clearTimeout(timer);
  timer = setTimeout(tick, Math.max(MIN_SLEEP_MS, Math.min(ms, MAX_SLEEP_MS)));
}

async function tick() {
  if (running) return;
  running = true;
  try {
    await runDueSchedules();
    const next = await prisma.scheduledPurchase.findFirst({
      where: { active: true },
      orderBy: { nextRunAt: 'asc' },
      select: { nextRunAt: true },
    });
    arm(next ? next.nextRunAt.getTime() - Date.now() + 1000 : MAX_SLEEP_MS);
  } catch (e) {
    console.error('Scheduler tick failed:', e);
    arm(15 * 60 * 1000);
  } finally {
    running = false;
  }
}

// Called when a schedule is created or resumed, so the timer re-aims at
// the (possibly earlier) next due time.
function kickScheduler() {
  if (process.env.DISABLE_SCHEDULER === '1') return;
  arm(MIN_SLEEP_MS);
}

function startScheduler() {
  if (timer || process.env.DISABLE_SCHEDULER === '1') return;
  arm(20 * 1000);
}

module.exports = { FREQUENCIES, nextRunAfter, createSchedule, upsertBeneficiary, runDueSchedules, startScheduler, kickScheduler };
