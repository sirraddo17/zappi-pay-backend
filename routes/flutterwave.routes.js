const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');
const fw = require('../lib/flutterwave');

// Card / USSD wallet funding (Flutterwave) + the admin switches for both
// funding methods.
const router = express.Router();

function fail(res, error, msg) {
  if (error instanceof fw.FlutterwaveError) return res.status(error.status).json({ error: error.message, code: error.code });
  console.error(msg, error.message);
  return res.status(500).json({ error: msg });
}

router.post('/wallet/card/start', requireCustomerAuth, async (req, res) => {
  try {
    res.json(await fw.start(req.customer.customerId, req.body?.amount));
  } catch (error) {
    fail(res, error, 'Could not start the card payment.');
  }
});

// Back from Flutterwave's page: confirm and credit (only the customer's own).
router.post('/wallet/card/verify', requireCustomerAuth, async (req, res) => {
  try {
    const txRef = String(req.body?.txRef || '');
    const p = await prisma.cardPayment.findUnique({ where: { txRef } });
    if (!p || p.customerId !== req.customer.customerId) return res.status(404).json({ error: 'Payment not found.' });
    const r = await fw.verifyAndCredit(txRef);
    const fresh = await prisma.customer.findUnique({ where: { id: p.customerId }, select: { walletBalance: true } });
    res.json({ ...r, amount: Number(p.amount), walletBalance: fresh.walletBalance });
  } catch (error) {
    fail(res, error, 'Could not confirm the payment yet. If you paid, it will be added automatically within a few minutes.');
  }
});

// Flutterwave → us. Hash-checked; the payment is re-verified with the API.
router.post('/webhooks/flutterwave', async (req, res) => {
  try {
    if (!(await fw.validHash(req.headers['verif-hash']))) {
      require('../lib/attackWatch').record('WEBHOOK_BAD_SIGNATURE', req, { detail: 'Someone sent a card payment message that was not from Flutterwave. It was rejected — no money moved.' });
      return res.status(401).json({ error: 'Invalid hash.' });
    }
    const d = req.body?.data || {};
    const txRef = d.tx_ref || d.txRef || req.body?.txRef;
    if (txRef && /^zpfw_/.test(String(txRef))) console.log('Flutterwave webhook:', txRef, JSON.stringify(await fw.verifyAndCredit(String(txRef))));
    res.json({ ok: true });
  } catch (error) {
    console.error('POST /webhooks/flutterwave failed:', error.message);
    res.status(500).json({ error: 'Processing failed.' });
  }
});

router.get('/admin/funding-methods', requireAdminAuth, async (req, res) => {
  try {
    const [st, recent] = await Promise.all([
      fw.status(),
      prisma.cardPayment.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);
    res.json({ ...st, recent: recent.map((p) => ({ txRef: p.txRef, amount: Number(p.amount), fee: Number(p.fee), status: p.status, createdAt: p.createdAt })) });
  } catch (error) {
    fail(res, error, 'Could not load funding settings.');
  }
});

router.put('/admin/funding-methods', requireAdminAuth, async (req, res) => {
  try {
    if (req.headers['x-admin-assistant']) return res.status(403).json({ error: 'The AI assistant cannot change payment settings.' });
    const out = await fw.updateSettings(req.body || {});
    const changed = Object.keys(req.body || {}).filter((k) => !/key|hash/i.test(k)).concat(Object.keys(req.body || {}).filter((k) => /key|hash/i.test(k)).map((k) => `${k} (changed)`));
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'FUNDING_METHODS_SETTINGS', details: { changed } } }).catch(() => {});
    res.json(out);
  } catch (error) {
    fail(res, error, 'Could not save.');
  }
});

module.exports = router;
