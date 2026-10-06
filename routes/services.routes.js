const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');
const { confirmTransaction } = require('../lib/security');
const { getSettings, invalidateSettings } = require('../lib/vtpass');
const F = require('../lib/features');
const sms = require('../lib/bulkSms');
const tickets = require('../lib/tickets');
const bills = require('../lib/flwBills');
const checkout = require('../lib/checkout');
const direct = require('../lib/directPay');

// Bulk SMS, Event tickets and More bills — each behind its own switch.
const router = express.Router();
const me = (req) => req.customer.customerId;
const H = (fn, msg) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (error) {
    if (error instanceof F.FeatureError || error.status) return res.status(error.status >= 400 && error.status < 600 ? error.status : 400).json({ error: error.message, code: error.code });
    console.error(msg, error);
    res.status(500).json({ error: msg });
  }
};
const withPin = (fn, msg) => H(async (req, res) => {
  const c = await confirmTransaction(req);
  if (!c.ok) { res.status(c.status).json({ error: c.error, code: c.code }); return undefined; }
  return fn(req, res);
}, msg);
const noAi = (req, res) => { if (req.headers['x-admin-assistant']) { res.status(403).json({ error: 'The AI assistant can’t change this.' }); return true; } return false; };

// --- Bulk SMS ---
router.get('/sms', requireCustomerAuth, F.gate('bulkSms'), H(async (req) => {
  const s = await getSettings();
  return { ...(await sms.senders(me(req))), history: await sms.history(me(req)), pricePerPage: Number(s.smsPricePerPage), dndPricePerPage: Number(s.smsDndPricePerPage), maxRecipients: s.smsMaxRecipients };
}, 'Could not load Bulk SMS.'));
router.post('/sms/quote', requireCustomerAuth, F.gate('bulkSms'), H(async (req) => sms.quote(me(req), req.body || {}), 'Could not price the message.'));
router.post('/sms/send', requireCustomerAuth, withPin(async (req) => sms.send(me(req), req.body || {}), 'Could not send the SMS.'));
router.post('/sms/senders', requireCustomerAuth, H(async (req) => ({ sender: await sms.requestSender(me(req), req.body || {}) }), 'Could not request the sender name.'));

// --- Event tickets ---
router.get('/tickets', requireCustomerAuth, F.gate('tickets'), H(async (req) => {
  const s = await getSettings();
  return { events: await tickets.mine(me(req)), tickets: await tickets.myTickets(me(req)), feeFlat: Number(s.ticketFeeFlat), feePercent: Number(s.ticketFeePercent) };
}, 'Could not load tickets.'));
router.get('/tickets/mine', requireCustomerAuth, H(async (req) => ({ tickets: await tickets.myTickets(me(req)) }), 'Could not load your tickets.'));
router.post('/tickets/events', requireCustomerAuth, H(async (req) => ({ event: await tickets.create(me(req), req.body || {}) }), 'Could not create the event.'));
router.get('/tickets/events/:id', requireCustomerAuth, H(async (req) => tickets.dashboard(req.params.id, me(req)), 'Could not load the event.'));
router.post('/tickets/events/:id/checkin', requireCustomerAuth, H(async (req) => tickets.checkIn(req.params.id, me(req), req.body?.code), 'Could not check in.'));
router.post('/tickets/events/:id/status', requireCustomerAuth, H(async (req) => tickets.setStatus(req.params.id, me(req), req.body?.status), 'Could not update the event.'));
router.get('/tickets/e/:code', requireCustomerAuth, H(async (req) => tickets.publicView(req.params.code, me(req)), 'Could not open this event.'));
router.post('/tickets/e/:code/checkout', requireCustomerAuth, H(async (req) => tickets.checkout(req.params.code, me(req), req.body || {}), 'Could not start checkout.'));
router.get('/tickets/order/:ref', requireCustomerAuth, H(async (req) => tickets.orderView(req.params.ref, me(req)), 'Could not load the order.'));

// --- More bills ---
router.get('/bills/categories', requireCustomerAuth, F.gate('moreBills'), H(async () => ({ categories: await bills.categories() }), 'Could not load bill types.'));
router.get('/bills/categories/:code', requireCustomerAuth, F.gate('moreBills'), H(async (req) => ({ billers: await bills.billers(req.params.code) }), 'Could not load billers.'));
router.get('/bills/billers/:code/items', requireCustomerAuth, F.gate('moreBills'), H(async (req) => ({ items: await bills.items(req.params.code) }), 'Could not load options.'));
router.post('/bills/validate', requireCustomerAuth, H(async (req) => bills.validate(me(req), req.body || {}), 'Could not check the number.'));
router.post('/bills/pay', requireCustomerAuth, withPin(async (req) => bills.pay(me(req), req.body || {}), 'Could not pay the bill.'));
router.get('/bills/history', requireCustomerAuth, H(async (req) => ({ bills: await bills.history(me(req)) }), 'Could not load your bills.'));
router.get('/bills/:ref', requireCustomerAuth, H(async (req) => bills.view(me(req), req.params.ref), 'Could not load the payment.'));

// --- Pay by card at checkout ---
router.get('/checkout/quote', requireCustomerAuth, H(async (req) => checkout.quote(me(req), req.query.needed), 'Could not price the card payment.'));
router.post('/checkout/start', requireCustomerAuth, H(async (req) => checkout.start(me(req), req.body || {}), 'Could not start the card payment.'));
router.get('/checkout/:ref', requireCustomerAuth, H(async (req) => checkout.view(me(req), req.params.ref), 'Could not load the payment.'));

// --- Direct pay (straight to the receiver's bank) ---
router.get('/payout', requireCustomerAuth, H(async (req) => { const s = await getSettings(); return { account: await direct.payout(me(req)), on: direct.isOnFor(s, me(req)), feeFlat: Number(s.directPayFeeFlat), feePercent: Number(s.directPayFeePercent) }; }, 'Could not load.'));
router.put('/payout', requireCustomerAuth, withPin(async (req) => ({ account: await direct.setPayout(me(req), req.body || {}) }), 'Could not save the bank account.'));
router.get('/paid/:ref', requireCustomerAuth, H(async (req) => direct.view(me(req), req.params.ref), 'Could not load the payment.'));

// --- Admin ---
router.get('/admin/extra-services', requireAdminAuth, H(async () => {
  const s = await getSettings();
  return {
    sms: await sms.adminOverview(),
    tickets: { ...(await tickets.adminOverview()), feeFlat: Number(s.ticketFeeFlat), feePercent: Number(s.ticketFeePercent) },
    bills: await bills.adminOverview(),
    direct: { feeFlat: Number(s.directPayFeeFlat), feePercent: Number(s.directPayFeePercent) },
  };
}, 'Could not load.'));
router.put('/admin/extra-services/config', requireAdminAuth, H(async (req, res) => {
  if (noAi(req, res)) return undefined;
  const b = req.body || {};
  const data = {};
  const num = (v, lo, hi) => { const n = Number(v); if (!(n >= lo && n <= hi)) throw new F.FeatureError(`Use a number between ${lo} and ${hi}.`); return n; };
  if (b.smsPricePerPage !== undefined) data.smsPricePerPage = num(b.smsPricePerPage, 1, 100);
  if (b.smsDndPricePerPage !== undefined) data.smsDndPricePerPage = num(b.smsDndPricePerPage, 1, 200);
  if (b.smsMaxRecipients !== undefined) data.smsMaxRecipients = Math.round(num(b.smsMaxRecipients, 1, 10000));
  if (b.smsDefaultSender !== undefined) data.smsDefaultSender = String(b.smsDefaultSender).trim().slice(0, 11) || 'ZAPPIPAY';
  if (b.smsPublicKey) data.smsPublicKey = String(b.smsPublicKey).trim();
  if (b.smsSecretKey) data.smsSecretKey = String(b.smsSecretKey).trim();
  if (b.ticketFeeFlat !== undefined) data.ticketFeeFlat = num(b.ticketFeeFlat, 0, 5000);
  if (b.ticketFeePercent !== undefined) data.ticketFeePercent = num(b.ticketFeePercent, 0, 20);
  if (b.billsFee !== undefined) data.billsFee = num(b.billsFee, 0, 5000);
  if (b.directPayFeeFlat !== undefined) data.directPayFeeFlat = num(b.directPayFeeFlat, 0, 2000);
  if (b.directPayFeePercent !== undefined) data.directPayFeePercent = num(b.directPayFeePercent, 0, 10);
  if (Array.isArray(b.billsHiddenCategories)) data.billsHiddenCategories = b.billsHiddenCategories.map((x) => String(x).slice(0, 40)).slice(0, 50);
  const s = await getSettings();
  await prisma.settings.update({ where: { id: s.id }, data });
  invalidateSettings();
  await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'EXTRA_SERVICES_CONFIG', details: { changed: Object.keys(data).map((k) => (/Key$/.test(k) ? `${k} (hidden)` : k)) } } }).catch(() => {});
  return { ok: true };
}, 'Could not save.'));
router.post('/admin/sms/senders/:id', requireAdminAuth, H(async (req, res) => {
  if (noAi(req, res)) return undefined;
  return sms.reviewSender(req.params.id, Boolean(req.body?.approve), req.body?.note);
}, 'Could not update.'));
router.post('/admin/tickets/events/:id/stop', requireAdminAuth, H(async (req, res) => (noAi(req, res) ? undefined : tickets.adminStop(req.params.id)), 'Could not stop sales.'));
router.post('/admin/bills/:ref/resolve', requireAdminAuth, H(async (req, res) => {
  if (noAi(req, res)) return undefined;
  const out = await bills.adminResolve(req.params.ref, req.body?.outcome);
  await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'BILL_RESOLVE', details: { reference: req.params.ref, outcome: req.body?.outcome } } }).catch(() => {});
  return out;
}, 'Could not resolve.'));

function startJobs() {
  if (process.env.DISABLE_SCHEDULER === '1') return;
  const run = () => {
    tickets.sweep().catch((e) => console.error('tickets sweep failed:', e.message));
    bills.sweep().catch((e) => console.error('bills sweep failed:', e.message));
    checkout.sweep().catch((e) => console.error('checkout sweep failed:', e.message));
    direct.sweep().catch((e) => console.error('direct pay sweep failed:', e.message));
  };
  setTimeout(run, 3 * 60 * 1000).unref?.();
  setInterval(run, 10 * 60 * 1000).unref?.();
}

module.exports = router;
module.exports.startJobs = startJobs;
