const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');
const { getSettings } = require('../lib/vtpass');
const ch = require('../lib/challenges');

// Activity rewards — see lib/challenges.js. Admin routes are owner-only
// (not in lib/staffAccess.js's support list).
const router = express.Router();

function fail(res, error, what) {
  if (error instanceof ch.ChallengeError) return res.status(400).json({ error: error.message });
  console.error(`${what} failed:`, error);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

router.get('/challenges', requireCustomerAuth, async (req, res) => {
  try {
    res.json({ challenges: await ch.forCustomer(req.customer.customerId) });
  } catch (error) {
    fail(res, error, 'GET /challenges');
  }
});

router.get('/admin/challenges', requireAdminAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    const list = await prisma.challenge.findMany({ orderBy: { createdAt: 'desc' }, include: { _count: { select: { rewards: true } } } });
    const now = new Date();
    res.json({
      challenges: list.map((c) => ({
        ...c,
        reward: Number(c.reward),
        budget: c.budget == null ? null : Number(c.budget),
        paidTotal: Number(c.paidTotal),
        completions: c._count?.rewards || 0,
        running: Boolean(ch.windowFor(c, now)),
        preview: ch.preview(c, settings),
      })),
      safetyLimit: settings.rewardGuardEnabled !== false ? Number(settings.rewardGuardPercent ?? 50) : null,
    });
  } catch (error) {
    fail(res, error, 'GET /admin/challenges');
  }
});

// "Will this reward fit my earnings?" before saving.
router.post('/admin/challenges/preview', requireAdminAuth, async (req, res) => {
  try {
    const data = ch.validate(req.body || {});
    res.json(ch.preview(data, await getSettings()));
  } catch (error) {
    fail(res, error, 'POST /admin/challenges/preview');
  }
});

router.post('/admin/challenges', requireAdminAuth, async (req, res) => {
  try {
    const data = ch.validate(req.body || {});
    const created = await prisma.challenge.create({ data });
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'CHALLENGE_CREATED', details: { id: created.id, title: created.title, reward: data.reward } } });
    res.status(201).json({ challenge: created, preview: ch.preview(data, await getSettings()) });
  } catch (error) {
    fail(res, error, 'POST /admin/challenges');
  }
});

router.patch('/admin/challenges/:id', requireAdminAuth, async (req, res) => {
  try {
    const existing = await prisma.challenge.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Challenge not found.' });
    const onlyToggle = Object.keys(req.body || {}).every((k) => k === 'active');
    const data = onlyToggle ? { active: Boolean(req.body.active) } : ch.validate(req.body || {}, { ...existing, reward: Number(existing.reward), budget: existing.budget == null ? null : Number(existing.budget) });
    const updated = await prisma.challenge.update({ where: { id: existing.id }, data });
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'CHALLENGE_UPDATED', details: { id: existing.id, changed: Object.keys(data) } } });
    res.json({ challenge: updated });
  } catch (error) {
    fail(res, error, 'PATCH /admin/challenges/:id');
  }
});

module.exports = router;
