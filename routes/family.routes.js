const express = require('express');
const { requireCustomerAuth } = require('../lib/auth');
const fam = require('../lib/family');

// Family wallet — see lib/family.js.
const router = express.Router();
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error instanceof fam.FamilyError) return res.status(error.status).json({ error: error.message });
    console.error(`${req.method} ${req.path} failed:`, error);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
const me = (req) => req.customer.customerId;

router.get('/family', requireCustomerAuth, wrap(async (req, res) => {
  const [members, managedBy] = await Promise.all([fam.forParent(me(req)), fam.forChild(me(req))]);
  res.json({ members, managedBy, services: fam.SERVICES });
}));
router.post('/family/invite', requireCustomerAuth, wrap(async (req, res) => {
  res.status(201).json({ link: await fam.invite(me(req), req.body || {}) });
}));
router.post('/family/respond', requireCustomerAuth, wrap(async (req, res) => {
  res.json({ link: await fam.respond(me(req), Boolean(req.body?.accept)) });
}));
router.post('/family/leave', requireCustomerAuth, wrap(async (req, res) => {
  await fam.leave(me(req));
  res.json({ ok: true });
}));
router.put('/family/:id', requireCustomerAuth, wrap(async (req, res) => {
  res.json({ link: await fam.update(me(req), req.params.id, req.body || {}) });
}));
router.post('/family/:id/send-now', requireCustomerAuth, wrap(async (req, res) => {
  await fam.sendNow(me(req), req.params.id);
  res.json({ ok: true });
}));
router.delete('/family/:id', requireCustomerAuth, wrap(async (req, res) => {
  await fam.remove(me(req), req.params.id);
  res.json({ ok: true });
}));

module.exports = router;
