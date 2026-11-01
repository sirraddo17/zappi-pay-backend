const express = require('express');
const { requireAdminAuth } = require('../lib/auth');
const subs = require('../lib/subscriptions');

// Admin → 🧾 Subscriptions (owner only — support staff are refused by
// lib/staffAccess.js; the AI assistant may read but never change it).
//  GET /admin/subscriptions   list, renewal countdowns, yearly totals
//  PUT /admin/subscriptions   save the whole list { subscriptions: [...] }
const router = express.Router();

router.get('/admin/subscriptions', requireAdminAuth, async (req, res) => {
  try {
    res.json(await subs.list());
  } catch (error) {
    console.error('GET /admin/subscriptions failed:', error);
    res.status(500).json({ error: 'Could not load subscriptions.' });
  }
});

router.put('/admin/subscriptions', requireAdminAuth, async (req, res) => {
  if (req.headers['x-admin-assistant']) return res.status(403).json({ error: 'The AI assistant can’t change subscriptions — edit them on the Subscriptions page.' });
  try {
    res.json(await subs.save(req.body?.subscriptions));
  } catch (error) {
    if (error instanceof subs.SubscriptionError) return res.status(400).json({ error: error.message });
    console.error('PUT /admin/subscriptions failed:', error);
    res.status(500).json({ error: 'Could not save subscriptions.' });
  }
});

module.exports = router;
