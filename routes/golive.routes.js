const express = require('express');
const prisma = require('../lib/prisma');
const { requireAdminAuth } = require('../lib/auth');
const goLive = require('../lib/goLive');

// Admin → Go-live check (owner-only via lib/staffAccess.js).
const router = express.Router();

router.get('/admin/go-live', requireAdminAuth, async (req, res) => {
  try {
    res.json(await goLive.report());
  } catch (error) {
    console.error('GET /admin/go-live failed:', error);
    res.status(500).json({ error: 'Could not run the go-live check.' });
  }
});

// Removes TEST account numbers so those customers can get real ones.
// A person has to type REMOVE; the AI assistant can't do it.
router.post('/admin/go-live/remove-test-numbers', requireAdminAuth, async (req, res) => {
  try {
    if (req.headers['x-admin-assistant']) return res.status(403).json({ error: 'Only a person can remove account numbers.' });
    const provider = String(req.body?.provider || '');
    if (!['monnify', 'squad', 'nomba', 'all'].includes(provider)) return res.status(400).json({ error: 'Choose a partner.' });
    if (String(req.body?.confirm || '').trim().toUpperCase() !== 'REMOVE') return res.status(400).json({ error: 'Type REMOVE to confirm.' });
    const r = await goLive.removeTestNumbers(provider);
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'TEST_ACCOUNT_NUMBERS_REMOVED', details: { provider, ...r } } }).catch(() => {});
    res.json({ ok: true, ...r, message: r.customers ? `Removed ${r.numbers} test number${r.numbers === 1 ? '' : 's'} from ${r.customers} customer${r.customers === 1 ? '' : 's'}. They can get a real one on the Wallet page.` : 'No test numbers to remove.' });
  } catch (error) {
    console.error('POST /admin/go-live/remove-test-numbers failed:', error);
    res.status(500).json({ error: 'Could not remove the test numbers.' });
  }
});

module.exports = router;
