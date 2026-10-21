const express = require('express');
const { requireAdminAuth } = require('../lib/auth');
const dbHealth = require('../lib/dbHealth');

// Admin → Database (owner-only via lib/staffAccess.js). Read-only.
const router = express.Router();

router.get('/admin/database', requireAdminAuth, async (req, res) => {
  try {
    res.json(await dbHealth.report({ fresh: req.query.fresh === '1' }));
  } catch (error) {
    console.error('GET /admin/database failed:', error);
    res.status(500).json({ error: 'Could not check the database.' });
  }
});

module.exports = router;
