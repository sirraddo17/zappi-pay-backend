const prisma = require('./prisma');
const { getSettings } = require('./vtpass');
const { notify } = require('./notify');

// Savings pocket with daily interest, like OWealth / CashBox.
//
// OFF by default. Paying interest on money customers keep with you is
// regulated in Nigeria (deposit-taking needs a CBN licence), so the
// owner can only switch it on after naming the licence or licensed
// partner it runs under (Settings → Savings). While it's off nobody
// can move money in and no interest is paid, but anyone who already
// has savings can always move it back to their wallet.
//
// Interest is worked out once a day, just after midnight Nigerian
// time, on the LOWEST the pocket held since the previous run (so money
// moved in at 11:59pm and out at 12:01am earns nothing), capped at the
// maximum balance that earns interest, and scaled down if the total
// for the day would pass the daily budget. It's added to the savings
// pocket, so it compounds.

const LAGOS = 60 * 60 * 1000;
const lagosYmd = (d = new Date()) => new Date(d.getTime() + LAGOS).toISOString().slice(0, 10);
const startOfLagosDay = (ymd) => new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() - LAGOS);
const kobo = (n) => Math.floor(Number(n) * 100) / 100;
const naira = (n) => `₦${Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

class SavingsError extends Error {}

function config(s) {
  return {
    enabled: Boolean(s.savingsEnabled),
    ratePct: Number(s.savingsRatePct ?? 10),
    minBalance: Number(s.savingsMinBalance ?? 1000),
    maxBalance: Number(s.savingsMaxBalance ?? 500000),
    dailyBudget: Number(s.savingsDailyBudget ?? 5000),
  };
}

function cleanAmount(amount) {
  const n = kobo(amount);
  if (!Number.isFinite(n) || n <= 0) throw new SavingsError('Enter an amount.');
  if (n > 100000000) throw new SavingsError('That amount is too large.');
  return n;
}

// Wallet → savings.
async function deposit(customerId, amount) {
  const cfg = config(await getSettings());
  if (!cfg.enabled) throw new SavingsError('Savings is not available right now.');
  const amt = cleanAmount(amount);
  return prisma.$transaction(async (tx) => {
    const r = await tx.customer.updateMany({
      where: { id: customerId, active: true, deletedAt: null, walletBalance: { gte: amt } },
      data: { walletBalance: { decrement: amt }, savingsBalance: { increment: amt } },
    });
    if (r.count !== 1) throw new SavingsError('Not enough money in your wallet.');
    await tx.walletTransaction.create({ data: { customerId, type: 'SAVINGS_IN', amount: amt, status: 'APPROVED', note: 'Moved to savings' } });
    return tx.customer.findUnique({ where: { id: customerId }, select: { walletBalance: true, savingsBalance: true } });
  });
}

// Savings → wallet. Always allowed, even when savings is switched off.
async function withdraw(customerId, amount) {
  const amt = cleanAmount(amount);
  return prisma.$transaction(async (tx) => {
    const r = await tx.customer.updateMany({
      where: { id: customerId, deletedAt: null, savingsBalance: { gte: amt } },
      data: { savingsBalance: { decrement: amt }, walletBalance: { increment: amt } },
    });
    if (r.count !== 1) throw new SavingsError('You don’t have that much in savings.');
    const c = await tx.customer.findUnique({ where: { id: customerId }, select: { walletBalance: true, savingsBalance: true } });
    await tx.customer.updateMany({ where: { id: customerId, savingsLowBalance: { gt: c.savingsBalance } }, data: { savingsLowBalance: c.savingsBalance } });
    await tx.walletTransaction.create({ data: { customerId, type: 'SAVINGS_OUT', amount: amt, status: 'APPROVED', note: 'Moved from savings to wallet' } });
    return c;
  });
}

function dailyInterest(balance, cfg) {
  const eligible = Math.min(Number(balance), cfg.maxBalance);
  if (eligible < cfg.minBalance || eligible <= 0) return 0;
  return (eligible * cfg.ratePct) / 100 / 365;
}

// Pays today's interest once. Safe to call more than once or from two
// servers: the day is claimed first, and each payment has a unique
// reference so one customer can't be paid twice for the same day.
async function runDailyInterest({ now = new Date() } = {}) {
  const settings = await getSettings();
  const cfg = config(settings);
  if (!cfg.enabled) return { paid: 0, skipped: 'savings is off' };
  const today = lagosYmd(now);
  const claim = await prisma.settings.updateMany({
    where: { id: settings.id, OR: [{ savingsLastRunDate: null }, { savingsLastRunDate: { not: today } }] },
    data: { savingsLastRunDate: today },
  });
  if (claim.count !== 1) return { paid: 0, skipped: 'already paid today' };

  const where = { active: true, deletedAt: null, savingsLowBalance: { gte: cfg.minBalance } };
  const savers = [];
  let cursor;
  for (;;) {
    const page = await prisma.customer.findMany({ where, select: { id: true, savingsLowBalance: true }, orderBy: { id: 'asc' }, take: 500, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) });
    savers.push(...page);
    if (page.length < 500) break;
    cursor = page[page.length - 1].id;
  }
  const total = savers.reduce((s, c) => s + dailyInterest(c.savingsLowBalance, cfg), 0);
  const factor = cfg.dailyBudget > 0 && total > cfg.dailyBudget ? cfg.dailyBudget / total : 1;

  let paid = 0;
  let count = 0;
  for (const c of savers) {
    try {
      const amount = await prisma.$transaction(async (tx) => {
        const fresh = await tx.customer.findUnique({ where: { id: c.id }, select: { savingsLowBalance: true } });
        const low = Math.min(Number(fresh.savingsLowBalance), Number(c.savingsLowBalance));
        const amt = kobo(dailyInterest(low, cfg) * factor);
        if (amt < 0.01) return 0;
        await tx.walletTransaction.create({
          data: { customerId: c.id, type: 'INTEREST', amount: amt, status: 'APPROVED', providerRef: `INT-${today}-${c.id}`, note: `Savings interest (${cfg.ratePct}% a year)` },
        });
        await tx.customer.update({ where: { id: c.id }, data: { savingsBalance: { increment: amt }, savingsEarned: { increment: amt } } });
        return amt;
      });
      paid += amount;
      if (amount) count += 1;
    } catch (error) {
      if (error.code !== 'P2002') console.error('savings interest failed for', c.id, error.message);
    }
  }
  // Start the next day's "lowest balance" from what each pocket holds now.
  await prisma.$executeRawUnsafe('UPDATE "Customer" SET "savingsLowBalance" = "savingsBalance" WHERE "savingsLowBalance" <> "savingsBalance"');
  return { paid: kobo(paid), count, scaledDown: factor < 1 };
}

async function customerSavings(customerId) {
  const [s, c, recent] = await Promise.all([
    getSettings(),
    prisma.customer.findUnique({ where: { id: customerId }, select: { walletBalance: true, savingsBalance: true, savingsLowBalance: true, savingsEarned: true } }),
    prisma.walletTransaction.findMany({ where: { customerId, type: { in: ['SAVINGS_IN', 'SAVINGS_OUT', 'INTEREST'] } }, orderBy: { createdAt: 'desc' }, take: 30 }),
  ]);
  const cfg = config(s);
  const earning = Math.min(Number(c.savingsLowBalance), Number(c.savingsBalance));
  return {
    enabled: cfg.enabled,
    ratePct: cfg.ratePct,
    minBalance: cfg.minBalance,
    maxBalance: cfg.maxBalance,
    walletBalance: Number(c.walletBalance),
    savingsBalance: Number(c.savingsBalance),
    earned: Number(c.savingsEarned),
    // Rough figure shown to the customer; the real one can be lower if
    // the daily budget is reached.
    estimatedTomorrow: cfg.enabled ? kobo(dailyInterest(earning, cfg)) : 0,
    history: recent.map((t) => ({ id: t.id, type: t.type, amount: Number(t.amount), createdAt: t.createdAt })),
  };
}

async function overview() {
  const s = await getSettings();
  const cfg = config(s);
  const since = (days) => new Date(Date.now() - days * 24 * LAGOS);
  const sum = async (where) => Number((await prisma.walletTransaction.aggregate({ where: { type: 'INTEREST', ...where }, _sum: { amount: true } }))._sum.amount || 0);
  const [held, savers, today, last30, allTime, eligible] = await Promise.all([
    prisma.customer.aggregate({ where: { deletedAt: null }, _sum: { savingsBalance: true } }),
    prisma.customer.count({ where: { deletedAt: null, savingsBalance: { gt: 0 } } }),
    sum({ createdAt: { gte: startOfLagosDay(lagosYmd()) } }),
    sum({ createdAt: { gte: since(30) } }),
    sum({}),
    prisma.customer.findMany({ where: { active: true, deletedAt: null, savingsBalance: { gte: cfg.minBalance } }, select: { savingsBalance: true }, take: 5000 }),
  ]);
  const projected = eligible.reduce((t, c) => t + dailyInterest(c.savingsBalance, { ...cfg }), 0);
  return {
    ...cfg,
    partnerNote: s.savingsPartnerNote || '',
    lastRunDate: s.savingsLastRunDate,
    totalHeld: Number(held._sum.savingsBalance || 0),
    savers,
    paidToday: today,
    paid30Days: last30,
    paidAllTime: allTime,
    projectedDaily: kobo(Math.min(projected, cfg.dailyBudget > 0 ? cfg.dailyBudget : projected)),
    projectedDailyUncapped: kobo(projected),
  };
}

// When savings is switched off, tell savers their money is safe and
// can be moved back to the wallet.
async function tellSaversItIsOff() {
  const list = await prisma.customer.findMany({ where: { deletedAt: null, savingsBalance: { gt: 0 } }, select: { id: true, savingsBalance: true }, take: 5000 });
  for (const c of list) {
    notify(c.id, 'Savings interest paused', `Interest on savings is paused. Your ${naira(c.savingsBalance)} is safe — move it to your wallet any time from Wallet → Savings.`);
  }
  return list.length;
}

let timer = null;
function msUntilNextRun() {
  const now = Date.now();
  const at = startOfLagosDay(lagosYmd()).getTime() + 5 * 60 * 1000; // 00:05 Lagos
  return at > now ? at - now : at + 24 * LAGOS - now;
}
function arm() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await runDailyInterest().catch((e) => console.error('savings interest run failed:', e.message));
    arm();
  }, msUntilNextRun());
}
function startSavingsTimer() {
  if (process.env.DISABLE_SCHEDULER === '1') return;
  // If the server was asleep at midnight, pay today's once it wakes.
  setTimeout(() => runDailyInterest().catch(() => {}), 90 * 1000);
  arm();
}

module.exports = { deposit, withdraw, runDailyInterest, customerSavings, overview, tellSaversItIsOff, startSavingsTimer, dailyInterest, SavingsError };
