const express = require('express');
const prisma = require('../lib/prisma');
const { requireAdminAuth } = require('../lib/auth');
const P = require('../lib/codePr');

// Admin AI code pull requests (owner-only via lib/staffAccess.js).
// Opened only when the owner taps Apply on the assistant's card.
const router = express.Router();

router.get('/admin/code/status', requireAdminAuth, (req, res) => res.json(P.status()));

router.post('/admin/code/pull-request', requireAdminAuth, async (req, res) => {
  try {
    const pr = await P.open(req.body || {});
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'CODE_PULL_REQUEST', details: { url: pr.url, repo: pr.repo, branch: pr.branch, files: (req.body?.files || []).map((f) => f.path) } } }).catch(() => {});
    res.json({ pr: { id: pr.url, ...pr } });
  } catch (error) {
    if (error instanceof P.PrError || error.name === 'CodeError') return res.status(400).json({ error: error.message });
    console.error('POST /admin/code/pull-request failed:', error);
    res.status(502).json({ error: `Could not open the pull request: ${String(error.message || error).slice(0, 200)}` });
  }
});

module.exports = router;
