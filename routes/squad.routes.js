const express = require('express');
const prisma = require('../lib/prisma');
const { requireAdminAuth } = require('../lib/auth');
const squad = require('../lib/squad');

// Admin → Settings → Wallet funding → Squad (GTBank account numbers).
// Owner-only (support staff are blocked by lib/staffAccess.js); the AI
// assistant can't change any of it. The secret key is never sent back.
const router = express.Router();
const noAi = (req, res) => (req.headers['x-admin-assistant'] ? res.status(403).json({ error: 'The AI assistant cannot change payment settings.' }) : null);
function fail(res, error, msg) {
  if (error instanceof squad.SquadError) return res.status(error.status && error.status < 500 ? error.status : 502).json({ error: error.message });
  console.error(msg, error.message);
  return res.status(500).json({ error: msg });
}

router.get('/admin/squad', requireAdminAuth, async (req, res) => {
  try {
    res.json(await squad.status());
  } catch (error) {
    fail(res, error, 'Could not load Squad settings.');
  }
});

router.put('/admin/squad', requireAdminAuth, async (req, res) => {
  if (noAi(req, res)) return;
  try {
    const body = req.body || {};
    const out = await squad.updateSettings(body);
    const changed = Object.keys(body).map((k) => (/key/i.test(k) ? `${k} (changed)` : k));
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'SQUAD_SETTINGS', details: { changed } } }).catch(() => {});
    res.json(out);
  } catch (error) {
    fail(res, error, 'Could not save Squad settings.');
  }
});

router.post('/admin/squad/test', requireAdminAuth, async (req, res) => {
  try {
    res.json(await squad.testConnection());
  } catch (error) {
    fail(res, error, 'Could not test Squad.');
  }
});

// Re-check payments Squad couldn't deliver to us (runs every 10 min anyway).
router.post('/admin/squad/sync', requireAdminAuth, async (req, res) => {
  if (noAi(req, res)) return;
  try {
    res.json(await squad.processMissedWebhooks());
  } catch (error) {
    fail(res, error, 'Could not check missed payments.');
  }
});

// Sandbox only: send a pretend payment to an account number to test the
// whole flow (webhook → wallet credit).
router.post('/admin/squad/simulate', requireAdminAuth, async (req, res) => {
  if (noAi(req, res)) return;
  try {
    const accountNumber = String(req.body?.accountNumber || '').replace(/\D/g, '');
    const amount = Number(req.body?.amount);
    if (accountNumber.length !== 10) return res.status(400).json({ error: 'Enter the 10-digit GTBank account number.' });
    if (!(amount >= 100 && amount <= 1000000)) return res.status(400).json({ error: 'Enter an amount between ₦100 and ₦1,000,000.' });
    await squad.simulatePayment(accountNumber, amount);
    res.json({ ok: true });
  } catch (error) {
    fail(res, error, 'Could not send the test payment.');
  }
});

module.exports = router;
