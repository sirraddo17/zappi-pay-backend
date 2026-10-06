const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');
const { confirmTransaction } = require('../lib/security');
const { getSettings, invalidateSettings } = require('../lib/vtpass');
const F = require('../lib/features');
const spray = require('../lib/spray');
const dues = require('../lib/dues');
const pfm = require('../lib/payForMe');
const light = require('../lib/sharedLight');
const safe = require('../lib/safeBuy');
const payroll = require('../lib/payroll');
const daily = require('../lib/dailyRewards');

// Owambe Spray, Association Dues, Pay It For Me, Shared Light, SafeBuy,
// Payroll and Daily rewards — each behind its own switch (lib/features.js).
const router = express.Router();
const me = (req) => req.customer.customerId;
const H = (fn, msg) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (error) {
    if (error instanceof F.FeatureError || error.status) return res.status(error.status || 400).json({ error: error.message, code: error.code });
    console.error(msg, error);
    res.status(500).json({ error: msg });
  }
};
async function pin(req, res) {
  const c = await confirmTransaction(req);
  if (!c.ok) { res.status(c.status).json({ error: c.error, code: c.code }); return false; }
  return true;
}
const withPin = (fn, msg) => H(async (req, res) => ((await pin(req, res)) ? fn(req, res) : undefined), msg);

// --- Owambe Spray ---
router.get('/spray', requireCustomerAuth, H(async (req) => ({ events: await spray.mine(me(req)) }), 'Could not load your events.'));
router.post('/spray', requireCustomerAuth, H(async (req) => ({ event: await spray.create(me(req), req.body || {}) }), 'Could not create the event.'));
router.get('/spray/:code/live', H(async (req) => spray.live(req.params.code, { since: req.query.since }), 'Could not load.'));
router.post('/spray/:code/session', requireCustomerAuth, withPin(async (req) => {
  const s = await spray.startSession(req.params.code, me(req), req.body?.budget);
  return { sessionId: s.id, budget: Number(s.budget), left: Number(s.budget) };
}, 'Could not start spraying.'));
router.post('/spray/:code/gift', requireCustomerAuth, H(async (req) => spray.spray(req.params.code, me(req), req.body || {}), 'Could not spray.'));
router.post('/spray/:code/close', requireCustomerAuth, H(async (req) => spray.close(req.params.code, me(req)), 'Could not end the event.'));

// --- Association Dues ---
router.get('/dues', requireCustomerAuth, H(async (req) => ({ groups: await dues.mine(me(req)) }), 'Could not load your groups.'));
router.post('/dues', requireCustomerAuth, H(async (req) => ({ group: await dues.create(me(req), req.body || {}) }), 'Could not create the group.'));
router.get('/dues/join/:code', requireCustomerAuth, H(async (req) => dues.preview(req.params.code), 'Could not open this group.'));
router.post('/dues/join/:code', requireCustomerAuth, H(async (req) => dues.join(req.params.code, me(req)), 'Could not join.'));
router.get('/dues/:id', requireCustomerAuth, H(async (req) => dues.detail(req.params.id, me(req), { period: req.query.period }), 'Could not load the group.'));
router.post('/dues/:id/pay', requireCustomerAuth, withPin(async (req) => dues.pay(req.params.id, me(req), req.body?.period), 'Could not pay.'));
router.post('/dues/:id/autopay', requireCustomerAuth, withPin(async (req) => dues.setAutoPay(req.params.id, me(req), Boolean(req.body?.on)), 'Could not change auto-pay.'));
router.post('/dues/:id/remind', requireCustomerAuth, H(async (req) => dues.remindUnpaid(req.params.id, me(req)), 'Could not send reminders.'));
router.post('/dues/:id/leave', requireCustomerAuth, H(async (req) => dues.leave(req.params.id, me(req)), 'Could not leave.'));

// --- Pay It For Me ---
router.get('/pay-for-me', requireCustomerAuth, H(async (req) => ({ requests: await pfm.mine(me(req)) }), 'Could not load your requests.'));
router.post('/pay-for-me', requireCustomerAuth, H(async (req) => ({ request: await pfm.create(me(req), req.body || {}) }), 'Could not create the link.'));
router.get('/pay-for-me/:token', requireCustomerAuth, H(async (req) => pfm.view(req.params.token, me(req)), 'Could not open this link.'));
router.post('/pay-for-me/:token/pay', requireCustomerAuth, withPin(async (req) => pfm.pay(req.params.token, me(req)), 'Could not pay.'));
router.post('/pay-for-me/:token/cancel', requireCustomerAuth, H(async (req) => pfm.cancel(req.params.token, me(req)), 'Could not cancel.'));

// --- Shared Light ---
router.get('/shared-light', requireCustomerAuth, H(async (req) => ({ pots: await light.mine(me(req)) }), 'Could not load your pots.'));
router.post('/shared-light', requireCustomerAuth, H(async (req) => ({ pot: await light.create(me(req), req.body || {}) }), 'Could not create the pot.'));
router.get('/shared-light/join/:code', requireCustomerAuth, H(async (req) => light.preview(req.params.code), 'Could not open this pot.'));
router.post('/shared-light/join/:code', requireCustomerAuth, H(async (req) => light.join(req.params.code, me(req)), 'Could not join.'));
router.get('/shared-light/:id', requireCustomerAuth, H(async (req) => light.detail(req.params.id, me(req)), 'Could not load the pot.'));
router.post('/shared-light/:id/pay', requireCustomerAuth, withPin(async (req) => light.contribute(req.params.id, me(req), req.body?.amount), 'Could not add money.'));
router.post('/shared-light/:id/buy', requireCustomerAuth, H(async (req) => light.buyNow(req.params.id, me(req)), 'Could not buy the token.'));
router.post('/shared-light/:id/close', requireCustomerAuth, H(async (req) => light.close(req.params.id, me(req)), 'Could not close the pot.'));

// --- SafeBuy ---
router.get('/safebuy', requireCustomerAuth, H(async (req) => ({ deals: await safe.mine(me(req)) }), 'Could not load your deals.'));
router.post('/safebuy', requireCustomerAuth, H(async (req) => ({ deal: await safe.create(me(req), req.body || {}) }), 'Could not create the deal.'));
router.get('/safebuy/:code', requireCustomerAuth, H(async (req) => safe.view(req.params.code, me(req)), 'Could not open this deal.'));
router.post('/safebuy/:code/pay', requireCustomerAuth, withPin(async (req) => safe.pay(req.params.code, me(req)), 'Could not pay.'));
router.post('/safebuy/:code/sent', requireCustomerAuth, H(async (req) => safe.markSent(req.params.code, me(req), req.body?.note), 'Could not update.'));
router.post('/safebuy/:code/received', requireCustomerAuth, withPin(async (req) => safe.confirm(req.params.code, me(req)), 'Could not confirm.'));
router.post('/safebuy/:code/dispute', requireCustomerAuth, H(async (req) => safe.dispute(req.params.code, me(req), req.body?.reason), 'Could not report the problem.'));
router.post('/safebuy/:code/cancel', requireCustomerAuth, H(async (req) => safe.cancel(req.params.code, me(req)), 'Could not cancel.'));

// --- Payroll ---
router.get('/payroll', requireCustomerAuth, H(async (req) => payroll.list(me(req)), 'Could not load payroll.'));
router.post('/payroll/staff', requireCustomerAuth, H(async (req) => ({ staff: await payroll.addStaff(me(req), req.body || {}) }), 'Could not add staff.'));
router.patch('/payroll/staff/:id', requireCustomerAuth, H(async (req) => payroll.updateStaff(me(req), req.params.id, req.body || {}), 'Could not update.'));
router.post('/payroll/run', requireCustomerAuth, withPin(async (req) => payroll.run(me(req), req.body?.label), 'Could not run payroll.'));

// --- Daily rewards ---
router.get('/rewards/daily', requireCustomerAuth, H(async (req) => daily.status(me(req)), 'Could not load rewards.'));
router.post('/rewards/daily/checkin', requireCustomerAuth, H(async (req) => daily.checkin(me(req)), 'Could not check in.'));
router.post('/rewards/daily/quiz', requireCustomerAuth, H(async (req) => daily.answer(me(req), req.body?.choice), 'Could not answer.'));

// --- Admin ---
router.get('/admin/features', requireAdminAuth, H(async () => {
  const s = await getSettings();
  return { features: await F.adminStatus(), safeBuy: { feePercent: Number(s.safeBuyFeePercent), feeCap: Number(s.safeBuyFeeCap), autoReleaseDays: s.safeBuyAutoReleaseDays, deals: await safe.adminList() }, daily: { streakReward: Number(s.dailyStreakReward), quizReward: Number(s.dailyQuizReward), budget: Number(s.dailyRewardsBudget) } };
}, 'Could not load features.'));
router.put('/admin/features/:key', requireAdminAuth, H(async (req, res) => {
  if (req.headers['x-admin-assistant']) { res.status(403).json({ error: 'The AI assistant can’t switch features on or off.' }); return undefined; }
  const out = await F.setFeature(req.params.key, Boolean(req.body?.on), { acknowledged: Boolean(req.body?.acknowledged) });
  await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'FEATURE_SWITCH', details: { feature: req.params.key, on: Boolean(req.body?.on), acknowledgedWarning: Boolean(req.body?.acknowledged) } } }).catch(() => {});
  return { features: out };
}, 'Could not change the feature.'));
router.put('/admin/features-config', requireAdminAuth, H(async (req, res) => {
  if (req.headers['x-admin-assistant']) { res.status(403).json({ error: 'The AI assistant can’t change these.' }); return undefined; }
  const b = req.body || {};
  const data = {};
  const num = (v, lo, hi) => { const n = Number(v); if (!(n >= lo && n <= hi)) throw new F.FeatureError(`Use a number between ${lo} and ${hi}.`); return n; };
  if (b.safeBuyFeePercent !== undefined) data.safeBuyFeePercent = num(b.safeBuyFeePercent, 0, 10);
  if (b.safeBuyFeeCap !== undefined) data.safeBuyFeeCap = num(b.safeBuyFeeCap, 0, 100000);
  if (b.safeBuyAutoReleaseDays !== undefined) data.safeBuyAutoReleaseDays = Math.round(num(b.safeBuyAutoReleaseDays, 1, 30));
  if (b.dailyStreakReward !== undefined) data.dailyStreakReward = num(b.dailyStreakReward, 0, 1000);
  if (b.dailyQuizReward !== undefined) data.dailyQuizReward = num(b.dailyQuizReward, 0, 200);
  if (b.dailyRewardsBudget !== undefined) data.dailyRewardsBudget = num(b.dailyRewardsBudget, 0, 1000000);
  const s = await getSettings();
  await prisma.settings.update({ where: { id: s.id }, data });
  invalidateSettings();
  return { ok: true };
}, 'Could not save.'));
router.post('/admin/safebuy/:code/resolve', requireAdminAuth, H(async (req, res) => {
  if (req.headers['x-admin-assistant']) { res.status(403).json({ error: 'The AI assistant can’t settle disputes.' }); return undefined; }
  const out = await safe.resolve(req.params.code, req.admin.adminId, { outcome: req.body?.outcome, note: req.body?.note });
  await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'SAFEBUY_RESOLVE', details: { code: req.params.code, outcome: req.body?.outcome } } }).catch(() => {});
  return out;
}, 'Could not resolve.'));

// Background jobs: dues reminders/auto-pay and SafeBuy auto-release.
function startJobs() {
  if (process.env.DISABLE_SCHEDULER === '1') return;
  const run = () => {
    dues.tick().catch((e) => console.error('dues tick failed:', e.message));
    safe.tick().catch((e) => console.error('safebuy tick failed:', e.message));
  };
  setTimeout(run, 2 * 60 * 1000).unref?.();
  setInterval(run, 15 * 60 * 1000).unref?.();
}

module.exports = router;
module.exports.startJobs = startJobs;
