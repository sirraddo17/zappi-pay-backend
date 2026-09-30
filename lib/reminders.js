const prisma = require('./prisma');
const { vtpassRequest } = require('./vtpass');
const { notify } = require('./notify');

// Renewal reminders: "Your DStv expires in 3 days", "Your MTN 10GB
// plan ends tomorrow". Rows are made after a successful purchase (see
// afterPurchase) and checked every hour.

const DAY = 24 * 60 * 60 * 1000;
// How far ahead we remind, per service.
const LEAD_DAYS = { CABLE: 3, DATA: 1, INTERNET: 2 };
// Plans shorter than this aren't worth a reminder (daily plans).
const MIN_PLAN_DAYS = 3;

// "MTN N1000 1.5GB - 30 days" → 30, "Weekly" → 7, "2 Months" → 60.
// Returns null when the name doesn't say, or the plan is under a day.
function planDays(name) {
  const s = String(name || '').toLowerCase();
  if (/\b\d+\s*-?\s*(hrs?|hours?)\b/.test(s)) return null;
  let m = s.match(/(\d+)\s*-?\s*(days?|dys?)\b/);
  if (m) return Number(m[1]);
  m = s.match(/(\d+)\s*-?\s*(weeks?|wks?)\b/);
  if (m) return Number(m[1]) * 7;
  m = s.match(/(\d+)\s*-?\s*(months?|mnths?)\b/);
  if (m) return Number(m[1]) * 30;
  m = s.match(/(\d+)\s*-?\s*(years?|yrs?)\b/);
  if (m) return Number(m[1]) * 365;
  if (/\b(yearly|annual)\b/.test(s)) return 365;
  if (/\bmonthly\b/.test(s)) return 30;
  if (/\bweekly\b/.test(s)) return 7;
  if (/\b(daily|1day)\b/.test(s)) return 1;
  return null;
}

// VTpass sends cable due dates as "2026-10-15T00:00:00" or "15-Oct-2026".
// Only the day matters: it's stored as midday Lagos time (11:00 UTC) so
// server time zones never shift it to the day before.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function parseDueDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let y; let mo; let d;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  else if ((m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ,]+(\d{4})$/))) [y, mo, d] = [Number(m[3]), MONTHS.indexOf(m[2].toLowerCase()), Number(m[1])];
  else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) [y, mo, d] = [Number(m[3]), Number(m[2]) - 1, Number(m[1])];
  if (y === undefined || mo < 0 || mo > 11 || !(d >= 1 && d <= 31)) return null;
  const out = new Date(Date.UTC(y, mo, d, 11, 0, 0));
  return Number.isNaN(out.getTime()) ? null : out;
}

function dueFromVerify(data) {
  const c = data?.content || {};
  return parseDueDate(c.Due_Date || c.due_date || c.DueDate || c.dueDate);
}

// Plan names per service, kept for six hours.
const planCache = new Map();
async function planName(serviceID, variationCode) {
  const hit = planCache.get(serviceID);
  let list = hit && Date.now() - hit.at < 6 * 60 * 60 * 1000 ? hit.list : null;
  if (!list) {
    const data = await vtpassRequest('GET', '/service-variations', { query: { serviceID } });
    list = data?.content?.varations || data?.content?.variations || [];
    if (list.length) {
      if (planCache.size > 100) planCache.clear();
      planCache.set(serviceID, { at: Date.now(), list });
    }
  }
  return list.find((v) => v.variation_code === variationCode)?.name || null;
}

const NETWORK = { mtn: 'MTN', airtel: 'Airtel', glo: 'Glo', etisalat: '9mobile', '9mobile': '9mobile', dstv: 'DStv', gotv: 'GOtv', startimes: 'Startimes', showmax: 'Showmax', smile: 'Smile', spectranet: 'Spectranet' };
function providerName(serviceID) {
  const key = String(serviceID || '').toLowerCase().split('-')[0];
  return NETWORK[key] || serviceID;
}

async function save(customerId, { service, serviceID, billersCode, variationCode, label, dueDate }) {
  const where = { customerId_service_serviceID_billersCode: { customerId, service, serviceID, billersCode } };
  const existing = await prisma.billReminder.findUnique({ where });
  // A customer who switched one off keeps it off, but a new date still
  // updates the row so it's right if they switch it back on.
  if (existing) {
    return prisma.billReminder.update({ where: { id: existing.id }, data: { dueDate, label, variationCode: variationCode || null } });
  }
  return prisma.billReminder.create({ data: { customerId, service, serviceID, billersCode, variationCode: variationCode || null, label, dueDate } });
}

// Called (in the background) after every successful purchase.
async function afterPurchase(order) {
  try {
    if (!['CABLE', 'DATA', 'INTERNET'].includes(order.service)) return null;
    const customer = await prisma.customer.findUnique({ where: { id: order.customerId }, select: { billRemindersOff: true } });
    if (!customer || customer.billRemindersOff) return null;
    // A repeating top-up already renews it — no need to nag.
    const scheduled = await prisma.scheduledPurchase.findFirst({ where: { customerId: order.customerId, serviceID: order.provider, billersCode: order.recipient, active: true } });
    if (scheduled) return null;

    const who = order.recipientName ? ` (${order.recipientName})` : '';
    if (order.service === 'CABLE') {
      // The new expiry shows on the smartcard a little after payment.
      const data = await vtpassRequest('GET', '/merchant-verify', { query: { serviceID: order.provider, billersCode: order.recipient } });
      const due = dueFromVerify(data);
      if (!due || due.getTime() < Date.now()) return null;
      const name = data?.content?.Customer_Name ? ` (${String(data.content.Customer_Name).trim().slice(0, 40)})` : who;
      return save(order.customerId, { service: 'CABLE', serviceID: order.provider, billersCode: order.recipient, variationCode: order.variationCode, label: `${providerName(order.provider)} ${order.recipient}${name}`, dueDate: due });
    }

    if (!order.variationCode) return null;
    const name = await planName(order.provider, order.variationCode);
    const days = planDays(name);
    if (!days || days < MIN_PLAN_DAYS) return null;
    const start = new Date(order.createdAt || Date.now());
    const plan = String(name).replace(/\s+/g, ' ').trim().slice(0, 60);
    return save(order.customerId, { service: order.service, serviceID: order.provider, billersCode: order.recipient, variationCode: order.variationCode, label: `${plan} · ${order.recipient}`, dueDate: new Date(start.getTime() + days * DAY) });
  } catch (error) {
    console.error('reminders.afterPurchase failed:', error.message);
    return null;
  }
}

function whenText(due, now = Date.now()) {
  const days = Math.round((new Date(due).getTime() - now) / DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

// Hourly: remind once per due date, a few days ahead.
async function runReminders(now = new Date()) {
  const maxLead = Math.max(...Object.values(LEAD_DAYS));
  const due = await prisma.billReminder.findMany({
    where: { active: true, dueDate: { gt: now, lte: new Date(now.getTime() + maxLead * DAY) } },
    take: 500,
  });
  let sent = 0;
  for (const r of due) {
    const lead = LEAD_DAYS[r.service] || 1;
    if (new Date(r.dueDate).getTime() - now.getTime() > lead * DAY) continue;
    if (r.lastRemindedFor && new Date(r.lastRemindedFor).getTime() === new Date(r.dueDate).getTime()) continue;
    // Claim it first so two servers never both send it.
    const claim = await prisma.billReminder.updateMany({
      where: { id: r.id, active: true, OR: [{ lastRemindedFor: null }, { lastRemindedFor: { not: r.dueDate } }] },
      data: { lastRemindedFor: r.dueDate },
    });
    if (claim.count !== 1) continue;
    const customer = await prisma.customer.findUnique({ where: { id: r.customerId }, select: { billRemindersOff: true, active: true } });
    if (!customer || customer.billRemindersOff || customer.active === false) continue;
    const when = whenText(r.dueDate, now.getTime());
    if (r.service === 'CABLE') {
      notify(r.customerId, 'Subscription Expiring', `Your ${r.label} subscription expires ${when}. Renew in ZAPPI PAY to keep watching.`);
    } else {
      notify(r.customerId, 'Data Plan Ending', `Your ${r.label} plan ends ${when}. Renew it in ZAPPI PAY so you don't run out.`);
    }
    sent += 1;
  }
  return sent;
}

let timer = null;
function startReminders() {
  if (timer || process.env.DISABLE_SCHEDULER === '1') return;
  const run = () => runReminders().catch((e) => console.error('bill reminders failed:', e.message));
  setTimeout(run, 3 * 60 * 1000);
  timer = setInterval(run, 60 * 60 * 1000);
}

// For the Home card: what's coming up in the next 30 days.
async function upcoming(customerId, now = new Date()) {
  const rows = await prisma.billReminder.findMany({
    where: { customerId, active: true, dueDate: { gt: new Date(now.getTime() - DAY), lte: new Date(now.getTime() + 30 * DAY) } },
    orderBy: { dueDate: 'asc' },
    take: 10,
  });
  return rows.map((r) => ({ id: r.id, service: r.service, serviceID: r.serviceID, billersCode: r.billersCode, variationCode: r.variationCode, label: r.label, dueDate: r.dueDate, when: whenText(r.dueDate, now.getTime()) }));
}

module.exports = { planDays, parseDueDate, dueFromVerify, afterPurchase, runReminders, startReminders, upcoming, whenText, LEAD_DAYS };
