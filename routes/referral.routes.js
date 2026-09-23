const express = require('express');
const prisma = require('../lib/prisma');
const { getSettings } = require('../lib/vtpass');
const { requireCustomerAuth } = require('../lib/auth');

const router = express.Router();

// Public: lets the signup page show "Invited by Ridwan" and the
// landing page show the current bonus without logging in.
router.get('/referrals/info', async (req, res) => {
  try {
    const settings = await getSettings();
    const out = {
      enabled: settings.referralEnabled,
      bonusAmount: Number(settings.referralBonusAmount),
      minPurchase: Number(settings.referralMinPurchase),
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
    const settings = await getSettings();
    const me = await prisma.customer.findUnique({ where: { id: req.customer.customerId }, select: { username: true } });
    const referrals = await prisma.customer.findMany({
      where: { referredById: req.customer.customerId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { name: true, createdAt: true, referralBonusPaidAt: true, referralBonusAmount: true },
    });
    const totalEarned = referrals.reduce((sum, r) => sum + (r.referralBonusPaidAt ? Number(r.referralBonusAmount || 0) : 0), 0);
    res.json({
      enabled: settings.referralEnabled,
      bonusAmount: Number(settings.referralBonusAmount),
      minPurchase: Number(settings.referralMinPurchase),
      code: me?.username || null,
      totalEarned,
      referrals: referrals.map((r) => ({
        name: maskName(r.name),
        joinedAt: r.createdAt,
        rewarded: Boolean(r.referralBonusPaidAt),
        amount: r.referralBonusPaidAt ? Number(r.referralBonusAmount || 0) : null,
      })),
    });
  } catch (error) {
    console.error('GET /referrals failed:', error);
    res.status(500).json({ error: 'Could not load referrals.' });
  }
});

module.exports = router;
