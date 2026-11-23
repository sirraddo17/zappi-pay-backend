const express = require('express');
const prisma = require('../lib/prisma');
const { requireAdminAuth } = require('../lib/auth');
const waitlist = require('../lib/waitlist');

// Launch waitlist (welcome page form) and its admin page.
const router = express.Router();

// Small per-address limit for the public form: 5 sign-ups an hour.
const hits = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); }, 10 * 60 * 1000).unref();
function limit(req, res, next) {
  const now = Date.now(); const key = req.ip;
  let h = hits.get(key);
  if (!h || h.reset <= now) { h = { n: 0, reset: now + 60 * 60 * 1000 }; hits.set(key, h); }
  if (++h.n > 5) return res.status(429).json({ error: 'Too many tries. Please try again later.' });
  next();
}

async function audit(req, action, details) {
  await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action, details } }).catch(() => {});
}

router.post('/waitlist', limit, async (req, res) => {
  try { res.json(await waitlist.join(req.body || {})); }
  catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not save. Please try again.' }); }
});

router.get('/admin/waitlist', requireAdminAuth, async (req, res) => {
  try { res.json(await waitlist.overview()); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/admin/waitlist/export', requireAdminAuth, async (req, res) => {
  try {
    await audit(req, 'waitlist.exported', 'CSV download');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="zappipay-waitlist-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
    res.send(await waitlist.csv());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/admin/waitlist/phones', requireAdminAuth, async (req, res) => {
  try { res.json({ phones: await waitlist.phones() }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/waitlist/notify', requireAdminAuth, async (req, res) => {
  try {
    const out = await waitlist.notify(req.body || {});
    await audit(req, 'waitlist.emailed', `${out.sent} sent, ${out.failed.length} failed, ${out.left} left`);
    res.json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete('/admin/waitlist/:id', requireAdminAuth, async (req, res) => {
  try { await waitlist.remove(req.params.id); await audit(req, 'waitlist.removed', req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
