const express = require('express');
const { requireCustomerAuth } = require('../lib/auth');
const { confirmTransaction } = require('../lib/security');
const C = require('../lib/connectedApps');
const F = require('../lib/features');

// Connected business apps (lib/connectedApps.js).
//   App side (server to server, Authorization: Bearer zpk_live_…):
//     POST /api/connect/payout-requests        create a request to approve
//     GET  /api/connect/payout-requests/:id    status (id or your reference)
//     GET  /api/connect/banks, /api/connect/account-lookup?bankCode=&accountNumber=
//   Customer side (ZAPPI PAY app):
//     GET/POST /api/connected-apps, PATCH/DELETE /api/connected-apps/:id
//     GET /api/payout-requests, GET /api/payout-requests/:id
//     POST /api/payout-requests/:id/approve (PIN), /decline
const router = express.Router();
const me = (req) => req.customer.customerId;
function fail(res, error, msg) {
  if (error instanceof C.ConnectError || error instanceof F.FeatureError) return res.status(error.status).json({ error: error.message, code: error.code });
  console.error(msg, error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// --- App side ---
async function requireApp(req, res, next) {
  try {
    const app = await C.appFromKey(req.headers.authorization);
    if (!app) return res.status(401).json({ error: 'Invalid or revoked API key.', code: 'BAD_KEY' });
    await F.requireOn('connectedApps', app.customerId);
    req.connectedApp = app;
    next();
  } catch (error) { fail(res, error, 'connect auth failed:'); }
}

router.post('/connect/payout-requests', requireApp, async (req, res) => {
  try {
    const out = await C.createRequest(req.connectedApp, req.body || {});
    res.status(out.duplicate ? 200 : 201).json(out);
  } catch (error) { fail(res, error, 'POST /connect/payout-requests failed:'); }
});

router.get('/connect/payout-requests/:id', requireApp, async (req, res) => {
  try { res.json({ request: await C.getForApp(req.connectedApp, req.params.id) }); } catch (error) { fail(res, error, 'GET /connect/payout-requests failed:'); }
});

router.get('/connect/ping', requireApp, (req, res) => res.json({ ok: true, app: req.connectedApp.name }));

// Bank list and account-name check, so the app can save a supplier's
// bank details correctly before asking for a payment.
router.get('/connect/banks', requireApp, async (req, res) => {
  try { res.json({ banks: await require('../lib/disbursement').listBanks() }); } catch (error) { fail(res, error, 'GET /connect/banks failed:'); }
});
router.get('/connect/account-lookup', requireApp, async (req, res) => {
  try {
    const bankCode = String(req.query.bankCode || '').trim();
    const accountNumber = String(req.query.accountNumber || '').replace(/\D/g, '');
    if (!bankCode || accountNumber.length !== 10) return res.status(400).json({ error: 'bankCode and a 10-digit accountNumber are required.' });
    const acct = await require('../lib/disbursement').lookupAccount(bankCode, accountNumber);
    res.json({ accountNumber: acct.accountNumber, accountName: acct.accountName });
  } catch (error) {
    if (error && error.status && error.status < 500) return res.status(400).json({ error: error.message });
    fail(res, error, 'GET /connect/account-lookup failed:');
  }
});

// --- Customer side ---
const gate = F.gate('connectedApps');

router.get('/connected-apps', requireCustomerAuth, gate, async (req, res) => {
  try { res.json({ apps: await C.listApps(me(req)) }); } catch (error) { fail(res, error, 'GET /connected-apps failed:'); }
});

// Making a key needs the PIN: whoever holds it can send you requests.
router.post('/connected-apps', requireCustomerAuth, gate, async (req, res) => {
  try {
    const ok = await confirmTransaction(req);
    if (!ok.ok) return res.status(ok.status).json({ error: ok.error, code: ok.code });
    res.status(201).json(await C.createApp(me(req), req.body || {}));
  } catch (error) { fail(res, error, 'POST /connected-apps failed:'); }
});

router.patch('/connected-apps/:id', requireCustomerAuth, gate, async (req, res) => {
  try { await C.updateApp(me(req), req.params.id, req.body || {}); res.json({ apps: await C.listApps(me(req)) }); } catch (error) { fail(res, error, 'PATCH /connected-apps failed:'); }
});

router.delete('/connected-apps/:id', requireCustomerAuth, async (req, res) => {
  try { await C.revokeApp(me(req), req.params.id); res.json({ apps: await C.listApps(me(req)) }); } catch (error) { fail(res, error, 'DELETE /connected-apps failed:'); }
});

router.get('/payout-requests', requireCustomerAuth, async (req, res) => {
  try { res.json({ requests: await C.listForCustomer(me(req)) }); } catch (error) { fail(res, error, 'GET /payout-requests failed:'); }
});

router.get('/payout-requests/:id', requireCustomerAuth, async (req, res) => {
  try { res.json({ request: await C.getForCustomer(me(req), req.params.id) }); } catch (error) { fail(res, error, 'GET /payout-requests/:id failed:'); }
});

router.post('/payout-requests/:id/approve', requireCustomerAuth, gate, async (req, res) => {
  try {
    if (req.headers['x-admin-assistant']) return res.status(403).json({ error: 'Only you can approve payments.' });
    const familyError = await require('../lib/family').checkSend(me(req));
    if (familyError) return res.status(403).json({ error: familyError, code: 'FAMILY_LIMIT' });
    const circleLock = await require('../lib/circles').owingLock(me(req));
    if (circleLock) return res.status(403).json({ error: circleLock, code: 'CIRCLE_OWING' });
    const ok = await confirmTransaction(req);
    if (!ok.ok) return res.status(ok.status).json({ error: ok.error, code: ok.code });
    res.json({ request: await C.approve(me(req), req.params.id) });
  } catch (error) { fail(res, error, 'POST /payout-requests/:id/approve failed:'); }
});

router.post('/payout-requests/:id/decline', requireCustomerAuth, async (req, res) => {
  try { res.json({ request: await C.decline(me(req), req.params.id) }); } catch (error) { fail(res, error, 'POST /payout-requests/:id/decline failed:'); }
});

module.exports = router;
