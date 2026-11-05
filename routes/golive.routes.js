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

// Monnify is live: reset BVN/NIN checks and account numbers made before a
// cutoff date (Lagos), so the real check runs. A person types RESET-KYC;
// the AI assistant can't. Balances, orders and history are untouched.
router.post('/admin/go-live/reset-kyc', requireAdminAuth, async (req, res) => {
  try {
    if (req.headers['x-admin-assistant']) return res.status(403).json({ error: 'Only a person can reset BVN checks.' });
    if (String(req.body?.confirm || '').trim().toUpperCase() !== 'RESET-KYC') return res.status(400).json({ error: 'Type RESET-KYC to confirm.' });
    const day = String(req.body?.cutoff || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'Choose the cutoff date.' });
    // Everything made on or before the cutoff day (Lagos), and never in the future.
    const endOfDay = new Date(`${day}T00:00:00+01:00`).getTime() + 24 * 60 * 60 * 1000;
    if (!Number.isFinite(endOfDay)) return res.status(400).json({ error: 'Choose the cutoff date.' });
    const cutoff = new Date(Math.min(endOfDay, Date.now()));
    const r = await goLive.resetKycBefore(cutoff);
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'KYC_RESET_BEFORE_LIVE', details: { cutoffDay: day, cutoff: cutoff.toISOString(), ...r } } }).catch(() => {});
    res.json({ ok: true, ...r, message: r.customers ? `Reset ${r.customers} customer${r.customers === 1 ? '' : 's'} (${r.wereVerified} had a BVN/NIN check, ${r.numbers} account number${r.numbers === 1 ? '' : 's'} removed). They re-enter their BVN/NIN on the Wallet page; wallet balances are unchanged.` : 'Nobody to reset: no checks or account numbers from before that date.' });
  } catch (error) {
    console.error('POST /admin/go-live/reset-kyc failed:', error);
    res.status(500).json({ error: 'Could not reset BVN checks.' });
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
