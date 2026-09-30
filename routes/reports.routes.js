const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');

// Customer statements and the admin profit dashboard.
const router = express.Router();

const CREDIT_TYPES = ['FUND', 'REFUND', 'TRANSFER_IN', 'AIRTIME_CASH', 'REFERRAL_BONUS', 'CASHBACK', 'LOYALTY', 'CONTEST_PRIZE', 'COUPON', 'SAVINGS_OUT', 'CHALLENGE_REWARD', 'DELIVERY_BONUS'];
// SAVINGS_IN/OUT move money between the wallet and the savings pocket;
// INTEREST lands in savings, so it doesn't change the wallet.
const DEBIT_TYPES = ['DEBIT', 'TRANSFER_OUT', 'SAVINGS_IN'];

// Days are grouped in Nigerian time (UTC+1).
const LAGOS_MS = 60 * 60 * 1000;
function lagosDay(d) {
  return new Date(new Date(d).getTime() + LAGOS_MS).toISOString().slice(0, 10);
}
function startOfLagosDay(ymd) {
  return new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() - LAGOS_MS);
}

function signed(t) {
  const n = Number(t.amount);
  if (CREDIT_TYPES.includes(t.type)) return n;
  if (DEBIT_TYPES.includes(t.type)) return -n;
  return 0;
}

// --- Spending insights --------------------------------------------------

// "You spent ₦12,400 this month, mostly on data" + the last 6 months.
router.get('/insights', requireCustomerAuth, async (req, res) => {
  try {
    const id = req.customer.customerId;
    const months = [];
    const now = lagosDay(new Date());
    let y = Number(now.slice(0, 4));
    let m = Number(now.slice(5, 7));
    for (let i = 0; i < 6; i += 1) {
      months.unshift(`${y}-${String(m).padStart(2, '0')}`);
      m -= 1;
      if (m === 0) { m = 12; y -= 1; }
    }
    const from = startOfLagosDay(`${months[0]}-01`);
    const [orders, transfers, sent] = await Promise.all([
      prisma.order.findMany({ where: { customerId: id, status: 'SUCCESS', createdAt: { gte: from } }, select: { service: true, amount: true, createdAt: true }, take: 5000 }),
      prisma.bankTransfer.findMany({ where: { customerId: id, status: 'SUCCESS', createdAt: { gte: from } }, select: { amount: true, fee: true, createdAt: true }, take: 2000 }),
      prisma.walletTransaction.findMany({ where: { customerId: id, type: 'TRANSFER_OUT', status: 'APPROVED', createdAt: { gte: from } }, select: { amount: true, createdAt: true }, take: 2000 }),
    ]);
    const byMonth = Object.fromEntries(months.map((k) => [k, { month: k, total: 0, byCategory: {} }]));
    const add = (when, cat, amt) => {
      const k = lagosDay(when).slice(0, 7);
      if (!byMonth[k]) return;
      byMonth[k].total += amt;
      byMonth[k].byCategory[cat] = (byMonth[k].byCategory[cat] || 0) + amt;
    };
    orders.forEach((o) => add(o.createdAt, o.service, Number(o.amount)));
    transfers.forEach((t) => add(t.createdAt, 'BANK_TRANSFER', Number(t.amount) + Number(t.fee || 0)));
    sent.forEach((t) => add(t.createdAt, 'SENT_TO_FRIENDS', Number(t.amount)));
    const list = months.map((k) => {
      const e = byMonth[k];
      const cats = Object.entries(e.byCategory).map(([category, amount]) => ({ category, amount: Math.round(amount * 100) / 100 })).sort((a, b) => b.amount - a.amount);
      return { month: k, total: Math.round(e.total * 100) / 100, categories: cats };
    });
    const current = list[list.length - 1];
    const previous = list[list.length - 2];
    res.json({ months: list, current, previous, top: current.categories[0] || null });
  } catch (error) {
    console.error('GET /insights failed:', error);
    res.status(500).json({ error: 'Could not load your spending.' });
  }
});

// --- Customer statement -----------------------------------------------

// Only approved transactions change the balance, so only they appear.
// Closing balance = today's balance minus everything after the period;
// opening = closing minus the period's net movement.
router.get('/wallet/statement', requireCustomerAuth, async (req, res) => {
  try {
    const today = lagosDay(new Date());
    const fromYmd = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : `${today.slice(0, 8)}01`;
    const toYmd = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;
    const from = startOfLagosDay(fromYmd);
    const to = new Date(startOfLagosDay(toYmd).getTime() + 24 * LAGOS_MS);
    if (to <= from) return res.status(400).json({ error: 'The end date must be after the start date.' });
    if (to - from > 367 * 24 * LAGOS_MS) return res.status(400).json({ error: 'A statement can cover at most one year.' });

    const id = req.customer.customerId;
    const [customer, inRange, after] = await Promise.all([
      prisma.customer.findUnique({ where: { id }, select: { name: true, phone: true, email: true, username: true, walletBalance: true } }),
      prisma.walletTransaction.findMany({
        where: { customerId: id, status: 'APPROVED', createdAt: { gte: from, lt: to } },
        orderBy: { createdAt: 'asc' },
        take: 2000,
      }),
      prisma.walletTransaction.findMany({
        where: { customerId: id, status: 'APPROVED', createdAt: { gte: to } },
        select: { type: true, amount: true },
      }),
    ]);

    const closing = Number(customer.walletBalance) - after.reduce((s, t) => s + signed(t), 0);
    const net = inRange.reduce((s, t) => s + signed(t), 0);
    const opening = closing - net;
    let running = opening;
    const transactions = inRange.map((t) => {
      running += signed(t);
      return {
        id: t.id,
        date: t.createdAt,
        type: t.type,
        note: t.note,
        reference: t.reference,
        credit: signed(t) > 0 ? Number(t.amount) : 0,
        debit: signed(t) < 0 ? Number(t.amount) : 0,
        balance: Math.round(running * 100) / 100,
      };
    });

    res.json({
      customer: { name: customer.name, phone: customer.phone, email: customer.email, username: customer.username },
      from: fromYmd,
      to: toYmd,
      opening: Math.round(opening * 100) / 100,
      closing: Math.round(closing * 100) / 100,
      totalCredits: transactions.reduce((s, t) => s + t.credit, 0),
      totalDebits: transactions.reduce((s, t) => s + t.debit, 0),
      transactions,
    });
  } catch (error) {
    console.error('GET /wallet/statement failed:', error);
    res.status(500).json({ error: 'Could not build your statement.' });
  }
});

// --- Admin profit dashboard -------------------------------------------

// Profit = markup + VTpass commission + fees you charge − Monnify's
// fees − rewards paid (see lib/earnings.js for every line).
router.get('/admin/analytics', requireAdminAuth, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
    const today = lagosDay(new Date());
    const since = new Date(startOfLagosDay(today).getTime() - (days - 1) * 24 * LAGOS_MS);
    const dayList = [];
    for (let i = 0; i < days; i += 1) dayList.push(lagosDay(new Date(since.getTime() + i * 24 * LAGOS_MS)));

    const [report, failedOrders] = await Promise.all([
      require('../lib/earnings').earningsReport({ gte: since }, { dayOf: lagosDay, days: dayList }),
      prisma.order.count({ where: { status: 'FAILED', createdAt: { gte: since } } }),
    ]);
    const purchaseProfit = report.income.purchaseMarkup + report.income.vtpassCommission;

    res.json({
      days: report.days,
      byService: report.byService,
      breakdown: { income: report.income, costs: report.costs, rewardsByType: report.rewardsByType },
      totals: {
        revenue: report.sales,
        purchaseProfit: Math.round(purchaseProfit * 100) / 100,
        transferFees: report.income.sendToBankFees,
        transferVolume: report.transferVolume,
        bankFundingVolume: report.bankFundingVolume,
        profit: report.profit,
        orders: report.orders,
        commissionExactOrders: report.commissionExactOrders,
        failedOrders,
        transfers: report.transfers,
      },
    });
  } catch (error) {
    console.error('GET /admin/analytics failed:', error);
    res.status(500).json({ error: 'Could not load analytics.' });
  }
});

// "What do I make if a customer spends ₦X on this?" (Earnings calculator)
router.post('/admin/earnings/estimate', requireAdminAuth, async (req, res) => {
  try {
    const settings = await require('../lib/vtpass').getSettings();
    const b = req.body || {};
    const one = (x) => require('../lib/earnings').estimateSale({ service: String(x.service || ''), provider: x.provider, amount: x.amount, funding: x.funding === 'bank' ? 'bank' : 'wallet', agent: Boolean(x.agent) }, settings);
    if (Array.isArray(b.items)) return res.json({ results: b.items.slice(0, 40).map(one) });
    res.json(one(b));
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not calculate.' });
  }
});

module.exports = router;
