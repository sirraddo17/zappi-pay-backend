const express = require('express');
const prisma = require('../lib/prisma');
const { getSettings, vtpassRequest } = require('../lib/vtpass');

// Public service status for status.zappipay.com.ng. Shows whether each
// service is working — never balances or anything private. Worked out
// at most once a minute.
const router = express.Router();

const SERVICES = [
  ['AIRTIME', 'Airtime'],
  ['DATA', 'Data'],
  ['ELECTRICITY', 'Electricity'],
  ['CABLE', 'Cable TV'],
  ['EDUCATION', 'Exam PINs (WAEC, NECO, JAMB)'],
  ['INTERNET', 'Internet'],
  ['BETTING', 'Bet funding'],
];

let cache = { at: 0, body: null };

async function check(fn) {
  const t = Date.now();
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
    return { ok: true, ms: Date.now() - t };
  } catch {
    return { ok: false, ms: Date.now() - t };
  }
}

async function buildStatus() {
  const settings = await getSettings();
  const maintenance = require('../lib/maintenance');
  const [db, vtpass, monnify] = await Promise.all([
    check(() => prisma.$queryRawUnsafe('SELECT 1')),
    check(() => vtpassRequest('GET', '/balance')),
    check(async () => {
      const m = require('../lib/monnify');
      if (!(await m.isConfigured())) throw new Error('not configured');
      await require('../lib/disbursement').listBanks();
    }),
  ]);

  // Recent purchases per service (last hour): many failures = degraded.
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await prisma.order.groupBy({ by: ['service', 'status'], where: { createdAt: { gte: since } }, _count: { _all: true } }).catch(() => []);
  const stats = {};
  for (const r of recent) {
    const s = (stats[r.service] ||= { ok: 0, failed: 0 });
    if (r.status === 'SUCCESS') s.ok += r._count._all;
    if (r.status === 'FAILED' || r.status === 'REFUNDED') s.failed += r._count._all;
  }

  const services = SERVICES.map(([key, label]) => {
    let state = 'OPERATIONAL';
    let note = null;
    const paused = maintenance.pauseMessage(settings, key);
    const st = stats[key];
    if (paused) { state = 'MAINTENANCE'; note = paused; }
    else if (!db.ok || !vtpass.ok) { state = 'DOWN'; note = 'Purchases can’t be completed right now.'; }
    else if (st && st.failed >= 3 && st.failed / (st.ok + st.failed) >= 0.5) { state = 'DEGRADED'; note = 'Some purchases are failing and being refunded automatically.'; }
    return { key, label, state, note };
  });

  const transfersOn = settings.bankTransferEnabled !== false;
  services.push({ key: 'FUNDING', label: 'Wallet funding (bank transfer)', state: !db.ok ? 'DOWN' : monnify.ok ? 'OPERATIONAL' : 'DEGRADED', note: monnify.ok ? null : 'Automatic funding may be slow. Money you send will still arrive.' });
  services.push({ key: 'SEND_TO_BANK', label: 'Send to bank', state: !transfersOn ? 'MAINTENANCE' : !db.ok || !monnify.ok ? 'DOWN' : 'OPERATIONAL', note: !transfersOn ? 'Temporarily unavailable.' : null });
  services.push({ key: 'APP', label: 'App & login', state: db.ok ? 'OPERATIONAL' : 'DOWN', note: null });

  const worst = ['DOWN', 'DEGRADED', 'MAINTENANCE'].find((s) => services.some((x) => x.state === s)) || 'OPERATIONAL';
  return { overall: worst, checkedAt: new Date(), services, testMode: settings.vtpassMode !== 'live' };
}

router.get('/status', async (req, res) => {
  try {
    if (!cache.body || Date.now() - cache.at > 60 * 1000) {
      cache = { at: Date.now(), body: await buildStatus() };
    }
    res.set('Cache-Control', 'public, max-age=30');
    res.json(cache.body);
  } catch (error) {
    console.error('GET /status failed:', error);
    res.json({ overall: 'DOWN', checkedAt: new Date(), services: [{ key: 'APP', label: 'App & login', state: 'DOWN', note: 'We’re having trouble right now.' }] });
  }
});

module.exports = router;
module.exports._reset = () => { cache = { at: 0, body: null }; };
