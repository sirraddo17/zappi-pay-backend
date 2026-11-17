// "Verify with BVN" + auto-fill (lib/bvnAutofill.js, lib/bvnProviders).
// Customer routes: start (code sent to the BVN phone) and confirm (code →
// locked name and date of birth). Admin routes (owner only — not in the
// support allow-list): the OFF / Testers only / ON switch, provider and keys.
// The AI assistant can't call any of them. BVNs are never logged.

const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');
const { getSettings, invalidateSettings } = require('../lib/vtpass');
const B = require('../lib/bvnAutofill');
const { PROVIDERS } = require('../lib/bvnProviders');
const { clientIp } = require('../lib/protect');
const { scrub } = require('../lib/idNumber');

const router = express.Router();
const noAi = (req, res) => { if (req.headers['x-admin-assistant']) { res.status(403).json({ error: 'The AI assistant can’t do this.' }); return true; } return false; };
const fail = (res, error, what) => {
  if (error instanceof B.BvnError) return res.status(error.status).json({ error: error.message, code: error.code });
  console.error(`${what} failed:`, scrub(error.message));
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
};

router.post('/wallet/bvn/start', requireCustomerAuth, async (req, res) => {
  if (noAi(req, res)) return;
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    res.json(await B.start(customer, { bvn: req.body?.bvn, consent: Boolean(req.body?.consent), ip: clientIp(req) }));
  } catch (error) { fail(res, error, 'POST /wallet/bvn/start'); }
});

router.post('/wallet/bvn/confirm', requireCustomerAuth, async (req, res) => {
  if (noAi(req, res)) return;
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    res.json(await B.confirm(customer, { sessionId: req.body?.sessionId, otp: req.body?.otp, bvn: req.body?.bvn }));
  } catch (error) { fail(res, error, 'POST /wallet/bvn/confirm'); }
});

// --- admin ---------------------------------------------------------------------------
async function adminView() {
  const s = await getSettings();
  return {
    mode: s.bvnAutofillMode || 'OFF',
    provider: s.bvnProvider || 'test',
    providers: Object.entries(PROVIDERS).map(([key, p]) => ({ key, name: p.name, implemented: p.implemented })),
    keySet: Boolean(s.bvnProviderKey),
    keyHint: s.bvnProviderKey ? `…${String(s.bvnProviderKey).slice(-4)}` : null,
    appIdSet: Boolean(s.bvnProviderAppId),
    testers: Array.isArray(s.featureTesters) ? s.featureTesters.length : 0,
    month: await B.monthCounts(),
  };
}

router.get('/admin/bvn-autofill', requireAdminAuth, async (req, res) => {
  try { res.json(await adminView()); } catch (error) { fail(res, error, 'GET /admin/bvn-autofill'); }
});

router.put('/admin/bvn-autofill', requireAdminAuth, async (req, res) => {
  if (noAi(req, res)) return;
  try {
    const s = await getSettings();
    const b = req.body || {};
    const data = {};
    if (b.provider !== undefined) {
      if (!PROVIDERS[b.provider]) return res.status(400).json({ error: 'Unknown provider.' });
      if (!PROVIDERS[b.provider].implemented) return res.status(400).json({ error: `${PROVIDERS[b.provider].name} isn’t built into the app yet.` });
      data.bvnProvider = b.provider;
    }
    if (b.clearKey) { data.bvnProviderKey = null; data.bvnProviderAppId = null; }
    if (b.apiKey !== undefined && String(b.apiKey).trim()) {
      const k = String(b.apiKey).trim();
      if (!/^[A-Za-z0-9._~+/=:-]{10,400}$/.test(k)) return res.status(400).json({ error: 'That key doesn’t look right (no spaces).' });
      data.bvnProviderKey = k;
    }
    if (b.appId !== undefined && String(b.appId).trim()) data.bvnProviderAppId = String(b.appId).trim().slice(0, 200);
    if (b.mode !== undefined) {
      const m = String(b.mode).toUpperCase();
      if (!['OFF', 'TESTERS', 'ON'].includes(m)) return res.status(400).json({ error: 'Choose Off, Testers only or On.' });
      const provider = data.bvnProvider || s.bvnProvider || 'test';
      const hasKey = data.bvnProviderKey !== undefined ? Boolean(data.bvnProviderKey) : Boolean(s.bvnProviderKey);
      if (m === 'ON' && provider === 'test') return res.status(400).json({ error: 'On for everyone needs a real identity provider. Use “Testers only” with the TEST provider.' });
      if (m === 'ON' && !hasKey) return res.status(400).json({ error: 'Save the provider’s API key before turning it on.' });
      data.bvnAutofillMode = m;
    }
    await prisma.settings.update({ where: { id: s.id }, data });
    invalidateSettings();
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'BVN_AUTOFILL_SETTINGS', details: { mode: data.bvnAutofillMode, provider: data.bvnProvider, keyChanged: data.bvnProviderKey !== undefined } } }).catch(() => {});
    res.json(await adminView());
  } catch (error) { fail(res, error, 'PUT /admin/bvn-autofill'); }
});

module.exports = router;
