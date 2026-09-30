const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');
const { confirmTransaction } = require('../lib/security');
const epins = require('../lib/epins');

const router = express.Router();

function fail(res, error, what) {
  if (error instanceof epins.EpinError) return res.status(error.status).json({ error: error.message, code: error.code });
  console.error(`${what} failed:`, error.message);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// --- Customers ------------------------------------------------------------

router.get('/epins/options', requireCustomerAuth, async (req, res) => {
  try { res.json(await epins.options(req.customer.customerId)); } catch (e) { fail(res, e, 'GET /epins/options'); }
});

router.get('/epins', requireCustomerAuth, async (req, res) => {
  try { res.json({ batches: await epins.list(req.customer.customerId) }); } catch (e) { fail(res, e, 'GET /epins'); }
});

router.get('/epins/:id', requireCustomerAuth, async (req, res) => {
  try {
    const batch = await epins.view(req.params.id, req.customer.customerId);
    if (!batch) return res.status(404).json({ error: 'Batch not found.' });
    res.set('Cache-Control', 'no-store');
    res.json({ batch });
  } catch (e) { fail(res, e, 'GET /epins/:id'); }
});

// Buy cards — needs the transaction PIN / fingerprint like any purchase.
router.post('/epins', requireCustomerAuth, async (req, res) => {
  try {
    const confirmation = await confirmTransaction(req);
    if (!confirmation.ok) return res.status(confirmation.status).json({ error: confirmation.error, code: confirmation.code });
    const batch = await epins.buy(req.customer.customerId, req.body || {});
    res.status(batch.status === 'PENDING' ? 202 : batch.status === 'FAILED' ? 502 : 201).json({
      batch,
      ...(batch.status === 'PENDING' ? { message: 'Your cards are being prepared. We will notify you as soon as they are ready.' } : {}),
      ...(batch.status === 'FAILED' ? { error: 'The cards could not be printed. You have been refunded.' } : {}),
    });
  } catch (e) { fail(res, e, 'POST /epins'); }
});

router.post('/epins/:id/printed', requireCustomerAuth, async (req, res) => {
  try { await epins.markPrinted(req.params.id, req.customer.customerId); res.json({ ok: true }); } catch (e) { fail(res, e, 'POST /epins/:id/printed'); }
});

router.post('/epins/:id/sold', requireCustomerAuth, async (req, res) => {
  try {
    await epins.markSold(req.params.id, req.customer.customerId, req.body?.cardIds, req.body?.sold !== false);
    res.json({ batch: await epins.view(req.params.id, req.customer.customerId) });
  } catch (e) { fail(res, e, 'POST /epins/:id/sold'); }
});

// --- Admin (owner only — not in the support-staff allow list) ------------

router.get('/admin/epins', requireAdminAuth, async (req, res) => {
  try { res.json(await epins.adminOverview()); } catch (e) { fail(res, e, 'GET /admin/epins'); }
});

router.put('/admin/epins/settings', requireAdminAuth, async (req, res) => {
  try {
    if (req.headers['x-admin-assistant']) return res.status(403).json({ error: 'The AI assistant cannot change supplier keys.' });
    await epins.updateSettings(req.body || {});
    const changed = Object.keys(req.body || {}).filter((k) => k !== 'ckApiKey');
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'EPIN_SETTINGS', details: { changed, keyChanged: Boolean(req.body?.ckApiKey || req.body?.ckApiKeyClear) } } }).catch(() => {});
    res.json(await epins.adminOverview());
  } catch (e) { fail(res, e, 'PUT /admin/epins/settings'); }
});

router.post('/admin/epins/:id/:action', requireAdminAuth, async (req, res) => {
  try {
    if (!['recheck', 'refund'].includes(req.params.action)) return res.status(404).json({ error: 'Not found.' });
    if (req.headers['x-admin-assistant']) return res.status(403).json({ error: 'Only the owner can do this.' });
    const b = await epins.adminResolve(req.params.id, req.params.action);
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: `EPIN_${req.params.action.toUpperCase()}`, details: { batchId: req.params.id, status: b?.status } } }).catch(() => {});
    res.json({ status: b?.status });
  } catch (e) { fail(res, e, 'POST /admin/epins/:id/:action'); }
});

module.exports = router;
