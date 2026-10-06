require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRouter = require('./routes/auth.routes');
const walletRouter = require('./routes/wallet.routes');
const vtpassRouter = require('./routes/vtpass.routes');
const adminRouter = require('./routes/admin.routes');
const supportRouter = require('./routes/support.routes');
const notificationRouter = require('./routes/notification.routes');
const broadcastRouter = require('./routes/broadcast.routes');
const airtimeCashRouter = require('./routes/airtimecash.routes');
const securityRouter = require('./routes/security.routes');
const referralRouter = require('./routes/referral.routes');
const savedRouter = require('./routes/saved.routes');
const bankFundingRouter = require('./routes/bankfunding.routes');
const bankTransferRouter = require('./routes/banktransfer.routes');
const reportsRouter = require('./routes/reports.routes');
const extrasRouter = require('./routes/extras.routes');
const growthRouter = require('./routes/growth.routes');
const customersRouter = require('./routes/customers.routes');
const aiRouter = require('./routes/ai.routes');
const engageRouter = require('./routes/engage.routes');
const escalationsRouter = require('./routes/escalations.routes');
const savingsRouter = require('./routes/savings.routes');
const challengesRouter = require('./routes/challenges.routes');
const moneyRouter = require('./routes/money.routes');
const statusRouter = require('./routes/status.routes');
const remindersRouter = require('./routes/reminders.routes');
const giftsRouter = require('./routes/gifts.routes');
const promiseRouter = require('./routes/promise.routes');
const dealsRouter = require('./routes/deals.routes');
const shopRouter = require('./routes/shop.routes');
const profitBookRouter = require('./routes/profitbook.routes');
const familyRouter = require('./routes/family.routes');
const rewardSplitRouter = require('./routes/rewardsplit.routes');
const selfProtectRouter = require('./routes/selfprotect.routes');
const insightsRouter = require('./routes/insights.routes');
const epinsRouter = require('./routes/epins.routes');
const adVideoRouter = require('./routes/advideo.routes');
const heygenRouter = require('./routes/heygen.routes');
const { startScheduler } = require('./lib/schedules');
const { startOrderSweeper } = require('./lib/purchase');
const { startDailySummary } = require('./lib/dailySummary');

const app = express();

app.disable('x-powered-by');
// Email owners about crashes and repeated failures (lib/errorAlerts.js).
require('./lib/errorAlerts').installCrashHandlers();
// Only our own websites may call the API from a browser. Requests with
// no Origin (payment webhooks, server-to-server, the Android app's own
// calls) are not affected. CORS_ORIGINS on Render adds more addresses;
// CORS_ALLOW_ALL=1 is the emergency switch.
const ALLOWED_ORIGINS = [
  /^https:\/\/([a-z0-9-]+\.)?zappipay\.com\.ng$/,
  /^https:\/\/zappi-pay-frontend[a-z0-9-]*\.vercel\.app$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
  ...String(process.env.CORS_ORIGINS || '').split(',').map((x) => x.trim().replace(/\/$/, '')).filter(Boolean),
];
const blockedOrigins = new Set();
const originOk = (origin) => !origin || process.env.CORS_ALLOW_ALL === '1' || ALLOWED_ORIGINS.some((o) => (o instanceof RegExp ? o.test(origin) : o === origin));
app.use(cors({
  origin(origin, cb) {
    const ok = originOk(origin);
    if (!ok && !blockedOrigins.has(origin)) { blockedOrigins.add(origin); console.warn(`CORS: blocked browser calls from ${origin} (add it to CORS_ORIGINS if it is ours)`); }
    cb(null, ok);
  },
  maxAge: 600,
}));
// Attack watch (lib/attackWatch.js): refuse blocked addresses, catch
// scanners, note calls from other websites.
const attackWatch = require('./lib/attackWatch');
app.use(attackWatch.guard);
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && !originOk(o)) attackWatch.record('CORS_BLOCKED', req, { detail: `From ${String(o).slice(0, 100)}` });
  next();
});
app.use(require('./lib/errorAlerts').watchResponses);
// Security headers and request limits (lib/protect.js).
app.use(require('./lib/protect').securityHeaders);
app.use(require('./lib/protect').rateLimit);
// Gzip API responses — lists of plans, orders and transactions shrink
// by 70-80%, which matters most on slow mobile data.
app.use(require('compression')());
// Default is 100kb, far too small for a base64-encoded profile
// photo — raised to cover that (matched by the 2MB cap on the
// avatar field itself in auth.routes.js) without leaving the limit
// unbounded.
// rawBody is kept for webhook signature checks (the signature is over
// the exact bytes the payment provider sent).
app.use(express.json({ limit: '6mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'zappi-pay-backend' }));

// Support staff (role SUPPORT) may only reach customer-care admin routes;
// everything sensitive needs an owner (lib/staffAccess.js).
app.use('/api', require('./lib/staffAccess').staffGate);
app.use('/api', escalationsRouter);
app.use('/api', savingsRouter);
app.use('/api', challengesRouter);
app.use('/api', moneyRouter);
app.use('/api', statusRouter);
app.use('/api', remindersRouter);
app.use('/api', giftsRouter);
app.use('/api', promiseRouter);
app.use('/api', dealsRouter);
app.use('/api', shopRouter);
app.use('/api', profitBookRouter);
app.use('/api', familyRouter);
app.use('/api', rewardSplitRouter);
app.use('/api', selfProtectRouter);
app.use('/api', insightsRouter);
app.use('/api', epinsRouter);
app.use('/api', adVideoRouter);
app.use('/api', heygenRouter);
app.use('/api', require('./routes/attackwatch.routes'));
app.use('/api', require('./routes/payrequests.routes'));
app.use('/api', require('./routes/flutterwave.routes'));
app.use('/api', require('./routes/circles.routes'));

// Before adminRouter so /admin/customers/list isn't taken as a customer id.
app.use('/api', customersRouter);
app.use('/api', authRouter);
app.use('/api', walletRouter);
app.use('/api', vtpassRouter);
app.use('/api', adminRouter);
app.use('/api', supportRouter);
app.use('/api', notificationRouter);
app.use('/api', broadcastRouter);
app.use('/api', airtimeCashRouter);
app.use('/api', securityRouter);
app.use('/api', referralRouter);
app.use('/api', savedRouter);
app.use('/api', bankFundingRouter);
app.use('/api', bankTransferRouter);
app.use('/api', reportsRouter);
app.use('/api', extrasRouter);
app.use('/api', growthRouter);
app.use('/api', aiRouter);
app.use('/api', engageRouter);

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`zappi-pay-backend listening on port ${PORT}`);
  // Runs scheduled top-ups when they're due (see lib/schedules.js).
  startScheduler();
  startOrderSweeper();
  require('./lib/epins').startSweeper();
  require('./lib/adminRadar').startJobs();
  require('./lib/attackWatch').start();
  require('./lib/festivals').start();
  require('./lib/flutterwave').startSweeper();
  require('./lib/circles').startJob();
  startDailySummary();
  require('./lib/savings').startSavingsTimer();
  require('./lib/contest').armContestTimer();
  require('./lib/reminders').startReminders();
  require('./lib/family').startFamilyTimer();
  require('./lib/rewardSplit').startRewardSplitTimer();
  require('./lib/adminInsights').startInsights();
});
