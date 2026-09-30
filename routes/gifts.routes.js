const express = require('express');
const { requireCustomerAuth } = require('../lib/auth');
const gifts = require('../lib/gifts');

const router = express.Router();

// Public: the gift card page (no login — the recipient may not have
// ZAPPI PAY yet).
router.get('/gifts/:token', async (req, res) => {
  try {
    const view = await gifts.publicView(req.params.token);
    if (!view) return res.status(404).json({ error: 'This gift link is not available.' });
    res.set('Cache-Control', 'no-store');
    res.json(view);
  } catch (error) {
    console.error('GET /gifts/:token failed:', error);
    res.status(500).json({ error: 'Could not load this gift.' });
  }
});

// Turn a past airtime/data purchase into a gift card (or edit its message).
router.post('/orders/:id/gift', requireCustomerAuth, async (req, res) => {
  try {
    await gifts.createGift(req.customer.customerId, req.params.id, req.body || {});
    res.json({ gift: await gifts.forOrder(req.customer.customerId, req.params.id) });
  } catch (error) {
    if (error instanceof gifts.GiftError) return res.status(400).json({ error: error.message });
    console.error('POST /orders/:id/gift failed:', error);
    res.status(500).json({ error: 'Could not create the gift card.' });
  }
});

router.get('/orders/:id/gift', requireCustomerAuth, async (req, res) => {
  try {
    res.json({ gift: await gifts.forOrder(req.customer.customerId, req.params.id) });
  } catch (error) {
    console.error('GET /orders/:id/gift failed:', error);
    res.status(500).json({ error: 'Could not load the gift card.' });
  }
});

module.exports = router;
