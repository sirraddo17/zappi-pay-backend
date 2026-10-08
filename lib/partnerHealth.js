// Auto-pause: when one provider (e.g. ikeja-electric, mtn-data) keeps
// failing for several different customers, it is paused for a while so
// nobody else hits the failure, then opened again on "trial": the next
// purchase decides — success reopens it fully, a failure pauses it again
// for longer. The owner is told when it pauses and when it is back, and a
// follow-up message for the affected customers is drafted for approval.

const prisma = require('./prisma');
const { getSettings, invalidateSettings } = require('./vtpass');

const MIN = 60 * 1000;
const WINDOW = 10 * MIN;
const FAILS = 5;          // failures in the window…
const CUSTOMERS = 3;      // …from at least this many different customers
const BASE_COOL = 15 * MIN;
const MAX_COOL = 2 * 60 * MIN;
const TRIAL_FOR = 6 * 60 * MIN; // a quiet trial is closed after this long

const NAMES = {
  mtn: 'MTN airtime', airtel: 'Airtel airtime', glo: 'Glo airtime', etisalat: '9mobile airtime', '9mobile': '9mobile airtime',
  'mtn-data': 'MTN data', 'airtel-data': 'Airtel data', 'glo-data': 'Glo data', 'glo-sme-data': 'Glo SME data', 'etisalat-data': '9mobile data', '9mobile-sme-data': '9mobile SME data',
  'ikeja-electric': 'Ikeja Electric (IKEDC)', 'eko-electric': 'Eko Electric (EKEDC)', 'abuja-electric': 'Abuja Electric (AEDC)', 'ibadan-electric': 'Ibadan Electric (IBEDC)', 'enugu-electric': 'Enugu Electric (EEDC)', 'portharcourt-electric': 'Port Harcourt Electric (PHED)', 'kano-electric': 'Kano Electric (KEDCO)', 'kaduna-electric': 'Kaduna Electric', 'jos-electric': 'Jos Electric (JED)', 'benin-electric': 'Benin Electric (BEDC)', 'aba-electric': 'Aba Power', 'yola-electric': 'Yola Electric',
  dstv: 'DStv', gotv: 'GOtv', startimes: 'Startimes', showmax: 'Showmax', waec: 'WAEC PINs', 'waec-registration': 'WAEC registration', jamb: 'JAMB PINs', 'smile-direct': 'Smile', spectranet: 'Spectranet',
};
const nameOf = (provider) => NAMES[provider] || (String(provider).startsWith('ck:') ? `${String(provider).slice(3)} (bet funding)` : String(provider).replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));

const fails = new Map(); // provider -> [{ at, customerId }]

function readMap(settings) {
  const m = settings?.autoPaused;
  return m && typeof m === 'object' && !Array.isArray(m) ? { ...m } : {};
}

async function saveMap(map) {
  const s = await prisma.settings.findFirst({ select: { id: true } });
  if (!s) return;
  await prisma.settings.update({ where: { id: s.id }, data: { autoPaused: map } });
  invalidateSettings();
}

const alert = (title, message) => Promise.resolve(require('./adminAlert').alertAdmins(title, message, '/admin/partners')).catch(() => {});

// Message to show the customer when this provider is paused right now, else null.
function pauseFor(settings, provider) {
  if (!provider) return null;
  const p = readMap(settings)[provider];
  if (!p || p.trial) return null;
  if (new Date(p.until).getTime() <= Date.now()) return null; // cool-down over → trial
  const mins = Math.max(1, Math.round((new Date(p.until).getTime() - Date.now()) / MIN));
  return `${p.name} is having problems at our provider right now, so we've paused it to protect your money. Please try again in about ${mins < 60 ? `${mins} minute${mins === 1 ? '' : 's'}` : `${Math.round(mins / 60)} hour${mins >= 90 ? 's' : ''}`}. Other services work as normal.`;
}

// Public list for the app's notice banner.
function publicList(settings) {
  const now = Date.now();
  return Object.entries(readMap(settings))
    .filter(([, p]) => !p.trial && new Date(p.until).getTime() > now)
    .map(([provider, p]) => ({ provider, service: p.service, name: p.name, until: p.until }));
}

async function pause(provider, service, { reason, customers = [], strikes = 0 } = {}) {
  const settings = await getSettings();
  if (settings.autoPauseEnabled === false) return null;
  const map = readMap(settings);
  const prev = map[provider];
  const strike = prev ? (prev.strikes || 0) + 1 : strikes;
  const cool = Math.min(MAX_COOL, BASE_COOL * 2 ** strike);
  const now = new Date();
  map[provider] = {
    service, name: nameOf(provider), since: prev?.since || now.toISOString(), until: new Date(now.getTime() + cool).toISOString(),
    strikes: strike, trial: false, reason: String(reason || '').slice(0, 300),
    customers: [...new Set([...(prev?.customers || []), ...customers])].slice(0, 200),
  };
  await saveMap(map);
  fails.delete(provider);
  alert(`Auto-paused: ${map[provider].name}`, `${map[provider].name} failed for several customers (${reason || 'provider errors'}). Everyone was refunded automatically. It is paused for ${Math.round(cool / MIN)} minutes, then tried again by itself. You don't need to do anything — but check VTpass status if it keeps happening.`);
  return map[provider];
}

// Called when a purchase ends as FAILED (after the refund).
async function failure(order) {
  try {
    if (!order?.provider) return;
    const settings = await getSettings();
    if (settings.autoPauseEnabled === false) return;
    const current = readMap(settings)[order.provider];
    if (current && (current.trial || new Date(current.until).getTime() <= Date.now())) { await pause(order.provider, order.service, { reason: 'still failing after the pause', customers: [order.customerId] }); return; }
    if (current) return; // still paused: nothing new to learn
    const now = Date.now();
    const list = (fails.get(order.provider) || []).filter((f) => now - f.at < WINDOW);
    list.push({ at: now, customerId: order.customerId });
    fails.set(order.provider, list);
    const people = new Set(list.map((f) => f.customerId));
    if (list.length >= FAILS && people.size >= CUSTOMERS) {
      await pause(order.provider, order.service, { reason: `${list.length} failed purchases from ${people.size} customers in ${Math.round(WINDOW / MIN)} minutes`, customers: [...people] });
    }
  } catch (error) {
    console.error('partnerHealth.failure:', error.message);
  }
}

// Called when a purchase succeeds: a provider on trial is fully back.
async function success(order) {
  try {
    if (!order?.provider) return;
    fails.delete(order.provider);
    const settings = await getSettings();
    const map = readMap(settings);
    const p = map[order.provider];
    if (!p || !p.trial) return;
    delete map[order.provider];
    await saveMap(map);
    await backAgain(order.provider, p, 'a purchase went through');
  } catch (error) {
    console.error('partnerHealth.success:', error.message);
  }
}

async function backAgain(provider, p, how) {
  const mins = Math.max(1, Math.round((Date.now() - new Date(p.since).getTime()) / MIN));
  alert(`Back to normal: ${p.name}`, `${p.name} is working again (${how}). It was paused for about ${mins} minutes. A message for the ${p.customers?.length || 0} affected customer(s) is ready for you to approve under Partners → Follow-ups.`);
  if (p.customers?.length) {
    await require('./followUps').draft({
      kind: 'OUTAGE',
      title: `${p.name} is back`,
      message: `Good news — ${p.name} is working again on ZAPPI PAY. Earlier your purchase couldn't go through and your money was refunded to your wallet. You can buy again now. Sorry for the trouble, and thank you for your patience 💜`,
      customerIds: p.customers,
    }).catch(() => {});
  }
}

// Every minute: cool-downs that ended become trials; long quiet trials close.
async function tick() {
  const settings = await getSettings();
  const map = readMap(settings);
  let changed = false;
  const now = Date.now();
  for (const [provider, p] of Object.entries(map)) {
    if (!p.trial && new Date(p.until).getTime() <= now) { map[provider] = { ...p, trial: true, trialSince: new Date().toISOString() }; changed = true; }
    else if (p.trial && now - new Date(p.trialSince || p.until).getTime() > TRIAL_FOR) {
      delete map[provider];
      changed = true;
      await backAgain(provider, p, 'no new failures since it reopened');
    }
  }
  if (changed) await saveMap(map);
}

async function list() {
  const settings = await getSettings();
  const now = Date.now();
  return {
    enabled: settings.autoPauseEnabled !== false,
    rule: { failures: FAILS, customers: CUSTOMERS, minutes: WINDOW / MIN },
    paused: Object.entries(readMap(settings)).map(([provider, p]) => ({ provider, ...p, customers: p.customers?.length || 0, state: p.trial ? 'TRIAL' : new Date(p.until).getTime() > now ? 'PAUSED' : 'TRIAL' })),
  };
}

async function resume(provider) {
  const map = readMap(await getSettings());
  const p = map[provider];
  if (!p) return false;
  delete map[provider];
  await saveMap(map);
  fails.delete(provider);
  await backAgain(provider, p, 'reopened by an admin');
  return true;
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => tick().catch((e) => console.error('partnerHealth.tick:', e.message)), MIN);
  timer.unref?.();
}

module.exports = { pauseFor, publicList, failure, success, tick, list, resume, pause, start, nameOf, _reset: () => fails.clear(), FAILS, CUSTOMERS };
