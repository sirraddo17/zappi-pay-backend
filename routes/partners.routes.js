// Admin → Partners: partner desk, auto-pause, away mode and follow-ups.
// Owner-only (not in the support-staff allow list). The admin AI may read
// but never change or send anything here.

const express = require('express');
const prisma = require('../lib/prisma');
const { requireAdminAuth } = require('../lib/auth');
const { invalidateSettings } = require('../lib/vtpass');
const desk = require('../lib/partnerDesk');
const health = require('../lib/partnerHealth');
const away = require('../lib/awayMode');
const follow = require('../lib/followUps');

const router = express.Router();
const noAi = (req, res) => { if (req.headers['x-admin-assistant']) { res.status(403).json({ error: 'The AI assistant can’t change this — do it from the Partners page.' }); return true; } return false; };
const audit = (req, action, details) => prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action, details } }).catch(() => {});
const H = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (error) {
    if (res.headersSent) return;
    if (error instanceof desk.DeskError || error instanceof follow.FollowUpError) return res.status(400).json({ error: error.message });
    if (/^Use a time/.test(error.message)) return res.status(400).json({ error: error.message });
    console.error(`${req.method} ${req.path} failed:`, error.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
const guard = (fn) => H(async (req, res) => (noAi(req, res) ? undefined : fn(req, res)));

router.get('/admin/partners', requireAdminAuth, H(async () => {
  const [o, pause, awayCfg, followUps] = await Promise.all([desk.overview(), health.list(), away.config(), follow.list()]);
  return { ...o, autoPause: pause, away: awayCfg, followUps };
}));
router.put('/admin/partners/contacts/:key', requireAdminAuth, guard(async (req) => {
  const p = await desk.savePartner(req.params.key, req.body || {});
  await audit(req, 'PARTNER_SAVED', { key: p.key });
  return { partner: p };
}));
router.delete('/admin/partners/contacts/:key', requireAdminAuth, guard(async (req) => {
  await audit(req, 'PARTNER_DELETED', { key: req.params.key });
  return desk.deletePartner(req.params.key);
}));
router.post('/admin/partners/tasks', requireAdminAuth, guard(async (req) => ({ task: await desk.addTask(req.body || {}) })));
router.patch('/admin/partners/tasks/:id', requireAdminAuth, guard(async (req) => ({ task: await desk.updateTask(req.params.id, req.body || {}) })));
router.delete('/admin/partners/tasks/:id', requireAdminAuth, guard(async (req) => desk.deleteTask(req.params.id)));

router.get('/admin/partners/issues', requireAdminAuth, H(async () => desk.issues()));
router.post('/admin/partners/vtpass-draft', requireAdminAuth, H(async (req) => desk.vtpassDraft(Array.isArray(req.body?.orderIds) ? req.body.orderIds.map(String) : [])));
router.post('/admin/partners/reconcile', requireAdminAuth, guard(async (req) => {
  await audit(req, 'PARTNER_RECONCILE', {});
  return desk.reconcile({ by: 'admin' });
}));
router.get('/admin/partners/report', requireAdminAuth, H(async (req) => desk.report(req.query.month)));

// Auto-pause
router.put('/admin/partners/auto-pause', requireAdminAuth, guard(async (req) => {
  const s = await prisma.settings.findFirst({ select: { id: true } });
  await prisma.settings.update({ where: { id: s.id }, data: { autoPauseEnabled: Boolean(req.body?.enabled) } });
  invalidateSettings();
  await audit(req, 'AUTO_PAUSE_SETTING', { enabled: Boolean(req.body?.enabled) });
  return health.list();
}));
router.post('/admin/partners/auto-pause/:provider/resume', requireAdminAuth, guard(async (req) => {
  const ok = await health.resume(req.params.provider);
  await audit(req, 'AUTO_PAUSE_RESUMED', { provider: req.params.provider });
  return { ok, ...(await health.list()) };
}));

// Away mode
router.put('/admin/partners/away', requireAdminAuth, guard(async (req) => {
  const data = away.cleanConfig(req.body || {});
  const s = await prisma.settings.findFirst({ select: { id: true } });
  await prisma.settings.update({ where: { id: s.id }, data });
  invalidateSettings();
  await audit(req, 'AWAY_MODE_SETTING', data);
  return away.config();
}));

// Follow-ups (owner approves before anything reaches customers)
router.post('/admin/partners/follow-ups/:id/send', requireAdminAuth, guard(async (req) => {
  const r = await follow.send(req.params.id, { message: req.body?.message });
  await audit(req, 'FOLLOW_UP_SENT', { id: req.params.id, sent: r.sent });
  return r;
}));
router.post('/admin/partners/follow-ups/:id/dismiss', requireAdminAuth, guard(async (req) => follow.dismiss(req.params.id)));

function startJobs() {
  health.start();
  desk.start();
  require('../lib/fundsGuard').start();
}

module.exports = router;
module.exports.startJobs = startJobs;
