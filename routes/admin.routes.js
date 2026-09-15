const express = require('express');
const prisma = require('../lib/prisma');
const { getSettings } = require('../lib/vtpass');
const { requireAdminAuth } = require('../lib/auth');

const router = express.Router();

router.get('/admin/settings', requireAdminAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ settings });
  } catch (error) {
    console.error('GET /admin/settings failed:', error);
    res.status(500).json({ error: 'Could not load settings.' });
  }
});

// The one place VTpass credentials and markup get changed — logged to
// AuditLog since this is the most sensitive endpoint in the app (wrong
// keys here means every purchase fails; a wrong mode flips live money
// to sandbox or back).
router.patch('/admin/settings', requireAdminAuth, async (req, res) => {
  try {
    const { vtpassMode, vtpassApiKey, vtpassSecretKey, vtpassPublicKey, markupPercent } = req.body;
    if (vtpassMode !== undefined && !['sandbox', 'live'].includes(vtpassMode)) {
      return res.status(400).json({ error: 'vtpassMode must be "sandbox" or "live".' });
    }

    const existing = await getSettings();
    const data = {};
    if (vtpassMode !== undefined) data.vtpassMode = vtpassMode;
    if (vtpassApiKey !== undefined) data.vtpassApiKey = vtpassApiKey;
    if (vtpassSecretKey !== undefined) data.vtpassSecretKey = vtpassSecretKey;
    if (vtpassPublicKey !== undefined) data.vtpassPublicKey = vtpassPublicKey;
    if (markupPercent !== undefined) data.markupPercent = markupPercent;

    const settings = await prisma.settings.update({ where: { id: existing.id }, data });

    await prisma.auditLog.create({
      data: {
        actorAdminId: req.admin.adminId,
        action: 'SETTINGS_UPDATED',
        details: { changedFields: Object.keys(data) },
      },
    });

    res.json({ settings });
  } catch (error) {
    console.error('PATCH /admin/settings failed:', error);
    res.status(500).json({ error: 'Could not update settings.' });
  }
});

router.get('/admin/customers', requireAdminAuth, async (req, res) => {
  try {
    const customers = await prisma.customer.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, phone: true, email: true, walletBalance: true, active: true, createdAt: true },
    });
    res.json({ customers });
  } catch (error) {
    console.error('GET /admin/customers failed:', error);
    res.status(500).json({ error: 'Could not load customers.' });
  }
});

router.patch('/admin/customers/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { active } = req.body;
    if (active === undefined) return res.status(400).json({ error: 'active is required.' });

    const customer = await prisma.customer.update({
      where: { id },
      data: { active: !!active },
      select: { id: true, name: true, phone: true, active: true },
    });

    await prisma.auditLog.create({
      data: {
        actorAdminId: req.admin.adminId,
        action: active ? 'CUSTOMER_REACTIVATED' : 'CUSTOMER_DEACTIVATED',
        details: { customerId: id },
      },
    });

    res.json({ customer });
  } catch (error) {
    console.error('PATCH /admin/customers/:id failed:', error);
    res.status(500).json({ error: 'Could not update customer.' });
  }
});

router.get('/admin/audit-log', requireAdminAuth, async (req, res) => {
  try {
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ logs });
  } catch (error) {
    console.error('GET /admin/audit-log failed:', error);
    res.status(500).json({ error: 'Could not load audit log.' });
  }
});

module.exports = router;
