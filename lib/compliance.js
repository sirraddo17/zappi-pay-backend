// Monthly compliance summary (admin AI tool get_compliance_summary and the
// owner-only CSV at /admin/compliance/export). For the owner to review for
// SCUML / NFIU and partner due-diligence questions. READ-ONLY: it never
// files, sends or changes anything — the AI only drafts.
//
// Real figures leave out test orders (Order.isTest) and owner-marked test
// accounts (Customer.isTestAccount); those are shown separately.
// Amounts are whole kobo.

const prisma = require('./prisma');
const { scrubLine } = require('./serverLogs');

const LAGOS = 60 * 60 * 1000;
const DAY = 24 * LAGOS;
const DEFAULT_SINGLE_NAIRA = 1000000;
const DEFAULT_DAILY_NAIRA = 5000000;
const LIST = 50;

const kobo = (v) => Math.round(Number(v || 0) * 100);
const naira = (k) => `₦${(k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const lagosDay = (d) => new Date(new Date(d).getTime() + LAGOS).toISOString().slice(0, 10);
const maskPhone = (p) => (p ? scrubLine(String(p)) : null);

// "2026-11" → Lagos month range (default: last full month).
function monthRange(ym) {
  let y;
  let m;
  if (/^\d{4}-\d{2}$/.test(String(ym || ''))) [y, m] = String(ym).split('-').map(Number);
  else {
    const now = new Date(Date.now() + LAGOS);
    y = now.getUTCFullYear();
    m = now.getUTCMonth(); // last month (1-based below)
    if (m === 0) { y -= 1; m = 12; }
  }
  const gte = new Date(Date.UTC(y, m - 1, 1) - LAGOS);
  const lt = new Date(Date.UTC(y, m, 1) - LAGOS);
  return { month: `${y}-${String(m).padStart(2, '0')}`, gte, lt };
}

async function thresholds() {
  const s = await require('./vtpass').getSettings().catch(() => ({}));
  const single = Number(s.complianceSingleFunding);
  const daily = Number(s.complianceDailyFunding);
  return {
    singleKobo: kobo(single > 0 ? single : DEFAULT_SINGLE_NAIRA),
    dailyKobo: kobo(daily > 0 ? daily : DEFAULT_DAILY_NAIRA),
  };
}

async function testAccountIds() {
  const rows = await prisma.customer.findMany({ where: { isTestAccount: true }, select: { id: true } }).catch(() => []);
  return new Set(rows.map((r) => r.id));
}

const sum = (list, f = (x) => kobo(x.amount)) => list.reduce((a, x) => a + f(x), 0);
const totals = (list, f) => ({ count: list.length, totalKobo: sum(list, f) });
const listOf = (list) => ({ count: list.length, items: list.slice(0, LIST), ...(list.length > LIST ? { more: list.length - LIST } : {}) });

async function summary({ month } = {}) {
  const r = monthRange(month);
  const range = { gte: r.gte, lt: r.lt };
  const testIds = await testAccountIds();
  const { singleKobo, dailyKobo } = await thresholds();

  const [funds, orders, refunds, deactivations, selfFrozen, flagsRaised, flagsDismissed, scams, dupIds, unmatched, unmatchedOpen] = await Promise.all([
    prisma.walletTransaction.findMany({ where: { type: 'FUND', status: 'APPROVED', createdAt: range }, select: { id: true, customerId: true, amount: true, providerRef: true, createdAt: true } }),
    prisma.order.findMany({ where: { status: 'SUCCESS', createdAt: range }, select: { id: true, customerId: true, amount: true, cashbackUsed: true, isTest: true, service: true } }),
    prisma.walletTransaction.findMany({ where: { type: 'REFUND', status: 'APPROVED', createdAt: range }, select: { id: true, customerId: true, amount: true, reference: true } }),
    prisma.auditLog.findMany({ where: { action: 'CUSTOMER_DEACTIVATED', createdAt: range }, select: { details: true, createdAt: true } }).catch(() => []),
    prisma.customer.count({ where: { selfFrozenAt: range } }).catch(() => 0),
    prisma.riskFlag.findMany({ where: { createdAt: range }, select: { severity: true, title: true, status: true } }).catch(() => []),
    prisma.riskFlag.count({ where: { status: 'DISMISSED', updatedAt: range } }).catch(() => 0),
    prisma.scamReport.findMany({ where: { createdAt: range }, select: { channel: true, lostMoney: true } }).catch(() => []),
    prisma.idCheck.findMany({ where: { result: 'DUPLICATE_ID', createdAt: range }, select: { customerId: true, idType: true } }).catch(() => []),
    prisma.unmatchedPayment.findMany({ where: { createdAt: range }, select: { amount: true, status: true, provider: true } }).catch(() => []),
    prisma.unmatchedPayment.findMany({ where: { status: 'OPEN' }, select: { amount: true } }).catch(() => []),
  ]);

  // Refunds of test orders count as test.
  const refRefs = [...new Set(refunds.map((x) => x.reference).filter(Boolean))];
  const testRefs = new Set(refRefs.length ? (await prisma.order.findMany({ where: { vtpassRequestId: { in: refRefs }, isTest: true }, select: { vtpassRequestId: true } })).map((o) => o.vtpassRequestId) : []);

  const isTestCustomer = (x) => testIds.has(x.customerId);
  const realFunds = funds.filter((x) => !isTestCustomer(x));
  const testFunds = funds.filter(isTestCustomer);
  const realOrders = orders.filter((o) => !o.isTest && !isTestCustomer(o));
  const testOrders = orders.filter((o) => o.isTest || isTestCustomer(o));
  const realRefunds = refunds.filter((x) => !isTestCustomer(x) && !testRefs.has(x.reference));
  const testRefunds = refunds.filter((x) => isTestCustomer(x) || testRefs.has(x.reference));
  const paid = (o) => kobo(o.amount) - kobo(o.cashbackUsed); // cash part of the price

  // Large funding: one payment ≥ single threshold, or a day's total ≥ daily threshold.
  const ids = [...new Set(realFunds.map((f) => f.customerId))];
  const people = ids.length ? await prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, phone: true } }) : [];
  const who = new Map(people.map((c) => [c.id, { customerId: c.id, name: c.name, phone: maskPhone(c.phone) }]));
  const large = realFunds.filter((f) => kobo(f.amount) >= singleKobo).sort((a, b) => kobo(b.amount) - kobo(a.amount)).map((f) => ({ ...who.get(f.customerId), amountKobo: kobo(f.amount), date: lagosDay(f.createdAt), reference: f.providerRef || null }));
  const byDay = new Map();
  for (const f of realFunds) {
    const k = `${f.customerId}|${lagosDay(f.createdAt)}`;
    const e = byDay.get(k) || { customerId: f.customerId, date: lagosDay(f.createdAt), totalKobo: 0, payments: 0 };
    e.totalKobo += kobo(f.amount);
    e.payments += 1;
    byDay.set(k, e);
  }
  const heavyDays = [...byDay.values()].filter((e) => e.totalKobo >= dailyKobo).sort((a, b) => b.totalKobo - a.totalKobo).map((e) => ({ ...who.get(e.customerId), date: e.date, totalKobo: e.totalKobo, payments: e.payments }));

  const frozenIds = [...new Set(deactivations.map((d) => d.details?.customerId).filter(Boolean))];
  const bySeverity = flagsRaised.reduce((a, f) => ({ ...a, [f.severity]: (a[f.severity] || 0) + 1 }), {});
  const byChannel = scams.reduce((a, s) => ({ ...a, [s.channel]: (a[s.channel] || 0) + 1 }), {});
  const unmatchedBy = unmatched.reduce((a, u) => { const k = u.status; a[k] = a[k] || { count: 0, totalKobo: 0 }; a[k].count += 1; a[k].totalKobo += kobo(u.amount); return a; }, {});

  return {
    month: r.month,
    period: { from: lagosDay(r.gte), to: lagosDay(new Date(r.lt.getTime() - 1)) },
    amountsIn: 'kobo (₦1 = 100 kobo)',
    thresholds: { singleFundingKobo: singleKobo, dailyFundingKobo: dailyKobo, setIn: 'Admin → Money check → Compliance summary' },
    real: {
      fundingInflows: totals(realFunds),
      purchases: { ...totals(realOrders, paid), note: 'Successful purchases, cash part paid (cashback used is left out).' },
      refunds: totals(realRefunds),
    },
    test: {
      note: 'Test orders and owner-marked test accounts, kept out of the real figures.',
      testAccounts: testIds.size,
      fundingInflows: totals(testFunds),
      purchases: totals(testOrders, paid),
      refunds: totals(testRefunds),
    },
    largeSingleFunding: listOf(large),
    largeDailyFunding: listOf(heavyDays),
    accountsFrozen: { byStaff: deactivations.length, customersFrozenByStaff: frozenIds.length, frozenByCustomerThemselves: selfFrozen },
    riskFlags: { raised: flagsRaised.length, bySeverity, dismissed: flagsDismissed, stillOpen: flagsRaised.filter((f) => f.status === 'OPEN').length },
    scamReports: { count: scams.length, lostMoney: scams.filter((s) => s.lostMoney).length, byChannel },
    duplicateIdBlocked: { attempts: dupIds.length, customers: new Set(dupIds.map((d) => d.customerId)).size, note: 'Same BVN/NIN refused for a second account (recorded from 5 Nov 2026).' },
    unmatchedPayments: { thisMonth: unmatchedBy, stillOpenNow: { count: unmatchedOpen.length, totalKobo: sum(unmatchedOpen) } },
    disclaimer: 'Draft for the owner to review. ZAPPI PAY does not file or send any report: the owner decides what to file with SCUML/NFIU or share with partners.',
  };
}

// Rows for the CSV (naira with 2 decimals for people reading it).
function csvRows(s) {
  const n = (k) => (k / 100).toFixed(2);
  const rows = [];
  const add = (section, item, count, amountKobo, details = '') => rows.push([section, item, count ?? '', amountKobo === null || amountKobo === undefined ? '' : n(amountKobo), details]);
  add('Period', s.month, '', null, `${s.period.from} to ${s.period.to} (Lagos)`);
  add('Thresholds', 'Single funding at or above', '', s.thresholds.singleFundingKobo);
  add('Thresholds', 'Funding in one day at or above', '', s.thresholds.dailyFundingKobo);
  add('Real', 'Funding inflows', s.real.fundingInflows.count, s.real.fundingInflows.totalKobo);
  add('Real', 'Purchases (successful, cash paid)', s.real.purchases.count, s.real.purchases.totalKobo);
  add('Real', 'Refunds', s.real.refunds.count, s.real.refunds.totalKobo);
  add('Test (excluded)', 'Funding inflows', s.test.fundingInflows.count, s.test.fundingInflows.totalKobo, `${s.test.testAccounts} test accounts`);
  add('Test (excluded)', 'Purchases', s.test.purchases.count, s.test.purchases.totalKobo);
  add('Test (excluded)', 'Refunds', s.test.refunds.count, s.test.refunds.totalKobo);
  for (const x of s.largeSingleFunding.items) add('Large single funding', `${x.name || ''} (${x.customerId})`, 1, x.amountKobo, `${x.date} · ${x.phone || ''} · ref ${x.reference || ''}`);
  for (const x of s.largeDailyFunding.items) add('Large funding in one day', `${x.name || ''} (${x.customerId})`, x.payments, x.totalKobo, `${x.date} · ${x.phone || ''}`);
  add('Accounts frozen', 'By staff', s.accountsFrozen.byStaff, null, `${s.accountsFrozen.customersFrozenByStaff} customers`);
  add('Accounts frozen', 'By the customer', s.accountsFrozen.frozenByCustomerThemselves, null);
  add('Risk flags', 'Raised', s.riskFlags.raised, null, Object.entries(s.riskFlags.bySeverity).map(([k, v]) => `${k}: ${v}`).join('; '));
  add('Risk flags', 'Dismissed', s.riskFlags.dismissed, null);
  add('Scam reports', 'Reported', s.scamReports.count, null, `${s.scamReports.lostMoney} lost money`);
  add('Duplicate BVN/NIN', 'Second account refused', s.duplicateIdBlocked.attempts, null, `${s.duplicateIdBlocked.customers} customers`);
  for (const [status, v] of Object.entries(s.unmatchedPayments.thisMonth)) add('Unmatched payments', `This month: ${status}`, v.count, v.totalKobo);
  add('Unmatched payments', 'Still open now', s.unmatchedPayments.stillOpenNow.count, s.unmatchedPayments.stillOpenNow.totalKobo);
  add('Note', s.disclaimer, '', null);
  return rows;
}
const CSV_HEADERS = ['Section', 'Item', 'Count', 'Amount (₦)', 'Details'];

async function saveThresholds({ singleNaira, dailyNaira } = {}) {
  const data = {};
  const ok = (v) => Number.isFinite(Number(v)) && Number(v) >= 1000 && Number(v) <= 1000000000;
  if (singleNaira !== undefined) { if (!ok(singleNaira)) throw Object.assign(new Error('Single funding threshold must be ₦1,000 to ₦1,000,000,000.'), { status: 400 }); data.complianceSingleFunding = Math.round(Number(singleNaira)); }
  if (dailyNaira !== undefined) { if (!ok(dailyNaira)) throw Object.assign(new Error('Daily funding threshold must be ₦1,000 to ₦1,000,000,000.'), { status: 400 }); data.complianceDailyFunding = Math.round(Number(dailyNaira)); }
  if (!Object.keys(data).length) throw Object.assign(new Error('Nothing to change.'), { status: 400 });
  const s = await prisma.settings.findFirst({ select: { id: true } });
  await prisma.settings.update({ where: { id: s.id }, data });
  require('./vtpass').invalidateSettings?.();
  return thresholds();
}

module.exports = { summary, csvRows, CSV_HEADERS, monthRange, thresholds, saveThresholds, naira, DEFAULT_SINGLE_NAIRA, DEFAULT_DAILY_NAIRA };
