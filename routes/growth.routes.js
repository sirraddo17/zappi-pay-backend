const express = require('express');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');
const { getSettings } = require('../lib/vtpass');
const { confirmTransaction } = require('../lib/security');
const { performPurchase } = require('../lib/purchase');
const push = require('../lib/push');
const { notify } = require('../lib/notify');

// Push notifications, bulk airtime/data and loyalty points.
const router = express.Router();

// --- Push ---------------------------------------------------------

router.get('/push/key', async (req, res) => {
  try {
    res.json({ publicKey: await push.publicKey() });
  } catch (error) {
    console.error('GET /push/key failed:', error);
    res.status(500).json({ error: 'Push notifications are not available.' });
  }
});

router.post('/push/subscribe', requireCustomerAuth, async (req, res) => {
  try {
    const sub = req.body?.subscription || {};
    const endpoint = String(sub.endpoint || '');
    const p256dh = String(sub.keys?.p256dh || '');
    const auth = String(sub.keys?.auth || '');
    if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) return res.status(400).json({ error: 'Invalid subscription.' });
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { customerId: req.customer.customerId, endpoint, p256dh, auth },
      update: { customerId: req.customer.customerId, p256dh, auth },
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('POST /push/subscribe failed:', error);
    res.status(500).json({ error: 'Could not turn on notifications.' });
  }
});

router.post('/push/unsubscribe', requireCustomerAuth, async (req, res) => {
  try {
    const endpoint = String(req.body?.endpoint || '');
    if (endpoint) await prisma.pushSubscription.deleteMany({ where: { endpoint, customerId: req.customer.customerId } });
    res.json({ ok: true });
  } catch (error) {
    console.error('POST /push/unsubscribe failed:', error);
    res.status(500).json({ error: 'Could not turn off notifications.' });
  }
});

router.post('/admin/push/broadcast', requireAdminAuth, async (req, res) => {
  try {
    const title = String(req.body?.title || '').trim().slice(0, 60);
    const message = String(req.body?.message || '').trim().slice(0, 180);
    if (!title || !message) return res.status(400).json({ error: 'Write a title and a message.' });
    const result = await push.pushToAll(title, message, '/');
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'PUSH_BROADCAST', details: { title, message, sent: result.sent } } }).catch(() => {});
    res.json(result);
  } catch (error) {
    console.error('POST /admin/push/broadcast failed:', error);
    res.status(500).json({ error: 'Could not send the notification.' });
  }
});

router.get('/admin/push/stats', requireAdminAuth, async (req, res) => {
  try {
    const [devices, customers] = await Promise.all([
      prisma.pushSubscription.count(),
      prisma.pushSubscription.groupBy({ by: ['customerId'] }).then((r) => r.length),
    ]);
    res.json({ devices, customers });
  } catch (error) {
    res.status(500).json({ error: 'Could not load push stats.' });
  }
});

// --- Bulk airtime / data -------------------------------------------

// Jobs run one purchase at a time in the background; the phone polls
// for progress. Every purchase is a normal order (in Orders, receipts,
// refunds), so nothing is lost if the server restarts mid-way — the
// remaining numbers just aren't bought.
const jobs = new Map();
const MAX_NUMBERS = 50;

function normalizePhone(p) {
  let n = String(p || '').replace(/\D/g, '');
  if (n.startsWith('234') && n.length === 13) n = `0${n.slice(3)}`;
  return /^0\d{10}$/.test(n) ? n : null;
}

router.post('/vtpass/bulk', requireCustomerAuth, async (req, res) => {
  try {
    const { service, serviceID, variationCode, amount } = req.body || {};
    if (!['AIRTIME', 'DATA'].includes(service)) return res.status(400).json({ error: 'Bulk buying is for airtime and data only.' });
    if (!serviceID) return res.status(400).json({ error: 'Choose a network.' });
    if (service === 'DATA' && !variationCode) return res.status(400).json({ error: 'Choose a data plan.' });
    if (service === 'AIRTIME' && !(Number(amount) > 0)) return res.status(400).json({ error: 'Enter an amount.' });

    const raw = Array.isArray(req.body.phones) ? req.body.phones : String(req.body.phones || '').split(/[\s,;]+/);
    const phones = [];
    const invalid = [];
    for (const p of raw.map((x) => String(x).trim()).filter(Boolean)) {
      const n = normalizePhone(p);
      if (!n) invalid.push(p);
      else if (!phones.includes(n)) phones.push(n);
    }
    if (invalid.length) return res.status(400).json({ error: `These don't look like phone numbers: ${invalid.slice(0, 5).join(', ')}` });
    if (!phones.length) return res.status(400).json({ error: 'Add at least one phone number.' });
    if (phones.length > MAX_NUMBERS) return res.status(400).json({ error: `You can send to up to ${MAX_NUMBERS} numbers at once.` });

    const running = [...jobs.values()].find((j) => j.customerId === req.customer.customerId && j.status === 'running');
    if (running) return res.status(409).json({ error: 'A bulk purchase is already running. Wait for it to finish.', jobId: running.id });

    const confirmation = await confirmTransaction(req);
    if (!confirmation.ok) return res.status(confirmation.status).json({ error: confirmation.error, code: confirmation.code });

    const id = crypto.randomBytes(8).toString('hex');
    const job = { id, customerId: req.customer.customerId, service, status: 'running', total: phones.length, done: 0, results: phones.map((phone) => ({ phone, status: 'waiting' })), createdAt: Date.now() };
    jobs.set(id, job);
    res.status(202).json({ jobId: id, total: phones.length });

    (async () => {
      for (const r of job.results) {
        if (job.status === 'stopped') {
          r.status = 'skipped';
          continue;
        }
        try {
          const out = await performPurchase(job.customerId, { service, serviceID, variationCode: variationCode || undefined, billersCode: r.phone, phone: r.phone, amount: service === 'AIRTIME' ? Number(amount) : undefined }, { source: 'bulk' });
          r.status = out.status === 201 ? 'success' : out.status === 202 ? 'pending' : 'failed';
          r.amount = out.body?.order?.amount;
          r.orderId = out.body?.order?.id;
          if (out.status >= 400) r.error = out.body?.error;
          // Out of money or over the limit — no point trying the rest.
          if (['INSUFFICIENT_BALANCE', 'DAILY_LIMIT'].includes(out.body?.code)) job.status = 'stopped';
        } catch (error) {
          r.status = 'failed';
          r.error = 'Unexpected error.';
        }
        job.done += 1;
      }
      if (job.status === 'running') job.status = 'finished';
      const ok = job.results.filter((r) => r.status === 'success').length;
      const pend = job.results.filter((r) => r.status === 'pending').length;
      notify(job.customerId, 'Bulk Purchase Finished', `Bulk ${service.toLowerCase()}: ${ok} of ${job.total} successful${pend ? `, ${pend} still processing` : ''}. Failed ones were refunded.`);
      setTimeout(() => jobs.delete(id), 6 * 3600 * 1000);
    })();
  } catch (error) {
    console.error('POST /vtpass/bulk failed:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Could not start the bulk purchase.' });
  }
});

router.get('/vtpass/bulk/:id', requireCustomerAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.customerId !== req.customer.customerId) return res.status(404).json({ error: 'Bulk purchase not found (it may have finished a while ago — check Orders).' });
  res.json(job);
});

// --- Loyalty points --------------------------------------------------

router.get('/loyalty', requireCustomerAuth, async (req, res) => {
  try {
    const [settings, customer] = await Promise.all([
      getSettings(),
      prisma.customer.findUnique({ where: { id: req.customer.customerId }, select: { loyaltyPoints: true } }),
    ]);
    const value = Number(settings.loyaltyPointValue || 0);
    res.json({
      enabled: Boolean(settings.loyaltyEnabled),
      points: customer.loyaltyPoints,
      worth: Math.floor(customer.loyaltyPoints * value * 100) / 100,
      pointValue: value,
      pointsPer100: Number(settings.loyaltyPointsPer100 || 0),
      minRedeem: settings.loyaltyMinRedeem,
    });
  } catch (error) {
    console.error('GET /loyalty failed:', error);
    res.status(500).json({ error: 'Could not load your points.' });
  }
});

// Converts all points into wallet credit (claimed with a conditional
// update so a double tap can't redeem twice).
router.post('/loyalty/redeem', requireCustomerAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    if (!settings.loyaltyEnabled) return res.status(400).json({ error: 'Loyalty points are not available right now.' });
    const id = req.customer.customerId;
    const c = await prisma.customer.findUnique({ where: { id }, select: { loyaltyPoints: true } });
    const points = c.loyaltyPoints;
    if (points < settings.loyaltyMinRedeem) return res.status(400).json({ error: `You need at least ${settings.loyaltyMinRedeem} points to redeem.` });
    const credit = Math.floor(points * Number(settings.loyaltyPointValue || 0) * 100) / 100;
    if (!(credit > 0)) return res.status(400).json({ error: 'Nothing to redeem.' });
    let ok = false;
    await prisma.$transaction(async (tx) => {
      const r = await tx.customer.updateMany({ where: { id, loyaltyPoints: points }, data: { loyaltyPoints: 0, walletBalance: { increment: credit } } });
      if (r.count !== 1) return;
      await tx.walletTransaction.create({ data: { customerId: id, type: 'LOYALTY', amount: credit, status: 'APPROVED', note: `Redeemed ${points} loyalty points` } });
      ok = true;
    });
    if (!ok) return res.status(409).json({ error: 'Your points changed — please try again.' });
    notify(id, 'Points Redeemed', `${points} points turned into ₦${credit.toLocaleString()} in your wallet.`);
    res.json({ credit, points });
  } catch (error) {
    console.error('POST /loyalty/redeem failed:', error);
    res.status(500).json({ error: 'Could not redeem your points.' });
  }
});

module.exports = router;
