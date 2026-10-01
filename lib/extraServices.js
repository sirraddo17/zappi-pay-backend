// International airtime/data (VTpass "foreign-airtime") and third-party
// motor insurance (VTpass "ui-insure", Universal Insurance). Both are
// paid through the normal purchase flow (lib/purchase.js): this module
// supplies the catalog for the app, the server-side price, and the extra
// fields VTpass needs on /pay. Prices are never taken from the app.

const { cachedCatalog } = require('./catalog');

const INTL = 'foreign-airtime';
const INSURE = 'ui-insure';

class ExtraServiceError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const list = (d) => (Array.isArray(d?.content) ? d.content : Array.isArray(d?.content?.countries) ? d.content.countries : []);
const num = (v) => Number(String(v ?? '').replace(/,/g, ''));

// --- International airtime / data -----------------------------------------------

async function countries() {
  const d = await cachedCatalog('/get-international-airtime-countries');
  return list(d).map((c) => ({ code: c.code, name: c.name, flag: c.flag, currency: c.currency, prefix: c.prefix })).filter((c) => c.code && c.code !== 'NG').sort((a, b) => a.name.localeCompare(b.name));
}

async function productTypes(code) {
  if (!/^[A-Z]{2}$/.test(String(code || ''))) throw new ExtraServiceError('Choose a country.');
  return list(await cachedCatalog('/get-international-airtime-product-types', { code })).map((p) => ({ id: String(p.product_type_id), name: p.name }));
}

async function operators(code, productTypeId) {
  if (!/^[A-Z]{2}$/.test(String(code || '')) || !/^\d+$/.test(String(productTypeId || ''))) throw new ExtraServiceError('Choose a country and type.');
  return list(await cachedCatalog('/get-international-airtime-operators', { code, product_type_id: productTypeId })).map((o) => ({ id: String(o.operator_id), name: o.name, image: o.operator_image }));
}

// A variation is either a fixed bundle (VTpass's naira price) or a range
// top-up the customer types in the local currency (naira = rate × amount).
function readVariation(v) {
  const fixed = String(v.fixedPrice || '').toLowerCase() === 'yes';
  const range = /([\d.,]+)\s*-\s*([\d.,]+)/.exec(String(v.name || ''));
  const rate = num(v.variation_rate ?? v.rate);
  const nairaFixed = num(v.charged_amount ?? v.variation_amount);
  const flexible = (!fixed || !(nairaFixed > 0)) && rate > 0;
  return {
    code: String(v.variation_code),
    name: String(v.name || '').trim(),
    fixed: !flexible,
    naira: !flexible && nairaFixed > 0 ? nairaFixed : null,
    rate: flexible ? rate : null,
    min: flexible && range ? num(range[1]) : null,
    max: flexible && range ? num(range[2]) : null,
    available: flexible ? rate > 0 : nairaFixed > 0,
  };
}

async function variations(operatorId, productTypeId) {
  if (!/^\d+$/.test(String(operatorId || '')) || !/^\d+$/.test(String(productTypeId || ''))) throw new ExtraServiceError('Choose a network.');
  const d = await cachedCatalog('/service-variations', { serviceID: INTL, operator_id: operatorId, product_type_id: productTypeId });
  const vs = d?.content?.variations || d?.content?.varations || [];
  return vs.map(readVariation).filter((v) => v.available);
}

// Server-side price for an international purchase.
async function intlQuote({ countryCode, productTypeId, operatorId, variationCode, localAmount }) {
  const v = (await variations(operatorId, productTypeId)).find((x) => x.code === String(variationCode));
  if (!v) throw new ExtraServiceError('That option is no longer available. Pick again.');
  if (!/^[A-Z]{2}$/.test(String(countryCode || ''))) throw new ExtraServiceError('Choose a country.');
  let baseAmount; let local = null;
  if (v.fixed) {
    baseAmount = v.naira;
  } else {
    local = num(localAmount);
    if (!(local > 0)) throw new ExtraServiceError('Enter the amount to send.');
    if (v.min && local < v.min) throw new ExtraServiceError(`The minimum is ${v.min}.`);
    if (v.max && local > v.max) throw new ExtraServiceError(`The maximum is ${v.max}.`);
    baseAmount = Math.ceil(v.rate * local * 100) / 100;
  }
  if (!(baseAmount > 0)) throw new ExtraServiceError('This option has no price right now. Try another.');
  return { baseAmount, variation: v, payExtras: { operator_id: String(operatorId), country_code: String(countryCode), product_type_id: String(productTypeId), ...(local ? { amount: local } : {}) } };
}

// --- Third-party motor insurance -----------------------------------------------------

const OPTION_PATHS = {
  color: '/universal-insurance/options/color',
  'engine-capacity': '/universal-insurance/options/engine-capacity',
  state: '/universal-insurance/options/state',
  lga: '/universal-insurance/options/lga/',
  brand: '/universal-insurance/options/brand',
  model: '/universal-insurance/options/model/',
};
const OPTION_KEYS = {
  color: ['ColourCode', 'ColourName'],
  'engine-capacity': ['CapacityCode', 'CapacityName'],
  state: ['StateCode', 'StateName'],
  lga: ['LGACode', 'LGAName'],
  brand: ['VehicleMakeCode', 'VehicleMakeName'],
  model: ['VehicleModelCode', 'VehicleModelName'],
};

async function insuranceOptions(kind, parent) {
  if (!OPTION_PATHS[kind]) throw new ExtraServiceError('Unknown list.');
  const needsParent = kind === 'lga' || kind === 'model';
  if (needsParent && !/^[A-Za-z0-9-]{1,20}$/.test(String(parent || ''))) throw new ExtraServiceError('Choose the state / make first.');
  const d = await cachedCatalog(OPTION_PATHS[kind] + (needsParent ? encodeURIComponent(parent) : ''));
  const [k, n] = OPTION_KEYS[kind];
  return list(d).map((o) => ({ code: String(o[k] ?? ''), name: String(o[n] ?? '').trim() })).filter((o) => o.code && o.name);
}

async function insurancePlans() {
  const d = await cachedCatalog('/service-variations', { serviceID: INSURE });
  return (d?.content?.variations || d?.content?.varations || []).map((v) => ({ code: String(v.variation_code), name: v.name, amount: num(v.variation_amount) }));
}

const clean = (v, max = 60) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
function insuranceExtras(input = {}, customer) {
  const plate = clean(input.plateNumber, 15).toUpperCase().replace(/[^A-Z0-9-]/g, '');
  const f = {
    Insured_Name: clean(input.insuredName, 80),
    engine_capacity: clean(input.engineCapacity, 10),
    Chasis_Number: clean(input.chassisNumber, 30).toUpperCase(),
    Plate_Number: plate,
    vehicle_make: clean(input.vehicleMake, 10),
    vehicle_color: clean(input.vehicleColor, 10),
    vehicle_model: clean(input.vehicleModel, 10),
    YearofMake: clean(input.yearOfMake, 4),
    state: clean(input.state, 10),
    lga: clean(input.lga, 10),
    email: clean(input.email || customer?.email || '', 80),
  };
  if (f.Insured_Name.length < 3) throw new ExtraServiceError('Enter the owner’s full name (as on the vehicle papers).');
  if (!/^[A-Z0-9-]{5,12}$/.test(plate)) throw new ExtraServiceError('Enter a valid plate number, e.g. ABC123XY.');
  if (f.Chasis_Number.length < 6) throw new ExtraServiceError('Enter the chassis number (VIN).');
  const year = Number(f.YearofMake);
  if (!(year >= 1960 && year <= new Date().getFullYear() + 1)) throw new ExtraServiceError('Enter the year of make.');
  for (const [k, label] of [['engine_capacity', 'engine capacity'], ['vehicle_make', 'vehicle make'], ['vehicle_model', 'vehicle model'], ['vehicle_color', 'colour'], ['state', 'state'], ['lga', 'local government']]) {
    if (!f[k]) throw new ExtraServiceError(`Choose the ${label}.`);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) throw new ExtraServiceError('Enter an email address — the certificate is sent there.');
  return f;
}

// The certificate link from VTpass's reply (wherever it sits).
function certUrlOf(payload) {
  const seen = new Set();
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 5 || seen.has(o)) return null;
    seen.add(o);
    for (const [k, v] of Object.entries(o)) {
      if (/^cert(ificate)?_?url$/i.test(k) && typeof v === 'string' && /^https:\/\//.test(v)) return v;
      const r = walk(v, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return walk(payload);
}

module.exports = { INTL, INSURE, ExtraServiceError, countries, productTypes, operators, variations, intlQuote, readVariation, insuranceOptions, insurancePlans, insuranceExtras, certUrlOf };
