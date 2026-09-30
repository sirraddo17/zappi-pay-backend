const express = require('express');
const prisma = require('../lib/prisma');
const { requireAdminAuth } = require('../lib/auth');
const { getSettings, invalidateSettings } = require('../lib/vtpass');

// Video adverts (optional — off unless the owner turns them on) and the
// AI video-script writer for social media.
const router = express.Router();
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];

const audit = (req, action, details) => prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action, details } }).catch(() => {});

// Streams with Range support (phones need it to play video).
router.get('/ads/:id/video', async (req, res) => {
  try {
    const settings = await getSettings();
    if (!settings.videoAdsEnabled) return res.status(404).end();
    const v = await prisma.adVideo.findUnique({ where: { adId: req.params.id } });
    if (!v) return res.status(404).end();
    const buf = Buffer.from(v.data);
    const total = buf.length;
    res.set('Content-Type', v.mime);
    res.set('Accept-Ranges', 'bytes');
    res.set('Cache-Control', 'public, max-age=86400');
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      let start = m[1] === '' ? total - Number(m[2]) : Number(m[1]);
      let end = m[1] !== '' && m[2] !== '' ? Number(m[2]) : total - 1;
      if (!(start >= 0) || start >= total || end < start) {
        res.set('Content-Range', `bytes */${total}`);
        return res.status(416).end();
      }
      end = Math.min(end, total - 1);
      start = Math.max(0, start);
      res.status(206);
      res.set('Content-Range', `bytes ${start}-${end}/${total}`);
      res.set('Content-Length', String(end - start + 1));
      return res.end(buf.subarray(start, end + 1));
    }
    res.set('Content-Length', String(total));
    return res.end(buf);
  } catch (error) {
    console.error('GET /ads/:id/video failed:', error.message);
    return res.status(404).end();
  }
});

router.put('/admin/ads/:id/video', requireAdminAuth, express.raw({ type: TYPES, limit: MAX_BYTES + 1024 }), async (req, res) => {
  try {
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
    if (!TYPES.includes(mime)) return res.status(400).json({ error: 'The video must be MP4 or WebM.' });
    const data = req.body;
    if (!Buffer.isBuffer(data) || data.length < 1000) return res.status(400).json({ error: 'No video received.' });
    if (data.length > MAX_BYTES) return res.status(413).json({ error: 'The video is too large (max 10 MB). Export it shorter or at 720p.' });
    const ad = await prisma.appAd.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!ad) return res.status(404).json({ error: 'Advert not found.' });
    await prisma.adVideo.upsert({ where: { adId: ad.id }, create: { adId: ad.id, mime, size: data.length, data }, update: { mime, size: data.length, data } });
    await prisma.appAd.update({ where: { id: ad.id }, data: { updatedAt: new Date() } });
    await audit(req, 'AD_VIDEO_SET', { adId: ad.id, size: data.length });
    res.json({ ok: true, size: data.length });
  } catch (error) {
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'The video is too large (max 10 MB).' });
    console.error('PUT /admin/ads/:id/video failed:', error.message);
    res.status(500).json({ error: 'Could not save the video.' });
  }
});

router.delete('/admin/ads/:id/video', requireAdminAuth, async (req, res) => {
  await prisma.adVideo.deleteMany({ where: { adId: req.params.id } }).catch(() => {});
  await audit(req, 'AD_VIDEO_REMOVED', { adId: req.params.id });
  res.json({ ok: true });
});

router.get('/admin/ads/video-settings', requireAdminAuth, async (req, res) => {
  const settings = await getSettings();
  res.json({ enabled: Boolean(settings.videoAdsEnabled) });
});

router.put('/admin/ads/video-settings', requireAdminAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    const enabled = Boolean(req.body?.enabled);
    await prisma.settings.update({ where: { id: settings.id }, data: { videoAdsEnabled: enabled } });
    invalidateSettings();
    await audit(req, 'VIDEO_ADS', { enabled });
    res.json({ enabled });
  } catch (error) {
    res.status(500).json({ error: 'Could not save.' });
  }
});

// 🎬 Social media video script (AI).
router.post('/admin/ai/video-script', requireAdminAuth, async (req, res) => {
  const vs = require('../lib/videoScript');
  try {
    res.json({ script: await vs.generate(req.admin.adminId, req.body || {}) });
  } catch (error) {
    if (error instanceof vs.ScriptError || error.code?.startsWith?.('AI_')) return res.status(400).json({ error: error.message, code: error.code });
    console.error('POST /admin/ai/video-script failed:', error.message);
    res.status(502).json({ error: 'The AI could not write the script right now. Please try again.' });
  }
});

module.exports = router;
