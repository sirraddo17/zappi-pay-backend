const express = require('express');
const prisma = require('../lib/prisma');
const { requireAdminAuth } = require('../lib/auth');
const { getSettings } = require('../lib/vtpass');
const ins = require('../lib/adminInsights');

// Owner insights (not in lib/staffAccess.js's support list, so owner
// only), Help Centre answers, and ad view counting.
const router = express.Router();
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (error) {
    console.error(`${req.method} ${req.path} failed:`, error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Something went wrong.' });
  }
};

router.get('/admin/risk-flags', requireAdminAuth, wrap(async (req, res) => {
  await ins.recordFlags(await ins.fraudFlags());
  res.json({ flags: await ins.openFlags() });
}));
router.post('/admin/risk-flags/:id/dismiss', requireAdminAuth, wrap(async (req, res) => {
  await prisma.riskFlag.update({ where: { id: req.params.id }, data: { status: 'DISMISSED' } });
  res.json({ ok: true });
}));
router.get('/admin/ai/briefing', requireAdminAuth, wrap(async (req, res) => {
  const s = await getSettings();
  const text = await ins.aiBriefing({ ...s, aiBriefingEnabled: true });
  if (!text) return res.status(400).json({ error: 'Turn on the admin AI assistant (Settings → AI Assistant) to get a briefing.' });
  res.json({ briefing: text });
}));

// --- Help Centre answers added from the admin --------------------------
function faqData(b, partial) {
  const d = {};
  const need = (k, max) => {
    if (b[k] === undefined && partial) return;
    const v = String(b[k] || '').trim();
    if (!v) throw Object.assign(new Error(`${k} is required.`), { status: 400 });
    d[k] = v.slice(0, max);
  };
  need('topic', 40); need('question', 200); need('answer', 1500);
  if (b.active !== undefined) d.active = Boolean(b.active);
  return d;
}
router.get('/help/faqs', wrap(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ faqs: await prisma.faqEntry.findMany({ where: { active: true }, orderBy: { createdAt: 'asc' }, take: 200, select: { id: true, topic: true, question: true, answer: true } }) });
}));
router.get('/admin/faqs', requireAdminAuth, wrap(async (req, res) => {
  res.json({ faqs: await prisma.faqEntry.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }) });
}));
router.post('/admin/faqs', requireAdminAuth, wrap(async (req, res) => {
  const faq = await prisma.faqEntry.create({ data: faqData(req.body || {}, false) });
  await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'FAQ_ADDED', details: { question: faq.question } } }).catch(() => {});
  res.status(201).json({ faq });
}));
router.patch('/admin/faqs/:id', requireAdminAuth, wrap(async (req, res) => {
  res.json({ faq: await prisma.faqEntry.update({ where: { id: req.params.id }, data: faqData(req.body || {}, true) }) });
}));

// Ad shown in the app (once per app open, per ad).
router.post('/ads/:id/view', wrap(async (req, res) => {
  await prisma.appAd.update({ where: { id: req.params.id }, data: { views: { increment: 1 } } }).catch(() => {});
  res.json({ ok: true });
}));

module.exports = router;
