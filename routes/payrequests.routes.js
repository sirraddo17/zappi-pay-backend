const express = require('express');
const jwt = require('jsonwebtoken');
const { requireCustomerAuth } = require('../lib/auth');
const { confirmTransaction } = require('../lib/security');
const P = require('../lib/payRequests');

// Pay me links, split bills and group gifts (lib/payRequests.js).
const router = express.Router();

function fail(res, e, what) {
  if (e instanceof P.PayRequestError) return res.status(e.status).json({ error: e.message, code: e.code });
  console.error(`${what} failed:`, e);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// The link page works logged out too; a valid customer token just shows more.
function optionalCustomer(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  try { const p = jwt.verify(h.slice(7), process.env.JWT_SECRET); return p.kind === 'customer' ? p.sub : null; } catch { return null; }
}

router.post('/pay-requests', requireCustomerAuth, async (req, res) => {
  try { res.status(201).json(await P.create(req.customer.customerId, req.body || {})); } catch (e) { fail(res, e, 'POST /pay-requests'); }
});

router.get('/pay-requests', requireCustomerAuth, async (req, res) => {
  try {
    const [mine, forMe] = await Promise.all([P.mine(req.customer.customerId), P.forMe(req.customer.customerId)]);
    res.json({ mine, forMe });
  } catch (e) { fail(res, e, 'GET /pay-requests'); }
});

router.get('/pay-requests/public/:token', async (req, res) => {
  try { res.json({ request: await P.view(req.params.token, optionalCustomer(req)) }); } catch (e) { fail(res, e, 'GET /pay-requests/public'); }
});

router.post('/pay-requests/:token/pay', requireCustomerAuth, async (req, res) => {
  try {
    const confirmation = await confirmTransaction(req);
    if (!confirmation.ok) return res.status(confirmation.status).json({ error: confirmation.error, code: confirmation.code });
    res.status(201).json(await P.pay(req.params.token, req.customer.customerId, req.body || {}));
  } catch (e) { fail(res, e, 'POST /pay-requests/pay'); }
});

router.post('/pay-requests/:id/close', requireCustomerAuth, async (req, res) => {
  try { res.json({ request: await P.close(req.customer.customerId, req.params.id) }); } catch (e) { fail(res, e, 'close pay request'); }
});

router.post('/pay-requests/:id/remind', requireCustomerAuth, async (req, res) => {
  try { res.json(await P.remind(req.customer.customerId, req.params.id)); } catch (e) { fail(res, e, 'remind pay request'); }
});

module.exports = router;
