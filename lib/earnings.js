const prisma = require('./prisma');

// What ZAPPI PAY really earns, line by line:
//   + price the customer paid − face value (your markup, after discounts/promos)
//   + VTpass commission (VTpass charges us less than face value)
//   + fees you charge (bank-funding fee, send-to-bank fee, airtime-to-cash fee)
//   − Monnify's cut on bank funding and on send-to-bank payouts
//   − rewards paid (cashback, referral bonus, loyalty, contest prizes, coupons)
//
// VTpass tells us the exact commission in every purchase response; the
// table below is only used when that's missing (older orders, pending).
// Rates are VTpass's published API rates (vtpass.com/commissions) — your
// account's own rates can differ.

const PCT = (pct, cap) => ({ pct, cap });
const FLAT = (flat) => ({ flat });
const VTPASS_RATES = {
  // Airtime
  mtn: PCT(3), airtel: PCT(3.4), glo: PCT(4), etisalat: PCT(4), '9mobile': PCT(4), 'foreign-airtime': PCT(3),
  // Data
  'mtn-data': PCT(3), 'airtel-data': PCT(3.4), 'glo-data': PCT(4), 'etisalat-data': PCT(4), '9mobile-sme-data': PCT(4), 'glo-sme-data': PCT(4),
  // Internet
  'smile-direct': PCT(5), smile: PCT(5),
  // TV
  dstv: PCT(1.5), gotv: PCT(1.5), startimes: PCT(2),
  // Electricity
  'aba-electric': PCT(1.7), 'abuja-electric': PCT(1.2, 1300), 'benin-electric': PCT(1.5), 'eko-electric': PCT(1),
  'enugu-electric': PCT(1.4), 'ibadan-electric': PCT(1.1), 'ikeja-electric': PCT(1, 1500), 'jos-electric': PCT(0.9),
  'kaduna-electric': PCT(1.5), 'kano-electric': PCT(1), 'portharcourt-electric': PCT(1.1), 'yola-electric': PCT(1.2),
  // Education (fixed ₦ per PIN)
  'waec-registration': FLAT(150), waec: FLAT(250),
};
// When the provider isn't in the table.
const SERVICE_FALLBACK = { AIRTIME: PCT(3), DATA: PCT(3), ELECTRICITY: PCT(1), CABLE: PCT(1.5), INTERNET: PCT(0), EDUCATION: PCT(0), BETTING: PCT(0), OTHER: PCT(0) };

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
// Monnify published pricing (VAT exclusive). Override on Render if your
// negotiated rates differ: MONNIFY_COLLECTION_PERCENT, MONNIFY_COLLECTION_CAP,
// MONNIFY_PAYOUT_FEES (e.g. "10,20,40"), VAT_PERCENT.
const COLLECTION_PERCENT = num(process.env.MONNIFY_COLLECTION_PERCENT, 1.5);
const COLLECTION_CAP = num(process.env.MONNIFY_COLLECTION_CAP, 2000);
const PAYOUT_FEES = String(process.env.MONNIFY_PAYOUT_FEES || '10,20,40').split(',').map((x) => Number(x) || 0);
const VAT = num(process.env.VAT_PERCENT, 7.5) / 100;
const r2 = (n) => Math.round(n * 100) / 100;

function rateFor(service, provider) {
  return VTPASS_RATES[String(provider || '').toLowerCase()] || SERVICE_FALLBACK[service] || PCT(0);
}

function estimateCommission(service, provider, faceValue) {
  const rate = rateFor(service, provider);
  if (rate.flat) return rate.flat;
  let c = (Number(faceValue) * rate.pct) / 100;
  if (rate.cap) c = Math.min(c, rate.cap);
  return r2(c);
}

// Exact commission from VTpass's response when we have it.
function commissionOf(order) {
  const t = order.responsePayload?.content?.transactions;
  const exact = Number(t?.commission);
  if (Number.isFinite(exact) && exact >= 0 && t?.commission !== null && t?.commission !== undefined) return { amount: exact, exact: true };
  return { amount: estimateCommission(order.service, order.provider, order.costAmount ?? order.amount), exact: false };
}

function collectionCost(amountPaid) {
  const fee = Math.min((Number(amountPaid) * COLLECTION_PERCENT) / 100, COLLECTION_CAP);
  return r2(fee * (1 + VAT));
}

function payoutCost(amount) {
  const a = Number(amount);
  const fee = a >= 50000 ? PAYOUT_FEES[2] : a >= 10000 ? PAYOUT_FEES[1] : PAYOUT_FEES[0];
  return r2(fee * (1 + VAT));
}

// Fee we kept from a Monnify bank-funding credit, read from its note
// ("Bank transfer of ₦5,000 (₦50 fee)").
function fundingFeeFromNote(note) {
  const m = /\(₦([\d,.]+) fee\)/.exec(String(note || ''));
  return m ? Number(m[1].replace(/,/g, '')) : 0;
}

function bankFundingFee(amountPaid, settings) {
  const pct = Number(settings.bankFundingFeePercent || 0);
  const cap = Number(settings.bankFundingFeeCap || 0);
  let fee = (Number(amountPaid) * pct) / 100;
  if (cap > 0) fee = Math.min(fee, cap);
  return Math.round(fee * 100) / 100;
}

// Full earnings for a date range, with a per-day series when `days` (a
// list of YYYY-MM-DD Lagos dates) and `dayOf(date)` are given.
async function earningsReport(range, { dayOf, days } = {}) {
  const where = { createdAt: range };
  const [orders, transfers, fundings, rewards, a2c] = await Promise.all([
    prisma.order.findMany({ where: { ...where, status: 'SUCCESS' }, select: { service: true, provider: true, amount: true, costAmount: true, cashbackAmount: true, responsePayload: true, createdAt: true } }),
    prisma.bankTransfer.findMany({ where: { ...where, status: 'SUCCESS' }, select: { amount: true, fee: true, createdAt: true } }),
    prisma.walletTransaction.findMany({ where: { ...where, type: 'FUND', status: 'APPROVED', providerRef: { not: null } }, select: { amount: true, note: true, createdAt: true } }),
    prisma.walletTransaction.findMany({ where: { ...where, status: 'APPROVED', type: { in: ['CASHBACK', 'REFERRAL_BONUS', 'LOYALTY', 'CONTEST_PRIZE', 'COUPON'] } }, select: { type: true, amount: true, createdAt: true } }),
    prisma.airtimeCashRequest.findMany({ where: { ...where, status: 'APPROVED' }, select: { amount: true, receivedAmount: true, payoutAmount: true, createdAt: true } }).catch(() => []),
  ]);

  const dayMap = new Map((days || []).map((d) => [d, { date: d, revenue: 0, cost: 0, profit: 0, orders: 0 }]));
  const addDay = (date, profit, extra = {}) => {
    if (!dayOf) return;
    const d = dayMap.get(dayOf(date));
    if (!d) return;
    d.profit += profit;
    for (const [k, v] of Object.entries(extra)) d[k] += v;
  };

  const services = new Map();
  let sales = 0;
  let margin = 0;
  let commission = 0;
  let commissionExact = 0;
  for (const o of orders) {
    const paid = Number(o.amount);
    const face = o.costAmount == null ? paid : Number(o.costAmount);
    const c = commissionOf(o);
    const m = paid - face;
    sales += paid;
    margin += m;
    commission += c.amount;
    if (c.exact) commissionExact += 1;
    const s = services.get(o.service) || { service: o.service, orders: 0, revenue: 0, cost: 0, margin: 0, commission: 0, profit: 0 };
    s.orders += 1;
    s.revenue += paid;
    s.cost += face - c.amount; // what VTpass actually took from us
    s.margin += m;
    s.commission += c.amount;
    s.profit += m + c.amount;
    services.set(o.service, s);
    addDay(o.createdAt, m + c.amount, { revenue: paid, cost: face - c.amount, orders: 1 });
  }

  let transferFees = 0;
  let payoutCosts = 0;
  let transferVolume = 0;
  for (const t of transfers) {
    const cost = payoutCost(t.amount);
    transferFees += Number(t.fee || 0);
    payoutCosts += cost;
    transferVolume += Number(t.amount);
    addDay(t.createdAt, Number(t.fee || 0) - cost);
  }

  let fundingFees = 0;
  let collectionCosts = 0;
  let fundingVolume = 0;
  for (const f of fundings) {
    const fee = fundingFeeFromNote(f.note);
    const gross = Number(f.amount) + fee;
    const cost = collectionCost(gross);
    fundingFees += fee;
    collectionCosts += cost;
    fundingVolume += gross;
    addDay(f.createdAt, fee - cost);
  }

  const rewardByType = {};
  let rewardTotal = 0;
  for (const w of rewards) {
    rewardByType[w.type] = (rewardByType[w.type] || 0) + Number(w.amount);
    rewardTotal += Number(w.amount);
    addDay(w.createdAt, -Number(w.amount));
  }

  let a2cFees = 0;
  for (const q of a2c) {
    const fee = Number(q.receivedAmount ?? q.amount) - Number(q.payoutAmount || 0);
    a2cFees += fee;
    addDay(q.createdAt, fee);
  }

  const income = { purchaseMarkup: r2(margin), vtpassCommission: r2(commission), sendToBankFees: r2(transferFees), bankFundingFees: r2(fundingFees), airtimeToCashFees: r2(a2cFees) };
  const costs = { monnifyFundingFees: r2(collectionCosts), monnifyPayoutFees: r2(payoutCosts), rewards: r2(rewardTotal) };
  const totalIncome = Object.values(income).reduce((a, b) => a + b, 0);
  const totalCosts = Object.values(costs).reduce((a, b) => a + b, 0);
  const round = (x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v]));

  return {
    income,
    costs,
    rewardsByType: round(rewardByType),
    profit: r2(totalIncome - totalCosts),
    sales: r2(sales),
    orders: orders.length,
    commissionExactOrders: commissionExact,
    transfers: transfers.length,
    transferVolume: r2(transferVolume),
    bankFundings: fundings.length,
    bankFundingVolume: r2(fundingVolume),
    byService: [...services.values()].map(round).sort((a, b) => b.profit - a.profit),
    days: [...dayMap.values()].map(round),
  };
}

// "If a customer spends ₦X on this service, what do I keep?"
// funding: 'wallet' (money already in their wallet / manual funding) or
// 'bank' (they just sent exactly this amount to their Monnify account).
function estimateSale({ service, provider, amount, funding = 'wallet', agent = false }, settings) {
  const face = Number(amount);
  if (!(face > 0)) throw new Error('Enter an amount.');
  const lines = [];
  if (service === 'SEND_TO_BANK') {
    const fee = Number(settings.bankTransferFee || 0);
    const cost = payoutCost(face);
    lines.push({ label: 'Send-to-bank fee you charge', amount: fee });
    lines.push({ label: 'Monnify payout fee (incl. VAT)', amount: -cost });
    if (funding === 'bank') {
      const kept = bankFundingFee(face + fee, settings);
      lines.push({ label: 'Bank-funding fee you charge', amount: kept });
      lines.push({ label: 'Monnify collection fee (incl. VAT)', amount: -collectionCost(face + fee) });
    }
    return { service, amount: face, customerPays: face + fee, lines, profit: r2(lines.reduce((a, l) => a + l.amount, 0)) };
  }
  if (service === 'TRANSFER') {
    return { service, amount: face, customerPays: face, lines: [{ label: 'ZappiPay to ZappiPay transfers are free — no fee, no cost', amount: 0 }], profit: 0 };
  }
  if (service === 'AIRTIME_CASH') {
    const pct = Number(settings.airtimeToCashFeePercent || 0);
    const fee = r2((face * pct) / 100);
    return { service, amount: face, customerPays: face, lines: [{ label: `Airtime-to-Cash fee (${pct}%) — kept as airtime on your line`, amount: fee }], profit: fee };
  }
  const { computePrice, settingsForCustomer } = require('./pricing');
  const s = settingsForCustomer(settings, { isAgent: agent });
  const priced = computePrice(face, service, s);
  const commission = estimateCommission(service, provider, face);
  const cashbackPct = settings.cashbackEnabled ? Number(settings.cashbackPercentByService?.[service] || 0) : 0;
  const cashback = Math.min(r2((priced.chargeAmount * cashbackPct) / 100), Number(settings.cashbackMaxPerOrder || Infinity));
  const rate = rateFor(service, provider);
  lines.push({ label: `VTpass commission (${rate.flat ? `₦${rate.flat} per PIN` : `${rate.pct}%${rate.cap ? `, max ₦${rate.cap}` : ''}`})`, amount: commission });
  if (priced.markupPercent) lines.push({ label: `Your markup (${priced.markupPercent}%)`, amount: priced.markedUp - face });
  if (priced.discountAmount) lines.push({ label: `Discount you give (${priced.discountPercent}%${agent ? ' incl. agent' : ''})`, amount: -priced.discountAmount });
  if (cashback > 0) lines.push({ label: `Cashback (${cashbackPct}%)`, amount: -cashback });
  if (funding === 'bank') {
    lines.push({ label: 'Bank-funding fee you charge', amount: bankFundingFee(priced.chargeAmount, settings) });
    lines.push({ label: 'Monnify collection fee (incl. VAT)', amount: -collectionCost(priced.chargeAmount) });
  }
  return { service, provider: provider || null, amount: face, customerPays: priced.chargeAmount, lines: lines.map((l) => ({ ...l, amount: r2(l.amount) })), profit: r2(lines.reduce((a, l) => a + l.amount, 0)) };
}

module.exports = { VTPASS_RATES, rateFor, estimateCommission, commissionOf, collectionCost, payoutCost, earningsReport, estimateSale };
