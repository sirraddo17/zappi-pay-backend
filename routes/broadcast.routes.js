const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');

const router = express.Router();

const TYPES = ['INFO', 'WARNING', 'MAINTENANCE'];
const TYPE_LABELS = { INFO: '', WARNING: 'Warning: ', MAINTENANCE: 'Maintenance: ' };

// --- Admin ---

router.get('/admin/broadcasts', requireAdminAuth, async (req, res) => {
  try {
    const broadcasts = await prisma.broadcast.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    res.json({ broadcasts });
  } catch (error) {
    console.error('GET /admin/broadcasts failed:', error);
    res.status(500).json({ error: 'Could not load broadcasts.' });
  }
});

// Sends one announcement to every active customer. The Broadcast row
// and all the per-customer Notification rows are written in a single
// transaction, so a broadcast is never recorded as sent to people
// who didn't actually get it.
router.post('/admin/broadcasts', requireAdminAuth, async (req, res) => {
  try {
    const title = String(req.body.title || '').trim();
    const message = String(req.body.message || '').trim();
    const type = TYPES.includes(req.body.type) ? req.body.type : 'INFO';
    const showBanner = Boolean(req.body.showBanner);

    if (!title || !message) return res.status(400).json({ error: 'Title and message are required.' });
    if (title.length > 100) return res.status(400).json({ error: 'Title must be 100 characters or fewer.' });
    if (message.length > 1000) return res.status(400).json({ error: 'Message must be 1000 characters or fewer.' });

    const customers = await prisma.customer.findMany({ where: { active: true }, select: { id: true } });
    const notificationTitle = `${TYPE_LABELS[type]}${title}`;

    const [broadcast] = await prisma.$transaction([
      prisma.broadcast.create({
        data: {
          title,
          message,
          type,
          showBanner,
          active: showBanner,
          recipientCount: customers.length,
          createdByAdminId: req.admin.adminId,
        },
      }),
      prisma.notification.createMany({
        data: customers.map((c) => ({ customerId: c.id, title: notificationTitle, message })),
      }),
      prisma.auditLog.create({
        data: {
          actorAdminId: req.admin.adminId,
          action: 'BROADCAST_SENT',
          details: { title, type, showBanner, recipientCount: customers.length },
        },
      }),
    ]);

    res.status(201).json({ broadcast });
  } catch (error) {
    console.error('POST /admin/broadcasts failed:', error);
    res.status(500).json({ error: 'Could not send broadcast.' });
  }
});

// Takes a broadcast's banner off every customer's dashboard. The
// bell notifications it already created stay — they're a record of
// what customers were told.
router.patch('/admin/broadcasts/:id/end', requireAdminAuth, async (req, res) => {
  try {
    const broadcast = await prisma.broadcast.update({
      where: { id: req.params.id },
      data: { active: false, endedAt: new Date() },
    });
    await prisma.auditLog.create({
      data: { actorAdminId: req.admin.adminId, action: 'BROADCAST_ENDED', details: { broadcastId: broadcast.id, title: broadcast.title } },
    });
    res.json({ broadcast });
  } catch (error) {
    console.error('PATCH /admin/broadcasts/:id/end failed:', error);
    res.status(500).json({ error: 'Could not end broadcast.' });
  }
});

// --- Customer ---

// Banners currently pinned to the dashboard, newest first.
router.get('/broadcasts/active', requireCustomerAuth, async (req, res) => {
  try {
    const broadcasts = await prisma.broadcast.findMany({
      where: { active: true, showBanner: true },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { id: true, title: true, message: true, type: true, createdAt: true },
    });
    res.json({ broadcasts });
  } catch (error) {
    console.error('GET /broadcasts/active failed:', error);
    res.status(500).json({ error: 'Could not load announcements.' });
  }
});

module.exports = router;
