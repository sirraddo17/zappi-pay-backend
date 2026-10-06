const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');
const { confirmTransaction } = require('../lib/security');
const { getSettings } = require('../lib/vtpass');
const C = require('../lib/circles');

// Ajo Circle — group contributions (see lib/circles.js).
const router = express.Router();
const me = (req) => req.customer.customerId;

function fail(res, error, msg) {
  if (error instanceof C.CircleError) return res.status(error.status).json({ error: error.message, code: error.code });
  console.error(msg, error);
  return res.status(500).json({ error: msg });
}
// PIN / biometrics before anything that commits money or consent.
async function pin(req, res) {
  const c = await confirmTransaction(req);
  if (!c.ok) { res.status(c.status).json({ error: c.error, code: c.code }); return false; }
  return true;
}
const noAi = (req, res) => {
  if (req.headers['x-admin-assistant']) { res.status(403).json({ error: 'The AI assistant can’t do this — use the Ajo Circles page.' }); return true; }
  return false;
};

router.get('/circles', requireCustomerAuth, async (req, res) => {
  try {
    const s = await getSettings();
    res.json({ enabled: Boolean(s.circlesEnabled), limits: { maxAmount: Number(s.circleMaxAmount || 500000), maxMembers: Number(s.circleMaxMembers || 30), appShare: C.APP_SHARE }, ...(await C.mine(me(req))) });
  } catch (error) { fail(res, error, 'Could not load your circles.'); }
});

router.post('/circles', requireCustomerAuth, async (req, res) => {
  try {
    if (!(await pin(req, res))) return;
    const c = await C.create(me(req), req.body || {});
    res.status(201).json({ circle: C.publicCircle(c) });
  } catch (error) { fail(res, error, 'Could not create the circle.'); }
});

// The agreement for a circle being set up (shown before creating it).
router.post('/circles/agreement-preview', requireCustomerAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const draft = { name: String(b.name || 'Your circle').slice(0, 50), amount: Number(b.amount) || 0, size: parseInt(b.size, 10) || 2, frequency: ['DAILY', 'WEEKLY', 'MONTHLY'].includes(b.frequency) ? b.frequency : 'WEEKLY', payoutFee: b.payoutFeeOn ? Number(b.payoutFee) || 0 : 0, penaltyFee: Number(b.penaltyFee) || 0, graceHours: parseInt(b.graceHours, 10) || 24, strikesToLast: parseInt(b.strikesToLast, 10) || 2, extraRules: String(b.extraRules || '').slice(0, 1500) || null };
    res.json({ agreement: require('../lib/circleAgreement').terms(draft, { appShare: C.APP_SHARE }) });
  } catch (error) { fail(res, error, 'Could not load the agreement.'); }
});

router.get('/circles/join/:code', requireCustomerAuth, async (req, res) => {
  try { res.json(await C.preview(req.params.code, me(req))); } catch (error) { fail(res, error, 'Could not open this circle.'); }
});

router.post('/circles/join/:code', requireCustomerAuth, async (req, res) => {
  try {
    if (!(await pin(req, res))) return;
    res.json(await C.join(req.params.code, me(req), { agree: Boolean(req.body?.agree) }));
  } catch (error) { fail(res, error, 'Could not join the circle.'); }
});

router.post('/circles/appeal', requireCustomerAuth, async (req, res) => {
  try {
    if (!req.body?.agree) return res.status(400).json({ error: 'Tick that you will keep to the agreement.', code: 'AGREE' });
    res.status(201).json({ appeal: await C.appeal(me(req), req.body?.message) });
  } catch (error) { fail(res, error, 'Could not send your appeal.'); }
});

router.get('/circles/:id', requireCustomerAuth, async (req, res) => {
  try { res.json(await C.detail(req.params.id, me(req))); } catch (error) { fail(res, error, 'Could not load the circle.'); }
});

router.post('/circles/:id/invite', requireCustomerAuth, async (req, res) => {
  try { res.json(await C.invite(req.params.id, me(req), req.body?.identifier)); } catch (error) { fail(res, error, 'Could not send the invite.'); }
});

router.post('/circles/:id/leave', requireCustomerAuth, async (req, res) => {
  try { res.json(await C.leave(req.params.id, me(req))); } catch (error) { fail(res, error, 'Could not leave the circle.'); }
});

router.post('/circles/:id/order', requireCustomerAuth, async (req, res) => {
  try { res.json(await C.reorder(req.params.id, me(req), { order: req.body?.order, shuffle: Boolean(req.body?.shuffle) })); } catch (error) { fail(res, error, 'Could not change the order.'); }
});

router.post('/circles/:id/start', requireCustomerAuth, async (req, res) => {
  try {
    if (!(await pin(req, res))) return;
    res.json(await C.start(req.params.id, me(req)));
  } catch (error) { fail(res, error, 'Could not start the circle.'); }
});

router.post('/circles/:id/cancel', requireCustomerAuth, async (req, res) => {
  try { res.json(await C.cancel(req.params.id, { creatorId: me(req) })); } catch (error) { fail(res, error, 'Could not cancel the circle.'); }
});

router.post('/circles/:id/release', requireCustomerAuth, async (req, res) => {
  try {
    if (!(await pin(req, res))) return;
    res.status(201).json({ release: await C.requestRelease(req.params.id, me(req), { reason: req.body?.reason, agree: Boolean(req.body?.agree) }) });
  } catch (error) { fail(res, error, 'Could not send the request.'); }
});

// --- Admin ---
router.get('/admin/circles', requireAdminAuth, async (req, res) => {
  try { res.json(await C.adminList()); } catch (error) { fail(res, error, 'Could not load circles.'); }
});

router.get('/admin/circles/:id', requireAdminAuth, async (req, res) => {
  try { res.json(await C.detail(req.params.id, null, { admin: true })); } catch (error) { fail(res, error, 'Could not load the circle.'); }
});

router.post('/admin/circles/releases/:id', requireAdminAuth, async (req, res) => {
  try {
    if (noAi(req, res)) return;
    const out = await C.reviewRelease(req.params.id, req.admin.adminId, { approve: Boolean(req.body?.approve), note: req.body?.note });
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'CIRCLE_RELEASE', details: { releaseId: req.params.id, ...out } } }).catch(() => {});
    res.json(out);
  } catch (error) { fail(res, error, 'Could not review the request.'); }
});

router.post('/admin/circles/appeals/:id', requireAdminAuth, async (req, res) => {
  try {
    if (noAi(req, res)) return;
    const out = await C.reviewAppeal(req.params.id, req.admin.adminId, { approve: Boolean(req.body?.approve), note: req.body?.note });
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'CIRCLE_APPEAL', details: { appealId: req.params.id, ...out } } }).catch(() => {});
    res.json(out);
  } catch (error) { fail(res, error, 'Could not review the appeal.'); }
});

router.post('/admin/circles/unban/:customerId', requireAdminAuth, async (req, res) => {
  try {
    if (noAi(req, res)) return;
    await prisma.customer.update({ where: { id: req.params.customerId }, data: { circleBannedAt: null, circleBanReason: null } });
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'CIRCLE_UNBAN', details: { customerId: req.params.customerId } } }).catch(() => {});
    res.json({ ok: true });
  } catch (error) { fail(res, error, 'Could not unblock.'); }
});

router.post('/admin/circles/:id/stop', requireAdminAuth, async (req, res) => {
  try {
    if (noAi(req, res)) return;
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 5) return res.status(400).json({ error: 'Give a reason (members will see it).' });
    const out = await C.cancel(req.params.id, { adminId: req.admin.adminId, reason });
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'CIRCLE_STOPPED', details: { circleId: req.params.id, reason, ...out } } }).catch(() => {});
    res.json(out);
  } catch (error) { fail(res, error, 'Could not stop the circle.'); }
});

module.exports = router;
