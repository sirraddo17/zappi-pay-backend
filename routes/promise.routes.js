const express = require('express');
const prisma = require('../lib/prisma');
const { requireAdminAuth } = require('../lib/auth');
const { getSettings, invalidateSettings } = require('../lib/vtpass');
const dp = require('../lib/deliveryPromise');

// Owner settings for "Delivered in 60s or ₦20 back" (owner-only: not in
// lib/staffAccess.js's support list).
const router = express.Router();

router.get('/admin/delivery-promise', requireAdminAuth, async (req, res) => {
  try {
    res.json({ config: dp.config(await getSettings()), stats: await dp.stats(), services: dp.SERVICES });
  } catch (error) {
    console.error('GET /admin/delivery-promise failed:', error);
    res.status(500).json({ error: 'Could not load.' });
  }
});

router.put('/admin/delivery-promise', requireAdminAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const data = {};
    if (b.enabled !== undefined) data.deliveryPromiseEnabled = Boolean(b.enabled);
    for (const [field, key, lo, hi] of [['deliveryPromiseSeconds', 'seconds', 30, 600], ['deliveryPromiseBonus', 'bonus', 1, 500], ['deliveryPromiseMinAmount', 'minAmount', 0, 100000], ['deliveryPromiseDailyBudget', 'dailyBudget', 0, 10000000]]) {
      if (b[key] === undefined) continue;
      const n = parseInt(b[key], 10);
      if (!(n >= lo && n <= hi)) return res.status(400).json({ error: `${key} must be between ${lo} and ${hi}.` });
      data[field] = n;
    }
    if (b.services !== undefined) {
      if (!Array.isArray(b.services)) return res.status(400).json({ error: 'services must be a list.' });
      data.deliveryPromiseServices = [...new Set(b.services.filter((x) => dp.SERVICES.includes(x)))];
      if (!data.deliveryPromiseServices.length) return res.status(400).json({ error: 'Pick at least one service.' });
    }
    const existing = await getSettings();
    await prisma.settings.update({ where: { id: existing.id }, data });
    invalidateSettings();
    await prisma.auditLog.create({ data: { actorAdminId: req.admin?.adminId || null, action: 'DELIVERY_PROMISE_UPDATED', details: data } }).catch(() => {});
    res.json({ config: dp.config(await getSettings()) });
  } catch (error) {
    console.error('PUT /admin/delivery-promise failed:', error);
    res.status(500).json({ error: 'Could not save.' });
  }
});

module.exports = router;
