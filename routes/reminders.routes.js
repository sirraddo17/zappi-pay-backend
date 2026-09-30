const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth } = require('../lib/auth');
const reminders = require('../lib/reminders');

// Renewal reminders — see lib/reminders.js.
const router = express.Router();

router.get('/reminders', requireCustomerAuth, async (req, res) => {
  try {
    const customerId = req.customer.customerId;
    const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { billRemindersOff: true } });
    res.json({ off: Boolean(customer?.billRemindersOff), upcoming: await reminders.upcoming(customerId) });
  } catch (error) {
    console.error('GET /reminders failed:', error);
    res.status(500).json({ error: 'Could not load reminders.' });
  }
});

// Stop reminding about one bill.
router.delete('/reminders/:id', requireCustomerAuth, async (req, res) => {
  try {
    const r = await prisma.billReminder.updateMany({ where: { id: req.params.id, customerId: req.customer.customerId }, data: { active: false } });
    if (!r.count) return res.status(404).json({ error: 'Reminder not found.' });
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE /reminders failed:', error);
    res.status(500).json({ error: 'Could not update reminder.' });
  }
});

// Turn all renewal reminders off / on.
router.put('/reminders/settings', requireCustomerAuth, async (req, res) => {
  try {
    const off = Boolean(req.body?.off);
    await prisma.customer.update({ where: { id: req.customer.customerId }, data: { billRemindersOff: off } });
    if (!off) await prisma.billReminder.updateMany({ where: { customerId: req.customer.customerId }, data: { active: true } });
    res.json({ off });
  } catch (error) {
    console.error('PUT /reminders/settings failed:', error);
    res.status(500).json({ error: 'Could not save.' });
  }
});

module.exports = router;
