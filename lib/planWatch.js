// Plan-code watch. Once a day, read VTpass's plan list (service-variations)
// for every data / TV / exam / internet service the app sells and compare
// it with the last snapshot (PriceSnapshot, one row per plan code):
//  • codes REMOVED (VTpass no longer lists them), codes ADDED, price changes;
//  • for removed codes, what still uses them — active scheduled top-ups,
//    bill reminders, open Pay-for-me links, plan corrections — each with
//    the closest plan VTpass still sells (same size and validity, nearest
//    price);
//  • one alert to the owner when a removed code is still in use.
// Read-only for customers' things: nothing is changed automatically. The
// admin AI (tool get_plan_changes) can only explain and suggest.
// Amounts are kept in whole kobo.

const prisma = require('./prisma');
const { closestPlan } = require('./planNames');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const LAGOS = HOUR;
// Plan-based services the app sells (data, TV, exams, internet). Services
// found on saved schedules, reminders, Pay-for-me links or plan fixes are
// added to this list automatically.
const BASE_SERVICES = ['mtn-data', 'airtel-data', 'glo-data', 'etisalat-data', 'smile-direct', 'spectranet', 'dstv', 'gotv', 'startimes', 'waec', 'jamb'];
const kobo = (v) => Math.round(Number(v || 0) * 100);

async function servicesInUse() {
  const has = { variationCode: { not: null } };
  const [a, b, c, d] = await Promise.all([
    prisma.scheduledPurchase.findMany({ where: { active: true, ...has }, select: { serviceID: true } }).catch(() => []),
    prisma.billReminder.findMany({ where: { active: true, ...has }, select: { serviceID: true } }).catch(() => []),
    prisma.payForMe.findMany({ where: { status: 'OPEN', ...has }, select: { serviceID: true } }).catch(() => []),
    prisma.planFix.findMany({ select: { serviceID: true } }).catch(() => []),
  ]);
  return [...new Set([...BASE_SERVICES, ...[...a, ...b, ...c, ...d].map((x) => x.serviceID).filter(Boolean)])];
}

async function fetchPlans(serviceID) {
  const { vtpassRequest } = require('./vtpass');
  const d = await vtpassRequest('GET', '/service-variations', { query: { serviceID } });
  const list = d?.content?.varations || d?.content?.variations || [];
  return Array.isArray(list) ? list.filter((v) => v && v.variation_code).map((v) => ({ variationCode: String(v.variation_code), name: String(v.name || v.variation_code).slice(0, 120), priceKobo: kobo(v.variation_amount) })) : [];
}

// What still points at a removed code (ids only — no phone or account numbers).
async function usesOf(serviceID, variationCode) {
  const where = { serviceID, variationCode };
  const [scheduled, reminders, payForMe, planFixes] = await Promise.all([
    prisma.scheduledPurchase.findMany({ where: { ...where, active: true }, select: { id: true, customerId: true } }).catch(() => []),
    prisma.billReminder.findMany({ where: { ...where, active: true }, select: { id: true, customerId: true } }).catch(() => []),
    prisma.payForMe.findMany({ where: { ...where, status: 'OPEN' }, select: { id: true } }).catch(() => []),
    prisma.planFix.findMany({ where, select: { id: true } }).catch(() => []),
  ]);
  return {
    count: scheduled.length + reminders.length + payForMe.length + planFixes.length,
    scheduledTopUps: scheduled.map((x) => ({ id: x.id, customerId: x.customerId })),
    billReminders: reminders.map((x) => ({ id: x.id, customerId: x.customerId })),
    payForMeLinks: payForMe.map((x) => ({ id: x.id })),
    planFixes: planFixes.map((x) => ({ id: x.id })),
  };
}

// One check of every service. Returns the report (also saved).
async function run({ fetch = fetchPlans, alert = true } = {}) {
  const startedAt = new Date();
  const report = { at: startedAt, servicesChecked: [], skipped: [], removed: [], added: [], priceChanges: [] };
  for (const serviceID of await servicesInUse()) {
    let plans;
    try {
      plans = await fetch(serviceID);
    } catch (e) {
      report.skipped.push({ serviceID, why: String(e?.message || e).slice(0, 120) });
      continue;
    }
    // An empty answer is treated as a VTpass hiccup, never as "every plan removed".
    if (!plans.length) { report.skipped.push({ serviceID, why: 'VTpass returned no plans' }); continue; }
    report.servicesChecked.push(serviceID);
    const known = await prisma.priceSnapshot.findMany({ where: { serviceID } });
    const firstTime = known.length === 0;
    const byCode = new Map(known.map((r) => [r.variationCode, r]));
    const live = new Set(plans.map((p) => p.variationCode));
    const seen = [];
    for (const p of plans) {
      const old = byCode.get(p.variationCode);
      if (!old) {
        await prisma.priceSnapshot.create({ data: { serviceID, variationCode: p.variationCode, name: p.name, amount: p.priceKobo / 100 } });
        if (!firstTime) report.added.push({ serviceID, variationCode: p.variationCode, name: p.name, priceKobo: p.priceKobo });
        continue;
      }
      const oldK = kobo(old.amount);
      if (old.removedAt) {
        await prisma.priceSnapshot.update({ where: { id: old.id }, data: { removedAt: null, name: p.name, amount: p.priceKobo / 100, seenAt: startedAt } });
        report.added.push({ serviceID, variationCode: p.variationCode, name: p.name, priceKobo: p.priceKobo, back: true });
      } else if (oldK > 0 && p.priceKobo > 0 && oldK !== p.priceKobo) {
        await prisma.priceSnapshot.update({ where: { id: old.id }, data: { previous: oldK / 100, amount: p.priceKobo / 100, name: p.name, changedAt: startedAt, seenAt: startedAt } });
        report.priceChanges.push({ serviceID, variationCode: p.variationCode, name: p.name, fromKobo: oldK, toKobo: p.priceKobo });
      } else {
        seen.push(old.id);
      }
    }
    if (seen.length) await prisma.priceSnapshot.updateMany({ where: { id: { in: seen } }, data: { seenAt: startedAt } });
    for (const old of known) {
      if (old.removedAt || live.has(old.variationCode)) continue;
      await prisma.priceSnapshot.update({ where: { id: old.id }, data: { removedAt: startedAt } });
      const usedBy = await usesOf(serviceID, old.variationCode);
      const suggestion = usedBy.count ? closestPlan({ name: old.name, priceKobo: kobo(old.amount) }, plans) : null;
      report.removed.push({ serviceID, variationCode: old.variationCode, name: old.name, lastPriceKobo: kobo(old.amount), usedBy, suggestion });
    }
  }
  report.stillUsed = report.removed.filter((r) => r.usedBy.count > 0).length;
  report.summary = summary(report);
  await prisma.planChangeReport.create({ data: { report: JSON.parse(JSON.stringify(report)) } }).catch((e) => console.error('plan watch: could not save report:', e.message));
  await prisma.planChangeReport.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 60 * DAY) } } }).catch(() => {});
  if (alert) await sendAlerts(report);
  return report;
}

const naira = (k) => `₦${(k / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
function summary(r) {
  if (!r.servicesChecked.length) return 'VTpass could not be checked (no plan lists came back).';
  const parts = [];
  parts.push(r.removed.length ? `${r.removed.length} plan code${r.removed.length === 1 ? '' : 's'} removed${r.stillUsed ? ` (${r.stillUsed} still used by customers' schedules, reminders, Pay-for-me links or plan fixes)` : ''}` : 'no plan codes removed');
  parts.push(`${r.added.length} added`);
  parts.push(`${r.priceChanges.length} price change${r.priceChanges.length === 1 ? '' : 's'}`);
  return `${parts.join(', ')}. Checked ${r.servicesChecked.length} service${r.servicesChecked.length === 1 ? '' : 's'}${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}.`;
}

async function sendAlerts(r) {
  const { alertAdmins } = require('./adminAlert');
  const used = r.removed.filter((x) => x.usedBy.count > 0);
  if (used.length) {
    const lines = used.slice(0, 10).map((x) => `• ${x.name} (${x.serviceID}, ${x.variationCode}): used ${x.usedBy.count} time${x.usedBy.count === 1 ? '' : 's'}${x.suggestion ? ` → closest now: ${x.suggestion.name} at ${naira(x.suggestion.priceKobo)} (${x.suggestion.match})` : ''}`);
    await Promise.resolve(alertAdmins(`VTpass removed ${used.length} plan${used.length === 1 ? '' : 's'} customers still use`, `${lines.join('\n')}\nNothing was changed automatically. Ask the AI assistant "what plan codes changed?" for details.`, '/admin/orders')).catch(() => {});
  }
  // Same price alert the old daily price watch sent.
  if (r.priceChanges.length) {
    await Promise.resolve(alertAdmins(`VTpass changed ${r.priceChanges.length} price${r.priceChanges.length === 1 ? '' : 's'}`, r.priceChanges.slice(0, 10).map((c) => `• ${c.name}: ${naira(c.fromKobo)} → ${naira(c.toKobo)}`).join('\n'), '/admin/assistant')).catch(() => {});
  }
}

// The last saved report (for the admin AI).
async function lastReport() {
  const row = await prisma.planChangeReport.findFirst({ orderBy: { createdAt: 'desc' } });
  if (!row) return { note: 'No plan-code check has run yet. It runs once a day (after 6am Lagos time).' };
  return { checkedAt: row.createdAt, ...row.report, rule: 'Nothing is changed automatically: schedules, reminders, Pay-for-me links and plan fixes keep the old code until the owner or the customer changes them.' };
}

// Hourly tick: runs the check once a day, after 6am Lagos time.
let lastRunAt = null;
async function tick(now = Date.now()) {
  if (new Date(now + LAGOS).getUTCHours() < 6) return null;
  if (!lastRunAt) {
    const last = await prisma.planChangeReport.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }).catch(() => null);
    lastRunAt = last ? new Date(last.createdAt).getTime() : 0;
  }
  if (now - lastRunAt < 23 * HOUR) return null;
  lastRunAt = now;
  return run();
}

let started = false;
function start() {
  if (started || process.env.DISABLE_SCHEDULER === '1') return;
  started = true;
  require('./quietClock').every('plan-code watch', HOUR, () => tick(), { firstAfter: 6 * 60 * 1000 });
}

module.exports = { run, tick, lastReport, start, servicesInUse, BASE_SERVICES, _reset: () => { lastRunAt = null; started = false; } };
