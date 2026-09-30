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
  {
    name: 'prepare_transfer',
    description: 'Prepare sending money for the customer to confirm with their PIN. Does NOT send anything. to = "ZAPPI" (another ZAPPI PAY user by username or phone) or "BANK" (any Nigerian bank account). For BANK give accountNumber, bank (name, e.g. "FCMB", "GTBank", "Opay") and the accountName the customer said, if any — the app checks the real name on the account.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', enum: ['ZAPPI', 'BANK'] },
        amount: { type: 'number' },
        recipient: { type: 'string', description: 'ZAPPI: username or phone number.' },
        accountNumber: { type: 'string', description: 'BANK: 10-digit account number.' },
        bank: { type: 'string', description: 'BANK: bank name.' },
        accountName: { type: 'string', description: 'Name the customer said is on the account (optional).' },
        note: { type: 'string' },
      },
      required: ['to', 'amount'],
    },
  },
];


// "FCMB" → First City Monument Bank, "GTB" → Guaranty Trust Bank, …
const BANK_ALIASES = { fcmb: 'first city monument', gtb: 'guaranty trust', gtbank: 'guaranty trust', uba: 'united bank for africa', fbn: 'first bank', firstbank: 'first bank', zenith: 'zenith', access: 'access', 'access diamond': 'access', diamond: 'access', stanbic: 'stanbic', ibtc: 'stanbic', fidelity: 'fidelity', union: 'union bank', sterling: 'sterling', wema: 'wema', alat: 'wema', ecobank: 'ecobank', polaris: 'polaris', keystone: 'keystone', unity: 'unity', heritage: 'heritage', jaiz: 'jaiz', providus: 'providus', opay: 'opay', palmpay: 'palmpay', moniepoint: 'moniepoint', kuda: 'kuda', vfd: 'vfd', globus: 'globus', titan: 'titan', lotus: 'lotus', parallex: 'parallex', taj: 'taj', suntrust: 'suntrust', premium: 'premiumtrust', carbon: 'carbon', fairmoney: 'fairmoney', paga: 'paga', rubies: 'rubies', sparkle: 'sparkle', 'first city': 'first city monument' };
function findBank(banks, q) {
  const raw = String(q || '').toLowerCase().replace(/\b(bank|plc|limited|ltd|nigeria|mfb|microfinance)\b/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return { matches: [] };
  const want = BANK_ALIASES[raw] || BANK_ALIASES[raw.replace(/\s/g, '')] || raw;
  const norm = (n) => String(n).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ');
  let matches = banks.filter((b) => norm(b.name).includes(want));
  if (!matches.length) matches = banks.filter((b) => want.split(' ').every((w) => norm(b.name).includes(w)));
  // Prefer the main bank over its microfinance / mortgage arms.
  matches.sort((a, b) => norm(a.name).length - norm(b.name).length);
  return { matches: matches.slice(0, 5) };
}
// Account-name checks per customer (stops people using chat to look up
// lots of strangers' accounts): 15 per 10 minutes.
const lookups = new Map();
function lookupAllowed(customerId, n = 1) {
  const now = Date.now();
  const recent = (lookups.get(customerId) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (recent.length + n > 15) return false;
  lookups.set(customerId, [...recent, ...Array(n).fill(now)]);
  if (lookups.size > 5000) lookups.clear();
  return true;
}

// Does the name the customer typed match the name on the account?
function namesMatch(typed, real) {
  const words = (x) => String(x || '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  const t = words(typed);
  if (!t.length) return null;
  const r = new Set(words(real));
  const hits = t.filter((w) => r.has(w)).length;
  return hits >= Math.min(2, t.length);
}

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


    async prepare_transfer({ to, amount, recipient, accountNumber, bank, accountName, note }) {
      collector.purchase = null;
      collector.transfer = null;
      const amt = Math.round(Number(amount) * 100) / 100;
      if (!(amt >= 1)) return { error: 'How much should I send?' };
      const me = await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true, phone: true, username: true, walletBalance: true } });
      const balance = Number(me?.walletBalance || 0);
      const cleanNote = String(note || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 60) || undefined;
      const family = require('./family');

      if (to === 'ZAPPI') {
        const id = String(recipient || '').trim();
        if (!id) return { error: 'Who should I send it to? Ask for their ZAPPI PAY username or phone number.' };
        const phone = cleanPhone(id);
        const r = await prisma.customer.findFirst({ where: { OR: [{ phone: phone || id }, { username: id.toLowerCase().replace(/^@/, '') }] }, select: { id: true, name: true, username: true, phone: true, deletedAt: true, active: true } });
        if (!r || r.deletedAt || r.active === false) return { error: 'No ZAPPI PAY user has that username or phone number. Ask the customer to check it — or send to their bank account instead.' };
        if (r.id === customerId) return { error: "That's the customer's own account." };
        const fam = await family.checkSend(customerId, r.id);
        if (fam) return { error: fam };
        if (accountName && namesMatch(accountName, r.name) === false) return { error: `That ZAPPI PAY account is registered to ${r.name}, not ${accountName}. Ask the customer to confirm before sending.`, realName: r.name };
        const draft = { kind: 'ZAPPI', identifier: r.username || r.phone, amount: amt, note: cleanNote, fee: 0, total: amt, balance, recipientName: r.name, summary: `${naira(amt)} to ${r.name} (@${r.username || r.phone}) on ZAPPI PAY` };
        collector.transfer = draft;
        return { ok: true, shownToCustomer: `A confirmation card is showing: ${draft.summary}. Free, arrives instantly.`, walletEnough: balance >= amt, next: 'Tell the customer to check the name and tap Send to confirm with their PIN. Do not say it has been sent.' };
      }

      if (to === 'BANK') {
        const acct = String(accountNumber || '').replace(/\D/g, '');
        if (acct.length !== 10) return { error: 'Bank account numbers have 10 digits. Ask for the account number again.' };
        const d = require('./disbursement');
        const cfg = await d.transferSettings();
        if (!cfg.enabled) return { error: 'Sending to banks is not switched on yet. The customer can send to other ZAPPI PAY users.' };
        if (cfg.min && amt < cfg.min) return { error: `The minimum bank transfer is ${naira(cfg.min)}.` };
        if (cfg.max && amt > cfg.max) return { error: `The most per bank transfer is ${naira(cfg.max)}.` };
        const fam = await family.checkSend(customerId);
        if (fam) return { error: fam };
        let banks;
        try { banks = await d.listBanks(); } catch { return { error: 'Could not load the bank list right now. Suggest the Send Money screen.' }; }
        const { matches } = findBank(banks, bank);
        if (!matches.length) return { error: `Which bank is it? I couldn't find "${bank || ''}".` };
        let found = null;
        let foundBank = null;
        // Try the best bank match; if the customer's bank name was vague, try the next few.
        for (const b of matches.slice(0, 3)) {
          if (!lookupAllowed(customerId)) return { error: 'Too many account checks. Please wait a few minutes, or use the Send Money screen.' };
          try {
            found = await d.lookupAccount(b.code, acct);
            foundBank = b;
            break;
          } catch { /* try next */ }
        }
        if (!found) return { error: `Account ${acct} was not found at ${matches[0].name}. Ask the customer to check the number and bank.` };
        if (accountName && namesMatch(accountName, found.accountName) === false) {
          return { error: `The name on ${foundBank.name} ${acct} is ${found.accountName}, not ${accountName}. Ask the customer to check the details before sending.`, realName: found.accountName };
        }
        const fee = cfg.feeFor(amt);
        const draft = { kind: 'BANK', bankCode: foundBank.code, bankName: foundBank.name, accountNumber: acct, accountName: found.accountName, amount: amt, narration: cleanNote, fee, total: amt + fee, balance, nameChecked: Boolean(accountName), summary: `${naira(amt)} to ${found.accountName} · ${foundBank.name} ${acct}` };
        collector.transfer = draft;
        return { ok: true, shownToCustomer: `A confirmation card is showing: ${draft.summary}. Fee ${naira(fee)}, total ${naira(amt + fee)}.`, nameOnAccount: found.accountName, walletEnough: balance >= amt + fee, next: 'Tell the customer the name on the account, and to tap Send to confirm with their PIN. Do not say it has been sent.' };
      }
      return { error: 'Send to a ZAPPI PAY user or to a bank account?' };
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
- Prepare one purchase at a time. If walletEnough is false, say their wallet needs funding and add [[link:/wallet]].

Sending money in chat:
- You CAN prepare a transfer with prepare_transfer — to another ZAPPI PAY user (username or phone) or to any bank account (account number + bank + the name they expect). The app checks the real name on the account. If the name doesn't match, tell the customer clearly and don't try again with a different name unless they confirm.
- Never say money has been sent: the customer checks the card and confirms with their PIN. Confirm big amounts (over ₦50,000) before preparing.`;

module.exports = { TOOLS, handlers, PROMPT, cleanPhone, findBank, namesMatch };
