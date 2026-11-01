// Admin → 🧾 Subscriptions: every plan and package the app runs on
// (domain, server, fixed IP, database, website hosting, AI, email…) with
// what it costs, how often, and when it renews. Owner only (support is
// deny-by-default in lib/staffAccess.js) and never changed by the AI
// assistant. Reminders go to owners 14, 7, 3, 1 and 0 days before a
// renewal date, and every day once it's overdue.
//
// No passwords, keys or card numbers are stored here — only names,
// prices, dates and the sign-in page address.

const prisma = require('./prisma');
const { getSettings, invalidateSettings } = require('./vtpass');

const LAGOS = 60 * 60 * 1000;
const DAY = 24 * LAGOS;
const lagosYmd = (d = new Date()) => new Date(new Date(d).getTime() + LAGOS).toISOString().slice(0, 10);

const PERIODS = { MONTHLY: 'Monthly', YEARLY: 'Yearly', ONE_TIME: 'One-time', PAYG: 'Pay as you go', FREE: 'Free' };
const STATUSES = { ACTIVE: 'Active', SUSPENDED: 'Suspended', CANCELLED: 'Cancelled', PLANNED: 'Not bought yet' };
const CATEGORIES = ['Domain', 'Server', 'IP address', 'Database', 'Website hosting', 'AI assistant', 'Email', 'Scheduled jobs', 'Code', 'App store', 'Video', 'Other'];
const CURRENCIES = ['NGN', 'USD'];
const REMIND_AT = [14, 7, 3, 1, 0];

// The starter list, shown until the owner saves the page once. Blank
// amounts and dates are for the owner to fill in from the receipts.
const STARTER = [
  { id: 'domain', name: 'Domain — zappipay.com.ng', category: 'Domain', provider: 'Whogohost', plan: '.com.ng domain + DNS', period: 'YEARLY', amount: '', currency: 'NGN', lastPaid: '', nextRenewal: '', autoRenew: 'unknown', status: 'ACTIVE', loginUrl: 'https://www.whogohost.com/host/clientarea.php', notes: 'Website, api., admin. and support@ email all depend on it. If it lapses, the whole app goes offline.' },
  { id: 'vps', name: 'API server (VPS)', category: 'Server', provider: 'RackNerd', plan: '1 GB KVM VPS Special — New York', period: 'YEARLY', amount: '21.99', currency: 'USD', lastPaid: '', nextRenewal: '', autoRenew: 'unknown', status: 'ACTIVE', loginUrl: 'https://my.racknerd.com/clientarea.php', notes: 'Runs api.zappipay.com.ng (pm2 zappi-pay-api). Bought October 2026 — renews October 2027.' },
  { id: 'ip', name: 'Fixed IP address 107.173.6.63', category: 'IP address', provider: 'RackNerd', plan: 'Included with the VPS', period: 'FREE', amount: '0', currency: 'USD', lastPaid: '', nextRenewal: '', autoRenew: 'unknown', status: 'ACTIVE', loginUrl: '', notes: 'Whitelisted with VTpass, Monnify and Nomba. Keeps working only while the VPS is paid — a new server means a new IP and new whitelisting.' },
  { id: 'neon', name: 'Database', category: 'Database', provider: 'Neon', plan: 'Free — 100 compute-hours and 0.5 GB a month', period: 'FREE', amount: '0', currency: 'USD', lastPaid: '', nextRenewal: '', autoRenew: 'unknown', status: 'ACTIVE', loginUrl: 'https://console.neon.tech', notes: 'Allowance resets on the 1st of each month. If it runs out, the app stops until then — plan a paid plan before launch.' },
  { id: 'vercel', name: 'Website + admin hosting', category: 'Website hosting', provider: 'Vercel', plan: 'Hobby (free)', period: 'FREE', amount: '0', currency: 'USD', lastPaid: '', nextRenewal: '', autoRenew: 'unknown', status: 'ACTIVE', loginUrl: 'https://vercel.com/dashboard', notes: 'zappipay.com.ng and admin.zappipay.com.ng.' },
  { id: 'render', name: 'Old API server (fallback)', category: 'Server', provider: 'Render', plan: 'Free', period: 'FREE', amount: '0', currency: 'USD', lastPaid: '', nextRenewal: '', autoRenew: 'unknown', status: 'SUSPENDED', loginUrl: 'https://dashboard.render.com', notes: 'Suspended — kept only as a fallback.' },
  { id: 'anthropic', name: 'AI assistant (Claude API)', category: 'AI assistant', provider: 'Anthropic', plan: 'Prepaid credits', period: 'PAYG', amount: '', currency: 'USD', lastPaid: '', nextRenewal: '', autoRenew: 'unknown', status: 'ACTIVE', loginUrl: 'https://console.anthropic.com', notes: 'Powers the customer and admin AI assistants. When credits run out the assistants stop answering — top up before the balance is low.' },
  { id: 'resend', name: 'App emails (OTP, receipts)', category: 'Email', provider: 'Resend', plan: 'Free', period: 'FREE', amount: '0', currency: 'USD', lastPaid: '', nextRenewal: '', autoRenew: 'unknown', status: 'ACTIVE', loginUrl: 'https://resend.com', notes: 'Free plan has a daily and monthly sending limit.' },
  { id: 'improvmx', name: 'support@zappipay.com.ng forwarding', category: 'Email', provider: 'ImprovMX', plan: 'Free', period: 'FREE', amount: '0', currency: 'USD', lastPaid: '', nextRenewal: '', autoRenew: 'unknown', status: 'ACTIVE', loginUrl: 'https://app.improvmx.com', notes: 'Forwards support@ to the company Gmail.' },
  { id: 'cronjob', name: 'Scheduled jobs / keep-awake', category: 'Scheduled jobs', provider: 'cron-job.org', plan: 'Free', period: 'FREE', amount: '0', currency: 'USD', lastPaid: '', nextRenewal: '', autoRenew: 'unknown', status: 'ACTIVE', loginUrl: 'https://console.cron-job.org', notes: '' },
  { id: 'github', name: 'Code (GitHub) — AI access token', category: 'Code', provider: 'GitHub', plan: 'Free; access token lasts 90 days', period: 'FREE', amount: '0', currency: 'USD', lastPaid: '', nextRenewal: '2027-01-19', autoRenew: 'no', status: 'ACTIVE', loginUrl: 'https://github.com/settings/tokens', notes: 'The date is when the AI code-access token expires (made about 21 Oct 2026) — make a new one and update GITHUB_TOKEN on the server before then.' },
  { id: 'play', name: 'Google Play developer account', category: 'App store', provider: 'Google', plan: 'One-time registration', period: 'ONE_TIME', amount: '', currency: 'USD', lastPaid: '', nextRenewal: '', autoRenew: 'no', status: 'PLANNED', loginUrl: 'https://play.google.com/console', notes: 'Change the status to Active once registered.' },
];

class SubscriptionError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const clean = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime());
// Nothing secret belongs here: refuse things that look like keys or cards.
function luhn(d) {
  let sum = 0;
  for (let i = 0; i < d.length; i += 1) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}
// Card numbers start 3–6 and pass the Luhn check (phone numbers don't start that way).
const looksCard = (v) => (v.match(/(?:\d[ -]?){13,19}/g) || []).some((m) => { const d = m.replace(/\D/g, ''); return d.length >= 13 && /^[3-6]/.test(d) && luhn(d); });
const looksSecret = (v) => /\b(sk|pk|ghp|github_pat|re)_[A-Za-z0-9_]{12,}/.test(v) || looksCard(v) || /password\s*[:=]/i.test(v);

function validate(input) {
  if (!Array.isArray(input)) throw new SubscriptionError('Send a list of subscriptions.');
  if (input.length > 60) throw new SubscriptionError('At most 60 subscriptions.');
  const seen = new Set();
  return input.map((x, i) => {
    const name = clean(x?.name, 80);
    if (!name) throw new SubscriptionError(`Row ${i + 1}: give it a name.`);
    let id = clean(x.id, 40).replace(/[^a-z0-9-]/gi, '').toLowerCase() || `s${Date.now().toString(36)}${i}`;
    while (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    const period = PERIODS[x.period] ? x.period : 'YEARLY';
    const amountRaw = clean(x.amount, 14).replace(/,/g, '');
    if (amountRaw && !(Number.isFinite(Number(amountRaw)) && Number(amountRaw) >= 0)) throw new SubscriptionError(`${name}: the amount must be a number.`);
    const amount = amountRaw === '' ? '' : String(Math.round(Number(amountRaw) * 100) / 100);
    for (const k of ['lastPaid', 'nextRenewal']) {
      const v = clean(x[k], 10);
      if (v && !isDate(v)) throw new SubscriptionError(`${name}: dates must look like 2027-01-31.`);
    }
    let loginUrl = clean(x.loginUrl, 200);
    if (loginUrl && !/^https:\/\//i.test(loginUrl)) loginUrl = /^[\w.-]+\.[a-z]{2,}/i.test(loginUrl) ? `https://${loginUrl}` : '';
    const row = {
      id,
      name,
      category: CATEGORIES.includes(x.category) ? x.category : 'Other',
      provider: clean(x.provider, 60),
      plan: clean(x.plan, 120),
      period,
      amount,
      currency: CURRENCIES.includes(x.currency) ? x.currency : 'NGN',
      lastPaid: clean(x.lastPaid, 10),
      nextRenewal: clean(x.nextRenewal, 10),
      autoRenew: ['yes', 'no', 'unknown'].includes(x.autoRenew) ? x.autoRenew : 'unknown',
      status: STATUSES[x.status] ? x.status : 'ACTIVE',
      loginUrl,
      notes: clean(x.notes, 400),
    };
    if ([row.name, row.provider, row.plan, row.notes, row.loginUrl].some(looksSecret)) throw new SubscriptionError(`${name}: that looks like a key, password or card number — don’t store secrets here.`);
    return row;
  });
}

function daysUntil(ymd, now = new Date()) {
  if (!ymd || !isDate(ymd)) return null;
  return Math.round((new Date(`${ymd}T00:00:00Z`).getTime() - new Date(`${lagosYmd(now)}T00:00:00Z`).getTime()) / DAY);
}

function decorate(row, now) {
  const daysLeft = row.status === 'ACTIVE' ? daysUntil(row.nextRenewal, now) : null;
  const due = daysLeft === null ? null : daysLeft < 0 ? 'overdue' : daysLeft <= 3 ? 'urgent' : daysLeft <= 14 ? 'soon' : 'ok';
  const missing = [];
  if (row.status === 'ACTIVE' && ['MONTHLY', 'YEARLY'].includes(row.period)) {
    if (row.amount === '') missing.push('amount');
    if (!row.nextRenewal) missing.push('next renewal date');
  }
  return { ...row, periodName: PERIODS[row.period], statusName: STATUSES[row.status], daysLeft, due, missing };
}

// Yearly running cost of active subscriptions, per currency (no exchange
// rate is guessed). Pay-as-you-go spend isn't predictable, so it's listed
// separately.
function totals(rows) {
  const yearly = {};
  const monthly = {};
  for (const r of rows) {
    if (r.status !== 'ACTIVE' || r.amount === '') continue;
    const a = Number(r.amount);
    const perYear = r.period === 'MONTHLY' ? a * 12 : r.period === 'YEARLY' ? a : 0;
    if (!perYear) continue;
    yearly[r.currency] = Math.round(((yearly[r.currency] || 0) + perYear) * 100) / 100;
    monthly[r.currency] = Math.round((yearly[r.currency] / 12) * 100) / 100;
  }
  return { yearly, monthly, payAsYouGo: rows.filter((r) => r.status === 'ACTIVE' && r.period === 'PAYG').map((r) => r.name) };
}

async function list(now = new Date()) {
  const s = await getSettings();
  const saved = Array.isArray(s.subscriptions);
  const rows = (saved ? s.subscriptions : STARTER).map((r) => decorate(r, now));
  const order = { overdue: 0, urgent: 1, soon: 2, ok: 3 };
  const upcoming = rows.filter((r) => r.due).sort((a, b) => order[a.due] - order[b.due] || a.daysLeft - b.daysLeft);
  return {
    starter: !saved,
    rows,
    upcoming: upcoming.filter((r) => r.due !== 'ok').map((r) => ({ id: r.id, name: r.name, nextRenewal: r.nextRenewal, daysLeft: r.daysLeft, due: r.due })),
    totals: totals(rows),
    options: { periods: PERIODS, statuses: STATUSES, categories: CATEGORIES, currencies: CURRENCIES },
    note: 'No passwords, keys or card numbers here — only prices, dates and where to sign in.',
  };
}

async function save(input, now = new Date()) {
  const rows = validate(input);
  const s = await getSettings();
  await prisma.settings.update({ where: { id: s.id }, data: { subscriptions: rows } });
  invalidateSettings();
  return list(now);
}

// Called hourly by lib/adminInsights.js: one alert a day listing what
// renews in 14/7/3/1/0 days or is overdue.
let lastWarnDay = null;
async function remind(now = new Date()) {
  const day = lagosYmd(now);
  if (lastWarnDay === day || new Date(now.getTime() + LAGOS).getUTCHours() < 8) return null;
  const { rows } = await list(now);
  const hits = rows.filter((r) => r.daysLeft !== null && (r.daysLeft < 0 || REMIND_AT.includes(r.daysLeft)));
  lastWarnDay = day;
  if (!hits.length) return null;
  const text = hits.map((r) => `${r.name} (${r.provider || r.category}) — ${r.daysLeft < 0 ? `overdue by ${-r.daysLeft} day(s)` : r.daysLeft === 0 ? 'renews TODAY' : `renews in ${r.daysLeft} day(s)`}, ${r.nextRenewal}${r.amount ? `, ${r.currency === 'USD' ? '$' : '₦'}${r.amount}` : ''}`).join('; ');
  await require('./adminAlert').alertAdmins(hits.some((r) => r.daysLeft <= 1) ? 'Subscription renewal due' : 'Subscription renewing soon', text, '/admin/subscriptions');
  return hits.map((r) => r.id);
}

module.exports = { list, save, validate, remind, daysUntil, totals, STARTER, PERIODS, STATUSES, CATEGORIES, SubscriptionError, _reset: () => { lastWarnDay = null; } };
