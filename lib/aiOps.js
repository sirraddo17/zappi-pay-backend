// Read-only helpers for the admin AI (owner only). Nothing here moves money
// or changes a record: the AI reads these and, where an action makes sense,
// proposes an Apply card (lib/adminActions.js) that the owner taps.
//  • unmatchedSuggestions — who each unmatched payment probably belongs to
//  • payoutRunway        — how long the payout wallet lasts at the current pace
//  • monnifyRecon        — yesterday's Monnify payments vs our wallet credits
//  • weeklyReport        — a plain Monday email to the owner
// Amounts are kept in kobo where they are compared.

const prisma = require('./prisma');

const LAGOS = 60 * 60 * 1000;
const DAY = 24 * LAGOS;
const kobo = (v) => Math.round(Number(v || 0) * 100);
const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const maskPhone = (p) => (p ? String(p).replace(/^(\d{4})\d+(\d{2})$/, '$1•••••$2') : null);
const lagosDayStart = (t) => new Date(Math.floor((t + LAGOS) / DAY) * DAY - LAGOS);
const ymd = (d) => new Date(new Date(d).getTime() + LAGOS).toISOString().slice(0, 10);

// --- 2. Unmatched payments: likely owner ------------------------------------
async function unmatchedSuggestions() {
  const rows = await prisma.unmatchedPayment.findMany({ where: { status: 'OPEN' }, orderBy: { createdAt: 'desc' }, take: 50 });
  if (!rows.length) return { open: 0, note: 'No unmatched payments waiting.' };
  const { namesMatch } = require('./idCheck');
  const out = [];
  for (const u of rows) {
    const candidates = [];
    if (u.suggestedCustomerId) {
      const c = await prisma.customer.findUnique({ where: { id: u.suggestedCustomerId }, select: { id: true, name: true, phone: true, deletedAt: true, active: true } });
      if (c && !c.deletedAt) candidates.push({ customerId: c.id, name: c.name, phone: maskPhone(c.phone), why: 'This account number used to belong to them (retired number).', strength: 'strong' });
    }
    if (u.payerName && candidates.length === 0) {
      const words = String(u.payerName).split(/[\s/,.-]+/).filter((w) => w.length >= 3).slice(0, 3);
      const found = words.length ? await prisma.customer.findMany({ where: { deletedAt: null, OR: words.map((w) => ({ name: { contains: w, mode: 'insensitive' } })) }, select: { id: true, name: true, phone: true }, take: 10 }) : [];
      for (const c of found.filter((x) => namesMatch(x.name, u.payerName)).slice(0, 3)) candidates.push({ customerId: c.id, name: c.name, phone: maskPhone(c.phone), why: `Payer name "${u.payerName}" matches their name.`, strength: 'possible' });
    }
    out.push({ paymentId: u.id, provider: u.provider, reference: u.providerRef, amountKobo: kobo(u.amount), payerName: u.payerName || null, received: u.createdAt, candidates, ...(candidates.length ? {} : { note: 'No likely owner found. Ask who paid (bank receipt), or mark it returned on the Unmatched payments screen.' }) });
  }
  return { open: rows.length, amountsIn: 'kobo', payments: out, rule: 'Suggestions only. To credit one, use propose_assign_unmatched (the owner taps Apply). Strong = their old account number; possible = name match only — confirm with the customer first.' };
}

// --- 7. Payout wallet runway -------------------------------------------------
async function payoutRunway({ days = 14 } = {}) {
  const c = await require('./fundsGuard').coverage({ fresh: true }).catch((e) => ({ error: e.message }));
  const since = new Date(Date.now() - days * DAY);
  const sent = await prisma.bankTransfer.findMany({ where: { status: 'SUCCESS', createdAt: { gte: since } }, select: { amount: true, provider: true } });
  const via = c.payoutProvider || 'monnify';
  const mine = sent.filter((t) => (t.provider || 'monnify') === via);
  const totalK = mine.reduce((a, t) => a + kobo(t.amount), 0);
  const perDayK = Math.round(totalK / days);
  const freeK = c.monnifyFree === null || c.monnifyFree === undefined ? null : kobo(c.monnifyFree);
  return {
    payoutPartner: via,
    freeInPayoutWalletKobo: freeK,
    sentLastDays: { days, count: mine.length, totalKobo: totalK },
    averagePerDayKobo: perDayK,
    daysLeft: freeK === null ? null : perDayK > 0 ? Math.floor(freeK / perDayK) : null,
    amountsIn: 'kobo',
    note: perDayK > 0 ? 'Days left = free balance ÷ average sent per day. Top up from the partner’s Fund account (Monnify → Balances → Fund Balance).' : 'No bank transfers sent recently, so there is no daily pace yet.',
    ...(c.error ? { error: `Could not read the wallet: ${c.error}` } : {}),
  };
}

// --- 6. Monnify daily reconciliation (API, no file) ------------------------------
// Monnify's transaction search, paid only, for one Lagos day; then the same
// matching as an uploaded statement (lib/statementMatch.js).
async function fetchMonnifyDay(day, { api } = {}) {
  const call = api || require('./monnify').api;
  const from = new Date(`${day}T00:00:00+01:00`).getTime();
  const to = from + DAY - 1;
  const rows = [];
  for (let page = 0; page < 20; page += 1) {
    const body = await call('GET', `/api/v1/transactions/search?page=${page}&size=100&paymentStatus=PAID&from=${from}&to=${to}`);
    const list = Array.isArray(body?.content) ? body.content : [];
    for (const t of list) {
      if (String(t.paymentStatus || 'PAID').toUpperCase() !== 'PAID') continue;
      rows.push({ reference: t.transactionReference, amount: t.amountPaid ?? t.amount, type: 'credit', date: t.completedOn || t.paidOn || t.createdOn || `${day} 12:00`, narration: t.paymentDescription || '' });
    }
    if (list.length < 100 || body?.last === true) break;
  }
  return rows;
}

async function monnifyRecon({ day, api } = {}) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? day : ymd(Date.now() - DAY);
  let rows;
  try {
    rows = await fetchMonnifyDay(d, { api });
  } catch (e) {
    return { day: d, error: `Monnify didn't answer the transaction search: ${String(e.message || e).slice(0, 160)}` };
  }
  if (!rows.length) return { day: d, monnifyPayments: 0, note: 'Monnify shows no paid transactions that day.' };
  const r = await require('./statementMatch').check({ partner: 'monnify', fileName: `Monnify API ${d}`, rows });
  return { day: d, monnifyPayments: rows.length, ...r, source: 'Monnify transaction search (API)' };
}

// --- 8. Weekly report (Monday email) ---------------------------------------------
async function weeklyReport({ now = Date.now() } = {}) {
  const end = lagosDayStart(now);
  const start = new Date(end.getTime() - 7 * DAY);
  const range = { gte: start, lt: end };
  const testIds = new Set((await prisma.customer.findMany({ where: { isTestAccount: true }, select: { id: true } }).catch(() => [])).map((c) => c.id));
  const real = (x) => !testIds.has(x.customerId);
  const [orders, funds, refunds, transfers, newCustomers, flags, tickets] = await Promise.all([
    prisma.order.findMany({ where: { createdAt: range }, select: { customerId: true, status: true, amount: true, cashbackUsed: true, isTest: true, service: true } }),
    prisma.walletTransaction.findMany({ where: { type: 'FUND', status: 'APPROVED', createdAt: range }, select: { customerId: true, amount: true } }),
    prisma.walletTransaction.findMany({ where: { type: 'REFUND', status: 'APPROVED', createdAt: range }, select: { customerId: true, amount: true } }),
    prisma.bankTransfer.findMany({ where: { createdAt: range }, select: { customerId: true, status: true, amount: true } }).catch(() => []),
    prisma.customer.count({ where: { createdAt: range, deletedAt: null } }),
    prisma.riskFlag.count({ where: { createdAt: range } }).catch(() => 0),
    prisma.supportTicket.count({ where: { createdAt: range } }).catch(() => 0),
  ]);
  const ok = orders.filter((o) => o.status === 'SUCCESS' && !o.isTest && real(o));
  const failed = orders.filter((o) => ['FAILED', 'REFUNDED'].includes(o.status) && !o.isTest && real(o)).length;
  const salesK = ok.reduce((a, o) => a + kobo(o.amount) - kobo(o.cashbackUsed), 0);
  const byService = {};
  for (const o of ok) byService[o.service] = (byService[o.service] || 0) + kobo(o.amount);
  const fundK = funds.filter(real).reduce((a, x) => a + kobo(x.amount), 0);
  const refundK = refunds.filter(real).reduce((a, x) => a + kobo(x.amount), 0);
  const sentOk = transfers.filter((t) => t.status === 'SUCCESS' && real(t));
  const follow = await require('./partnerDesk').followups().catch(() => null);
  const earn = await require('./earnings').earningsReport?.({ gte: start, lt: end }).catch(() => null);
  const profit = earn && Number.isFinite(Number(earn.net ?? earn.profit)) ? Number(earn.net ?? earn.profit) : null;
  const lines = [
    `Week ${ymd(start)} to ${ymd(end.getTime() - 1)} (Lagos), real customers only:`,
    `• Sales: ${naira(salesK / 100)} from ${ok.length} successful purchases (${failed} failed or refunded).`,
    ...(Object.keys(byService).length ? [`• By service: ${Object.entries(byService).sort((a, b) => b[1] - a[1]).map(([s, k]) => `${s.toLowerCase()} ${naira(k / 100)}`).join(', ')}.`] : []),
    ...(profit !== null ? [`• Estimated profit: ${naira(profit)}.`] : []),
    `• Wallet funding: ${naira(fundK / 100)} (${funds.filter(real).length} payments). Refunds: ${naira(refundK / 100)}.`,
    `• Send to Bank: ${sentOk.length} transfers sent (${naira(sentOk.reduce((a, t) => a + kobo(t.amount), 0) / 100)}).`,
    `• New customers: ${newCustomers}. Support tickets: ${tickets}. Risk flags raised: ${flags}.`,
    ...(follow ? [`• Partner follow-ups: ${follow.openTasks} open, ${follow.overdueTasks} overdue${follow.overdueTasks ? ` (${follow.partners.filter((p) => p.overdue).map((p) => p.name).join(', ')})` : ''}.`] : []),
    '',
    'Ask the AI Assistant for details, e.g. "how was last week?" or "what\'s pending with partners?".',
  ];
  return { from: ymd(start), to: ymd(end.getTime() - 1), salesKobo: salesK, purchases: ok.length, failedOrRefunded: failed, fundingKobo: fundK, refundsKobo: refundK, newCustomers, text: lines.join('\n') };
}

// --- jobs ------------------------------------------------------------------------
// Hourly tick (quietClock): Monnify reconciliation once a day after 7am;
// weekly report on Mondays after 7am. PartnerCheck rows remember the runs.
async function ranToday(kind, day) {
  const last = await prisma.partnerCheck.findFirst({ where: { kind }, orderBy: { ranAt: 'desc' } }).catch(() => null);
  return last && last.summary?.day === day;
}

async function tick(now = Date.now()) {
  const lagos = new Date(now + LAGOS);
  if (lagos.getUTCHours() < 7) return null;
  const today = ymd(now);
  const done = {};
  const s = await require('./vtpass').getSettings().catch(() => ({}));
  const monnifyLive = await require('./monnify').getConfig().then((c) => c.mode === 'live').catch(() => false);
  if (monnifyLive && !(await ranToday('MONNIFY_RECON', today))) {
    const r = await monnifyRecon({});
    await prisma.partnerCheck.create({ data: { kind: 'MONNIFY_RECON', summary: JSON.parse(JSON.stringify({ day: today, checkedDay: r.day, error: r.error || null, notInOurRecords: r.notInOurRecords?.count || 0, differentAmount: r.differentAmount?.count || 0, matched: r.matched?.count || 0 })) } }).catch(() => {});
    const missing = r.notInOurRecords?.count || 0;
    const diff = r.differentAmount?.count || 0;
    if (missing || diff) await Promise.resolve(require('./adminAlert').alertAdmins(`Monnify check ${r.day}: ${missing} payment${missing === 1 ? '' : 's'} not credited${diff ? `, ${diff} different amount${diff === 1 ? '' : 's'}` : ''}`, `Monnify confirmed payments that aren't in wallets yet (or differ). Ask the AI Assistant "Monnify reconciliation for ${r.day}" for the list. Nothing was credited automatically.`, '/admin/unmatched-payments')).catch(() => {});
    done.recon = r.day;
  }
  if (lagos.getUTCDay() === 1 && s.emailAlertsEnabled !== false && String(process.env.WEEKLY_REPORT || '').toLowerCase() !== 'off' && !(await ranToday('WEEKLY_REPORT', today))) {
    const w = await weeklyReport({ now });
    const { emailAdmins } = require('./adminAlert');
    const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    await emailAdmins(`ZAPPI PAY weekly report: ${w.from} to ${w.to}`, `<pre style="font-family:inherit;white-space:pre-wrap">${esc(w.text)}</pre>`, w.text).catch((e) => console.error('weekly report email failed:', e.message));
    await prisma.partnerCheck.create({ data: { kind: 'WEEKLY_REPORT', summary: { day: today, from: w.from, to: w.to } } }).catch(() => {});
    done.weekly = w.from;
  }
  return done;
}

let started = false;
function start() {
  if (started || process.env.DISABLE_SCHEDULER === '1') return;
  started = true;
  require('./quietClock').every('AI ops (Monnify check, weekly report)', 60 * 60 * 1000, () => tick(), { firstAfter: 8 * 60 * 1000 });
}

module.exports = { unmatchedSuggestions, payoutRunway, monnifyRecon, fetchMonnifyDay, weeklyReport, tick, start };
