// Admin → compliance summary (SCUML / NFIU and partner due diligence).
// Owner only: not in the support-staff allow list (lib/staffAccess.js).
// Read-only except the two thresholds; nothing is filed or sent anywhere.

const express = require('express');
const prisma = require('../lib/prisma');
const { requireAdminAuth } = require('../lib/auth');
const C = require('../lib/compliance');
const { toCsv } = require('./money.routes');

const router = express.Router();
const noAi = (req, res) => { if (req.headers['x-admin-assistant']) { res.status(403).json({ error: 'Change this from the Money check page.' }); return true; } return false; };

router.get('/admin/compliance', requireAdminAuth, async (req, res) => {
  try {
    res.json(await C.summary({ month: req.query.month }));
  } catch (error) {
    console.error('GET /admin/compliance failed:', error.message);
    res.status(500).json({ error: 'Could not build the summary.' });
  }
});

router.get('/admin/compliance/export', requireAdminAuth, async (req, res) => {
  try {
    const s = await C.summary({ month: req.query.month });
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'EXPORT_CSV', details: { kind: 'compliance', month: s.month } } }).catch(() => {});
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="zappipay-compliance-${s.month}.csv"`);
    res.send(toCsv(C.CSV_HEADERS, C.csvRows(s)));
  } catch (error) {
    console.error('GET /admin/compliance/export failed:', error.message);
    res.status(500).json({ error: 'Could not create the file.' });
  }
});

router.put('/admin/compliance/settings', requireAdminAuth, async (req, res) => {
  if (noAi(req, res)) return;
  try {
    const t = await C.saveThresholds(req.body || {});
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'COMPLIANCE_THRESHOLDS', details: { singleNaira: t.singleKobo / 100, dailyNaira: t.dailyKobo / 100 } } }).catch(() => {});
    res.json({ singleNaira: t.singleKobo / 100, dailyNaira: t.dailyKobo / 100 });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error('PUT /admin/compliance/settings failed:', error.message);
    res.status(500).json({ error: 'Could not save.' });
  }
});

module.exports = router;
