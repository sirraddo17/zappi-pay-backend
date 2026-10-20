const express = require('express');
const prisma = require('../lib/prisma');
const { requireAdminAuth } = require('../lib/auth');

// Owner corrections for data/internet plans whose VTpass name is wrong
// (lib/planFixes.js). Owner only (the staff gate keeps support staff out).
const router = express.Router();
const audit = (req, action, details) => prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action, details } }).catch(() => {});

router.get('/admin/plan-fixes', requireAdminAuth, async (req, res) => {
  try {
    res.json({ fixes: await prisma.planFix.findMany({ orderBy: { updatedAt: 'desc' } }) });
  } catch (error) {
    console.error('GET /admin/plan-fixes failed:', error);
    res.status(500).json({ error: 'Could not load plan corrections.' });
  }
});

router.put('/admin/plan-fixes', requireAdminAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const serviceID = String(b.serviceID || '').trim().slice(0, 60);
    const variationCode = String(b.variationCode || '').trim().slice(0, 120);
    if (!serviceID || !variationCode) return res.status(400).json({ error: 'Choose the plan to correct.' });
    const h = b.validityHours === '' || b.validityHours == null ? null : parseInt(b.validityHours, 10);
    if (h !== null && !(h >= 1 && h <= 24 * 400)) return res.status(400).json({ error: 'Validity must be between 1 hour and 400 days.' });
    const note = String(b.note || '').trim().slice(0, 160) || null;
    const hidden = Boolean(b.hidden);
    if (h === null && !note && !hidden) return res.status(400).json({ error: 'Set the real validity, add a note, or hide the plan.' });
    let name = String(b.name || '').trim().slice(0, 200) || null;
    if (!name) {
      const d = await require('../lib/catalog').cachedCatalog('/service-variations', { serviceID }).catch(() => null);
      name = (d?.content?.varations || d?.content?.variations || []).find((v) => v.variation_code === variationCode)?.name || null;
    }
    const data = { name, validityHours: h, note, hidden, updatedById: req.admin.adminId };
    const fix = await prisma.planFix.upsert({ where: { serviceID_variationCode: { serviceID, variationCode } }, create: { serviceID, variationCode, ...data }, update: data });
    require('../lib/planFixes').invalidate();
    await audit(req, 'PLAN_FIX_SAVED', { serviceID, variationCode, name, validityHours: h, note, hidden });
    res.json({ fix });
  } catch (error) {
    console.error('PUT /admin/plan-fixes failed:', error);
    res.status(500).json({ error: 'Could not save the correction.' });
  }
});

router.delete('/admin/plan-fixes/:id', requireAdminAuth, async (req, res) => {
  try {
    const f = await prisma.planFix.findUnique({ where: { id: req.params.id } });
    if (!f) return res.status(404).json({ error: 'Correction not found.' });
    await prisma.planFix.delete({ where: { id: f.id } });
    require('../lib/planFixes').invalidate();
    await audit(req, 'PLAN_FIX_REMOVED', { serviceID: f.serviceID, variationCode: f.variationCode, name: f.name });
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE /admin/plan-fixes/:id failed:', error);
    res.status(500).json({ error: 'Could not remove the correction.' });
  }
});

module.exports = router;
