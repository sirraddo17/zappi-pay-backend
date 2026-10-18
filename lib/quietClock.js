// One clock for the repeating background jobs, so the database can sleep.
//
// Neon (free plan) puts the database to sleep after 5 minutes with no
// queries, and only bills compute while it's awake. Jobs that each ran on
// their own timer (some every minute) kept it awake all day. Now:
//  • while people are using the app (an API request in the last
//    BUSY_FOR minutes) the database is awake anyway, so jobs keep their
//    normal pace;
//  • when it's quiet, every job that's due runs together, at most once
//    every QUIET_EVERY minutes, and the database sleeps in between;
//  • the moment someone comes back, anything due runs straight away
//    (e.g. a paused provider reopens before their purchase).
// Webhooks are API requests too, so money coming in wakes things up.
// QUIET_JOBS=off in the environment turns the quiet spacing off.

const MIN = 60 * 1000;
const BUSY_FOR = 15 * MIN;
const QUIET_EVERY = 30 * MIN;
const TICK = 30 * 1000;

// Only app API calls count (not bots poking random pages), and not the
// health/status checks that uptime monitors make.
const COUNTS = /^\/api\//;
const IGNORE = /^\/api\/(health|status)(\/|$)/;

const jobs = [];
let lastActive = 0;
let lastQuietBatch = 0;
let timer = null;

const quietOff = () => String(process.env.QUIET_JOBS || '').toLowerCase() === 'off';
const isBusy = (now = Date.now()) => quietOff() || now - lastActive < BUSY_FOR;

function runJob(j) {
  j.running = true;
  j.last = Date.now();
  Promise.resolve()
    .then(() => j.fn())
    .catch((e) => console.error(`${j.name} failed:`, e?.message || e))
    .finally(() => { j.running = false; });
}

function tick(now = Date.now()) {
  const busy = isBusy(now);
  if (!busy && now - lastQuietBatch < QUIET_EVERY) return 0;
  const due = jobs.filter((j) => !j.running && now - j.last >= j.ms);
  if (!due.length) return 0;
  if (!busy) lastQuietBatch = now;
  due.forEach(runJob);
  return due.length;
}

function ensureTimer() {
  if (timer) return;
  timer = setInterval(() => tick(), TICK);
  timer.unref?.();
}

// every('name', ms, fn, { firstAfter }) — fn runs about every ms
// (first run after firstAfter, default ms), spaced out when quiet.
function every(name, ms, fn, { firstAfter } = {}) {
  const first = firstAfter ?? ms;
  jobs.push({ name, ms, fn, last: Date.now() + first - ms, running: false });
  ensureTimer();
}

// Express middleware: notes real activity; waking from quiet runs due jobs.
function activity(req, res, next) {
  if (req.method !== 'OPTIONS' && req.method !== 'HEAD' && COUNTS.test(req.path || '') && !IGNORE.test(req.path || '')) {
    const now = Date.now();
    const wasQuiet = !isBusy(now);
    lastActive = now;
    if (wasQuiet && jobs.length) setImmediate(() => tick());
  }
  next();
}

function status() {
  const now = Date.now();
  return { busy: isBusy(now), quietEveryMin: QUIET_EVERY / MIN, busyForMin: BUSY_FOR / MIN, off: quietOff(), jobs: jobs.map((j) => ({ name: j.name, everyMin: Math.round(j.ms / MIN), lastRun: new Date(j.last) })) };
}

module.exports = { every, activity, tick, status, isBusy, BUSY_FOR, QUIET_EVERY, _reset: () => { jobs.length = 0; lastActive = 0; lastQuietBatch = 0; } };
