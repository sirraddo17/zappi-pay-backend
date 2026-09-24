const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');

// Customer statements and the admin profit dashboard.
const router = express.Router();

const CREDIT_TYPES = ['FUND', 'REFUND', 'TRANSFER_IN', 'AIRTIME_CASH', 'REFERRAL_BONUS'];
const DEBIT_TYPES = ['DEBIT', 'TRANSFER_OUT'];

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

// Profit on a purchase = what the customer paid − what VTpass charged
// (costAmount). Bank-transfer fees are added as their own income line.
router.get('/admin/analytics', requireAdminAuth, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90);
    const today = lagosDay(new Date());
    const since = new Date(startOfLagosDay(today).getTime() - (days - 1) * 24 * LAGOS_MS);

    const [orders, transfers, failedOrders] = await Promise.all([
      prisma.order.findMany({
        where: { status: 'SUCCESS', createdAt: { gte: since } },
        select: { service: true, amount: true, costAmount: true, createdAt: true },
      }),
      prisma.bankTransfer.findMany({
        where: { status: 'SUCCESS', createdAt: { gte: since } },
        select: { fee: true, amount: true, createdAt: true },
      }),
      prisma.order.count({ where: { status: 'FAILED', createdAt: { gte: since } } }),
    ]);

    const dayMap = new Map();
    for (let i = 0; i < days; i += 1) {
      const ymd = lagosDay(new Date(since.getTime() + i * 24 * LAGOS_MS));
      dayMap.set(ymd, { date: ymd, revenue: 0, cost: 0, profit: 0, orders: 0 });
    }
    const services = new Map();
    const round = (n) => Math.round(n * 100) / 100;

    for (const o of orders) {
      const revenue = Number(o.amount);
      const cost = o.costAmount == null ? revenue : Number(o.costAmount);
      const day = dayMap.get(lagosDay(o.createdAt));
      if (day) {
        day.revenue += revenue;
        day.cost += cost;
        day.profit += revenue - cost;
        day.orders += 1;
      }
      const s = services.get(o.service) || { service: o.service, revenue: 0, cost: 0, profit: 0, orders: 0 };
      s.revenue += revenue;
      s.cost += cost;
      s.profit += revenue - cost;
      s.orders += 1;
      services.set(o.service, s);
    }

    let transferFees = 0;
    let transferVolume = 0;
    for (const t of transfers) {
      transferFees += Number(t.fee || 0);
      transferVolume += Number(t.amount);
      const day = dayMap.get(lagosDay(t.createdAt));
      if (day) day.profit += Number(t.fee || 0);
    }

    const daysOut = [...dayMap.values()].map((d) => ({ ...d, revenue: round(d.revenue), cost: round(d.cost), profit: round(d.profit) }));
    const byService = [...services.values()]
      .map((s) => ({ ...s, revenue: round(s.revenue), cost: round(s.cost), profit: round(s.profit) }))
      .sort((a, b) => b.profit - a.profit);
    const revenue = byService.reduce((s, x) => s + x.revenue, 0);
    const purchaseProfit = byService.reduce((s, x) => s + x.profit, 0);

    res.json({
      days: daysOut,
      byService,
      totals: {
        revenue: round(revenue),
        purchaseProfit: round(purchaseProfit),
        transferFees: round(transferFees),
        transferVolume: round(transferVolume),
        profit: round(purchaseProfit + transferFees),
        orders: orders.length,
        failedOrders,
        transfers: transfers.length,
      },
    });
  } catch (error) {
    console.error('GET /admin/analytics failed:', error);
    res.status(500).json({ error: 'Could not load analytics.' });
  }
});

module.exports = router;
