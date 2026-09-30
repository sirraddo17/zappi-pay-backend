const express = require('express');
const { requireCustomerAuth } = require('../lib/auth');
const pb = require('../lib/profitBook');

const router = express.Router();
const fail = (res, error, what) => {
  if (error instanceof pb.BookError) return res.status(error.status).json({ error: error.message });
  console.error(`${what} failed:`, error);
  return res.status(500).json({ error: 'Could not load your profit book.' });
};

router.get('/agent/book', requireCustomerAuth, async (req, res) => {
  try { res.json(await pb.book(req.customer.customerId, req.query)); } catch (e) { fail(res, e, 'GET /agent/book'); }
});
router.get('/agent/book/owing', requireCustomerAuth, async (req, res) => {
  try { res.json({ owing: await pb.owing(req.customer.customerId) }); } catch (e) { fail(res, e, 'GET /agent/book/owing'); }
});
router.put('/agent/book/:orderId', requireCustomerAuth, async (req, res) => {
  try { res.json({ sale: await pb.record(req.customer.customerId, req.params.orderId, req.body || {}) }); } catch (e) { fail(res, e, 'PUT /agent/book'); }
});

module.exports = router;
