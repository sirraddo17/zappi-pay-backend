const express = require('express');
const { requireAdminAuth } = require('../lib/auth');
const W = require('../lib/attackWatch');

// Admin → 🛡️ Security (owner only — support staff are kept out by
// lib/staffAccess.js). The AI assistant can read the summary but can't
// block or unblock.
const router = express.Router();
const noAi = (req, res) => (req.headers['x-admin-assistant'] ? res.status(403).json({ error: 'The AI assistant cannot block or unblock addresses.' }) : null);

router.get('/admin/security/overview', requireAdminAuth, async (req, res) => {
  try { res.json(await W.summary({ hours: parseInt(req.query.hours, 10) || 24 })); } catch (e) {
    console.error('GET /admin/security/overview failed:', e);
    res.status(500).json({ error: 'Could not load security events.' });
  }
});

router.post('/admin/security/blocks/:id/unblock', requireAdminAuth, async (req, res) => {
  if (noAi(req, res)) return;
  try {
    const row = await W.unblock(req.params.id, req.admin.adminId);
    if (!row) return res.status(404).json({ error: 'Block not found.' });
    res.json({ ok: true });
  } catch (e) {
    console.error('unblock failed:', e);
    res.status(500).json({ error: 'Could not unblock.' });
  }
});

router.post('/admin/security/blocks', requireAdminAuth, async (req, res) => {
  if (noAi(req, res)) return;
  try {
    const ip = String(req.body?.ip || '').trim();
    if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) return res.status(400).json({ error: 'Enter a valid internet address (IP).' });
    if (ip === require('../lib/protect').clientIp(req)) return res.status(400).json({ error: 'That is your own address — blocking it would lock you out.' });
    const hours = Math.min(24 * 30, Math.max(0.25, Number(req.body?.hours) || 24));
    const row = await W.blockIp(ip, { scope: req.body?.scope === 'ADMIN' ? 'ADMIN' : 'ALL', hours, reason: String(req.body?.reason || 'blocked by the owner').slice(0, 120), auto: false });
    if (!row) return res.status(400).json({ error: 'Could not block that address (it may be on the trusted list).' });
    await require('../lib/prisma').auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'IP_BLOCKED', details: { ip, hours } } }).catch(() => {});
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error('block failed:', e);
    res.status(500).json({ error: 'Could not block.' });
  }
});

module.exports = router;
