// "Safe pricing" preset: discounts, agent commission, markups and the
// rewards split set from VTpass's commission minus Monnify's funding fee
// (1.5% + VAT ≈ 1.61%), so no normal sale loses money.
//
// Discounts are per service (not per network), so the lowest-paying
// network decides: MTN pays 3% → about 1.39% left after Monnify, so
// customer + agent discount on airtime/data must stay well under that.
//
// Applying it only makes things safer: customer discounts are lowered to
// the ceiling (never raised), markups are raised to the floor (never
// lowered), agent commission is set to the recommended value.

const { computePrice, settingsForCustomer } = require('./pricing');
const { estimateCommission, collectionCost, bankFundingFee } = require('./earnings');

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

const PRESET = {
  // Max customer discount % per service.
  discountMax: { AIRTIME: 0, DATA: 0, INTERNET: 0.5, ELECTRICITY: 0, CABLE: 0, EDUCATION: 0, BETTING: 0, INTERNATIONAL: 0, INSURANCE: 0 },
  // Extra agent discount % (on top of the customer discount).
  agent: { AIRTIME: 0.75, DATA: 0.75, INTERNET: 1.5, ELECTRICITY: 0, CABLE: 0, EDUCATION: 0, BETTING: 0, INTERNATIONAL: 0, INSURANCE: 0 },
  // Min markup % and its ₦ cap — covers Monnify's fee where VTpass pays too little.
  markupMin: { ELECTRICITY: 1, CABLE: 1 },
  markupCap: { ELECTRICITY: 350, CABLE: 150 },
  rewardSplitPct: 30,
};

const WHY = {
  AIRTIME: 'MTN pays 3% → ~1.39% left after Monnify. No customer discount (cashback & points come from the rewards split); agents get 0.75%.',
  DATA: 'Same as airtime: MTN data pays 3%.',
  INTERNET: 'Smile pays 5% → ~3.39% left. 0.5% customer discount, agents +1.5%.',
  ELECTRICITY: 'Discos pay only 0.9–1.7% — less than Monnify takes. A 1% service charge (max ₦350) keeps normal sales in profit.',
  CABLE: 'DStv/GOtv pay 1.5% — about what Monnify takes. A 1% service charge (max ₦150) keeps it in profit.',
  EDUCATION: 'VTpass pays a fixed ₦150–₦250 per PIN — fine without a discount.',
};

// Typical sales to check, with the lowest-paying provider for each.
const SAMPLES = [
  { service: 'AIRTIME', provider: 'mtn', label: 'MTN airtime', amounts: [500, 5000] },
  { service: 'AIRTIME', provider: 'glo', label: 'Glo airtime', amounts: [1000] },
  { service: 'DATA', provider: 'mtn-data', label: 'MTN data', amounts: [1000, 10000] },
  { service: 'INTERNET', provider: 'smile-direct', label: 'Smile', amounts: [5000] },
  { service: 'CABLE', provider: 'gotv', label: 'GOtv', amounts: [5000] },
  { service: 'CABLE', provider: 'dstv', label: 'DStv', amounts: [20000] },
  { service: 'ELECTRICITY', provider: 'jos-electric', label: 'Jos light (0.9%)', amounts: [5000] },
  { service: 'ELECTRICITY', provider: 'ikeja-electric', label: 'Ikeja light', amounts: [10000, 50000] },
  { service: 'EDUCATION', provider: 'waec', label: 'WAEC PIN', amounts: [3900] },
];

// What you keep on one sale, after discount and Monnify (before rewards —
// the rewards split only shares what is left, so it can't push it below 0).
function saleProfit(settings, { service, provider, amount, agent }) {
  const s = settingsForCustomer(settings, { isAgent: agent });
  const p = computePrice(amount, service, s);
  const commission = estimateCommission(service, provider, amount);
  const funding = Math.max(0, collectionCost(p.chargeAmount) - bankFundingFee(p.chargeAmount, settings));
  return r2(p.chargeAmount - amount + commission - funding);
}

function check(settings) {
  const agentsOn = Boolean(settings.agentPricingEnabled);
  const rows = [];
  for (const x of SAMPLES) {
    for (const amount of x.amounts) {
      const customer = saleProfit(settings, { ...x, amount, agent: false });
      const agent = agentsOn ? saleProfit({ ...settings }, { ...x, amount, agent: true }) : null;
      rows.push({ label: x.label, service: x.service, amount, customer, agent, loss: customer < 0 || (agent !== null && agent < 0) });
    }
  }
  return { rows, losses: rows.filter((r) => r.loss).length };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// The settings the preset would write, from the current ones.
function proposed(settings) {
  const discount = { ...(settings.discountPercentByService || {}) };
  for (const [svc, max] of Object.entries(PRESET.discountMax)) discount[svc] = Math.min(num(discount[svc]), max);
  const markup = { ...(settings.markupPercentByService || {}) };
  const caps = { ...(settings.markupCapByService || {}) };
  for (const [svc, min] of Object.entries(PRESET.markupMin)) {
    if (num(markup[svc]) < min) {
      markup[svc] = min;
      caps[svc] = PRESET.markupCap[svc];
    } else if (num(caps[svc]) > 0 && num(caps[svc]) < PRESET.markupCap[svc]) {
      caps[svc] = PRESET.markupCap[svc]; // a lower cap than this can't cover Monnify's fee
    }
  }
  return {
    discountPercentByService: discount,
    agentDiscountPercentByService: { ...(settings.agentDiscountPercentByService || {}), ...PRESET.agent },
    markupPercentByService: markup,
    markupCapByService: caps,
    rewardGuardEnabled: true,
    rewardSplitEnabled: true,
    rewardSplitPct: Math.min(num(settings.rewardSplitPct ?? 30) || 30, PRESET.rewardSplitPct),
  };
}

function changes(settings, next) {
  const list = [];
  const svcLine = (title, before, after, unit = '%') => {
    for (const svc of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
      const a = num(before?.[svc]);
      const b = num(after?.[svc]);
      if (a !== b) list.push(`${title} ${svc.toLowerCase()}: ${unit === '₦' ? `₦${a} → ₦${b}` : `${a}% → ${b}%`}`);
    }
  };
  svcLine('Customer discount', settings.discountPercentByService, next.discountPercentByService);
  svcLine('Agent commission', settings.agentDiscountPercentByService, next.agentDiscountPercentByService);
  svcLine('Service charge (markup)', settings.markupPercentByService, next.markupPercentByService);
  svcLine('Service charge max', settings.markupCapByService, next.markupCapByService, '₦');
  if (!settings.rewardSplitEnabled) list.push(`Rewards split: off → on (give back ${next.rewardSplitPct}% of real profit)`);
  else if (num(settings.rewardSplitPct) !== next.rewardSplitPct) list.push(`Rewards split: ${num(settings.rewardSplitPct)}% → ${next.rewardSplitPct}%`);
  if (settings.rewardGuardEnabled === false) list.push('Reward safety limit: off → on');
  return list;
}

function preview(settings) {
  const next = proposed(settings);
  const after = { ...settings, ...next };
  return {
    why: WHY,
    changes: changes(settings, next),
    now: check(settings),
    after: check({ ...after, agentPricingEnabled: settings.agentPricingEnabled }),
    note: 'Light above ~₦55,000 in one go can still lose a little (VTpass caps Ikeja/Abuja commission and the service charge is capped). Agent figures are shown only when agent pricing is on.',
  };
}

module.exports = { PRESET, proposed, preview, check, saleProfit };
