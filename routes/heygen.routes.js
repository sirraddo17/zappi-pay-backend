const express = require('express');
const prisma = require('../lib/prisma');
const { requireAdminAuth } = require('../lib/auth');
const H = require('../lib/heygen');

// HeyGen presenter videos (owner only — not in the support-staff list).
const router = express.Router();

function fail(res, error, what) {
  if (error instanceof H.HeygenError) return res.status(error.status).json({ error: error.message, code: error.code });
  console.error(`${what} failed:`, error.message);
  return res.status(500).json({ error: 'Something went wrong with HeyGen.' });
}

router.get('/admin/heygen/status', requireAdminAuth, async (req, res) => {
  try { res.json(await H.status()); } catch (e) { fail(res, e, 'GET /admin/heygen/status'); }
});

router.put('/admin/heygen/settings', requireAdminAuth, async (req, res) => {
  try {
    if (req.headers['x-admin-assistant']) return res.status(403).json({ error: 'The AI assistant cannot change HeyGen settings.' });
    await H.updateSettings(req.body || {});
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'HEYGEN_SETTINGS', details: { changed: Object.keys(req.body || {}).filter((k) => k !== 'apiKey'), keyChanged: Boolean(req.body?.apiKey || req.body?.apiKeyClear) } } }).catch(() => {});
    res.json(await H.status());
  } catch (e) { fail(res, e, 'PUT /admin/heygen/settings'); }
});

router.get('/admin/heygen/avatars', requireAdminAuth, async (req, res) => {
  try { res.json({ avatars: await H.avatars() }); } catch (e) { fail(res, e, 'GET /admin/heygen/avatars'); }
});
router.get('/admin/heygen/voices', requireAdminAuth, async (req, res) => {
  try { res.json({ voices: await H.voices() }); } catch (e) { fail(res, e, 'GET /admin/heygen/voices'); }
});

router.get('/admin/heygen/videos', requireAdminAuth, async (req, res) => {
  try { res.json({ videos: await H.list() }); } catch (e) { fail(res, e, 'GET /admin/heygen/videos'); }
});
// Also used by the AI assistant's "Apply" card (the owner taps Apply).
router.post('/admin/heygen/videos', requireAdminAuth, async (req, res) => {
  try { res.status(201).json({ video: await H.createVideo(req.admin.adminId, req.body || {}) }); } catch (e) { fail(res, e, 'POST /admin/heygen/videos'); }
});
router.get('/admin/heygen/videos/:id', requireAdminAuth, async (req, res) => {
  try { res.json({ video: await H.refresh(req.params.id) }); } catch (e) { fail(res, e, 'GET /admin/heygen/videos/:id'); }
});
router.post('/admin/heygen/videos/:id/attach', requireAdminAuth, async (req, res) => {
  try { res.json(await H.attachToAd(req.params.id, req.body?.adId)); } catch (e) { fail(res, e, 'POST /admin/heygen/videos/:id/attach'); }
});

module.exports = router;
