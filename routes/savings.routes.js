const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');
const savings = require('../lib/savings');

// Savings pocket with daily interest — see lib/savings.js. Admin routes
// here are owner-only (not in lib/staffAccess.js's support list).
const router = express.Router();

function fail(res, error, what) {
  if (error instanceof savings.SavingsError) return res.status(400).json({ error: error.message });
  console.error(`${what} failed:`, error);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

router.get('/savings', requireCustomerAuth, async (req, res) => {
  try {
    res.json(await savings.customerSavings(req.customer.customerId));
  } catch (error) {
    fail(res, error, 'GET /savings');
  }
});

router.post('/savings/deposit', requireCustomerAuth, async (req, res) => {
  try {
    await savings.deposit(req.customer.customerId, req.body?.amount);
    res.json(await savings.customerSavings(req.customer.customerId));
  } catch (error) {
    fail(res, error, 'POST /savings/deposit');
  }
});

router.post('/savings/withdraw', requireCustomerAuth, async (req, res) => {
  try {
    await savings.withdraw(req.customer.customerId, req.body?.amount);
    res.json(await savings.customerSavings(req.customer.customerId));
  } catch (error) {
    fail(res, error, 'POST /savings/withdraw');
  }
});

router.get('/admin/savings', requireAdminAuth, async (req, res) => {
  try {
    res.json(await savings.overview());
  } catch (error) {
    fail(res, error, 'GET /admin/savings');
  }
});

// Pays today's interest now instead of waiting for midnight. Still only
// once per day — if it already ran today, nothing more is paid.
router.post('/admin/savings/run', requireAdminAuth, async (req, res) => {
  try {
    const r = await savings.runDailyInterest();
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'SAVINGS_INTEREST_RUN', details: r } });
    res.json({ ...r, message: r.skipped ? `Nothing paid: ${r.skipped}.` : `Paid ₦${r.paid.toLocaleString()} interest to ${r.count} saver(s)${r.scaledDown ? ' (scaled down to your daily budget)' : ''}.` });
  } catch (error) {
    fail(res, error, 'POST /admin/savings/run');
  }
});

module.exports = router;
