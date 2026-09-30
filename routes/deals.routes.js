const express = require('express');
const { requireCustomerAuth } = require('../lib/auth');
const deals = require('../lib/deals');

const router = express.Router();

// GET /deals/data?budget=1500&network=MTN&phone=0803…&validity=MONTH&sort=MOST
router.get('/deals/data', requireCustomerAuth, async (req, res) => {
  try {
    const { budget, network, phone, validity, sort } = req.query;
    res.json(await deals.find(req.customer.customerId, { budget, network, phone, validity, sort }));
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error('GET /deals/data failed:', error);
    res.status(502).json({ error: 'Could not load data plans right now. Try again in a minute.' });
  }
});

module.exports = router;
