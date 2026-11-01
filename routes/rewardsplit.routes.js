const express = require('express');
const prisma = require('../lib/prisma');
const { requireAdminAuth } = require('../lib/auth');
const { getSettings, invalidateSettings } = require('../lib/vtpass');
const split = require('../lib/rewardSplit');

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
    const cap = require('../lib/rewardCap');
    const { toKobo, nairaNum } = require('../lib/money');
    const m = await cap.month();
    const range = { gte: m.from };
    const [pools, waiting, used, liability, testOrders] = await Promise.all([
      split.balances(),
      prisma.customer.count({ where: { referredById: { not: null }, referralBonusPaidAt: null, deletedAt: null } }).catch(() => 0),
      prisma.cashbackEntry.findMany({ where: { createdAt: range, OR: [{ type: 'USED' }, { type: null, amount: { lt: 0 } }] }, select: { amount: true, amountKobo: true } }).catch(() => []),
      prisma.customer.aggregate({ where: { deletedAt: null }, _sum: { cashbackBalance: true } }).catch(() => null),
      prisma.order.aggregate({ where: { isTest: true, status: 'SUCCESS', createdAt: range }, _count: true, _sum: { amount: true } }).catch(() => null),
    ]);
    const usedK = used.reduce((a, e) => a + Math.abs(e.amountKobo ?? toKobo(e.amount)), 0);
    res.json({
      config: c,
      programmes: split.KEYS.map((k) => ({ key: k, label: split.LABELS[k], on: on[k], share: c.shares[k], pool: split.POOLS.includes(k) })),
      pools,
      waitingReferrals: waiting,
      // Rewards counted when EARNED, against real (non-test) earnings.
      month: {
        from: m.from,
        earned: nairaNum(m.earnedKobo),
        rewardsEarned: nairaNum(m.rewardsKobo),
        givenPct: m.givenPctOfEarnings,
        cap: nairaNum(m.capKobo),
        capPercent: m.capPercent,
        capUsedPct: m.usedPct,
        capReached: m.reached,
        rewardsByType: m.byType,
        cashbackUsed: nairaNum(usedK),
        cashbackLiability: Number(liability?._sum?.cashbackBalance || 0),
        testOrders: { count: testOrders?._count || 0, amount: Number(testOrders?._sum?.amount || 0) },
        // Kept for older screens:
        rewardsPaid: nairaNum(m.rewardsKobo),
        discounts: 0,
      },
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
