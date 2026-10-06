// More customer help-chat tools: funding proof reader, scam checker and
// data plan advisor. Look-ups only — nothing moves money except the
// normal Monnify re-check, which can only ever credit the real owner
// of a payment.

const prisma = require('./prisma');

const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const DAY = 24 * 60 * 60 * 1000;
const when = (d) => (d ? new Date(d).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null);

const TOOLS = [
  {
    name: 'check_my_funding',
    description: 'The customer says they funded their wallet (bank transfer) but it is not showing. Re-checks their personal account with the bank partner (credits anything missed), then looks for a matching credit or pending manual request. Pass what you read from their bank alert / screenshot.',
    input_schema: { type: 'object', properties: { amount: { type: 'number', description: 'amount sent in naira' }, sentAt: { type: 'string', description: 'date/time from the alert, e.g. 2026-10-01 14:05' }, reference: { type: 'string', description: 'session ID / transaction reference from the alert' }, senderBank: { type: 'string' }, toAccount: { type: 'string', description: 'account number they sent to, if shown' } } },
  },
  {
    name: 'report_scam',
    description: 'Log a scam / suspicious message the customer received (fake ZAPPI PAY staff, fake prize, PIN/OTP request, fake link) so the ZAPPI PAY team can warn others. Call after you have explained it is a scam.',
    input_schema: { type: 'object', properties: { summary: { type: 'string', description: 'what the scammer said or asked, 1-3 sentences' }, channel: { type: 'string', enum: ['SMS', 'WHATSAPP', 'CALL', 'SOCIAL', 'EMAIL', 'OTHER'] }, contact: { type: 'string', description: 'phone number, username or link the scammer used, if any' }, lostMoney: { type: 'boolean' } }, required: ['summary'] },
  },
  {
    name: 'recommend_data_plan',
    description: 'Recommend the best data plans for how the customer uses data (not just the cheapest). Pass their monthly need in GB (estimate from what they say: WhatsApp/social light ≈ 2-4GB, daily videos ≈ 10-20GB, work/streaming ≈ 30GB+), budget if given, network if known.',
    input_schema: { type: 'object', properties: { monthlyGb: { type: 'number' }, budget: { type: 'number', description: 'max naira per month, optional' }, network: { type: 'string', enum: ['MTN', 'Airtel', 'Glo', '9mobile'] }, phone: { type: 'string', description: 'number the data is for (guesses the network)' } }, required: ['monthlyGb'] },
  },
];

const PROMPT = `
More things you can help with:
- Funding not showing ("I sent money but my wallet is not credited"): if they sent a screenshot of the bank alert, read the amount, date/time, reference and bank from it. Call check_my_funding with those details. Explain the result plainly. If it is still not found, ask "Shall I send this to our support team with your screenshot?" and on yes use open_support_ticket with every detail (amount, time, reference, bank, account sent to) and attachPictures true.
- Scam check: if the customer shows or describes a message/call/link and asks if it is real, judge it. ZAPPI PAY NEVER asks for a PIN, password, OTP, BVN or card details; never calls to "verify" or "unlock" accounts; never asks you to pay to receive a prize or refund; the only website is zappipay.com.ng and support is in the app or support@zappipay.com.ng. Say clearly "This is a scam" (or "This looks safe" only if it truly matches ZAPPI PAY), why in 2-3 points, what to do (don't reply, block, never share PIN/OTP; if they shared anything, change password and PIN now, and offer FREEZE via prepare_security_action). Then call report_scam.
- Data plan advice ("which data plan should I buy?", "I use YouTube a lot"): ask 1 short question if you don't know how they use data, estimate GB a month, call recommend_data_plan, and suggest 1-3 plans with why (value, validity). Offer to buy with prepare_purchase.
- "Help me get started" / new customers: ask what they want to do first (buy airtime/data, pay a bill, sell as an agent). Then walk them step by step, starting with funding their wallet (Wallet → personal account number) and creating a PIN (Profile → Security). Use get_feature_guide for exact steps.`;

function parseWhen(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(/(\d{1,2})\/(\d{1,2})\/(\d{4})/, '$3-$2-$1'));
  return Number.isNaN(d.getTime()) ? null : d;
}

function handlers(customerId) {
  return {
    async check_my_funding({ amount, sentAt, reference, senderBank, toAccount }) {
      const c = await prisma.customer.findUnique({ where: { id: customerId } });
      if (!c) return { error: 'Account not found.' };
      const amt = Number(amount) || null;
      const at = parseWhen(sentAt);
      // 1. Ask the bank partner again (credits anything missed).
      let synced = null;
      if (c.bankAccountRef) {
        try { synced = await require('./monnify').syncCustomerPayments(c); } catch { synced = { error: true }; }
      }
      // A Monnify reference credits only the real owner of that payment.
      let byRef = null;
      if (reference && /^MNFY/i.test(String(reference).trim())) {
        try {
          byRef = await require('./monnify').creditFromTransaction(String(reference).trim());
          if (byRef?.credited && byRef.customerId && byRef.customerId !== customerId) byRef = { credited: false, reason: 'belongs to another account' };
        } catch { byRef = null; }
      }
      // 2. Look for the money.
      const since = new Date((at ? at.getTime() : Date.now()) - 3 * DAY);
      const credits = await prisma.walletTransaction.findMany({ where: { customerId, type: 'FUND', createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 15 });
      const close = (x) => amt && Math.abs(Number(x.amount) - amt) <= Math.max(60, amt * 0.02); // fees can take a little off
      const match = credits.find((t) => t.status === 'APPROVED' && (close(t) || (reference && String(t.reference || '').includes(String(reference).trim()))));
      const pending = credits.find((t) => t.status === 'PENDING' && (!amt || close(t)));
      const rejected = credits.find((t) => t.status === 'REJECTED' && (!amt || close(t)));
      const accounts = (Array.isArray(c.bankAccounts) ? c.bankAccounts : []).map((a) => `${a.bankName} ${a.accountNumber}`);
      const sentToOurs = toAccount ? accounts.some((a) => a.includes(String(toAccount).replace(/\D/g, ''))) : null;
      return {
        recheckedWithBank: Boolean(c.bankAccountRef),
        newlyCredited: (synced?.credited || 0) + (byRef?.credited ? 1 : 0),
        found: match ? { amount: naira(match.amount), at: when(match.createdAt), note: match.note || null, status: 'Credited to wallet' } : null,
        pendingManualRequest: pending ? { amount: naira(pending.amount), submitted: when(pending.createdAt), status: 'Waiting for admin approval' } : null,
        rejectedRequest: rejected ? { amount: naira(rejected.amount), at: when(rejected.createdAt), reason: rejected.note || null } : null,
        theirFundingAccounts: accounts,
        sentToTheirAccount: sentToOurs,
        hint: match ? 'It is in the wallet — tell them the time and amount (a bank fee may have been taken off).'
          : !c.bankAccountRef ? 'They have no personal account number yet — they may have sent to the business account (manual funding needs a request on the Wallet page) or to the wrong account.'
            : sentToOurs === false ? 'The account in their alert is NOT their ZAPPI PAY account number — check the number with them.'
              : at && Date.now() - at.getTime() < 15 * 60 * 1000 ? 'Sent less than 15 minutes ago — banks can be slow; ask them to wait a little and tap "I\'ve sent money — check now" on Wallet.'
                : 'Not found yet — offer to send it to support with the screenshot and details.',
        senderBank: senderBank || null,
      };
    },

    async report_scam({ summary, channel, contact, lostMoney }) {
      const s = String(summary || '').trim().slice(0, 600);
      if (!s) return { error: 'Summarise the scam first.' };
      const recent = await prisma.scamReport.count({ where: { customerId, createdAt: { gte: new Date(Date.now() - DAY) } } });
      if (recent >= 5) return { ok: true, note: 'Already reported today.' };
      await prisma.scamReport.create({ data: { customerId, summary: s, channel: ['SMS', 'WHATSAPP', 'CALL', 'SOCIAL', 'EMAIL', 'OTHER'].includes(channel) ? channel : 'OTHER', contact: contact ? String(contact).slice(0, 120) : null, lostMoney: Boolean(lostMoney) } });
      if (lostMoney) require('./adminAlert').alertAdmins('Scam: a customer may have lost money', s.slice(0, 300), '/admin/assistant');
      return { ok: true, next: 'Thank them — the team will use it to warn other customers.' };
    },

    async recommend_data_plan({ monthlyGb, budget, network, phone }) {
      const gb = Math.max(0.1, Math.min(500, Number(monthlyGb) || 0));
      if (!gb) return { error: 'How much data do they need a month (GB)?' };
      const deals = require('./deals');
      const { getSettings } = require('./vtpass');
      const { settingsForCustomer } = require('./pricing');
      const cust = await prisma.customer.findUnique({ where: { id: customerId }, select: { isAgent: true } });
      const settings = settingsForCustomer(await getSettings(), cust);
      const net = network || (phone ? deals.networkForPhone(phone) : null);
      let plans = await deals.allPlans(settings);
      if (net) plans = plans.filter((p) => p.network === net);
      // Cost for a month of their usage with each plan (buy it as often as needed).
      const scored = plans.filter((p) => p.days).map((p) => {
        const perMonthBuys = Math.max(1, Math.ceil(Math.max(gb * 1024 / p.mb, 30 / p.days)));
        const monthly = perMonthBuys * p.price;
        return { ...p, perMonthBuys, monthly, coversGb: Math.round((perMonthBuys * p.mb) / 102.4) / 10 };
      }).filter((p) => (!budget || p.monthly <= Number(budget) * 1.15) && p.perMonthBuys <= 30);
      scored.sort((a, b) => a.monthly - b.monthly || a.perMonthBuys - b.perMonthBuys);
      const pick = [];
      const seen = new Set();
      for (const p of scored) {
        const k = `${p.network}|${p.name}`;
        if (seen.has(k)) continue;
        seen.add(k);
        pick.push(p);
        if (pick.length >= 5) break;
      }
      if (!pick.length) return { error: budget ? 'No plan fits that budget for that much data — suggest a smaller amount of data or a bigger budget.' : 'No plans found right now.' };
      return {
        needGbPerMonth: gb,
        network: net || 'any',
        options: pick.map((p) => ({ network: p.network, plan: p.name, price: naira(p.price), lasts: `${p.days} day${p.days === 1 ? '' : 's'}`, buyTimesAMonth: p.perMonthBuys, costPerMonth: naira(p.monthly), givesGbPerMonth: p.coversGb, serviceID: p.serviceID, variationCode: p.variationCode })),
        tip: 'Fewer, bigger plans are usually cheaper per GB and less stress. Mention the repeat option (auto-renew) for monthly plans.',
      };
    },
  };
}

module.exports = { TOOLS, PROMPT, handlers };
