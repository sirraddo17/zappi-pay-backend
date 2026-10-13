const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');
const { confirmTransaction } = require('../lib/security');
const D = require('../lib/disputes');

// Wrong transfers (see lib/disputes.js).
const router = express.Router();
const me = (req) => req.customer.customerId;
function fail(res, error, msg) {
  if (error instanceof D.DisputeError) return res.status(error.status).json({ error: error.message, code: error.code });
  console.error(msg, error);
  return res.status(500).json({ error: msg });
}
const noAi = (req, res) => {
  if (req.headers['x-admin-assistant']) { res.status(403).json({ error: 'The AI assistant can’t do this — use the Wrong transfers page.' }); return true; }
  return false;
};

router.get('/disputes', requireCustomerAuth, async (req, res) => {
  try { res.json({ disputes: await D.mine(me(req)), waiting: await D.waitingForMe(me(req)) }); } catch (e) { fail(res, e, 'Could not load.'); }
});
router.get('/disputes/sends', requireCustomerAuth, async (req, res) => {
  try { res.json({ sends: await D.recentSends(me(req)) }); } catch (e) { fail(res, e, 'Could not load.'); }
});
router.get('/disputes/:id', requireCustomerAuth, async (req, res) => {
  try { res.json({ dispute: await D.detail(req.params.id, me(req)) }); } catch (e) { fail(res, e, 'Could not load.'); }
});
// Which of my transfers are already reported (to show the right button).
router.post('/disputes/lookup', requireCustomerAuth, async (req, res) => {
  try {
    const transferIds = (Array.isArray(req.body?.transferIds) ? req.body.transferIds : []).slice(0, 100).map(String);
    const bankTransferIds = (Array.isArray(req.body?.bankTransferIds) ? req.body.bankTransferIds : []).slice(0, 100).map(String);
    res.json({ reported: await D.reportedIds({ transferIds, bankTransferIds }) });
  } catch (e) { fail(res, e, 'Could not load.'); }
});
router.post('/disputes', requireCustomerAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const d = b.bankTransferId ? await D.reportBank(me(req), String(b.bankTransferId), b.reason) : await D.reportWallet(me(req), String(b.transferId || ''), b.reason);
    res.status(201).json({ id: d.id });
  } catch (e) { fail(res, e, 'Could not report the transfer.'); }
});
router.post('/disputes/:id/return', requireCustomerAuth, async (req, res) => {
  try {
    const c = await confirmTransaction(req);
    if (!c.ok) return res.status(c.status).json({ error: c.error, code: c.code });
    res.json(await D.returnMoney(me(req), req.params.id));
  } catch (e) { fail(res, e, 'Could not return the money.'); }
});
router.post('/disputes/:id/mine', requireCustomerAuth, async (req, res) => {
  try { res.json(await D.recipientClaims(me(req), req.params.id, req.body?.reply)); } catch (e) { fail(res, e, 'Could not send your answer.'); }
});
router.post('/disputes/:id/cancel', requireCustomerAuth, async (req, res) => {
  try { res.json(await D.cancel(me(req), req.params.id)); } catch (e) { fail(res, e, 'Could not cancel.'); }
});

// --- Admin ---
router.get('/admin/disputes', requireAdminAuth, async (req, res) => {
  try { res.json({ disputes: await D.adminList(String(req.query.status || 'OPEN').toUpperCase()) }); } catch (e) { fail(res, e, 'Could not load.'); }
});
router.post('/admin/disputes/:id/resolve', requireAdminAuth, async (req, res) => {
  try {
    if (noAi(req, res)) return;
    const out = await D.adminResolve(req.params.id, { decision: String(req.body?.decision || '').toUpperCase(), note: req.body?.note });
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'DISPUTE_RESOLVE', details: { disputeId: req.params.id, ...out } } }).catch(() => {});
    res.json(out);
  } catch (e) { fail(res, e, 'Could not resolve.'); }
});
router.post('/admin/disputes/:id/bank', requireAdminAuth, async (req, res) => {
  try {
    if (noAi(req, res)) return;
    const out = await D.adminBank(req.params.id, { status: String(req.body?.status || '').toUpperCase(), note: req.body?.note, amount: req.body?.amount });
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'DISPUTE_BANK', details: { disputeId: req.params.id, ...out } } }).catch(() => {});
    res.json(out);
  } catch (e) { fail(res, e, 'Could not update.'); }
});

module.exports = router;
