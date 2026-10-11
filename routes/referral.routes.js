const express = require('express');
const prisma = require('../lib/prisma');
const { getSettings } = require('../lib/vtpass');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');

const router = express.Router();

// Public: lets the signup page show "Invited by Ridwan" and the
// landing page show the current bonus without logging in.
router.get('/referrals/info', async (req, res) => {
  try {
    const settings = await getSettings();
    const plus = require('../lib/referralPlus');
    const eff = plus.effective(settings);
    const out = {
      enabled: settings.referralEnabled,
      bonusAmount: eff.bonus,
      minPurchase: Number(settings.referralMinPurchase),
      friendFunded: Boolean(settings.rewardSplitEnabled),
      spendTarget: eff.target,
      welcomeBonus: settings.cashbackSeparate ? Number(settings.referralWelcomeBonus || 0) : 0,
      boostUntil: eff.boost?.until || null,
    };
    const code = String(req.query.code || '').trim().toLowerCase();
    if (code) {
      const referrer = await prisma.customer.findFirst({ where: { username: code, active: true }, select: { name: true } });
      out.referrerFirstName = referrer ? referrer.name.split(' ')[0] : null;
    }
    res.json(out);
  } catch (error) {
    console.error('GET /referrals/info failed:', error);
    res.status(500).json({ error: 'Could not load referral info.' });
  }
});

function maskName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
}

router.get('/referrals', requireCustomerAuth, async (req, res) => {
  try {
    await require('../lib/referral').catchUpReferralBonuses(req.customer.customerId);
    const settings = await getSettings();
    const me = await prisma.customer.findUnique({ where: { id: req.customer.customerId }, select: { username: true } });
    const referrals = await prisma.customer.findMany({
      where: { referredById: req.customer.customerId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, name: true, createdAt: true, referralBonusPaidAt: true, referralBonusAmount: true },
    });
    // Friends who already made a qualifying purchase/transfer but got no
    // bonus (e.g. rewards were switched off at the time), so the page
    // can say "Purchased" instead of "Waiting".
    const plus = require('../lib/referralPlus');
    const eff = plus.effective(settings);
    const spendTarget = eff.target;
    const min = spendTarget > 0 ? 0.01 : Number(settings.referralMinPurchase || 0);
    const unpaidIds = referrals.filter((r) => !r.referralBonusPaidAt).map((r) => r.id);
    const purchased = new Set();
    if (unpaidIds.length) {
      const [o, t] = await Promise.all([
        prisma.order.groupBy({ by: ['customerId'], where: { customerId: { in: unpaidIds }, status: 'SUCCESS', amount: { gte: min } } }),
        prisma.bankTransfer.groupBy({ by: ['customerId'], where: { customerId: { in: unpaidIds }, status: 'SUCCESS', amount: { gte: min } } }),
      ]);
      for (const g of [...o, ...t]) purchased.add(g.customerId);
    }
    // Rewards split on: how close each waiting friend is to covering the
    // bonus with their own purchases (shown as a %, never as ₦ earned).
    const progress = new Map();
    if (spendTarget > 0 && settings.referralEnabled) {
      const { spentBy } = require('../lib/referral');
      for (const id of [...purchased].slice(0, 50)) {
        const spent = await spentBy(id).catch(() => 0);
        progress.set(id, Math.min(99, Math.floor((spent / spendTarget) * 100)));
      }
    } else if (settings.rewardSplitEnabled && settings.referralEnabled && Number(settings.referralBonusAmount) > 0) {
      const { earnedFrom } = require('../lib/referral');
      for (const id of [...purchased].slice(0, 50)) {
        const e = await earnedFrom(id, settings).catch(() => 0);
        progress.set(id, Math.min(99, Math.floor((e / Number(settings.referralBonusAmount)) * 100)));
      }
    }
    const earnedAgg = await prisma.walletTransaction.aggregate({ where: { customerId: req.customer.customerId, type: 'REFERRAL_BONUS', status: 'APPROVED' }, _sum: { amount: true } });
    const totalEarned = Number(earnedAgg._sum.amount || 0);
    const meFull = await prisma.customer.findUnique({ where: { id: req.customer.customerId }, select: { referralMilestonesPaid: true } });
    const paidMs = new Set((Array.isArray(meFull?.referralMilestonesPaid) ? meFull.referralMilestonesPaid : []).map(Number));
    const rewardedCount = referrals.filter((r) => r.referralBonusPaidAt).length;
    res.json({
      enabled: settings.referralEnabled,
      bonusAmount: eff.bonus,
      normalBonus: Number(settings.referralBonusAmount),
      boostUntil: eff.boost?.until || null,
      welcomeBonus: settings.cashbackSeparate ? Number(settings.referralWelcomeBonus || 0) : 0,
      milestones: plus.milestones(settings).map((m) => ({ ...m, reached: rewardedCount >= m.count, paid: paidMs.has(m.count) })),
      rewardedCount,
      tickerEnabled: settings.referralTickerEnabled !== false,
      minPurchase: Number(settings.referralMinPurchase),
      friendFunded: Boolean(settings.rewardSplitEnabled),
      spendTarget,
      code: me?.username || null,
      totalEarned,
      referrals: referrals.map((r) => ({
        name: maskName(r.name),
        joinedAt: r.createdAt,
        rewarded: Boolean(r.referralBonusPaidAt),
        purchased: Boolean(r.referralBonusPaidAt) || purchased.has(r.id),
        progress: r.referralBonusPaidAt ? null : progress.get(r.id) ?? null,
        amount: r.referralBonusPaidAt ? Number(r.referralBonusAmount || 0) : null,
      })),
    });
  } catch (error) {
    console.error('GET /referrals failed:', error);
    res.status(500).json({ error: 'Could not load referrals.' });
  }
});

// --- Invite on receipts -----------------------------------------------
// Every shared receipt can carry the sender's referral link + QR code.
const DEFAULT_INVITE = 'Pay bills, buy airtime & data in seconds. Join me on ZAPPI PAY — scan or use my link:';
const cleanMsg = (m) => String(m || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);

// Real recent referral payouts, names masked (for the live ticker).
router.get('/referrals/ticker', async (req, res) => {
  try {
    const settings = await getSettings();
    if (!settings.referralEnabled || settings.referralTickerEnabled === false) return res.json({ items: [] });
    res.json({ items: await require('../lib/referralPlus').ticker(10) });
  } catch (error) {
    console.error('GET /referrals/ticker failed:', error.message);
    res.json({ items: [] });
  }
});

// Admin: friends still working toward the referral bonus, ₦ spent so far.
router.get('/admin/referrals/progress', requireAdminAuth, async (req, res) => {
  try {
    res.json(await require('../lib/referralPlus').adminProgress(100));
  } catch (error) {
    console.error('GET /admin/referrals/progress failed:', error.message);
    res.status(500).json({ error: 'Could not load referral progress.' });
  }
});

router.get('/receipt-invite', requireCustomerAuth, async (req, res) => {
  try {
    const s = await getSettings();
    const me = await prisma.customer.findUnique({ where: { id: req.customer.customerId }, select: { username: true } });
    res.json({ enabled: s.receiptInviteEnabled !== false, message: cleanMsg(s.receiptInviteMessage) || DEFAULT_INVITE, code: me?.username || null });
  } catch (error) {
    res.json({ enabled: false });
  }
});

router.get('/admin/receipt-invite', requireAdminAuth, async (req, res) => {
  const s = await getSettings();
  res.json({ enabled: s.receiptInviteEnabled !== false, message: s.receiptInviteMessage || '', defaultMessage: DEFAULT_INVITE });
});

router.put('/admin/receipt-invite', requireAdminAuth, async (req, res) => {
  try {
    const s = await getSettings();
    const data = {};
    if (req.body?.enabled !== undefined) data.receiptInviteEnabled = Boolean(req.body.enabled);
    if (req.body?.message !== undefined) data.receiptInviteMessage = cleanMsg(req.body.message) || null;
    await prisma.settings.update({ where: { id: s.id }, data });
    require('../lib/vtpass').invalidateSettings();
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'RECEIPT_INVITE', details: data } }).catch(() => {});
    const n = await getSettings();
    res.json({ enabled: n.receiptInviteEnabled !== false, message: n.receiptInviteMessage || '', defaultMessage: DEFAULT_INVITE });
  } catch (error) {
    res.status(500).json({ error: 'Could not save.' });
  }
});

module.exports = router;
