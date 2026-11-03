const express = require('express');
const prisma = require('../lib/prisma');
const { requireAdminAuth } = require('../lib/auth');
const { toKobo, nairaNum } = require('../lib/money');

// Read-only admin views of money records. Nothing here changes anything:
// wallet transactions are never edited or deleted — corrections are new
// rows (a REFUND, a reversal, an admin credit/debit with a reason).
//  GET /admin/ledger            wallet ledger (owner only)
//  GET /admin/refunds           refunds: automatic and manual (owner only)
//  GET /admin/orders/:id/timeline  one order's history (owner + support)
const router = express.Router();

const TYPES = ['FUND', 'DISPUTE_HOLD', 'DISPUTE_RELEASE', 'DISPUTE_RETURN_OUT', 'DISPUTE_RETURN_IN', 'SPRAY_OUT', 'SPRAY_IN', 'DUES_OUT', 'DUES_IN', 'POT_OUT', 'POT_IN', 'SAFEBUY_OUT', 'SAFEBUY_IN', 'PAYROLL_OUT', 'PAYROLL_IN', 'REWARD', 'CIRCLE_OUT', 'CIRCLE_IN', 'DEBIT', 'REFUND', 'TRANSFER_OUT', 'TRANSFER_IN', 'AIRTIME_CASH', 'REFERRAL_BONUS', 'CASHBACK', 'LOYALTY', 'CONTEST_PRIZE', 'COUPON', 'SAVINGS_IN', 'SAVINGS_OUT', 'INTEREST', 'CHALLENGE_REWARD', 'DELIVERY_BONUS', 'SHOP_COMMISSION', 'SMS', 'BILL_PAY'];

async function names(ids) {
  const rows = ids.length ? await prisma.customer.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true, phone: true } }) : [];
  return Object.fromEntries(rows.map((c) => [c.id, c]));
}

// Ledger types that belong to features that are switched off are left
// out of the totals and the type list (nothing is deleted).
async function hiddenTypes(s) {
  const F = require('../lib/features');
  const on = (k) => F.isOnFor(s, k) || Boolean((s.featureTestMode || {})[k]);
  const hide = [];
  if (!on('circles')) hide.push('CIRCLE_');
  const sendOn = on('sendMoney') || Boolean(s.bankTransferEnabled);
  if (!sendOn) hide.push('TRANSFER_', 'DISPUTE_');
  if (!on('airtimeToCash')) hide.push('AIRTIME_CASH');
  return hide;
}
const isHidden = (type, hide) => hide.some((h) => String(type).startsWith(h));

// Real or test: a wallet line is "test" when it belongs to a test order
// or is bank funding through a partner on sandbox keys.
// Refunds carry the order's request ID as their reference. A purchase
// DEBIT is written just before its order (in the same database step), so
// it has no reference: it is linked to the order by customer, time (a few
// seconds apart) and the cash taken (order amount − cashback used).
const PURCHASE_LINK_MS = 10 * 1000;
async function testFlags(rows) {
  const modes = await require('../lib/goLive').partnerModes().catch(() => ({ monnify: 'sandbox', squad: 'sandbox', nomba: 'sandbox' }));
  const refs = [...new Set(rows.map((r) => r.reference).filter(Boolean))];
  const testRefs = new Set(refs.length ? (await prisma.order.findMany({ where: { vtpassRequestId: { in: refs }, isTest: true }, select: { vtpassRequestId: true } })).map((o) => o.vtpassRequestId) : []);
  const fundProvider = (r) => { const p = String(r.providerRef || ''); return /^NB-/.test(p) ? 'nomba' : /^SQ-/.test(p) ? 'squad' : p ? 'monnify' : null; };

  const loose = [...new Map(rows.filter((r) => r.type === 'DEBIT' && !r.reference && r.customerId && r.createdAt && r.id != null).map((r) => [r.id, r])).values()];
  const testDebits = new Set();
  if (loose.length) {
    const times = loose.map((r) => new Date(r.createdAt).getTime());
    const orders = await prisma.order.findMany({
      where: { customerId: { in: [...new Set(loose.map((r) => r.customerId))] }, createdAt: { gte: new Date(Math.min(...times) - PURCHASE_LINK_MS), lte: new Date(Math.max(...times) + PURCHASE_LINK_MS) } },
      select: { id: true, customerId: true, createdAt: true, amount: true, cashbackUsed: true, isTest: true },
    }).catch(() => []);
    const used = new Set();
    for (const r of loose) {
      const at = new Date(r.createdAt).getTime();
      const cashK = toKobo(r.amount);
      let best = null;
      for (const o of orders) {
        if (used.has(o.id) || o.customerId !== r.customerId) continue;
        const gap = Math.abs(new Date(o.createdAt).getTime() - at);
        if (gap > PURCHASE_LINK_MS || toKobo(o.amount) - toKobo(o.cashbackUsed || 0) !== cashK) continue;
        if (!best || gap < best.gap) best = { o, gap };
      }
      if (best) { used.add(best.o.id); if (best.o.isTest) testDebits.add(r.id); }
    }
  }
  return (r) => (r.type === 'DEBIT' && !r.reference && testDebits.has(r.id)) || (r.reference && testRefs.has(r.reference)) || (r.type === 'FUND' && fundProvider(r) && modes[fundProvider(r)] !== 'live');
}

router.get('/admin/ledger', requireAdminAuth, async (req, res) => {
  try {
    const type = TYPES.includes(String(req.query.type || '').toUpperCase()) ? String(req.query.type).toUpperCase() : null;
    const status = ['APPROVED', 'PENDING', 'REJECTED'].includes(String(req.query.status || '').toUpperCase()) ? String(req.query.status).toUpperCase() : null;
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
    const since = new Date(Date.now() - days * 86400000);
    const where = { createdAt: { gte: since }, ...(type ? { type } : {}), ...(status ? { status } : {}) };
    const [rows, approved] = await Promise.all([
      prisma.walletTransaction.findMany({ where, orderBy: { createdAt: 'desc' }, take: 300, select: { id: true, customerId: true, type: true, amount: true, status: true, reference: true, providerRef: true, note: true, reviewedByAdminId: true, createdAt: true } }),
      // Every approved row in the period (not just the 300 shown), for the totals.
      prisma.walletTransaction.findMany({ where: { createdAt: { gte: since }, status: 'APPROVED' }, select: { id: true, customerId: true, type: true, amount: true, reference: true, providerRef: true, createdAt: true } }),
    ]);
    const who = await names(rows.map((r) => r.customerId));
    const hide = await hiddenTypes(await require('../lib/vtpass').getSettings());
    const isTest = await testFlags([...rows, ...approved]);
    const mode = ['real', 'test', 'all'].includes(String(req.query.mode)) ? String(req.query.mode) : 'real';
    const keep = (t) => (mode === 'all' ? true : mode === 'test' ? t : !t);
    const shownRows = rows.map((r) => ({ ...r, isTest: Boolean(isTest(r)) })).filter((r) => keep(r.isTest));
    // Totals follow the Real / Test / All switch, the same way as the rows.
    const byType = {};
    for (const r of approved) {
      if (!keep(Boolean(isTest(r)))) continue;
      const t = (byType[r.type] = byType[r.type] || { type: r.type, count: 0, kobo: 0 });
      t.count += 1;
      t.kobo += toKobo(r.amount);
    }
    res.json({
      days,
      mode,
      hiddenTypes: hide,
      note: 'Wallet records are never edited or deleted — a correction is always a new row.',
      totals: Object.values(byType).filter((t) => !isHidden(t.type, hide)).map((t) => ({ type: t.type, count: t.count, amount: nairaNum(t.kobo) })).sort((a, b) => b.amount - a.amount),
      rows: shownRows.map(({ providerRef, ...r }) => ({ ...r, amount: nairaNum(toKobo(r.amount)), manual: Boolean(r.reviewedByAdminId), customer: who[r.customerId] || null })),
    });
  } catch (error) {
    console.error('GET /admin/ledger failed:', error);
    res.status(500).json({ error: 'Could not load the ledger.' });
  }
});

router.get('/admin/refunds', requireAdminAuth, async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
    const since = new Date(Date.now() - days * 86400000);
    const refunds = await prisma.walletTransaction.findMany({ where: { type: 'REFUND', createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 300, select: { id: true, customerId: true, amount: true, status: true, reference: true, note: true, reviewedByAdminId: true, createdAt: true } });
    const refs = refunds.map((r) => r.reference).filter(Boolean);
    const [orders, returned, escalations] = await Promise.all([
      refs.length ? prisma.order.findMany({ where: { vtpassRequestId: { in: refs } }, select: { id: true, vtpassRequestId: true, service: true, provider: true, amount: true, cashbackUsed: true, status: true, isTest: true } }) : [],
      prisma.cashbackEntry.findMany({ where: { type: { in: ['RETURNED', 'ADJUSTMENT'] }, createdAt: { gte: since }, orderId: { not: null } }, select: { orderId: true, amountKobo: true, amount: true } }).catch(() => []),
      prisma.escalation ? prisma.escalation.findMany({ where: { type: 'ORDER_REFUND', createdAt: { gte: since } }, select: { id: true, ref: true, orderId: true, reason: true, status: true, createdAt: true } }).catch(() => []) : [],
    ]);
    const orderBy = Object.fromEntries(orders.map((o) => [o.vtpassRequestId, o]));
    const cbBy = {};
    for (const e of returned) cbBy[e.orderId] = (cbBy[e.orderId] || 0) + (e.amountKobo ?? toKobo(e.amount));
    const escBy = Object.fromEntries(escalations.filter((e) => e.orderId).map((e) => [e.orderId, e]));
    const who = await names(refunds.map((r) => r.customerId));
    // Real or test (default real): a refund is "test" when its order is a test order.
    const mode = ['real', 'test', 'all'].includes(String(req.query.mode)) ? String(req.query.mode) : 'real';
    const shown = refunds.filter((r) => { const t = Boolean(orderBy[r.reference]?.isTest); return mode === 'all' ? true : mode === 'test' ? t : !t; });
    res.json({
      days,
      mode,
      rows: shown.map((r) => {
        const o = orderBy[r.reference] || null;
        const cashK = toKobo(r.amount);
        const cbK = o ? cbBy[o.id] || 0 : 0;
        const esc = o ? escBy[o.id] : null;
        return {
          id: r.id,
          createdAt: r.createdAt,
          customer: who[r.customerId] || null,
          cash: nairaNum(cashK),
          cashbackReturned: nairaNum(cbK),
          orderPaid: o ? nairaNum(toKobo(o.amount)) : null,
          // Exact: cash back + cashback back = what the order took.
          adds: o ? cashK + cbK === toKobo(o.amount) || /partial|not delivered/i.test(String(r.note || '')) : null,
          order: o ? { id: o.id, service: o.service, provider: o.provider, status: o.status, isTest: o.isTest } : null,
          how: esc ? 'Manual (approved request)' : r.reviewedByAdminId ? 'Manual (admin)' : 'Automatic',
          reason: esc?.reason || r.note || null,
          requestRef: esc?.ref || null,
        };
      }),
    });
  } catch (error) {
    console.error('GET /admin/refunds failed:', error);
    res.status(500).json({ error: 'Could not load refunds.' });
  }
});

// One order's history, oldest first, from the records that already exist.
router.get('/admin/orders/:id/timeline', requireAdminAuth, async (req, res) => {
  try {
    const o = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!o) return res.status(404).json({ error: 'Order not found.' });
    const [tx, cb, audits, tickets] = await Promise.all([
      o.vtpassRequestId ? prisma.walletTransaction.findMany({ where: { customerId: o.customerId, reference: o.vtpassRequestId }, orderBy: { createdAt: 'asc' }, select: { type: true, amount: true, status: true, note: true, createdAt: true } }) : [],
      prisma.cashbackEntry.findMany({ where: { orderId: o.id }, orderBy: { createdAt: 'asc' }, select: { type: true, amount: true, amountKobo: true, note: true, createdAt: true } }).catch(() => []),
      prisma.auditLog.findMany({ where: { OR: [{ details: { path: ['orderId'], equals: o.id } }, { details: { path: ['id'], equals: o.id } }] }, orderBy: { createdAt: 'asc' }, take: 30, select: { action: true, createdAt: true, actorAdminId: true } }).catch(() => []),
      prisma.supportTicket.findMany({ where: { orderId: o.id }, orderBy: { createdAt: 'asc' }, select: { id: true, status: true, createdAt: true } }).catch(() => []),
    ]);
    const ev = [{ at: o.createdAt, what: 'Order placed — wallet debited, sent to the provider', status: 'PENDING' }];
    // The purchase debit has no reference; it is created with the order.
    for (const t of tx) ev.push({ at: t.createdAt, what: `${t.type === 'REFUND' ? 'Refund to wallet' : t.type} ₦${nairaNum(toKobo(t.amount)).toLocaleString()}${t.note ? ` — ${t.note}` : ''}` });
    for (const e of cb) ev.push({ at: e.createdAt, what: `Cashback ${String(e.type || (Number(e.amount) < 0 ? 'USED' : 'EARNED')).toLowerCase()} ₦${Math.abs(nairaNum(e.amountKobo ?? toKobo(e.amount))).toLocaleString()}` });
    for (const a of audits) ev.push({ at: a.createdAt, what: `Admin action: ${String(a.action).replace(/_/g, ' ').toLowerCase()}` });
    for (const t of tickets) ev.push({ at: t.createdAt, what: `Customer reported an issue (ticket ${t.status.toLowerCase()})` });
    if (o.status !== 'PENDING') ev.push({ at: null, what: `Now: ${o.status}${o.vtpassStatus ? ` (provider says “${o.vtpassStatus}”)` : ''}`, status: o.status });
    ev.sort((a, b) => (a.at && b.at ? new Date(a.at) - new Date(b.at) : a.at ? -1 : 1));
    res.json({ orderId: o.id, providerReference: o.vtpassRequestId, status: o.status, isTest: o.isTest, events: ev });
  } catch (error) {
    console.error('GET /admin/orders/:id/timeline failed:', error);
    res.status(500).json({ error: 'Could not load the order history.' });
  }
});

// Dashboard: what customers hold (owed to them), from the database only.
router.get('/admin/overview-totals', requireAdminAuth, async (req, res) => {
  try {
    const a = await prisma.customer.aggregate({ where: { deletedAt: null }, _sum: { walletBalance: true, cashbackBalance: true, savingsBalance: true }, _count: true });
    const w = toKobo(a._sum.walletBalance || 0);
    const c = toKobo(a._sum.cashbackBalance || 0);
    const s = toKobo(a._sum.savingsBalance || 0);
    res.json({ customers: typeof a._count === 'number' ? a._count : a._count?._all || 0, wallets: nairaNum(w), cashback: nairaNum(c), savings: nairaNum(s), owedTotal: nairaNum(w + c + s) });
  } catch (error) {
    console.error('GET /admin/overview-totals failed:', error);
    res.status(500).json({ error: 'Could not load totals.' });
  }
});

// Each partner and its mode, for the admin test-mode banner.
router.get('/admin/partner-modes', requireAdminAuth, async (req, res) => {
  try {
    const s = await require('../lib/vtpass').getSettings();
    const modes = await require('../lib/goLive').partnerModes();
    const on = {
      monnify: s.monnifyFundingEnabled !== false,
      squad: await require('../lib/squad').fundingOn().catch(() => false),
      nomba: await require('../lib/nomba').fundingOn().catch(() => false),
    };
    res.json({
      partners: [
        { key: 'vtpass', name: 'VTpass', mode: s.vtpassMode === 'live' ? 'live' : 'sandbox', on: true, what: 'purchases' },
        { key: 'monnify', name: 'Monnify', mode: modes.monnify, on: on.monnify, what: 'account numbers' },
        { key: 'squad', name: 'Squad (GTBank)', mode: modes.squad, on: on.squad, what: 'account numbers' },
        { key: 'nomba', name: 'Nomba', mode: modes.nomba, on: on.nomba, what: 'account numbers' },
      ],
      sendToBank: Boolean(s.bankTransferEnabled),
    });
  } catch (error) {
    console.error('GET /admin/partner-modes failed:', error);
    res.status(500).json({ error: 'Could not load partner modes.' });
  }
});

module.exports = router;
