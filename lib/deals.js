const prisma = require('./prisma');
const { getSettings } = require('./vtpass');
const { cachedCatalog } = require('./catalog');
const { computePrice, settingsForCustomer } = require('./pricing');
const { planDays } = require('./reminders');

// Data deal finder: "I have ₦1,500 — what's the most data I can get?"
// Looks across every network's plans at the customer's own price.

const NETWORKS = [
  { key: 'MTN', match: /^mtn/i },
  { key: 'Airtel', match: /^airtel/i },
  { key: 'Glo', match: /^glo/i },
  { key: '9mobile', match: /^(etisalat|9mobile)/i },
];

// Nigerian number prefixes (numbers can be ported, so it's a hint).
const PREFIXES = {
  MTN: ['0803', '0806', '0810', '0813', '0814', '0816', '0703', '0706', '0903', '0906', '0913', '0916', '0704', '07025', '07026'],
  Airtel: ['0802', '0808', '0812', '0701', '0708', '0902', '0907', '0901', '0904', '0912', '0911'],
  Glo: ['0805', '0807', '0811', '0815', '0705', '0905', '0915'],
  '9mobile': ['0809', '0817', '0818', '0908', '0909'],
};

function networkForPhone(phone) {
  let p = String(phone || '').replace(/\D/g, '');
  if (p.startsWith('234')) p = `0${p.slice(3)}`;
  if (p.length < 4) return null;
  let best = null;
  for (const [net, list] of Object.entries(PREFIXES)) {
    for (const pre of list) if (p.startsWith(pre) && (!best || pre.length > best.len)) best = { net, len: pre.length };
  }
  return best?.net || null;
}

// "MTN N1000 1.5GB - 30 days" → 1536 (MB). Unlimited / unknown → null.
function sizeMb(name) {
  const s = String(name || '');
  if (/unlimited/i.test(s)) return null;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(TB|GB|MB)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toUpperCase();
  return Math.round(unit === 'TB' ? n * 1024 * 1024 : unit === 'GB' ? n * 1024 : n);
}

const VALIDITY = { DAY: [1, 2], WEEK: [3, 14], MONTH: [15, 45], LONG: [46, 100000] };

async function allPlans(settings) {
  const svc = await cachedCatalog('/services', { identifier: 'data' });
  const services = (Array.isArray(svc?.content) ? svc.content : [])
    .map((x) => ({ serviceID: x.serviceID, name: x.name, net: NETWORKS.find((n) => n.match.test(x.serviceID))?.key }))
    .filter((x) => x.net);
  const lists = await Promise.all(services.map(async (x) => {
    try {
      const d = await cachedCatalog('/service-variations', { serviceID: x.serviceID });
      const vars = d?.content?.varations || d?.content?.variations || [];
      return vars.map((v) => {
        const base = Number(v.variation_amount);
        const mb = sizeMb(v.name);
        if (!(base > 0) || !mb) return null;
        const price = computePrice(base, 'DATA', settings).chargeAmount;
        return { network: x.net, serviceID: x.serviceID, serviceName: x.name, variationCode: v.variation_code, name: String(v.name).replace(/\s+/g, ' ').trim(), mb, days: planDays(v.name), price, perGb: Math.round((price / mb) * 1024) };
      }).filter(Boolean);
    } catch {
      return [];
    }
  }));
  return lists.flat();
}

// Best plans for a budget. sort: 'MOST' (most data) or 'VALUE' (cheapest per GB).
async function find(customerId, { budget, network, phone, validity, sort = 'MOST' } = {}) {
  const b = Math.floor(Number(budget));
  if (!(b >= 50 && b <= 1000000)) throw Object.assign(new Error('Enter a budget between ₦50 and ₦1,000,000.'), { status: 400 });
  const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { isAgent: true } });
  const settings = settingsForCustomer(await getSettings(), customer);
  const guessed = phone ? networkForPhone(phone) : null;
  const net = network === 'ALL' ? null : network || guessed;
  let plans = (await allPlans(settings)).filter((p) => p.price <= b);
  if (net) plans = plans.filter((p) => p.network === net);
  if (validity && VALIDITY[validity]) {
    const [lo, hi] = VALIDITY[validity];
    plans = plans.filter((p) => p.days && p.days >= lo && p.days <= hi);
  }
  plans.sort(sort === 'VALUE' ? (x, y) => x.perGb - y.perGb || y.mb - x.mb : (x, y) => y.mb - x.mb || x.price - y.price);
  // One row per network+plan name (some networks list the same plan twice).
  const seen = new Set();
  const out = [];
  for (const p of plans) {
    const k = `${p.network}|${p.mb}|${p.days}|${p.price}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
    if (out.length >= 12) break;
  }
  const cheapestPerGb = out.length ? Math.min(...out.map((p) => p.perGb)) : null;
  return {
    budget: b,
    network: net || null,
    guessedNetwork: guessed,
    plans: out.map((p) => ({ ...p, bestValue: p.perGb === cheapestPerGb })),
  };
}

module.exports = { find, sizeMb, networkForPhone, allPlans, NETWORKS: NETWORKS.map((n) => n.key) };
