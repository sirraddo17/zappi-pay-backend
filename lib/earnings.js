const prisma = require('./prisma');

// What ZAPPI PAY really earns, line by line:
//   + price the customer paid − face value (your markup, after discounts/promos)
//   + VTpass commission (VTpass charges us less than face value)
//   + fees you charge (bank-funding fee, send-to-bank fee, airtime-to-cash fee)
//   − Monnify's cut on bank funding and on send-to-bank payouts
//   − rewards paid (cashback, referral bonus, welcome bonus, daily rewards,
//     loyalty, contest prizes, coupons) — from the wallet or the cashback balance
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
const SERVICE_FALLBACK = { AIRTIME: PCT(3), DATA: PCT(3), ELECTRICITY: PCT(1), CABLE: PCT(1.5), INTERNET: PCT(0), EDUCATION: PCT(0), BETTING: PCT(0), INTERNATIONAL: PCT(0), INSURANCE: PCT(0), OTHER: PCT(0) };

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
// Monnify published pricing (VAT exclusive). Override in the server settings (.env) if your
// negotiated rates differ: MONNIFY_COLLECTION_PERCENT, MONNIFY_COLLECTION_CAP,
// MONNIFY_PAYOUT_FEES (e.g. "10,20,40"), VAT_PERCENT.
const COLLECTION_PERCENT = num(process.env.MONNIFY_COLLECTION_PERCENT, 1.5);
const COLLECTION_CAP = num(process.env.MONNIFY_COLLECTION_CAP, 2000);
const PAYOUT_FEES = String(process.env.MONNIFY_PAYOUT_FEES || '10,20,40').split(',').map((x) => Number(x) || 0);
const VAT = num(process.env.VAT_PERCENT, 7.5) / 100;
const r2 = (n) => Math.round(n * 100) / 100;
const naira = (n) => `₦${Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

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
// VTpass's reported commission is trusted only when it is sensible: no
// real commission is ever more than 20% of the face value. (The sandbox
// once reported ₦12,000+ commission on a ₦3,000 insurance policy, which
// then paid out as huge cashback.)
const MAX_COMMISSION_SHARE = 0.2;
function commissionOf(order) {
  const t = order.responsePayload?.content?.transactions;
  const exact = Number(t?.commission);
  const face = Number(order.costAmount ?? order.amount);
  const estimate = () => ({ amount: estimateCommission(order.service, order.provider, face), exact: false });
  if (!(Number.isFinite(exact) && exact >= 0 && t?.commission !== null && t?.commission !== undefined)) return estimate();
  if (face > 0 && exact > face * MAX_COMMISSION_SHARE) {
    console.warn(`Ignoring odd VTpass commission ₦${exact} on a ₦${face} ${order.service} order (${order.vtpassRequestId || order.id})`);
    return estimate();
  }
  return { amount: exact, exact: true };
}

function collectionCost(amountPaid) {
  const fee = Math.min((Number(amountPaid) * COLLECTION_PERCENT) / 100, COLLECTION_CAP);
  return r2(fee * (1 + VAT));
}

// Nomba Transfer API: ₦50 flat per payout (confirmed by Nomba).
const NOMBA_PAYOUT_FEE = num(process.env.NOMBA_PAYOUT_FEE, 50);
function payoutCost(amount, provider = 'monnify') {
  if (provider === 'nomba') return r2(NOMBA_PAYOUT_FEE * (1 + VAT));
  const a = Number(amount);
  const fee = a >= 50000 ? PAYOUT_FEES[2] : a >= 10000 ? PAYOUT_FEES[1] : PAYOUT_FEES[0];
  return r2(fee * (1 + VAT));
}

// Fee we kept from a Monnify bank-funding credit, read from its note
// ("Bank transfer of ₦5,000 (₦50 fee)").
function fundingFeeFromNote(note) {
  const m = /\(₦([\d,.]+) [a-z ]*fee\)/i.exec(String(note || ''));
  return m ? Number(m[1].replace(/,/g, '')) : 0;
}

function bankFundingFee(amountPaid, settings) {
  const pct = Number(settings.bankFundingFeePercent || 0);
  const cap = Number(settings.bankFundingFeeCap || 0);
  let fee = (Number(amountPaid) * pct) / 100;
  if (cap > 0) fee = Math.min(fee, cap);
  return Math.round(fee * 100) / 100;
}

// Which reward a positive cashback-balance entry was (null = not a
// reward, e.g. cashback handed back after a failed purchase).
function cashbackEntryType(note) {
  const n = String(note || '');
  if (/^returned:/i.test(n)) return null;
  if (/daily quiz|streak reward/i.test(n)) return 'DAILY_REWARD';
  if (/welcome bonus/i.test(n)) return 'WELCOME_BONUS';
  return 'CASHBACK';
}

// Full earnings for a date range, with a per-day series when `days` (a
// list of YYYY-MM-DD Lagos dates) and `dayOf(date)` are given.
async function earningsReport(range, { dayOf, days } = {}) {
  const where = { createdAt: range };
  const [orders, transfers, fundings, rewards, a2c, cbEntries, circleRounds] = await Promise.all([
    prisma.order.findMany({ where: { ...where, status: 'SUCCESS' }, select: { service: true, provider: true, amount: true, costAmount: true, cashbackAmount: true, responsePayload: true, createdAt: true } }),
    prisma.bankTransfer.findMany({ where: { ...where, status: 'SUCCESS' }, select: { amount: true, fee: true, provider: true, createdAt: true } }),
    prisma.walletTransaction.findMany({ where: { ...where, type: 'FUND', status: 'APPROVED', providerRef: { not: null } }, select: { amount: true, note: true, providerRef: true, createdAt: true } }),
    prisma.walletTransaction.findMany({ where: { ...where, status: 'APPROVED', type: { in: ['CASHBACK', 'REFERRAL_BONUS', 'LOYALTY', 'CONTEST_PRIZE', 'COUPON', 'CHALLENGE_REWARD', 'DELIVERY_BONUS', 'SHOP_COMMISSION'] } }, select: { type: true, amount: true, createdAt: true } }),
    prisma.airtimeCashRequest.findMany({ where: { ...where, status: 'APPROVED' }, select: { amount: true, receivedAmount: true, payoutAmount: true, createdAt: true } }).catch(() => []),
    // With "cashback in a separate balance" on, rewards go to the
    // cashback balance (CashbackEntry), not the wallet — count those too.
    prisma.cashbackEntry.findMany({ where: { ...where, amount: { gt: 0 } }, select: { amount: true, note: true, createdAt: true } }).catch(() => []),
    // ZAPPI PAY's share of Ajo Circle payouts (service fee).
    prisma.circleRound.findMany({ where: { feeTaken: true, paidAt: range, feeApp: { gt: 0 } }, select: { feeApp: true, paidAt: true } }).catch(() => []),
  ]);
  for (const e of cbEntries) {
    const type = cashbackEntryType(e.note);
    if (type) rewards.push({ type, amount: e.amount, createdAt: e.createdAt });
  }

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
    const cost = payoutCost(t.amount, t.provider);
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
    const ref = String(f.providerRef || '');
    const cost = partnerCollectionCost(ref.startsWith('SQ-') ? 'squad' : ref.startsWith('NB-') ? 'nomba' : 'monnify', gross);
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

  let circleFees = 0;
  for (const c of circleRounds) {
    circleFees += Number(c.feeApp);
    addDay(c.paidAt, Number(c.feeApp));
  }

  const income = { circleServiceFees: r2(circleFees), purchaseMarkup: r2(margin), vtpassCommission: r2(commission), sendToBankFees: r2(transferFees), bankFundingFees: r2(fundingFees), airtimeToCashFees: r2(a2cFees) };
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

// Deposit fee a partner charges us on a bank-transfer inflow (incl. VAT).
function partnerCollectionCost(partner, amountPaid) {
  if (partner === 'squad' || partner === 'nomba') return require('./fundingFees').partnerCost(partner, amountPaid);
  return collectionCost(amountPaid);
}
const PARTNER_LABEL = { monnify: 'Monnify', squad: 'Squad (GTBank)', nomba: 'Nomba' };

// "If a customer spends ₦X on this service, what do I keep?"
// funding: 'wallet' (money already in their wallet / manual funding), or the
// partner they just sent exactly this amount through: 'monnify' ('bank' =
// monnify), 'squad' or 'nomba'. coverFee: you pay the deposit fee (the
// customer is charged nothing); otherwise your funding-fee settings apply.
// allRewards: also count referral bonuses and active challenges, spread
// over the spending they need (opts.challenges = active challenges).
function estimateSale({ service, provider, amount, funding = 'wallet', agent = false, coverFee = false, allRewards = false, challenges = [] }, settings) {
  const face = Number(amount);
  if (!(face > 0)) throw new Error('Enter an amount.');
  const lines = [];
  const partner = funding === 'bank' ? 'monnify' : ['monnify', 'squad', 'nomba'].includes(funding) ? funding : null;
  const fundingLines = (paid) => {
    if (!partner) return;
    const { computeFee } = require('./fundingFees');
    const fee = coverFee ? 0 : computeFee(paid, settings, partner);
    if (fee > 0) lines.push({ label: `Funding fee the customer pays (${PARTNER_LABEL[partner]})`, amount: fee });
    lines.push({ label: `${PARTNER_LABEL[partner]} deposit fee${coverFee ? ' — you cover it' : ''} (incl. VAT)`, amount: -partnerCollectionCost(partner, paid + fee) });
  };
  if (service === 'SEND_TO_BANK') {
    const d = require('./disbursement');
    const fee = d.feeForAmount(face, d.feeTiers(settings));
    const via = settings && settings.payoutProvider === 'nomba' ? 'nomba' : 'monnify'; // Squad's payout fee isn't known yet → Monnify's
    const cost = payoutCost(face, via);
    lines.push({ label: 'Send-to-bank fee you charge', amount: fee });
    lines.push({ label: `${PARTNER_LABEL[via]} payout fee (incl. VAT)`, amount: -cost });
    fundingLines(face + fee);
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
  let cashback = Math.min(r2((priced.chargeAmount * cashbackPct) / 100), Number(settings.cashbackMaxPerOrder || Infinity));
  let loyalty = settings.loyaltyEnabled ? Math.floor((priced.chargeAmount / 100) * Number(settings.loyaltyPointsPer100 || 0)) * Number(settings.loyaltyPointValue || 0) : 0;
  // Same safety limit the purchase applies (lib/rewardGuard.js).
  const guard = require('./rewardGuard');
  // When you cover the deposit fee, the safety limit sees no customer fee either.
  const guardSettings = coverFee ? { ...settings, bankFundingFeePercent: 0, bankFundingFeeCap: 0, squadFundingFeePercent: 0, squadFundingFeeCap: 0, nombaFundingFeePercent: 0, nombaFundingFeeCap: 0 } : settings;
  const left = guard.room({ service, provider, face, markedUp: priced.markedUp, commission, alreadyGiven: priced.discountAmount }, guardSettings);
  let guardNote = null;
  if (left !== null) {
    const cb = Math.min(cashback, left);
    const lo = Math.min(loyalty, Math.max(0, left - cb));
    if (cb < cashback || lo < loyalty) guardNote = `Safety limit trimmed rewards to ${guard.percent(settings)}% of your real earnings (after the deposit fee)`;
    cashback = r2(cb);
    loyalty = r2(lo);
    if (left === 0 && priced.discountAmount > 0) guardNote = `Your discount alone already uses the ${settings.rewardGuardPercent ?? 50}% safety limit — promo codes, cashback and points get nothing here`;
  }
  const rate = rateFor(service, provider);
  lines.push({ label: `VTpass commission (${rate.flat ? `₦${rate.flat} per PIN` : `${rate.pct}%${rate.cap ? `, max ₦${rate.cap}` : ''}`})`, amount: commission });
  if (priced.markupPercent) lines.push({ label: `Your markup (${priced.markupPercent}%${priced.markupCap ? `, max ₦${priced.markupCap}` : ''})`, amount: priced.markedUp - face });
  if (priced.discountAmount) lines.push({ label: `Discount you give (${priced.discountPercent}%${agent ? ' incl. agent' : ''})`, amount: -priced.discountAmount });
  if (cashback > 0) lines.push({ label: `Cashback (${cashbackPct}%)`, amount: -cashback });
  if (loyalty > 0) lines.push({ label: 'Loyalty points (value)', amount: -loyalty });
  if (guardNote) lines.push({ label: guardNote, amount: 0 });
  fundingLines(priced.chargeAmount);

  if (allRewards) {
    if (settings.rewardSplitEnabled) {
      // Split on: cashback, points, referral, challenges etc. all come out
      // of one budget — counted in full (unused shares wait in pools).
      const cbLo = lines.filter((l) => /^Cashback|^Loyalty points/.test(l.label));
      cbLo.forEach((l) => { l.label += ' (paid from the rewards split below)'; l.amount = 0; });
      const pct = Number(settings.rewardSplitPct ?? 30);
      const before = lines.reduce((a, l) => a + l.amount, 0);
      if (before > 0) lines.push({ label: `Rewards split (${pct}% of what you earn — pays cashback, points, referral bonuses, challenges, delivery bonus)`, amount: -r2((before * pct) / 100) });
    } else {
      if (settings.referralEnabled) {
        const need = Math.max(Number(settings.referralMinPurchase || 0), Number(settings.referralSpendTarget || 0), 1);
        const bonus = Number(settings.referralBonusAmount || 0) + Number(settings.referralWelcomeBonus || 0);
        if (bonus > 0) lines.push({ label: `Referral bonus share if this customer was invited (${naira(bonus)} over ${naira(need)} of spending)`, amount: -r2(bonus * Math.min(1, face / need)) });
      }
      let ch = 0;
      for (const c of challenges || []) {
        if (c.service && c.service !== service) continue;
        let perBuy;
        let buys;
        if (c.kind === 'SPEND') { perBuy = Number(c.target); buys = 1; } else { perBuy = Math.max(Number(c.minAmount || 0), c.kind === 'STREAK' ? 100 : 500); buys = Number(c.target) || 1; }
        ch += Number(c.reward) * Math.min(1, face / Math.max(1, perBuy * buys));
      }
      if (ch > 0) lines.push({ label: 'Challenge rewards if completed (spread over the spending they need)', amount: -r2(ch) });
    }
  }
  return { service, provider: provider || null, amount: face, customerPays: priced.chargeAmount, lines: lines.map((l) => ({ ...l, amount: r2(l.amount) })), profit: r2(lines.reduce((a, l) => a + l.amount, 0)) };
}

// True when the bank-funding fee the admin set is no more than what
// Monnify charges us (1.5% + VAT, capped) — then the app can honestly
// tell customers the fee goes to the payment partner, not to us.
function fundingFeeIsPassThrough(settings) {
  const pct = Number(settings.bankFundingFeePercent || 0);
  const cap = Number(settings.bankFundingFeeCap || 0);
  if (!(pct > 0)) return false;
  const providerPct = COLLECTION_PERCENT * (1 + VAT);
  const providerCap = COLLECTION_CAP * (1 + VAT);
  return pct <= providerPct + 0.02 && cap > 0 && cap <= providerCap + 1;
}

module.exports = { partnerCollectionCost, cashbackEntryType, bankFundingFee, fundingFeeIsPassThrough, VTPASS_RATES, rateFor, estimateCommission, commissionOf, collectionCost, payoutCost, earningsReport, estimateSale };
