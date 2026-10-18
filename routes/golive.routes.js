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

// Owner's partner accounts (fund / settlement) — lib/partnerAccounts.js.
router.get('/admin/partner-accounts', requireAdminAuth, async (req, res) => {
  try {
    res.json(await require('../lib/partnerAccounts').list());
  } catch (error) {
    console.error('GET /admin/partner-accounts failed:', error);
    res.status(500).json({ error: 'Could not load partner accounts.' });
  }
});

router.put('/admin/partner-accounts', requireAdminAuth, async (req, res) => {
  try {
    if (req.headers['x-admin-assistant']) return res.status(403).json({ error: 'The AI assistant cannot change payment accounts.' });
    const pa = require('../lib/partnerAccounts');
    const out = await pa.save(req.body?.accounts);
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'PARTNER_ACCOUNTS_UPDATED', details: { accounts: (req.body?.accounts || []).length } } }).catch(() => {});
    res.json(out);
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error('PUT /admin/partner-accounts failed:', error);
    res.status(500).json({ error: 'Could not save partner accounts.' });
  }
});

// Database backups (lib/backup.js). Owner-only; never the AI assistant.
const noAi = (req, res) => (req.headers['x-admin-assistant'] ? res.status(403).json({ error: 'Only a person can manage backups.' }) : null);
const backupAudit = (req, action, details) => prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action, details } }).catch(() => {});

router.get('/admin/backup', requireAdminAuth, async (req, res) => {
  try { res.json(await require('../lib/backup').status()); } catch (error) { console.error('GET /admin/backup failed:', error); res.status(500).json({ error: 'Could not load backup settings.' }); }
});

router.put('/admin/backup', requireAdminAuth, async (req, res) => {
  try {
    if (noAi(req, res)) return;
    const out = await require('../lib/backup').setEmails(req.body?.emails);
    await backupAudit(req, 'BACKUP_EMAILS_UPDATED', { count: out.emails.length });
    res.json(out);
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error('PUT /admin/backup failed:', error);
    res.status(500).json({ error: 'Could not save backup emails.' });
  }
});

router.post('/admin/backup/run', requireAdminAuth, async (req, res) => {
  try {
    if (noAi(req, res)) return;
    const r = await require('../lib/backup').runAndEmail({ reason: 'sent now from admin' });
    await backupAudit(req, 'BACKUP_SENT', { sent: r.sent, of: r.of, bytes: r.bytes });
    if (r.skipped || r.error) return res.status(409).json({ error: r.skipped || r.error });
    res.json({ ...r, message: `Backup sent to ${r.sent} of ${r.of} email${r.of === 1 ? '' : 's'}${r.tooBig ? ' (too big to attach — use Download)' : ''}.`, status: await require('../lib/backup').status() });
  } catch (error) {
    console.error('POST /admin/backup/run failed:', error);
    res.status(500).json({ error: 'Could not make the backup.' });
  }
});

router.get('/admin/backup/download', requireAdminAuth, async (req, res) => {
  try {
    if (noAi(req, res)) return;
    const made = await require('../lib/backup').makeFile();
    await backupAudit(req, 'BACKUP_DOWNLOADED', { bytes: made.file.length, rows: made.rows });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${made.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(made.file);
  } catch (error) {
    if (error.status === 409) return res.status(409).json({ error: error.message });
    console.error('GET /admin/backup/download failed:', error);
    res.status(500).json({ error: 'Could not make the backup.' });
  }
});

module.exports = router;
