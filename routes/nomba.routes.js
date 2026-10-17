const express = require('express');
const prisma = require('../lib/prisma');
const { requireAdminAuth } = require('../lib/auth');
const { getSettings, invalidateSettings } = require('../lib/vtpass');
const nomba = require('../lib/nomba');

// Admin → Settings → Wallet funding: Nomba keys, and the payment-partner
// choices (who gives new customers account numbers, who sends Send to
// Bank, automatic backup). Owner-only (lib/staffAccess.js); the AI
// assistant can't change any of it. Keys are never sent back.
const router = express.Router();
const noAi = (req, res) => (req.headers['x-admin-assistant'] ? res.status(403).json({ error: 'The AI assistant cannot change payment settings.' }) : null);
const audit = (req, action, body) => prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action, details: { changed: Object.keys(body || {}).map((k) => (/key|secret|id$/i.test(k) ? `${k} (changed)` : k)) } } }).catch(() => {});
function fail(res, error, msg) {
  if (error instanceof nomba.NombaError) return res.status(error.status && error.status < 500 ? error.status : 502).json({ error: error.message });
  if (error.status && error.status < 500 && error.message) return res.status(error.status).json({ error: error.message });
  console.error(msg, error.message);
  return res.status(500).json({ error: msg });
}

router.get('/admin/nomba', requireAdminAuth, async (req, res) => {
  try {
    res.json(await nomba.status());
  } catch (error) {
    fail(res, error, 'Could not load Nomba settings.');
  }
});

router.put('/admin/nomba', requireAdminAuth, async (req, res) => {
  if (noAi(req, res)) return;
  try {
    const out = await nomba.updateSettings(req.body || {});
    await audit(req, 'NOMBA_SETTINGS', req.body);
    res.json(out);
  } catch (error) {
    fail(res, error, 'Could not save Nomba settings.');
  }
});

router.post('/admin/nomba/test', requireAdminAuth, async (req, res) => {
  try {
    res.json(await nomba.testConnection());
  } catch (error) {
    fail(res, error, 'Could not test Nomba.');
  }
});

// --- Payment partners -------------------------------------------------

const PARTNERS = ['monnify', 'squad', 'nomba'];

async function partners() {
  const s = await getSettings();
  const d = require('../lib/disbursement');
  const monnify = require('../lib/monnify');
  const squad = require('../lib/squad');
  const ready = {};
  for (const p of PARTNERS) ready[p] = await d.providerReady(p).catch(() => false);
  return {
    payoutProvider: await d.payoutProvider(),
    payoutFallback: s.payoutFallback !== false,
    fundingPrimary: PARTNERS.includes(s.fundingPrimary) ? s.fundingPrimary : '',
    funding: {
      monnify: s.monnifyFundingEnabled !== false && (await monnify.isConfigured().catch(() => false)),
      squad: await squad.fundingOn().catch(() => false),
      nomba: await nomba.fundingOn().catch(() => false),
    },
    ready,
  };
}

router.get('/admin/payout-partners', requireAdminAuth, async (req, res) => {
  try {
    res.json(await partners());
  } catch (error) {
    fail(res, error, 'Could not load payment partners.');
  }
});

router.put('/admin/payout-partners', requireAdminAuth, async (req, res) => {
  if (noAi(req, res)) return;
  try {
    const b = req.body || {};
    const now = await partners();
    const data = {};
    if (b.payoutProvider !== undefined) {
      if (!PARTNERS.includes(b.payoutProvider)) return res.status(400).json({ error: 'Choose Monnify, Squad or Nomba.' });
      if (!now.ready[b.payoutProvider]) return res.status(400).json({ error: 'Finish that partner’s setup (keys and wallet / merchant ID) first.' });
      data.payoutProvider = b.payoutProvider;
    }
    if (b.payoutFallback !== undefined) data.payoutFallback = Boolean(b.payoutFallback);
    if (b.fundingPrimary !== undefined) {
      if (b.fundingPrimary !== '' && !PARTNERS.includes(b.fundingPrimary)) return res.status(400).json({ error: 'Choose Monnify, Squad or Nomba.' });
      if (b.fundingPrimary && !now.funding[b.fundingPrimary]) return res.status(400).json({ error: 'Turn that partner’s account numbers on first.' });
      data.fundingPrimary = b.fundingPrimary;
    }
    if (Object.keys(data).length) {
      const s = await getSettings();
      await prisma.settings.update({ where: { id: s.id }, data });
      invalidateSettings();
      await audit(req, 'PAYMENT_PARTNERS', data);
    }
    res.json(await partners());
  } catch (error) {
    fail(res, error, 'Could not save payment partners.');
  }
});

module.exports = router;
