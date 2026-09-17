const express = require('express');
const prisma = require('../lib/prisma');
const { getSettings } = require('../lib/vtpass');
const { requireAdminAuth, hashPassword, comparePassword } = require('../lib/auth');

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
    const { vtpassMode, vtpassApiKey, vtpassSecretKey, vtpassPublicKey, markupPercentByService } = req.body;
    if (vtpassMode !== undefined && !['sandbox', 'live'].includes(vtpassMode)) {
      return res.status(400).json({ error: 'vtpassMode must be "sandbox" or "live".' });
    }

    const existing = await getSettings();
    const data = {};
    if (vtpassMode !== undefined) data.vtpassMode = vtpassMode;
    if (vtpassApiKey !== undefined) data.vtpassApiKey = vtpassApiKey;
    if (vtpassSecretKey !== undefined) data.vtpassSecretKey = vtpassSecretKey;
    if (vtpassPublicKey !== undefined) data.vtpassPublicKey = vtpassPublicKey;
    if (markupPercentByService !== undefined) data.markupPercentByService = markupPercentByService;

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

// Everything about one customer in a single call — their profile,
// every order, and every wallet transaction — rather than making the
// frontend stitch together three separate fetches for what's really
// one detail view.
router.get('/admin/customers/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const customer = await prisma.customer.findUnique({
      where: { id },
      select: { id: true, name: true, phone: true, email: true, walletBalance: true, active: true, createdAt: true },
    });
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });

    const [orders, walletTransactions] = await Promise.all([
      prisma.order.findMany({ where: { customerId: id }, orderBy: { createdAt: 'desc' } }),
      prisma.walletTransaction.findMany({ where: { customerId: id }, orderBy: { createdAt: 'desc' } }),
    ]);

    res.json({ customer, orders, walletTransactions });
  } catch (error) {
    console.error('GET /admin/customers/:id failed:', error);
    res.status(500).json({ error: 'Could not load customer.' });
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

// Direct wallet correction — unlike the customer-submitted fund
// requests in wallet.routes.js, this doesn't need approval since an
// admin is the one initiating it. CREDIT/DEBIT both funnel through the
// same WalletTransaction ledger as everything else, so the customer's
// transaction history stays a complete, honest record of every balance
// change, not just the ones they requested themselves.
router.post('/admin/customers/:id/adjust-wallet', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { type, amount, note } = req.body;
    if (!['CREDIT', 'DEBIT'].includes(type)) {
      return res.status(400).json({ error: 'type must be CREDIT or DEBIT.' });
    }
    const amountNum = Number(amount);
    if (!amountNum || amountNum <= 0) {
      return res.status(400).json({ error: 'A positive amount is required.' });
    }

    const customer = await prisma.customer.findUnique({ where: { id } });
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });
    if (type === 'DEBIT' && Number(customer.walletBalance) < amountNum) {
      return res.status(400).json({ error: 'Customer does not have enough balance for this debit.' });
    }

    const [, transaction] = await prisma.$transaction([
      prisma.customer.update({
        where: { id },
        data: { walletBalance: type === 'CREDIT' ? { increment: amountNum } : { decrement: amountNum } },
      }),
      prisma.walletTransaction.create({
        data: {
          customerId: id,
          type: type === 'CREDIT' ? 'FUND' : 'DEBIT',
          amount: amountNum,
          status: 'APPROVED',
          note: note || `Manual ${type.toLowerCase()} by admin`,
          reviewedByAdminId: req.admin.adminId,
          reviewedAt: new Date(),
        },
      }),
    ]);

    await prisma.auditLog.create({
      data: {
        actorAdminId: req.admin.adminId,
        action: type === 'CREDIT' ? 'WALLET_MANUAL_CREDIT' : 'WALLET_MANUAL_DEBIT',
        details: { customerId: id, amount: amountNum, note },
      },
    });

    res.json({ transaction });
  } catch (error) {
    console.error('POST /admin/customers/:id/adjust-wallet failed:', error);
    res.status(500).json({ error: 'Could not adjust wallet.' });
  }
});

// --- Admin/staff management ---
// Any logged-in admin can add another — there's no separate
// super-admin role in this V1, so anyone with the admin login can
// create more admin accounts and hand out access to staff.

router.get('/admin/admins', requireAdminAuth, async (req, res) => {
  try {
    const admins = await prisma.adminUser.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, email: true, active: true, createdAt: true },
    });
    res.json({ admins });
  } catch (error) {
    console.error('GET /admin/admins failed:', error);
    res.status(500).json({ error: 'Could not load admins.' });
  }
});

// The very first admin (earliest createdAt) is protected from
// deactivation in code — there's no separate super-admin role, so
// without this, the last person to deactivate everyone else could
// lock the whole team out of the panel with no way back in.
router.patch('/admin/admins/:id/active', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { active } = req.body;
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'active must be true or false.' });
    }

    const firstAdmin = await prisma.adminUser.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!active && firstAdmin?.id === id) {
      return res.status(400).json({ error: 'The original admin account cannot be deactivated.' });
    }

    const admin = await prisma.adminUser.update({
      where: { id },
      data: { active },
      select: { id: true, name: true, email: true, active: true, createdAt: true },
    });

    await prisma.auditLog.create({
      data: {
        actorAdminId: req.admin.adminId,
        action: active ? 'ADMIN_REACTIVATED' : 'ADMIN_DEACTIVATED',
        details: { targetAdminId: id },
      },
    });

    res.json({ admin });
  } catch (error) {
    console.error('PATCH /admin/admins/:id/active failed:', error);
    res.status(500).json({ error: 'Could not update admin.' });
  }
});

// Lets one admin reset another's password directly — useful when a
// staff member is locked out and forgot-password isn't set up yet.
router.post('/admin/admins/:id/reset-password', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'A new password of at least 6 characters is required.' });
    }

    const passwordHash = await hashPassword(newPassword);
    const admin = await prisma.adminUser.update({
      where: { id },
      data: { passwordHash },
      select: { id: true, name: true, email: true },
    });

    await prisma.auditLog.create({
      data: {
        actorAdminId: req.admin.adminId,
        action: 'ADMIN_PASSWORD_RESET_BY_ADMIN',
        details: { targetAdminId: id },
      },
    });

    res.json({ admin });
  } catch (error) {
    console.error('POST /admin/admins/:id/reset-password failed:', error);
    res.status(500).json({ error: 'Could not reset password.' });
  }
});

router.post('/admin/admins', requireAdminAuth, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existing = await prisma.adminUser.findUnique({ where: { email: normalizedEmail } });
    if (existing) return res.status(409).json({ error: 'An admin with this email already exists.' });

    const passwordHash = await hashPassword(password);
    const admin = await prisma.adminUser.create({
      data: { name: name.trim(), email: normalizedEmail, passwordHash },
      select: { id: true, name: true, email: true, createdAt: true },
    });

    await prisma.auditLog.create({
      data: {
        actorAdminId: req.admin.adminId,
        action: 'ADMIN_CREATED',
        details: { newAdminId: admin.id, email: admin.email },
      },
    });

    res.status(201).json({ admin });
  } catch (error) {
    console.error('POST /admin/admins failed:', error);
    res.status(500).json({ error: 'Could not create admin.' });
  }
});

router.patch('/admin/password', requireAdminAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }

    const admin = await prisma.adminUser.findUnique({ where: { id: req.admin.adminId } });
    if (!admin || !(await comparePassword(currentPassword, admin.passwordHash))) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.adminUser.update({ where: { id: admin.id }, data: { passwordHash } });

    await prisma.auditLog.create({
      data: { actorAdminId: admin.id, action: 'ADMIN_PASSWORD_CHANGED', details: {} },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('PATCH /admin/password failed:', error);
    res.status(500).json({ error: 'Could not change password.' });
  }
});

module.exports = router;
