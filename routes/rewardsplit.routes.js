const express = require('express');
const prisma = require('../lib/prisma');
const { requireAdminAuth } = require('../lib/auth');
const { getSettings, invalidateSettings } = require('../lib/vtpass');
const split = require('../lib/rewardSplit');
const { earningsReport } = require('../lib/earnings');

// Owner settings for the rewards split (owner-only: not in
// lib/staffAccess.js's support list).
const router = express.Router();
const LAGOS = 60 * 60 * 1000;
const r2 = (n) => Math.round(Number(n) * 100) / 100;

router.get('/admin/reward-split', requireAdminAuth, async (req, res) => {
  try {
    const s = await getSettings();
    const c = split.config(s);
    const on = await split.programmes(s, { shopAgentId: 'x', customerId: 'y' });
    const now = new Date();
    const ymd = new Date(now.getTime() + LAGOS).toISOString().slice(0, 10);
    const monthStart = new Date(new Date(`${ymd.slice(0, 8)}01T00:00:00.000Z`).getTime() - LAGOS);
    const [report, discounts, pools, waiting] = await Promise.all([
      earningsReport({ gte: monthStart, lt: now }).catch(() => null),
      prisma.order.aggregate({ where: { status: 'SUCCESS', createdAt: { gte: monthStart } }, _sum: { discountAmount: true, promoDiscount: true } }).catch(() => null),
      split.balances(),
      prisma.customer.count({ where: { referredById: { not: null }, referralBonusPaidAt: null, deletedAt: null } }).catch(() => 0),
    ]);
    const given = report ? Object.values(report.rewardsByType || {}).reduce((a, b) => a + b, 0) : 0;
    const disc = Number(discounts?._sum?.discountAmount || 0) + Number(discounts?._sum?.promoDiscount || 0);
    res.json({
      config: c,
      programmes: split.KEYS.map((k) => ({ key: k, label: split.LABELS[k], on: on[k], share: c.shares[k], pool: split.POOLS.includes(k) })),
      pools,
      waitingReferrals: waiting,
      month: report ? {
        // What you earn on purchases before rewards (markup after
        // discounts + VTpass commission), plus the discounts themselves.
        earned: r2(Number(report.income.purchaseMarkup || 0) + Number(report.income.vtpassCommission || 0) + disc),
        discounts: r2(disc),
        rewardsPaid: r2(given),
        rewardsByType: report.rewardsByType,
      } : null,
    });
  } catch (error) {
    console.error('GET /admin/reward-split failed:', error);
    res.status(500).json({ error: 'Could not load.' });
  }
});

router.put('/admin/reward-split', requireAdminAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const data = {};
    if (b.enabled !== undefined) data.rewardSplitEnabled = Boolean(b.enabled);
    if (b.pct !== undefined) {
      const p = parseInt(b.pct, 10);
      if (!(p >= 0 && p <= 90)) return res.status(400).json({ error: 'Give back between 0% and 90% of your earnings.' });
      data.rewardSplitPct = p;
    }
    if (b.shares !== undefined) {
      const shares = {};
      for (const k of split.KEYS) {
        const n = Math.round(Number(b.shares?.[k] ?? 0));
        if (!(n >= 0 && n <= 100)) return res.status(400).json({ error: `${split.LABELS[k]} share must be 0–100%.` });
        shares[k] = n;
      }
      const sum = Object.values(shares).reduce((a, x) => a + x, 0);
      if (sum !== 100) return res.status(400).json({ error: `The shares must add up to 100% (now ${sum}%).` });
      data.rewardSplitShares = shares;
    }
    const existing = await getSettings();
    await prisma.settings.update({ where: { id: existing.id }, data });
    invalidateSettings();
    await prisma.auditLog.create({ data: { actorAdminId: req.admin?.adminId || null, action: 'REWARD_SPLIT_UPDATED', details: data } }).catch(() => {});
    res.json({ config: split.config(await getSettings()) });
  } catch (error) {
    console.error('PUT /admin/reward-split failed:', error);
    res.status(500).json({ error: 'Could not save.' });
  }
});

module.exports = router;
