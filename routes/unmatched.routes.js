const express = require('express');
const { requireAdminAuth } = require('../lib/auth');
const unmatched = require('../lib/unmatched');

// Admin → 💸 Unmatched payments (lib/unmatched.js). Viewing is open to
// support staff; crediting or closing one is owner-only (staff gate) and
// never done by the AI assistant.
const router = express.Router();
const noAi = (req, res) => (req.headers['x-admin-assistant'] ? res.status(403).json({ error: 'Only a person can credit or close a payment.' }) : null);
const fail = (res, error, msg) => {
  if (error instanceof unmatched.UnmatchedError) return res.status(error.status).json({ error: error.message });
  console.error(msg, error);
  return res.status(500).json({ error: msg });
};

router.get('/admin/unmatched-payments', requireAdminAuth, async (req, res) => {
  try {
    const status = ['OPEN', 'ASSIGNED', 'RETURNED', 'IGNORED', 'ALL'].includes(req.query.status) ? req.query.status : 'OPEN';
    res.json(await unmatched.list(status));
  } catch (error) {
    fail(res, error, 'Could not load unmatched payments.');
  }
});

router.post('/admin/unmatched-payments/:id/assign', requireAdminAuth, async (req, res) => {
  if (noAi(req, res)) return;
  try {
    const customerId = String(req.body?.customerId || '').trim();
    if (!customerId) return res.status(400).json({ error: 'Choose the customer to credit.' });
    res.json(await unmatched.assign(req.params.id, customerId, { adminId: req.admin.adminId, note: req.body?.note, chargeFee: req.body?.chargeFee !== false }));
  } catch (error) {
    fail(res, error, 'Could not credit the payment.');
  }
});

router.post('/admin/unmatched-payments/:id/close', requireAdminAuth, async (req, res) => {
  if (noAi(req, res)) return;
  try {
    res.json(await unmatched.close(req.params.id, String(req.body?.status || ''), { adminId: req.admin.adminId, note: req.body?.note }));
  } catch (error) {
    fail(res, error, 'Could not update the payment.');
  }
});

module.exports = router;
