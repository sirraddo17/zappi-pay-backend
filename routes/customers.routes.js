const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');

// Usernames for older accounts (the username doubles as the referral
// code) and the admin customer list with tabs + search.
const router = express.Router();

const RESERVED = new Set(['admin', 'administrator', 'support', 'zappi', 'zappipay', 'zappi_pay', 'help', 'official', 'staff', 'deleted', 'system', 'root', 'monnify', 'vtpass']);

// Returns an error message, or null when the username is acceptable.
function usernameProblem(u) {
  if (!/^[a-z0-9_]{3,20}$/.test(u)) return 'Username must be 3-20 characters: letters, numbers and underscores only.';
  if (/^[0-9_]+$/.test(u)) return 'Username must contain at least one letter.';
  if (RESERVED.has(u) || u.startsWith('deleted')) return 'That username is not available. Please choose another.';
  return null;
}

async function claimUsername(customerId, raw, { allowChange = false } = {}) {
  const username = String(raw || '').trim().toLowerCase().replace(/^@/, '');
  const problem = usernameProblem(username);
  if (problem) return { status: 400, error: problem };

  const taken = await prisma.customer.findFirst({ where: { username, NOT: { id: customerId } }, select: { id: true } });
  if (taken) return { status: 409, error: 'This username is already taken.' };

  // Customers may set it only once (it's their referral link); admins
  // can correct it. The conditional update makes "only once" race-safe.
  const where = allowChange ? { id: customerId, deletedAt: null } : { id: customerId, username: null, deletedAt: null };
  try {
    const r = await prisma.customer.updateMany({ where, data: { username } });
    if (r.count === 0) return { status: 400, error: allowChange ? 'Customer not found or deleted.' : 'Your account already has a username.' };
  } catch (error) {
    if (error.code === 'P2002') return { status: 409, error: 'This username is already taken.' };
    throw error;
  }
  return { username };
}

router.get('/account/username/check', requireCustomerAuth, async (req, res) => {
  try {
    const username = String(req.query.username || '').trim().toLowerCase().replace(/^@/, '');
    const problem = usernameProblem(username);
    if (problem) return res.json({ available: false, error: problem });
    const taken = await prisma.customer.findFirst({ where: { username, NOT: { id: req.customer.customerId } }, select: { id: true } });
    res.json({ available: !taken, error: taken ? 'This username is already taken.' : null });
  } catch (error) {
    console.error('GET /account/username/check failed:', error);
    res.status(500).json({ error: 'Could not check that username.' });
  }
});

router.post('/account/username', requireCustomerAuth, async (req, res) => {
  try {
    const result = await claimUsername(req.customer.customerId, req.body?.username);
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ username: result.username });
  } catch (error) {
    console.error('POST /account/username failed:', error);
    res.status(500).json({ error: 'Could not save your username.' });
  }
});

router.post('/admin/customers/:id/username', requireAdminAuth, async (req, res) => {
  try {
    const before = await prisma.customer.findUnique({ where: { id: req.params.id }, select: { username: true } });
    if (!before) return res.status(404).json({ error: 'Customer not found.' });
    const result = await claimUsername(req.params.id, req.body?.username, { allowChange: true });
    if (result.error) return res.status(result.status).json({ error: result.error });
    await prisma.auditLog.create({
      data: { actorAdminId: req.admin.adminId, action: 'CUSTOMER_USERNAME_SET', details: { customerId: req.params.id, from: before.username, to: result.username } },
    }).catch(() => {});
    res.json({ username: result.username });
  } catch (error) {
    console.error('POST /admin/customers/:id/username failed:', error);
    res.status(500).json({ error: 'Could not save the username.' });
  }
});

// --- Admin customer list -------------------------------------------
// ?view=active|deactivated|deletion|deleted  &q=search  &all=1  &page=0
// Active view with no search shows the 5 most active customers
// (most successful orders in the last 30 days); search or "all"
// returns pages of 50.

const VIEWS = {
  active: { active: true, deletedAt: null },
  deactivated: { active: false, deletedAt: null },
  deletion: { deletionRequestedAt: { not: null }, deletedAt: null },
  deleted: { deletedAt: { not: null } },
};

const LIST_SELECT = {
  id: true, name: true, phone: true, username: true, email: true, walletBalance: true, active: true,
  createdAt: true, isAgent: true, deletionRequestedAt: true, deletedAt: true,
};

const PAGE = 50;

router.get('/admin/customers/list', requireAdminAuth, async (req, res) => {
  try {
    const view = VIEWS[req.query.view] ? String(req.query.view) : 'active';
    const q = String(req.query.q || '').trim().slice(0, 60);
    const page = Math.max(0, parseInt(req.query.page, 10) || 0);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [active, deactivated, deletion, deleted] = await Promise.all(
      ['active', 'deactivated', 'deletion', 'deleted'].map((v) => prisma.customer.count({ where: VIEWS[v] })),
    );
    const counts = { active, deactivated, deletion, deleted };

    const where = { ...VIEWS[view] };
    if (q) {
      const digits = q.replace(/\D/g, '');
      const or = [
        { name: { contains: q, mode: 'insensitive' } },
        { username: { contains: q.toLowerCase().replace(/^@/, '') } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
      ];
      // "0803..." and "+234803..." should find the same number.
      if (digits.length >= 4) {
        or.push({ phone: { contains: digits } });
        if (digits.startsWith('234')) or.push({ phone: { contains: `0${digits.slice(3)}` } });
        if (digits.startsWith('0')) or.push({ phone: { contains: `234${digits.slice(1)}` } });
      }
      where.AND = [{ OR: or }];
    }

    let customers;
    let total;
    let mode;
    if (view === 'active' && !q && !req.query.all) {
      mode = 'top';
      const grouped = await prisma.order.groupBy({
        by: ['customerId'],
        where: { status: 'SUCCESS', createdAt: { gte: since } },
        _count: { customerId: true },
        orderBy: { _count: { customerId: 'desc' } },
        take: 20,
      });
      const byId = new Map(grouped.map((g) => [g.customerId, g._count.customerId]));
      const rows = grouped.length
        ? await prisma.customer.findMany({ where: { ...where, id: { in: [...byId.keys()] } }, select: LIST_SELECT })
        : [];
      customers = rows
        .map((c) => ({ ...c, orders30d: byId.get(c.id) || 0 }))
        .sort((a, b) => b.orders30d - a.orders30d)
        .slice(0, 5);
      total = customers.length;
    } else {
      mode = q ? 'search' : 'all';
      [customers, total] = await Promise.all([
        prisma.customer.findMany({
          where,
          orderBy: view === 'deleted' ? { deletedAt: 'desc' } : view === 'deletion' ? { deletionRequestedAt: 'desc' } : { createdAt: 'desc' },
          skip: page * PAGE,
          take: PAGE,
          select: LIST_SELECT,
        }),
        prisma.customer.count({ where }),
      ]);
    }

    res.json({ view, mode, q, page, pageSize: PAGE, total, counts, customers });
  } catch (error) {
    console.error('GET /admin/customers/list failed:', error);
    res.status(500).json({ error: 'Could not load customers.' });
  }
});

module.exports = router;
module.exports.usernameProblem = usernameProblem;
