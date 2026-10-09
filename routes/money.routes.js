const express = require('express');
const prisma = require('../lib/prisma');
const { requireAdminAuth } = require('../lib/auth');
const { vtpassRequest } = require('../lib/vtpass');

// Owner-only money tools (not in lib/staffAccess.js's support list):
// the daily money check and CSV exports for accounting.
const router = express.Router();

const LAGOS = 60 * 60 * 1000;
const lagosYmd = (d = new Date()) => new Date(new Date(d).getTime() + LAGOS).toISOString().slice(0, 10);
const startOfLagosDay = (ymd) => new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() - LAGOS);
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const PENDING_TRANSFER = ['PROCESSING', 'HELD', 'PENDING_AUTHORIZATION'];

async function sum(model, where, fields) {
  const a = await prisma[model].aggregate({ where, _sum: Object.fromEntries(fields.map((f) => [f, true])), _count: true });
  return { count: a._count, ...Object.fromEntries(fields.map((f) => [f, r2(a._sum[f])])) };
}

// "Do I have enough money to cover what customers have in their wallets?"
router.get('/admin/reconciliation', requireAdminAuth, async (req, res) => {
  try {
    res.json(await require('../lib/moneyCheck').moneyCheck(req.query.other));
  } catch (error) {
    console.error('GET /admin/reconciliation failed:', error);
    res.status(500).json({ error: 'Could not work out the money check.' });
  }
});

// Customer-funds guard: is customer money covered, what's safe to withdraw.
router.get('/admin/funds-guard', requireAdminAuth, async (req, res) => {
  try {
    res.json(await require('../lib/fundsGuard').status());
  } catch (error) {
    console.error('GET /admin/funds-guard failed:', error);
    res.status(500).json({ error: 'Could not check customer money right now.' });
  }
});
router.put('/admin/funds-guard', requireAdminAuth, async (req, res) => {
  try {
    if (req.headers['x-admin-assistant']) return res.status(403).json({ error: 'The AI assistant can’t change this.' });
    const enabled = Boolean(req.body?.enabled);
    const s = await prisma.settings.findFirst({ select: { id: true } });
    await prisma.settings.update({ where: { id: s.id }, data: { fundsGuardEnabled: enabled } });
    require('../lib/vtpass').invalidateSettings();
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'FUNDS_GUARD_SETTING', details: { enabled } } }).catch(() => {});
    res.json(await require('../lib/fundsGuard').status());
  } catch (error) {
    console.error('PUT /admin/funds-guard failed:', error);
    res.status(500).json({ error: 'Could not save.' });
  }
});

// --- CSV exports -------------------------------------------------------

// Stops a cell like "=HYPERLINK(...)" from running as a formula when
// the file is opened in Excel.
function cell(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'object' && typeof v.toFixed === 'function') return v.toString(); // Decimal
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(headers, rows) {
  return `﻿${[headers.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n')}\r\n`;
}
const when = (d) => new Date(new Date(d).getTime() + LAGOS).toISOString().replace('T', ' ').slice(0, 19);

const EXPORTS = {
  orders: {
    headers: ['Date (Lagos)', 'Reference', 'Customer', 'Phone', 'Service', 'Provider', 'Recipient', 'Customer paid (₦)', 'VTpass cost (₦)', 'Discount (₦)', 'Promo (₦)', 'Cashback (₦)', 'Status'],
    async rows(range) {
      const list = await prisma.order.findMany({ where: { createdAt: range }, orderBy: { createdAt: 'asc' }, take: 20000, include: { customer: { select: { name: true, phone: true } } } });
      return list.map((o) => [when(o.createdAt), o.vtpassRequestId, o.customer?.name, o.customer?.phone, o.service, o.provider, o.recipient, r2(o.amount), o.costAmount == null ? '' : r2(o.costAmount), r2(o.discountAmount), r2(o.promoDiscount), r2(o.cashbackAmount), o.status]);
    },
  },
  transactions: {
    headers: ['Date (Lagos)', 'Customer', 'Phone', 'Type', 'Amount (₦)', 'Status', 'Reference', 'Note'],
    async rows(range) {
      const list = await prisma.walletTransaction.findMany({ where: { createdAt: range }, orderBy: { createdAt: 'asc' }, take: 20000, include: { customer: { select: { name: true, phone: true } } } });
      return list.map((t) => [when(t.createdAt), t.customer?.name, t.customer?.phone, t.type, r2(t.amount), t.status, t.providerRef || t.reference, t.note]);
    },
  },
  'bank-transfers': {
    headers: ['Date (Lagos)', 'Customer', 'Phone', 'Amount (₦)', 'Fee (₦)', 'Bank', 'Account number', 'Account name', 'Status', 'Reference'],
    async rows(range) {
      const list = await prisma.bankTransfer.findMany({ where: { createdAt: range }, orderBy: { createdAt: 'asc' }, take: 20000, include: { customer: { select: { name: true, phone: true } } } });
      return list.map((t) => [when(t.createdAt), t.customer?.name, t.customer?.phone, r2(t.amount), r2(t.fee), t.bankName, t.accountNumber, t.accountName, t.status, t.reference]);
    },
  },
  customers: {
    headers: ['Joined (Lagos)', 'Name', 'Phone', 'Email', 'Username', 'Wallet (₦)', 'Savings (₦)', 'Agent', 'Verified (BVN/NIN)', 'Status'],
    async rows(range) {
      const list = await prisma.customer.findMany({ where: { createdAt: range, deletedAt: null }, orderBy: { createdAt: 'asc' }, take: 20000 });
      return list.map((c) => [when(c.createdAt), c.name, c.phone, c.email, c.username, r2(c.walletBalance), r2(c.savingsBalance), c.isAgent ? 'Yes' : 'No', c.kycType ? 'Yes' : 'No', c.active ? 'Active' : 'Frozen']);
    },
  },
};

router.get('/admin/export/:kind', requireAdminAuth, async (req, res) => {
  try {
    const ex = EXPORTS[req.params.kind];
    if (!ex) return res.status(404).json({ error: 'Unknown export.' });
    const today = lagosYmd();
    const fromYmd = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : `${today.slice(0, 8)}01`;
    const toYmd = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;
    const from = startOfLagosDay(fromYmd);
    const to = new Date(startOfLagosDay(toYmd).getTime() + 24 * LAGOS);
    if (to <= from) return res.status(400).json({ error: 'The end date must be after the start date.' });
    const rows = await ex.rows({ gte: from, lt: to });
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'EXPORT_CSV', details: { kind: req.params.kind, from: fromYmd, to: toYmd, rows: rows.length } } }).catch(() => {});
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="zappipay-${req.params.kind}-${fromYmd}-to-${toYmd}.csv"`);
    res.send(toCsv(ex.headers, rows));
  } catch (error) {
    console.error('GET /admin/export failed:', error);
    res.status(500).json({ error: 'Could not create the export.' });
  }
});

module.exports = router;
module.exports.toCsv = toCsv;
