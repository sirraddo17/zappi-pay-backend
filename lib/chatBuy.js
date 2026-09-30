const prisma = require('./prisma');
const { vtpassRequest } = require('./vtpass');
const { cachedCatalog } = require('./catalog');
const { computePrice, settingsForCustomer } = require('./pricing');
const deals = require('./deals');

// "Buy by chat": tools that let the help assistant PREPARE a purchase.
// The assistant never buys anything. prepare_purchase checks every
// detail on the server and hands back a confirmation card; the customer
// taps Pay and enters their PIN, which goes through the normal purchase
// route like any other purchase.

const NETWORK_ALIASES = { mtn: 'mtn', airtel: 'airtel', glo: 'glo', globacom: 'glo', '9mobile': 'etisalat', etisalat: 'etisalat', '9 mobile': 'etisalat' };
const NETWORK_NAME = { mtn: 'MTN', airtel: 'Airtel', glo: 'Glo', etisalat: '9mobile' };
const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG')}`;

const TOOLS = [
  {
    name: 'get_my_saved_numbers',
    description: "The customer's saved phone numbers, meters and smartcards (with nicknames like \"Mum\"), to fill in who a purchase is for.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'find_data_plans',
    description: "Data plans at this customer's price, for a network and/or budget. Returns plan codes to use in prepare_purchase.",
    input_schema: {
      type: 'object',
      properties: {
        network: { type: 'string', enum: ['MTN', 'Airtel', 'Glo', '9mobile'] },
        budget: { type: 'integer', description: 'Most the customer wants to spend, in naira. Default 5000.' },
        phone: { type: 'string', description: 'Number the data is for (used to guess the network).' },
        validity: { type: 'string', enum: ['DAY', 'WEEK', 'MONTH', 'LONG'] },
      },
    },
  },
  {
    name: 'prepare_purchase',
    description: 'Prepare an airtime, data or electricity purchase for the customer to confirm with their PIN. Does NOT buy anything. Call it only when you know the service, network/company, number and amount (or data plan code).',
    input_schema: {
      type: 'object',
      properties: {
        service: { type: 'string', enum: ['AIRTIME', 'DATA', 'ELECTRICITY'] },
        network: { type: 'string', description: 'Airtime/data: MTN, Airtel, Glo or 9mobile.' },
        recipient: { type: 'string', description: 'Phone number (airtime/data) or meter number (electricity).' },
        amount: { type: 'integer', description: 'Airtime or electricity amount in naira.' },
        planCode: { type: 'string', description: 'Data plan code from find_data_plans.' },
        disco: { type: 'string', description: 'Electricity company, e.g. Ikeja, Eko, Abuja, Ibadan.' },
        meterType: { type: 'string', enum: ['prepaid', 'postpaid'] },
      },
      required: ['service', 'recipient'],
    },
  },
];

function cleanPhone(p) {
  let s = String(p || '').replace(/\D/g, '');
  if (s.startsWith('234') && s.length === 13) s = `0${s.slice(3)}`;
  return /^0[789][01]\d{8}$/.test(s) ? s : null;
}

function networkKey(n, phone) {
  const k = NETWORK_ALIASES[String(n || '').trim().toLowerCase()];
  if (k) return k;
  const guess = deals.networkForPhone(phone);
  return guess ? NETWORK_ALIASES[guess.toLowerCase()] : null;
}

async function catalog(identifier) {
  const d = await cachedCatalog('/services', { identifier });
  return Array.isArray(d?.content) ? d.content : [];
}

function handlers(customerId, rawSettings, collector) {
  const priced = async (face, service) => {
    const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { isAgent: true, walletBalance: true } });
    const settings = settingsForCustomer(rawSettings, customer);
    return { total: computePrice(face, service, settings).chargeAmount, balance: Number(customer?.walletBalance || 0) };
  };
  const done = (draft, extra) => {
    collector.purchase = draft;
    return {
      ok: true,
      shownToCustomer: `A confirmation card is now showing: ${draft.summary}. Total ${naira(draft.total)}.`,
      walletEnough: draft.balance >= draft.total,
      next: 'Tell the customer to check the card and tap Pay to confirm with their PIN. Do not say it has been bought.',
      ...extra,
    };
  };

  return {
    async get_my_saved_numbers() {
      const list = await prisma.beneficiary.findMany({ where: { customerId }, orderBy: { lastUsedAt: 'desc' }, take: 15 });
      const me = await prisma.customer.findUnique({ where: { id: customerId }, select: { phone: true } });
      return { myOwnPhone: me?.phone || null, saved: list.map((b) => ({ service: b.service, provider: b.serviceID, number: b.billersCode, nickname: b.nickname, meterType: b.meterType })) };
    },

    async find_data_plans({ network, budget, phone, validity }) {
      try {
        const r = await deals.find(customerId, { budget: budget || 5000, network: network || undefined, phone, validity });
        return r.plans.slice(0, 8).map((p) => ({ planCode: p.variationCode, network: p.network, name: p.name, price: naira(p.price), days: p.days }));
      } catch (e) {
        return { error: e.message };
      }
    },

    async prepare_purchase({ service, network, recipient, amount, planCode, disco, meterType }) {
      collector.purchase = null;
      if (service === 'AIRTIME' || service === 'DATA') {
        const phone = cleanPhone(recipient);
        if (!phone) return { error: 'That is not a valid Nigerian phone number. Ask for the 11-digit number.' };
        const net = networkKey(network, phone);
        if (!net) return { error: 'Which network is it: MTN, Airtel, Glo or 9mobile?' };
        if (service === 'AIRTIME') {
          const a = parseInt(amount, 10);
          const min = Math.max(50, Number(rawSettings.minPurchaseAmount || 50));
          if (!(a >= min && a <= 50000)) return { error: `Airtime must be between ${naira(min)} and ₦50,000.` };
          const p = await priced(a, 'AIRTIME');
          return done({ service: 'AIRTIME', serviceID: net, billersCode: phone, phone, amount: a, total: p.total, balance: p.balance, summary: `${naira(a)} ${NETWORK_NAME[net]} airtime for ${phone}` });
        }
        const serviceID = `${net}-data`;
        if (!planCode) return { error: 'Pick a plan first with find_data_plans, then pass its planCode.' };
        const d = await cachedCatalog('/service-variations', { serviceID });
        const vars = d?.content?.varations || d?.content?.variations || [];
        let v = vars.find((x) => x.variation_code === planCode);
        let sid = serviceID;
        if (!v) {
          // Plan may be from another data service of the same network (e.g. SME).
          for (const s of (await catalog('data')).filter((x) => String(x.serviceID).startsWith(net) && x.serviceID !== serviceID)) {
            const dd = await cachedCatalog('/service-variations', { serviceID: s.serviceID });
            v = (dd?.content?.varations || dd?.content?.variations || []).find((x) => x.variation_code === planCode);
            if (v) { sid = s.serviceID; break; }
          }
        }
        if (!v) return { error: 'That plan code was not found for this network. Use find_data_plans again.' };
        const p = await priced(Number(v.variation_amount), 'DATA');
        return done({ service: 'DATA', serviceID: sid, variationCode: v.variation_code, billersCode: phone, phone, total: p.total, balance: p.balance, summary: `${String(v.name).trim()} for ${phone}` });
      }

      if (service === 'ELECTRICITY') {
        const meter = String(recipient || '').replace(/\D/g, '');
        if (!/^\d{6,13}$/.test(meter)) return { error: 'Ask for the meter number (usually 11 or 13 digits).' };
        const a = parseInt(amount, 10);
        const min = Math.max(500, Number(rawSettings.minPurchaseAmount || 0));
        if (!(a >= min && a <= 500000)) return { error: `Electricity must be at least ${naira(min)}.` };
        const discos = await catalog('electricity-bill');
        const q = String(disco || '').toLowerCase().replace(/electric(ity)?|distribution|company|disco|\(.*?\)/g, '').trim();
        const found = q ? discos.find((x) => String(x.serviceID).toLowerCase().includes(q) || String(x.name).toLowerCase().includes(q)) : null;
        if (!found) return { error: `Which electricity company? Options: ${discos.map((x) => x.name).slice(0, 12).join(', ') || 'Ikeja, Eko, Abuja, Ibadan, Kano, Port Harcourt, Enugu, Benin, Jos, Kaduna'}.` };
        const type = meterType === 'postpaid' ? 'postpaid' : 'prepaid';
        let name = null;
        try {
          const vr = await vtpassRequest('GET', '/merchant-verify', { query: { serviceID: found.serviceID, billersCode: meter, type } });
          name = vr?.content?.Customer_Name || null;
          if (!name || vr?.content?.error) return { error: `That meter number didn't check out with ${found.name}. Ask the customer to confirm the number and company.` };
        } catch {
          return { error: 'Could not check the meter right now. Suggest trying the Electricity screen.' };
        }
        const p = await priced(a, 'ELECTRICITY');
        const me = await prisma.customer.findUnique({ where: { id: customerId }, select: { phone: true } });
        return done({ service: 'ELECTRICITY', serviceID: found.serviceID, billersCode: meter, meterType: type, phone: me?.phone || '', amount: a, total: p.total, balance: p.balance, verifiedName: String(name).trim().slice(0, 60), summary: `${naira(a)} ${type} electricity for meter ${meter} (${String(name).trim().slice(0, 40)}, ${found.name})` }, { meterName: name });
      }
      return { error: 'In chat I can prepare airtime, data or electricity. For other services, open the Buy screen.' };
    },
  };
}

const PROMPT = `
Buying in chat:
- You CAN prepare airtime, data and electricity purchases with prepare_purchase. The app then shows a confirmation card and the customer confirms with their PIN. You never buy anything yourself, and you must never say something was bought, sent or paid.
- Get the details first: who it's for (use get_my_saved_numbers for "me", "Mum", "my meter"), network/company, amount. For data use find_data_plans and let them pick (or pick the one that best fits what they asked), then pass its planCode.
- If a detail is missing or unclear, ask one short question. Confirm big amounts (over ₦20,000) before preparing.
- Prepare one purchase at a time. If walletEnough is false, say their wallet needs funding and add [[link:/wallet]].`;

module.exports = { TOOLS, handlers, PROMPT, cleanPhone };
