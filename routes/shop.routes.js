const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');
const { getSettings, invalidateSettings } = require('../lib/vtpass');
const shop = require('../lib/shop');

const router = express.Router();

// Public shop page data.
router.get('/shop/:username', async (req, res) => {
  try {
    const view = await shop.publicView(req.params.username);
    if (!view) return res.status(404).json({ error: 'This shop is not available.' });
    res.json(view);
  } catch (error) {
    console.error('GET /shop failed:', error);
    res.status(500).json({ error: 'Could not load this shop.' });
  }
});

// Agent: my shop settings + last 30 days.
router.get('/my-shop', requireCustomerAuth, async (req, res) => {
  try {
    res.json(await shop.myShop(req.customer.customerId));
  } catch (error) {
    console.error('GET /my-shop failed:', error);
    res.status(500).json({ error: 'Could not load your shop.' });
  }
});

router.put('/my-shop', requireCustomerAuth, async (req, res) => {
  try {
    res.json(await shop.updateMyShop(req.customer.customerId, req.body || {}));
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('PUT /my-shop failed:', error);
    res.status(500).json({ error: 'Could not save your shop.' });
  }
});

// Owner settings (owner-only: not in lib/staffAccess.js's support list).
router.get('/admin/shops', requireAdminAuth, async (req, res) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [paid, shops] = await Promise.all([
      prisma.walletTransaction.aggregate({ where: { type: 'SHOP_COMMISSION', status: 'APPROVED', createdAt: { gte: since } }, _sum: { amount: true }, _count: true }),
      prisma.customer.count({ where: { isAgent: true, shopEnabled: true } }),
    ]);
    res.json({ config: shop.config(await getSettings()), last30: { paid: Number(paid?._sum?.amount || 0), count: typeof paid?._count === 'number' ? paid._count : paid?._count?._all || 0 }, shops });
  } catch (error) {
    console.error('GET /admin/shops failed:', error);
    res.status(500).json({ error: 'Could not load.' });
  }
});

router.put('/admin/shops', requireAdminAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const data = {};
    if (b.enabled !== undefined) data.shopLinksEnabled = Boolean(b.enabled);
    if (b.pct !== undefined) {
      const p = Math.round(Number(b.pct) * 100) / 100;
      if (!(p >= 0 && p <= 10)) return res.status(400).json({ error: 'Commission must be between 0% and 10%.' });
      data.shopCommissionPct = p;
    }
    if (b.max !== undefined) {
      const m = parseInt(b.max, 10);
      if (!(m >= 0 && m <= 5000)) return res.status(400).json({ error: 'Maximum per sale must be between ₦0 and ₦5,000.' });
      data.shopCommissionMax = m;
    }
    const existing = await getSettings();
    await prisma.settings.update({ where: { id: existing.id }, data });
    invalidateSettings();
    await prisma.auditLog.create({ data: { actorAdminId: req.admin?.adminId || null, action: 'SHOP_SETTINGS_UPDATED', details: data } }).catch(() => {});
    res.json({ config: shop.config(await getSettings()) });
  } catch (error) {
    console.error('PUT /admin/shops failed:', error);
    res.status(500).json({ error: 'Could not save.' });
  }
});

module.exports = router;
