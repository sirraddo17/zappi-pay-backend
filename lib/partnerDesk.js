// Partner desk: contacts and deadlines for VTpass, Monnify, ClubKonnect…,
// a list of things a partner must look at (with ready email drafts the
// owner sends himself), a weekly reconciliation, and a monthly report the
// owner can send partners. Nothing here emails a partner by itself.

const prisma = require('./prisma');
const { getSettings, vtpassRequest } = require('./vtpass');

const DAY = 24 * 60 * 60 * 1000;
const LAGOS = 60 * 60 * 1000;
const naira = (n) => `₦${Math.round(Number(n || 0)).toLocaleString('en-NG')}`;
const when = (d) => new Date(d).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alert = (t, m) => Promise.resolve(require('./adminAlert').alertAdmins(t, m, '/admin/partners')).catch(() => {});

class DeskError extends Error {}

const DEFAULTS = (s) => [
  { key: 'vtpass', name: 'VTpass (Broadshift Technologies)', email: String(s.vtpassSupportEmail || 'support@vtpass.com'), phone: '07080631810', website: 'https://www.vtpass.com', notes: 'Airtime, data, electricity, TV, exam PINs, internet. Service Level Agreement signed 12 Sept 2026 (1 year, renews automatically; 30 days’ notice to change).' },
  { key: 'monnify', name: 'Monnify (Moniepoint)', email: 'support@monnify.com', phone: '', website: 'https://app.monnify.com', notes: 'Wallet funding (reserved accounts), card checkout, sub-accounts / split payments.' },
  { key: 'clubkonnect', name: 'ClubKonnect (Nellobytes)', email: '', phone: '', website: 'https://www.clubkonnect.com', notes: 'Recharge card PINs (Print Cards) and bet funding.' },
  { key: 'flutterwave', name: 'Flutterwave', email: '', phone: '', website: 'https://dashboard.flutterwave.com', notes: 'More bills (tax, waste, tolls, school fees).' },
];

async function ensureDefaults() {
  const s = await getSettings();
  const have = new Set((await prisma.partner.findMany({ select: { key: true } })).map((p) => p.key));
  for (const p of DEFAULTS(s)) if (!have.has(p.key)) await prisma.partner.create({ data: p }).catch(() => {});
}

// --- contacts & deadlines --------------------------------------------------------

const clip = (v, n) => (v === undefined ? undefined : String(v || '').trim().slice(0, n) || null);

async function savePartner(key, b = {}) {
  const k = String(key || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
  if (!k) throw new DeskError('Give the partner a short key, e.g. "anchor".');
  if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email).trim())) throw new DeskError('That email address doesn’t look right.');
  const data = { name: clip(b.name, 80), email: clip(b.email, 120), phone: clip(b.phone, 40), website: clip(b.website, 200), accountRef: clip(b.accountRef, 80), notes: clip(b.notes, 1000) };
  Object.keys(data).forEach((x) => data[x] === undefined && delete data[x]);
  const existing = await prisma.partner.findUnique({ where: { key: k } });
  if (existing) return prisma.partner.update({ where: { key: k }, data });
  if (!data.name) throw new DeskError('Give the partner a name.');
  return prisma.partner.create({ data: { key: k, ...data } });
}

async function deletePartner(key) {
  await prisma.partnerTask.deleteMany({ where: { partnerKey: key } });
  await prisma.partner.delete({ where: { key } }).catch(() => { throw new DeskError('Not found.'); });
  return { ok: true };
}

async function addTask(b = {}) {
  const title = String(b.title || '').trim().slice(0, 160);
  const dueAt = new Date(b.dueAt);
  if (!title) throw new DeskError('What needs doing?');
  if (Number.isNaN(dueAt.getTime())) throw new DeskError('Pick a due date.');
  return prisma.partnerTask.create({ data: { partnerKey: String(b.partnerKey || 'other').slice(0, 30), title, notes: clip(b.notes, 600) || undefined, dueAt } });
}

async function updateTask(id, b = {}) {
  const data = {};
  if (b.done !== undefined) data.done = Boolean(b.done);
  if (b.title !== undefined) data.title = String(b.title).trim().slice(0, 160);
  if (b.notes !== undefined) data.notes = clip(b.notes, 600);
  if (b.dueAt !== undefined) { const d = new Date(b.dueAt); if (Number.isNaN(d.getTime())) throw new DeskError('Pick a due date.'); data.dueAt = d; data.remindedAt = null; }
  return prisma.partnerTask.update({ where: { id }, data }).catch(() => { throw new DeskError('Not found.'); });
}

const deleteTask = (id) => prisma.partnerTask.delete({ where: { id } }).then(() => ({ ok: true })).catch(() => { throw new DeskError('Not found.'); });

// Reminders: once when a deadline is within a day (or already past).
async function remindTasks() {
  const due = await prisma.partnerTask.findMany({ where: { done: false, remindedAt: null, dueAt: { lte: new Date(Date.now() + DAY) } }, take: 20 });
  for (const t of due) {
    const p = await prisma.partner.findUnique({ where: { key: t.partnerKey } }).catch(() => null);
    const late = new Date(t.dueAt).getTime() < Date.now();
    await alert(`${late ? 'Overdue' : 'Due soon'}: ${t.title}`, `${p?.name || t.partnerKey} — ${late ? 'was due' : 'due'} ${when(t.dueAt)}.${t.notes ? `\n${t.notes}` : ''}`);
    await prisma.partnerTask.update({ where: { id: t.id }, data: { remindedAt: new Date() } }).catch(() => {});
  }
  return due.length;
}

// --- things a partner must look at ---------------------------------------------------

const orderRow = (o) => ({ id: o.id, requestId: o.vtpassRequestId, service: o.service, provider: o.provider, recipient: o.recipient, amount: Number(o.costAmount ?? o.amount), status: o.status, vtpassStatus: o.vtpassStatus, createdAt: o.createdAt, escalatedAt: o.vtpassEscalatedAt || null });

async function issues() {
  const settings = await getSettings();
  const since = new Date(Date.now() - 14 * DAY);
  const stale = new Date(Date.now() - 30 * 60 * 1000);
  const [held, pending, ticketed] = await Promise.all([
    prisma.order.findMany({ where: { status: 'PENDING', vtpassStatus: 'HELD', createdAt: { gte: since } }, orderBy: { createdAt: 'asc' }, take: 30 }),
    prisma.order.findMany({ where: { status: 'PENDING', vtpassStatus: { not: 'HELD' }, createdAt: { gte: since, lte: stale } }, orderBy: { createdAt: 'asc' }, take: 30 }),
    prisma.supportTicket.findMany({ where: { status: 'OPEN', orderId: { not: null }, createdAt: { gte: since } }, include: { order: true }, orderBy: { createdAt: 'asc' }, take: 30 }),
  ]);
  const vtpass = [
    ...held.map((o) => ({ ...orderRow(o), why: 'VTpass gave the PIN/token but later said failed — not refunded until VTpass confirms.' })),
    ...pending.map((o) => ({ ...orderRow(o), why: 'Still not confirmed after 30 minutes.' })),
    ...ticketed.filter((t) => t.order && t.order.status === 'SUCCESS').map((t) => ({ ...orderRow(t.order), why: `Customer says: “${String(t.message).slice(0, 140)}”`, ticketId: t.id })),
  ];
  const seen = new Set();
  const vtpassUnique = vtpass.filter((x) => (seen.has(x.id) ? false : seen.add(x.id)));
  const fundingTickets = await prisma.supportTicket.findMany({
    where: { status: 'OPEN', orderId: null, createdAt: { gte: since } },
    include: { customer: { select: { id: true, name: true, phone: true, bankAccountRef: true } } },
    orderBy: { createdAt: 'asc' }, take: 50,
  });
  const monnify = fundingTickets
    .filter((t) => /fund|transfer|credit|reflect|deposit|sent money|paid/i.test(t.message))
    .slice(0, 20)
    .map((t) => ({ ticketId: t.id, customerId: t.customerId, customer: t.customer?.name, phone: t.customer?.phone, hasAccount: Boolean(t.customer?.bankAccountRef), message: String(t.message).slice(0, 200), createdAt: t.createdAt }));
  let ck = null;
  try {
    const ckLib = require('./clubkonnect');
    if (await ckLib.creds(settings)) {
      const bal = await ckLib.balance(settings);
      const needs = settings.bettingSupplier === 'CLUBKONNECT' || settings.ckEnabled;
      ck = { balance: bal, low: needs && bal !== null && bal < 2000 };
    }
  } catch (error) {
    ck = { balance: null, error: error.message };
  }
  return { vtpass: vtpassUnique, monnify, clubkonnect: ck, autoPaused: (await require('./partnerHealth').list()).paused };
}

// A ready email for several VTpass orders at once (the owner sends it).
async function vtpassDraft(orderIds = []) {
  const settings = await getSettings();
  const orders = await prisma.order.findMany({ where: { id: { in: orderIds.slice(0, 25) } }, orderBy: { createdAt: 'asc' } });
  if (!orders.length) throw new DeskError('Pick at least one order.');
  const lines = orders.map((o, i) => {
    const t = o.responsePayload?.content?.transactions || {};
    return `${i + 1}. Request ID: ${o.vtpassRequestId}${t.transactionId ? ` · Transaction ID: ${t.transactionId}` : ''}\n   ${o.service} (${o.provider}) · ${o.recipient} · ${naira(o.costAmount ?? o.amount)} · ${when(o.createdAt)}\n   Our status: ${o.status}${o.vtpassStatus ? ` · VTpass status: ${o.vtpassStatus}` : ''}`;
  }).join('\n\n');
  const partner = await prisma.partner.findUnique({ where: { key: 'vtpass' } }).catch(() => null);
  return {
    to: partner?.email || settings.vtpassSupportEmail || 'support@vtpass.com',
    subject: `Please check ${orders.length} transaction${orders.length === 1 ? '' : 's'} — Sirraddo Venture (ZAPPI PAY)`,
    body: `Hello VTpass Support,\n\nPlease help us confirm the final status of the transaction${orders.length === 1 ? '' : 's'} below. Our customers are waiting, and we want to settle them correctly (deliver or refund).\n\n${lines}\n\nFor any that failed, please confirm the reversal to our VTpass wallet. For any that were delivered, please share the token/PIN or delivery confirmation.\n\nThank you for your support.\n\nKind regards,\nAdeyemo Ridwan\nSirraddo Venture (ZAPPI PAY)\n${settings.vtpassMode === 'live' ? '' : '(Sandbox environment)\n'}`,
  };
}

// --- weekly reconciliation ------------------------------------------------------------

async function reconcile({ by = 'schedule' } = {}) {
  const settings = await getSettings();
  const P = require('./purchase');
  const since = new Date(Date.now() - 7 * DAY);
  const out = { by, vtpass: { checked: 0, settled: 0, mismatches: [] }, monnify: { checked: 0, credited: 0, amount: 0, error: null }, clubkonnect: null };

  // VTpass: re-ask about orders we're unsure of, and a sample of failures.
  const unsure = await prisma.order.findMany({
    where: { createdAt: { gte: since }, vtpassRequestId: { not: null }, NOT: { provider: { startsWith: 'ck:' } }, OR: [{ status: 'PENDING' }, { status: 'FAILED', vtpassStatus: 'no-response' }, { status: 'FAILED' }] },
    orderBy: { createdAt: 'desc' }, take: 40,
  });
  for (const o of unsure) {
    if (String(o.provider || '').startsWith('ck:')) continue; // ClubKonnect, not VTpass
    try {
      if (o.status === 'PENDING') {
        const r = await P.recheckOrder(o.id);
        out.vtpass.checked += 1;
        if (r.status !== 'PENDING') out.vtpass.settled += 1;
      } else {
        let resp;
        try { resp = await vtpassRequest('POST', '/requery', { body: { request_id: o.vtpassRequestId } }); } catch (e) { resp = e.vtpassResponse || null; }
        out.vtpass.checked += 1;
        if (resp && P.classifyRequery(resp) === 'SUCCESS') {
          out.vtpass.mismatches.push({ ...orderRow(o), issue: 'We refunded the customer, but VTpass now says it was DELIVERED. Ask VTpass to confirm; if it was delivered, the customer got the value and the refund.' });
        }
      }
    } catch (error) {
      console.error('reconcile vtpass', o.id, error.message);
    }
    await sleep(300);
  }

  // Monnify: catch bank transfers whose notification never reached us.
  try {
    if (await require('./monnify').isConfigured()) {
      const recentFunders = await prisma.walletTransaction.findMany({ where: { type: 'FUND', createdAt: { gte: since } }, select: { customerId: true }, distinct: ['customerId'], take: 30 });
      const askers = await prisma.supportTicket.findMany({ where: { status: 'OPEN', createdAt: { gte: since } }, select: { customerId: true }, distinct: ['customerId'], take: 30 });
      const ids = [...new Set([...askers, ...recentFunders].map((x) => x.customerId))].slice(0, 40);
      const customers = await prisma.customer.findMany({ where: { id: { in: ids }, bankAccountRef: { not: null } } });
      for (const c of customers) {
        const r = await require('./monnify').syncCustomerPayments(c).catch(() => ({ credited: 0, amount: 0 }));
        out.monnify.checked += 1;
        out.monnify.credited += r.credited || 0;
        out.monnify.amount += r.amount || 0;
        await sleep(250);
      }
    } else out.monnify.error = 'Monnify is not set up.';
  } catch (error) {
    out.monnify.error = error.message;
  }

  // ClubKonnect wallet.
  try {
    const ck = require('./clubkonnect');
    if (await ck.creds(settings)) out.clubkonnect = { balance: await ck.balance(settings) };
  } catch (error) {
    out.clubkonnect = { balance: null, error: error.message };
  }

  const rec = await prisma.partnerCheck.create({ data: { kind: 'RECONCILE', summary: out } });
  const bits = [];
  if (out.vtpass.mismatches.length) bits.push(`${out.vtpass.mismatches.length} VTpass mismatch(es) to raise`);
  if (out.vtpass.settled) bits.push(`${out.vtpass.settled} stuck order(s) settled`);
  if (out.monnify.credited) bits.push(`${out.monnify.credited} missed bank transfer(s) found and credited (${naira(out.monnify.amount)})`);
  if (out.clubkonnect?.balance !== undefined && out.clubkonnect?.balance !== null && out.clubkonnect.balance < 2000) bits.push(`ClubKonnect wallet low (${naira(out.clubkonnect.balance)})`);
  if (bits.length || by !== 'schedule') alert('Weekly partner check', bits.length ? `${bits.join(' · ')}. Open Partners for details.` : 'Everything matched — VTpass, Monnify and ClubKonnect look fine.');
  return { id: rec.id, ranAt: rec.ranAt, ...out };
}

async function lastReconcile() {
  const r = await prisma.partnerCheck.findFirst({ where: { kind: 'RECONCILE' }, orderBy: { ranAt: 'desc' } });
  return r ? { id: r.id, ranAt: r.ranAt, ...r.summary } : null;
}

// --- monthly partner report -------------------------------------------------------------

function monthRange(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  const now = new Date(Date.now() + LAGOS);
  const y = m ? Number(m[1]) : now.getUTCFullYear();
  const mo = m ? Number(m[2]) - 1 : now.getUTCMonth() - 1; // default: last month
  const start = new Date(Date.UTC(y, mo, 1) - LAGOS);
  const end = new Date(Date.UTC(y, mo + 1, 1) - LAGOS);
  const label = new Date(Date.UTC(y, mo, 15)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { start, end, label, ym: `${new Date(start.getTime() + LAGOS).getUTCFullYear()}-${String(new Date(start.getTime() + LAGOS).getUTCMonth() + 1).padStart(2, '0')}` };
}

async function statsFor(start, end) {
  const orders = await prisma.order.groupBy({ by: ['service', 'status'], where: { createdAt: { gte: start, lt: end } }, _count: { _all: true }, _sum: { amount: true } });
  const funding = await prisma.walletTransaction.aggregate({ where: { type: 'FUND', status: 'APPROVED', createdAt: { gte: start, lt: end } }, _count: { _all: true }, _sum: { amount: true } });
  const newCustomers = await prisma.customer.count({ where: { createdAt: { gte: start, lt: end } } });
  const by = {};
  let total = 0; let ok = 0; let value = 0;
  for (const g of orders) {
    const s = (by[g.service] = by[g.service] || { orders: 0, success: 0, value: 0 });
    s.orders += g._count._all;
    total += g._count._all;
    if (g.status === 'SUCCESS') { s.success += g._count._all; s.value += Number(g._sum.amount || 0); ok += g._count._all; value += Number(g._sum.amount || 0); }
  }
  return { orders: total, success: ok, successRate: total ? Math.round((ok / total) * 1000) / 10 : 0, value, byService: by, funding: { count: funding._count._all, value: Number(funding._sum.amount || 0) }, newCustomers };
}

async function report(ym) {
  const r = monthRange(ym);
  const prevStart = new Date(Date.UTC(new Date(r.start.getTime() + LAGOS).getUTCFullYear(), new Date(r.start.getTime() + LAGOS).getUTCMonth() - 1, 1) - LAGOS);
  const [now, prev] = await Promise.all([statsFor(r.start, r.end), statsFor(prevStart, r.start)]);
  const growth = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null);
  const g = { orders: growth(now.orders, prev.orders), value: growth(now.value, prev.value), funding: growth(now.funding.value, prev.funding.value) };
  const svc = Object.entries(now.byService).sort((a, b) => b[1].value - a[1].value).map(([k, v]) => `- ${k}: ${v.success.toLocaleString()} successful of ${v.orders.toLocaleString()} (${naira(v.value)})`).join('\n');
  const gtxt = (x) => (x === null ? '' : ` (${x >= 0 ? '+' : ''}${x}% vs last month)`);
  const vtpassText = `Hello VTpass team,\n\nHere is a short summary of Sirraddo Venture (ZAPPI PAY) activity on VTpass for ${r.label}:\n\n- Successful transactions: ${now.success.toLocaleString()} of ${now.orders.toLocaleString()} (${now.successRate}% success)${gtxt(g.orders)}\n- Value delivered: ${naira(now.value)}${gtxt(g.value)}\n${svc ? `\nBy service:\n${svc}\n` : ''}\nThank you for the support. We'd be glad to discuss anything that can improve delivery speed or our earning share as our volume grows.\n\nKind regards,\nAdeyemo Ridwan\nSirraddo Venture (ZAPPI PAY)`;
  const monnifyText = `Hello Monnify team,\n\nHere is a short summary of Sirraddo Venture (ZAPPI PAY) collections for ${r.label}:\n\n- Wallet fundings: ${now.funding.count.toLocaleString()} payments, ${naira(now.funding.value)}${gtxt(g.funding)}\n- New customers: ${now.newCustomers.toLocaleString()}\n- Purchases completed by customers: ${now.success.toLocaleString()} (${naira(now.value)})\n\nThank you for the support.\n\nKind regards,\nAdeyemo Ridwan\nSirraddo Venture (ZAPPI PAY)`;
  return { month: r.ym, label: r.label, stats: now, previous: prev, growth: g, drafts: { vtpass: vtpassText, monnify: monnifyText } };
}

// --- overview + jobs ----------------------------------------------------------------------

async function overview() {
  await ensureDefaults();
  const [partners, tasks, last] = await Promise.all([
    prisma.partner.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.partnerTask.findMany({ where: { OR: [{ done: false }, { dueAt: { gte: new Date(Date.now() - 14 * DAY) } }] }, orderBy: [{ done: 'asc' }, { dueAt: 'asc' }], take: 50 }),
    lastReconcile(),
  ]);
  return { partners, tasks, lastReconcile: last };
}

let hourly = null;
let weeklyAt = 0;
function start() {
  if (hourly) return;
  const run = async () => {
    await remindTasks().catch((e) => console.error('partnerDesk.remind:', e.message));
    // Mondays after 07:00 Lagos, once a week.
    const lagos = new Date(Date.now() + LAGOS);
    if (lagos.getUTCDay() === 1 && lagos.getUTCHours() >= 7 && Date.now() - weeklyAt > 3 * DAY) {
      const last = await lastReconcile().catch(() => null);
      if (!last || Date.now() - new Date(last.ranAt).getTime() > 3 * DAY) {
        weeklyAt = Date.now();
        await reconcile().catch((e) => console.error('partnerDesk.reconcile:', e.message));
      } else weeklyAt = Date.now();
    }
  };
  hourly = setInterval(run, 60 * 60 * 1000);
  hourly.unref?.();
  setTimeout(run, 2 * 60 * 1000).unref?.();
}

module.exports = { DeskError, ensureDefaults, savePartner, deletePartner, addTask, updateTask, deleteTask, remindTasks, issues, vtpassDraft, reconcile, lastReconcile, report, overview, start, monthRange };
