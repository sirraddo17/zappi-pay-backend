const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth } = require('../lib/auth');
const { upsertBeneficiary } = require('../lib/schedules');

// Saved beneficiaries (numbers/meters/decoders) and scheduled top-ups.
// Creating a schedule happens through POST /vtpass/purchase (so it's
// PIN-confirmed and only kept if the first payment succeeds); these
// routes list, pause/resume and delete them.
const router = express.Router();

const SERVICES = ['AIRTIME', 'DATA', 'ELECTRICITY', 'CABLE', 'EDUCATION', 'INTERNET', 'BETTING'];

router.get('/beneficiaries', requireCustomerAuth, async (req, res) => {
  try {
    const where = { customerId: req.customer.customerId };
    if (req.query.service && SERVICES.includes(req.query.service)) where.service = req.query.service;
    const beneficiaries = await prisma.beneficiary.findMany({ where, orderBy: { lastUsedAt: 'desc' }, take: 50 });
    res.json({ beneficiaries });
  } catch (error) {
    console.error('GET /beneficiaries failed:', error);
    res.status(500).json({ error: 'Could not load saved numbers.' });
  }
});

router.post('/beneficiaries', requireCustomerAuth, async (req, res) => {
  try {
    const { service, serviceID, billersCode, meterType, nickname } = req.body;
    if (!SERVICES.includes(service) || !serviceID || !billersCode || !String(billersCode).trim()) {
      return res.status(400).json({ error: 'service, serviceID and number are required.' });
    }
    const beneficiary = await upsertBeneficiary(req.customer.customerId, { service, serviceID, billersCode, meterType, nickname });
    res.status(201).json({ beneficiary });
  } catch (error) {
    if (/limit/i.test(error.message)) return res.status(400).json({ error: 'You can save up to 50 numbers. Delete some first.' });
    console.error('POST /beneficiaries failed:', error);
    res.status(500).json({ error: 'Could not save number.' });
  }
});

router.patch('/beneficiaries/:id', requireCustomerAuth, async (req, res) => {
  try {
    const nickname = String(req.body.nickname || '').trim().slice(0, 40) || null;
    const result = await prisma.beneficiary.updateMany({ where: { id: req.params.id, customerId: req.customer.customerId }, data: { nickname } });
    if (!result.count) return res.status(404).json({ error: 'Not found.' });
    res.json({ ok: true });
  } catch (error) {
    console.error('PATCH /beneficiaries/:id failed:', error);
    res.status(500).json({ error: 'Could not update.' });
  }
});

router.delete('/beneficiaries/:id', requireCustomerAuth, async (req, res) => {
  try {
    await prisma.beneficiary.deleteMany({ where: { id: req.params.id, customerId: req.customer.customerId } });
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE /beneficiaries/:id failed:', error);
    res.status(500).json({ error: 'Could not delete.' });
  }
});

router.get('/schedules', requireCustomerAuth, async (req, res) => {
  try {
    const schedules = await prisma.scheduledPurchase.findMany({
      where: { customerId: req.customer.customerId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ schedules });
  } catch (error) {
    console.error('GET /schedules failed:', error);
    res.status(500).json({ error: 'Could not load scheduled top-ups.' });
  }
});

router.patch('/schedules/:id', requireCustomerAuth, async (req, res) => {
  try {
    const s = await prisma.scheduledPurchase.findFirst({ where: { id: req.params.id, customerId: req.customer.customerId } });
    if (!s) return res.status(404).json({ error: 'Not found.' });
    const data = {};
    if (req.body.active !== undefined) {
      data.active = Boolean(req.body.active);
      if (data.active) {
        data.failCount = 0;
        // Resuming after a long pause shouldn't fire immediately for a
        // slot that's long gone — move it to the next future slot.
        const { nextRunAfter } = require('../lib/schedules');
        let next = s.nextRunAt;
        while (next <= new Date()) next = nextRunAfter(next, s.frequency, s.anchorDay);
        data.nextRunAt = next;
      }
    }
    if (req.body.nickname !== undefined) data.nickname = String(req.body.nickname || '').trim().slice(0, 40) || null;
    const schedule = await prisma.scheduledPurchase.update({ where: { id: s.id }, data });
    if (data.active) require('../lib/schedules').kickScheduler();
    res.json({ schedule });
  } catch (error) {
    console.error('PATCH /schedules/:id failed:', error);
    res.status(500).json({ error: 'Could not update.' });
  }
});

router.delete('/schedules/:id', requireCustomerAuth, async (req, res) => {
  try {
    await prisma.scheduledPurchase.deleteMany({ where: { id: req.params.id, customerId: req.customer.customerId } });
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE /schedules/:id failed:', error);
    res.status(500).json({ error: 'Could not delete.' });
  }
});

module.exports = router;
