// Partner statement matching (admin AI tool check_partner_statement).
// The owner attaches a CSV/Excel statement from Nomba, Squad, Monnify or
// VTpass in Admin → AI Assistant; the browser sends only date, reference,
// amount, credit/debit and narration (max 5,000 rows). Each row is matched
// to our records in whole kobo:
//  • Nomba / Squad / Monnify: credits ↔ FUND wallet transactions by
//    providerRef (NB-… / SQ-… / Monnify's MNFY… reference), and ↔ payments
//    waiting on the Unmatched payments screen;
//  • VTpass: debits ↔ Orders by vtpassRequestId.
// READ-ONLY: it never credits, refunds or changes anything. For a missing
// credit it points to "Funding not showing?" on the customer's page or to
// Unmatched payments.

const prisma = require('./prisma');
const { scrubLine } = require('./serverLogs');

const PARTNERS = ['nomba', 'squad', 'monnify', 'vtpass'];
const MAX_ROWS = 5000;
const LIST = 50; // items shown per group (counts are always complete)
const LAGOS = 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

const kobo = (v) => Math.round(Number(v || 0) * 100);

// "₦1,234.50", "(500.00)", "-500", "1,000 CR" → { kobo, negative }
function parseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? { kobo: Math.round(Math.abs(v) * 100), negative: v < 0 } : null;
  const s = String(v ?? '').trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/[^\d.()-]/g, '')) || /\bDR\b/i.test(s);
  const num = Number(s.replace(/[^\d.]/g, ''));
  return Number.isFinite(num) && /\d/.test(s) ? { kobo: Math.round(num * 100), negative } : null;
}

// ISO, "2026-11-05 10:12", "05/11/2026" (day first, as Nigerian banks write it), "5 Nov 2026".
function parseDate(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  const s = String(v ?? '').trim();
  if (!s) return null;
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?/i.exec(s);
  if (dmy) {
    let h = Number(dmy[4] || 0);
    if (dmy[7]) h = (h % 12) + (/pm/i.test(dmy[7]) ? 12 : 0);
    // Times on statements are Lagos time (UTC+1).
    const t = Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]), h, Number(dmy[5] || 0), Number(dmy[6] || 0)) - LAGOS;
    return Number.isFinite(t) ? new Date(t) : null;
  }
  const iso = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(s) ? new Date(`${s.replace(' ', 'T')}${s.length > 10 ? '' : 'T00:00'}+01:00`) : new Date(s);
  return Number.isFinite(iso.getTime()) ? iso : null;
}

function direction(type, amount) {
  const t = String(type || '').trim().toLowerCase();
  if (/^(c|cr|credit|in|inflow|money in|deposit|received)\b/.test(t)) return 'credit';
  if (/^(d|dr|debit|out|outflow|money out|withdrawal|payment|purchase)\b/.test(t)) return 'debit';
  return amount?.negative ? 'debit' : 'credit';
}

// Clean the rows the browser sent.
function cleanRows(rows) {
  if (!Array.isArray(rows)) return { rows: [], dropped: 0 };
  let dropped = 0;
  const out = [];
  for (const r of rows.slice(0, MAX_ROWS)) {
    const reference = String(r?.reference ?? '').trim().slice(0, 120);
    const amount = parseAmount(r?.amount);
    if (!reference || !amount) { dropped += 1; continue; }
    const date = parseDate(r?.date);
    out.push({ reference, kobo: amount.kobo, dir: direction(r?.type, amount), date, narration: scrubLine(String(r?.narration ?? '').slice(0, 160)) });
  }
  return { rows: out, dropped: dropped + Math.max(0, rows.length - MAX_ROWS), truncated: rows.length > MAX_ROWS };
}

// Whole Lagos days the statement covers.
function rangeOf(rows) {
  const times = rows.map((r) => r.date?.getTime()).filter(Number.isFinite);
  if (!times.length) return null;
  const startDay = (t) => Math.floor((t + LAGOS) / DAY) * DAY - LAGOS;
  return { gte: new Date(startDay(Math.min(...times))), lt: new Date(startDay(Math.max(...times)) + DAY) };
}

const ymd = (d) => (d ? new Date(d.getTime() + LAGOS).toISOString().slice(0, 16).replace('T', ' ') : null);
const row = (r) => ({ reference: r.reference, amountKobo: r.kobo, date: ymd(r.date), narration: r.narration || undefined });

// Keys our providerRef could be for a statement reference.
function refKeys(partner, ref) {
  const r = String(ref).trim();
  if (partner === 'nomba') return [r.startsWith('NB-') ? r : `NB-${r}`];
  if (partner === 'squad') return [r.startsWith('SQ-') ? r : `SQ-${r}`];
  return [r];
}
const PREFIX = { nomba: 'NB-', squad: 'SQ-' };

// What the customer sent (from the note) and what was credited, in kobo.
function fundAmounts(t) {
  const credited = kobo(t.amount);
  const m = /Bank transfer of ₦([\d,.]+)/.exec(String(t.note || ''));
  const sent = m ? kobo(String(m[1]).replace(/,/g, '')) : credited;
  return [...new Set([sent, credited])];
}

async function matchFunding(partner, rows, range) {
  const credits = rows.filter((r) => r.dir === 'credit');
  const keyOf = new Map();
  for (const r of credits) for (const k of refKeys(partner, r.reference)) keyOf.set(k, r);
  const keys = [...keyOf.keys()];
  const [byRef, unmatched] = await Promise.all([
    keys.length ? prisma.walletTransaction.findMany({ where: { type: 'FUND', providerRef: { in: keys } }, select: { id: true, customerId: true, providerRef: true, amount: true, note: true, status: true, createdAt: true } }) : [],
    keys.length ? prisma.unmatchedPayment.findMany({ where: { providerRef: { in: keys } }, select: { id: true, providerRef: true, amount: true, status: true } }).catch(() => []) : [],
  ]);
  const ours = new Map(byRef.map((t) => [t.providerRef, t]));
  const waiting = new Map(unmatched.map((u) => [u.providerRef, u]));
  const out = { matched: [], notInOurRecords: [], differentAmount: [], waitingInUnmatched: [] };
  const used = new Set();
  for (const r of credits) {
    const k = refKeys(partner, r.reference)[0];
    const t = ours.get(k);
    if (t) {
      used.add(t.id);
      const amounts = fundAmounts(t);
      if (amounts.includes(r.kobo)) out.matched.push({ ...row(r), customerId: t.customerId, status: t.status });
      else out.differentAmount.push({ ...row(r), ourAmountKobo: kobo(t.amount), ourSentKobo: amounts[0], customerId: t.customerId, status: t.status });
    } else if (waiting.has(k)) {
      const u = waiting.get(k);
      out.waitingInUnmatched.push({ ...row(r), status: u.status, ourAmountKobo: kobo(u.amount) });
    } else {
      out.notInOurRecords.push(row(r));
    }
  }
  // Ours in the same days that the statement doesn't have.
  let notInStatement = [];
  if (range) {
    const where = partner === 'monnify'
      ? { type: 'FUND', createdAt: range, providerRef: { startsWith: 'MNFY' } }
      : { type: 'FUND', createdAt: range, providerRef: { startsWith: PREFIX[partner] } };
    const inRange = await prisma.walletTransaction.findMany({ where, select: { id: true, customerId: true, providerRef: true, amount: true, status: true, createdAt: true } });
    notInStatement = inRange.filter((t) => !used.has(t.id)).map((t) => ({ reference: partner === 'monnify' ? t.providerRef : String(t.providerRef).slice(PREFIX[partner].length), amountKobo: kobo(t.amount), date: ymd(new Date(t.createdAt)), customerId: t.customerId, status: t.status }));
  }
  return { ...out, notInStatement, otherRows: rows.length - credits.length, otherRowsNote: 'Debits (payouts, fees) are not checked against funding.' };
}

async function matchVtpass(rows, range) {
  const debits = rows.filter((r) => r.dir === 'debit');
  const credits = rows.filter((r) => r.dir === 'credit');
  const refs = [...new Set(rows.map((r) => r.reference))];
  const orders = refs.length ? await prisma.order.findMany({ where: { vtpassRequestId: { in: refs } }, select: { id: true, vtpassRequestId: true, amount: true, costAmount: true, status: true, isTest: true, service: true, provider: true, responsePayload: true } }) : [];
  const byRef = new Map(orders.map((o) => [o.vtpassRequestId, o]));
  const reversed = new Set(credits.filter((r) => byRef.has(r.reference)).map((r) => r.reference));
  const out = { matched: [], notInOurRecords: [], differentAmount: [], chargedForFailedOrder: [], reversals: [] };
  const used = new Set();
  for (const r of debits) {
    const o = byRef.get(r.reference);
    if (!o) { out.notInOurRecords.push(row(r)); continue; }
    used.add(o.id);
    const tx = o.responsePayload?.content?.transactions || {};
    const amounts = [o.costAmount, o.amount, tx.total_amount, tx.amount, tx.unit_price].filter((x) => x !== null && x !== undefined).map(kobo);
    const item = { ...row(r), orderId: o.id, service: o.service, provider: o.provider, status: o.status };
    if (['FAILED', 'REFUNDED'].includes(o.status) && !reversed.has(r.reference)) out.chargedForFailedOrder.push(item);
    else if (amounts.includes(r.kobo)) out.matched.push(item);
    else out.differentAmount.push({ ...item, ourCostKobo: kobo(o.costAmount ?? o.amount) });
  }
  for (const r of credits) if (byRef.has(r.reference)) out.reversals.push({ ...row(r), orderId: byRef.get(r.reference).id, status: byRef.get(r.reference).status });
  let notInStatement = [];
  if (range) {
    const inRange = await prisma.order.findMany({ where: { createdAt: range, status: { in: ['SUCCESS', 'PENDING'] }, isTest: false, vtpassRequestId: { not: null } }, select: { id: true, vtpassRequestId: true, amount: true, costAmount: true, status: true, service: true, provider: true, createdAt: true, responsePayload: true } });
    notInStatement = inRange
      .filter((o) => !used.has(o.id) && !['NOMBA', 'CLUBKONNECT'].includes(o.responsePayload?.supplier))
      .map((o) => ({ reference: o.vtpassRequestId, amountKobo: kobo(o.costAmount ?? o.amount), date: ymd(new Date(o.createdAt)), orderId: o.id, service: o.service, provider: o.provider, status: o.status }));
  }
  return { ...out, notInStatement, otherRows: credits.length - out.reversals.length, otherRowsNote: 'Credits that are not reversals (e.g. wallet top-ups) are not checked.' };
}

// Same reference (and direction) more than once in the statement.
function duplicatesOf(rows) {
  const seen = new Map();
  for (const r of rows) {
    const k = `${r.dir}|${r.reference}`;
    seen.set(k, [...(seen.get(k) || []), r]);
  }
  return [...seen.values()].filter((list) => list.length > 1).map((list) => ({ reference: list[0].reference, times: list.length, amountsKobo: list.map((r) => r.kobo), direction: list[0].dir }));
}

const totalKobo = (list) => list.reduce((a, x) => a + (x.amountKobo || 0), 0);
function group(list) {
  return { count: list.length, totalKobo: totalKobo(list), items: list.slice(0, LIST), ...(list.length > LIST ? { more: list.length - LIST } : {}) };
}

async function check({ partner, fileName, rows: raw } = {}) {
  const p = String(partner || '').toLowerCase();
  if (!PARTNERS.includes(p)) return { error: 'Choose the partner the statement is from: Nomba, Squad, Monnify or VTpass.' };
  const { rows, dropped, truncated } = cleanRows(raw);
  if (!rows.length) return { error: 'No usable rows: each row needs a reference and an amount. Check the file has those columns.' };
  const range = rangeOf(rows);
  const r = p === 'vtpass' ? await matchVtpass(rows, range) : await matchFunding(p, rows, range);
  const groups = Object.fromEntries(Object.entries(r).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, group(v)]));
  return {
    partner: p,
    file: fileName ? String(fileName).slice(0, 80) : undefined,
    rowsRead: rows.length,
    rowsSkipped: dropped,
    ...(truncated ? { note: `Only the first ${MAX_ROWS} rows were checked.` } : {}),
    period: range ? { from: ymd(range.gte), to: ymd(new Date(range.lt.getTime() - 60000)) } : 'No readable dates, so "in our records but not in the statement" was not checked.',
    amountsIn: 'kobo (₦1 = 100 kobo)',
    ...groups,
    duplicatesInStatement: group(duplicatesOf(rows)),
    otherRows: r.otherRows,
    otherRowsNote: r.otherRowsNote,
    nextSteps: p === 'vtpass'
      ? 'Read-only: nothing was changed. Raise "charged for a failed order" and "not in our records" rows with VTpass (Partners → partner desk); open an order from Admin → Orders.'
      : 'Read-only: nothing was credited. For a credit in the statement but not in our records, find the customer and use "Funding not showing?" on their page (Admin → Customers), or credit it from Admin → Unmatched payments if it is waiting there. Never credit twice: check the reference first.',
    links: p === 'vtpass' ? ['/admin/orders', '/admin/partners'] : ['/admin/unmatched-payments', '/admin/customers'],
  };
}

module.exports = { check, cleanRows, parseAmount, parseDate, direction, rangeOf, MAX_ROWS, PARTNERS };
