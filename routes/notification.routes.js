const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth } = require('../lib/auth');

const router = express.Router();

// A customer's own notifications, most recent first — covers
// wallet funding decisions, purchase success/failure, admin wallet
// adjustments, and support ticket resolutions, all created via the
// shared notify() helper at the point each event happens.
router.get('/notifications', requireCustomerAuth, async (req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { customerId: req.customer.customerId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const unreadCount = await prisma.notification.count({
      where: { customerId: req.customer.customerId, read: false },
    });
    res.json({ notifications, unreadCount });
  } catch (error) {
    console.error('GET /notifications failed:', error);
    res.status(500).json({ error: 'Could not load notifications.' });
  }
});

router.patch('/notifications/:id/read', requireCustomerAuth, async (req, res) => {
  try {
    // Scoped to the requesting customer via the where clause (not
    // just the id) so one customer can never mark another's
    // notification read by guessing an id.
    const result = await prisma.notification.updateMany({
      where: { id: req.params.id, customerId: req.customer.customerId },
      data: { read: true },
    });
    if (result.count === 0) return res.status(404).json({ error: 'Notification not found.' });
    res.json({ ok: true });
  } catch (error) {
    console.error('PATCH /notifications/:id/read failed:', error);
    res.status(500).json({ error: 'Could not update notification.' });
  }
});

router.patch('/notifications/read-all', requireCustomerAuth, async (req, res) => {
  try {
    await prisma.notification.updateMany({
      where: { customerId: req.customer.customerId, read: false },
      data: { read: true },
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('PATCH /notifications/read-all failed:', error);
    res.status(500).json({ error: 'Could not update notifications.' });
  }
});

module.exports = router;
