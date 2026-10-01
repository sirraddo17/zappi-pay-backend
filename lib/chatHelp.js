const crypto = require('crypto');
const prisma = require('./prisma');

// More things the customer help assistant can do. Look-ups answer
// straight away. Anything that changes something comes back as a card
// the customer taps to confirm (password for freezing the account); the
// app then calls the normal endpoint, so every usual check applies.
// A support ticket is the only thing created directly — after the
// customer agrees in the chat.

const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const LAGOS = 60 * 60 * 1000;
const DAY = 24 * LAGOS;
const lagosYmd = (d) => new Date(new Date(d).getTime() + LAGOS).toISOString().slice(0, 10);
const startOfLagosDay = (ymd) => new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() - LAGOS);
const when = (d) => (d ? new Date(d).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null);
const SERVICE = { AIRTIME: 'airtime', DATA: 'data', ELECTRICITY: 'electricity', CABLE: 'TV', EDUCATION: 'exam PIN', INTERNET: 'internet', BETTING: 'bet funding', INTERNATIONAL: 'international airtime', INSURANCE: 'motor insurance' };

const TOOLS = [
  // C2 report a problem
  { name: 'check_order', description: "Check one of the customer's purchases and refresh its status with the provider if it is still pending. Give orderId, or recipient/service to find the latest match.", input_schema: { type: 'object', properties: { orderId: { type: 'string' }, recipient: { type: 'string' }, service: { type: 'string' } } } },
  { name: 'open_support_ticket', description: 'Send the problem to the support team (a real person). Only after checking the order and after the customer agrees. Attaches the order and, if asked, the pictures from this message.', input_schema: { type: 'object', properties: { message: { type: 'string', description: 'Clear summary for support, in English.' }, orderId: { type: 'string' }, attachPictures: { type: 'boolean' } }, required: ['message'] } },
  // C4 repeats and reminders
  { name: 'get_my_schedules', description: "The customer's repeating top-ups (auto-renew) and upcoming renewal reminders.", input_schema: { type: 'object', properties: {} } },
  { name: 'prepare_schedule_change', description: 'Pause, resume or delete a repeating top-up (card to confirm). To CREATE a repeat, use prepare_purchase with repeat.', input_schema: { type: 'object', properties: { scheduleId: { type: 'string' }, action: { type: 'string', enum: ['PAUSE', 'RESUME', 'DELETE'] } }, required: ['scheduleId', 'action'] } },
  { name: 'prepare_reminders_setting', description: 'Turn renewal reminders (DStv/GOtv/data expiry) on or off (card to confirm).', input_schema: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] } },
  // C6 spending coach
  { name: 'get_my_spending', description: "How the customer's money was spent: totals per service and month, biggest purchases, most-used numbers, cashback earned, and cheaper-data hints.", input_schema: { type: 'object', properties: { months: { type: 'integer', description: '1-6, default 1 (this month)' } } } },
  // C7 emergency security
  { name: 'get_my_devices', description: 'Phones and browsers logged in to this account.', input_schema: { type: 'object', properties: {} } },
  { name: 'prepare_security_action', description: 'LOGOUT_OTHERS logs out every other device. FREEZE blocks all logins and spending until support unfreezes it (lost/stolen phone, hacked account) — needs their password.', input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['LOGOUT_OTHERS', 'FREEZE'] } }, required: ['action'] } },
  // C8 airtime to cash
  { name: 'get_airtime_cash_info', description: 'Airtime to Cash: whether it is on, fee %, minimum, and the number to send airtime to per network.', input_schema: { type: 'object', properties: {} } },
  { name: 'prepare_airtime_cash', description: 'Start an Airtime to Cash request (card to confirm). The customer then transfers the airtime to our number.', input_schema: { type: 'object', properties: { network: { type: 'string', enum: ['mtn', 'airtel', 'glo', 'etisalat'] }, senderPhone: { type: 'string' }, amount: { type: 'number' } }, required: ['network', 'senderPhone', 'amount'] } },
  // C9 family
  { name: 'get_my_family', description: 'Family members the customer manages (allowance, limits, balance, spending today) or who manages them.', input_schema: { type: 'object', properties: {} } },
  { name: 'prepare_family_action', description: 'Change a family member (card to confirm): SEND_NOW sends this period\'s allowance now, SET_ALLOWANCE (amount + frequency WEEKLY/MONTHLY, 0 to stop), SET_DAILY_LIMIT (amount, 0 = none), SET_SERVICES (list), ALLOW_SEND_MONEY (allow true/false).', input_schema: { type: 'object', properties: { member: { type: 'string', description: 'name, nickname or username' }, action: { type: 'string', enum: ['SEND_NOW', 'SET_ALLOWANCE', 'SET_DAILY_LIMIT', 'SET_SERVICES', 'ALLOW_SEND_MONEY'] }, amount: { type: 'number' }, frequency: { type: 'string', enum: ['WEEKLY', 'MONTHLY'] }, services: { type: 'array', items: { type: 'string' } }, allow: { type: 'boolean' } }, required: ['member', 'action'] } },
  // C10 agent helper
  { name: 'get_my_profit', description: 'Agents: sales, profit, commission and money owed, for today / 7 days / this month.', input_schema: { type: 'object', properties: { period: { type: 'string', enum: ['today', '7d', 'month'] } } } },
  { name: 'get_who_owes_me', description: 'Agents: customers who have not paid yet.', input_schema: { type: 'object', properties: {} } },
  { name: 'prepare_record_sale', description: 'Agents: record what they charged for a purchase and who it was for, or mark it paid / owing (card to confirm). orderId "latest" = their most recent purchase; or give recipient to find it.', input_schema: { type: 'object', properties: { orderId: { type: 'string' }, recipient: { type: 'string' }, soldFor: { type: 'number' }, customerName: { type: 'string' }, owing: { type: 'boolean' } } } },
  { name: 'get_my_shop_link', description: 'Agents: their shop link and last-30-day sales through it.', input_schema: { type: 'object', properties: {} } },
];

const PROMPT = `
More you can do:
- Problems: use check_order first (it refreshes pending orders). Explain the real status. Only if it still needs a person, ask "Shall I send this to our support team?" and on yes call open_support_ticket with a clear summary and the orderId. If the customer sent a screenshot, read it (amounts, dates, bank names, error messages), compare it with their records, and attach it to the ticket.
- Repeats: to set up "every Monday / every month", use prepare_purchase with repeat. To pause, resume or delete, use prepare_schedule_change. Reminders: prepare_reminders_setting.
- Spending questions ("where did my money go?"): get_my_spending, then give 2-3 friendly, practical tips (cheaper data plans, repeats, cashback). Don't lecture.
- Lost or stolen phone / hacked account: act fast. Offer prepare_security_action LOGOUT_OTHERS, and FREEZE if they can't get the phone back. Tell them to change their password and PIN after.
- Airtime to Cash: get_airtime_cash_info, explain the fee and payout, then prepare_airtime_cash.
- Family: get_my_family, then prepare_family_action.
- Agents: get_my_profit, get_who_owes_me, prepare_record_sale ("I sold it for ₦1,050 to Mama Tunde, she'll pay Friday" → soldFor 1050, customerName, owing true), get_my_shop_link.
- Cards: anything that changes something shows a card the customer taps to confirm. Never say it is done until they confirm.`;

// Pending orders: ask VTpass at most every 20 seconds per order.
const lastCheck = new Map();

function card(collector, c) {
  const id = crypto.randomBytes(6).toString('hex');
  collector.cards.push({ id, confirm: 'TAP', ...c });
  return { ok: true, shownToCustomer: `A card is showing: ${c.title}.`, next: 'Tell the customer to check the card and tap the button to confirm. Do not say it is done.' };
}

function handlers(customerId, settings, collector, ctx = {}) {
  const me = () => prisma.customer.findUnique({ where: { id: customerId } });

  async function findOrder({ orderId, recipient, service }) {
    if (orderId && orderId !== 'latest') return prisma.order.findFirst({ where: { id: String(orderId), customerId } });
    const where = { customerId };
    if (recipient) where.recipient = String(recipient).replace(/\s/g, '');
    if (service) where.service = String(service).toUpperCase();
    const list = await prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, take: 1 });
    return list[0] || null;
  }

  return {
    // --- C2 ---
    async check_order(input) {
      let o = await findOrder(input || {});
      if (!o) return { error: 'No matching purchase found. Ask for the number it was for, or when it was bought.' };
      if (o.status === 'PENDING' && Date.now() - new Date(o.createdAt).getTime() > 30 * 1000 && Date.now() - (lastCheck.get(o.id) || 0) > 20 * 1000) {
        lastCheck.set(o.id, Date.now());
        if (lastCheck.size > 5000) lastCheck.clear();
        await require('./purchase').recheckOrder(o).catch(() => {});
        o = await prisma.order.findUnique({ where: { id: o.id } });
      }
      const refund = o.status === 'FAILED' || o.status === 'REFUNDED'
        ? await prisma.walletTransaction.findFirst({ where: { customerId, type: 'REFUND', reference: o.vtpassRequestId } })
        : null;
      const mins = Math.round((Date.now() - new Date(o.createdAt).getTime()) / 60000);
      return {
        orderId: o.id,
        what: `${SERVICE[o.service] || o.service} ${naira(o.costAmount ?? o.amount)} for ${o.recipient}`,
        status: o.status,
        providerStatus: o.vtpassStatus,
        bought: when(o.createdAt),
        minutesAgo: mins,
        refunded: refund ? `${naira(refund.amount)} refunded to wallet ${when(refund.createdAt)}` : null,
        receipt: `/orders/${o.id}`,
        explain: o.status === 'SUCCESS' ? 'The provider confirmed delivery. For data/airtime ask them to check balance with the network code, restart the phone, or confirm the number. Electricity/exam tokens are on the receipt.'
          : o.status === 'PENDING' ? 'Still being confirmed by the provider. It will either be delivered or refunded automatically.'
            : 'It failed and the money went back to their wallet.',
      };
    },
    async open_support_ticket({ message, orderId, attachPictures }) {
      const m = String(message || '').trim().slice(0, 1500);
      if (!m) return { error: 'Summarise the problem first.' };
      const since = new Date(Date.now() - DAY);
      if ((await prisma.supportTicket.count({ where: { customerId, createdAt: { gte: since } } })) >= 5) return { error: 'They already sent several messages to support today. Tell them support will reply to those soon.' };
      let order = null;
      if (orderId) order = await prisma.order.findFirst({ where: { id: String(orderId), customerId } });
      const images = attachPictures ? (ctx.images || []).slice(0, 3) : [];
      const ticket = await prisma.supportTicket.create({
        data: { customerId, orderId: order?.id, message: `${m}\n\n(Sent from the help chat)`, ...(images.length ? { attachments: { create: images.map((image) => ({ image })) } } : {}) },
      });
      const c = await me();
      require('./adminAlert').alertAdmins('New support message (from chat)', `${c?.name || 'A customer'} (${c?.phone || ''}): ${m.slice(0, 300)}`, '/admin/support');
      collector.notes.push({ type: 'TICKET', ticketId: ticket.id });
      return { ok: true, ticketId: ticket.id, next: 'Tell them support has it and the reply will come to their Notifications (usually within a few hours).' };
    },

    // --- C4 ---
    async get_my_schedules() {
      const [schedules, renewals, c] = await Promise.all([
        prisma.scheduledPurchase.findMany({ where: { customerId }, take: 20 }),
        require('./reminders').upcoming(customerId).catch(() => []),
        me(),
      ]);
      return {
        repeats: schedules.map((s) => ({ scheduleId: s.id, what: `${SERVICE[s.service] || s.service} ${s.amount ? naira(s.amount) : s.variationCode || ''} for ${s.billersCode}`, nickname: s.nickname, frequency: s.frequency, active: s.active, next: when(s.nextRunAt), lastResult: s.lastStatus })),
        renewalRemindersOn: !c?.billRemindersOff,
        upcomingRenewals: renewals.map((r) => ({ what: r.label, due: when(r.dueDate), when: r.when })),
      };
    },
    async prepare_schedule_change({ scheduleId, action }) {
      const s = await prisma.scheduledPurchase.findFirst({ where: { id: String(scheduleId || ''), customerId } });
      if (!s) return { error: 'That repeat was not found. Use get_my_schedules.' };
      const what = `${SERVICE[s.service] || s.service} for ${s.billersCode} (${s.frequency.toLowerCase()})`;
      if (action === 'DELETE') return card(collector, { icon: '🗑️', title: `Delete repeat: ${what}`, lines: [['Next run', when(s.nextRunAt)]], button: 'Delete', danger: true, request: { method: 'DELETE', path: `/api/schedules/${s.id}` }, doneText: 'Repeat deleted.' });
      const active = action === 'RESUME';
      return card(collector, { icon: active ? '▶️' : '⏸️', title: `${active ? 'Resume' : 'Pause'} repeat: ${what}`, lines: [['Now', s.active ? 'Running' : 'Paused']], button: active ? 'Resume' : 'Pause', request: { method: 'PATCH', path: `/api/schedules/${s.id}`, body: { active } }, doneText: active ? 'Repeat resumed.' : 'Repeat paused.' });
    },
    async prepare_reminders_setting({ on }) {
      return card(collector, { icon: '⏰', title: `Turn renewal reminders ${on ? 'on' : 'off'}`, lines: [['What', 'Reminders before DStv / GOtv / Startimes or data plans run out']], button: on ? 'Turn on' : 'Turn off', request: { method: 'PUT', path: '/api/reminders/settings', body: { off: !on } }, doneText: `Renewal reminders ${on ? 'on' : 'off'}.` });
    },

    // --- C6 ---
    async get_my_spending({ months }) {
      const m = Math.min(6, Math.max(1, parseInt(months, 10) || 1));
      const ymd = lagosYmd(new Date());
      const start = new Date(startOfLagosDay(`${ymd.slice(0, 7)}-01`));
      start.setUTCMonth(start.getUTCMonth() - (m - 1));
      const [orders, cashback, transfers, bank] = await Promise.all([
        prisma.order.findMany({ where: { customerId, status: 'SUCCESS', createdAt: { gte: start } }, select: { service: true, provider: true, amount: true, recipient: true, variationCode: true, createdAt: true }, take: 3000 }),
        prisma.walletTransaction.aggregate({ where: { customerId, type: { in: ['CASHBACK', 'CHALLENGE_REWARD', 'DELIVERY_BONUS', 'REFERRAL_BONUS'] }, status: 'APPROVED', createdAt: { gte: start } }, _sum: { amount: true } }),
        prisma.walletTransaction.aggregate({ where: { customerId, type: 'TRANSFER_OUT', status: 'APPROVED', createdAt: { gte: start } }, _sum: { amount: true } }),
        prisma.bankTransfer.aggregate({ where: { customerId, status: 'SUCCESS', createdAt: { gte: start } }, _sum: { amount: true, fee: true } }).catch(() => null),
      ]);
      const byService = {};
      const byMonth = {};
      const byRecipient = {};
      let dataSpend = 0;
      let dataCount = 0;
      for (const o of orders) {
        const a = Number(o.amount);
        byService[o.service] = (byService[o.service] || 0) + a;
        const mo = lagosYmd(o.createdAt).slice(0, 7);
        byMonth[mo] = (byMonth[mo] || 0) + a;
        byRecipient[o.recipient] = (byRecipient[o.recipient] || 0) + a;
        if (o.service === 'DATA') { dataSpend += a; dataCount += 1; }
      }
      const top = Object.entries(byRecipient).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, a]) => ({ number: r, spent: naira(a) }));
      const biggest = [...orders].sort((a, b) => Number(b.amount) - Number(a.amount)).slice(0, 3).map((o) => ({ what: `${SERVICE[o.service]} for ${o.recipient}`, amount: naira(o.amount), date: when(o.createdAt) }));
      return {
        period: m === 1 ? 'this month' : `last ${m} months`,
        totalPurchases: naira(orders.reduce((s, o) => s + Number(o.amount), 0)),
        purchases: orders.length,
        byService: Object.fromEntries(Object.entries(byService).map(([k, v]) => [SERVICE[k] || k, naira(v)])),
        byMonth: Object.fromEntries(Object.entries(byMonth).sort().map(([k, v]) => [k, naira(v)])),
        sentToFriends: naira(transfers?._sum?.amount || 0),
        sentToBanks: bank ? `${naira(bank._sum?.amount || 0)} (fees ${naira(bank._sum?.fee || 0)})` : undefined,
        rewardsEarned: naira(cashback?._sum?.amount || 0),
        topNumbers: top,
        biggestPurchases: biggest,
        dataHint: dataCount >= 4 ? `They bought data ${dataCount} times (${naira(dataSpend)}). A bigger monthly plan or the "Best data for your budget" page (/deals) may be cheaper per GB; a repeat top-up saves time.` : null,
      };
    },

    // --- C7 ---
    async get_my_devices() {
      const list = await require('./sessions').list(customerId, ctx.sessionId).catch(() => []);
      return (list || []).slice(0, 10).map((s) => ({ device: s.label, thisDevice: s.current, lastSeen: when(s.lastSeenAt), loggedInWith: s.method }));
    },
    async prepare_security_action({ action }) {
      if (action === 'FREEZE') {
        return card(collector, { icon: '🧊', title: 'Freeze my account', lines: [['What happens', 'Every device is logged out. Nobody can log in, buy or send money.'], ['To unfreeze', 'Contact support — they check your date of birth and security question first.']], button: 'Freeze account', confirm: 'PASSWORD', danger: true, request: { method: 'POST', path: '/api/security/freeze' }, doneText: 'Your account is frozen. Contact support to unfreeze it.', logsOut: true });
      }
      return card(collector, { icon: '📵', title: 'Log out all other devices', lines: [['What happens', 'Every other phone and browser is logged out. You stay logged in here.'], ['Next', 'Change your password and PIN in Security.']], button: 'Log them out', request: { method: 'POST', path: '/api/security/sessions/logout-others' }, doneText: 'All your other devices were logged out. Now change your password and PIN.' });
    },

    // --- C8 ---
    async get_airtime_cash_info() {
      if (!settings.airtimeToCashEnabled) return { enabled: false };
      const numbers = settings.airtimeToCashNumbers || {};
      return { enabled: true, feePercent: Number(settings.airtimeToCashFeePercent || 0), minimum: naira(settings.airtimeToCashMinAmount), sendAirtimeTo: numbers, note: 'The customer submits a request, transfers the airtime to our number with their network\'s share/transfer code, and an admin credits the wallet after confirming.' };
    },
    async prepare_airtime_cash({ network, senderPhone, amount }) {
      if (!settings.airtimeToCashEnabled) return { error: 'Airtime to Cash is off right now.' };
      const net = String(network || '').toLowerCase();
      const to = (settings.airtimeToCashNumbers || {})[net];
      if (!to) return { error: 'That network is not supported for Airtime to Cash.' };
      const phone = String(senderPhone || '').replace(/\D/g, '').replace(/^234/, '0');
      if (!/^0\d{10}$/.test(phone)) return { error: 'Ask for the 11-digit phone number the airtime is on.' };
      const a = Number(amount);
      const min = Number(settings.airtimeToCashMinAmount || 0);
      if (!(a >= min && a <= 100000)) return { error: `Amount must be at least ${naira(min)}.` };
      const fee = Number(settings.airtimeToCashFeePercent || 0);
      const payout = Math.floor(a * (1 - fee / 100));
      return card(collector, { icon: '🔁', title: `Airtime to Cash: ${naira(a)} ${net.toUpperCase()}`, lines: [['From', phone], ['You get', `${naira(payout)} (${fee}% fee)`], ['Then', `Transfer the airtime to ${to}`]], button: 'Start request', request: { method: 'POST', path: '/api/airtime-cash/requests', body: { network: net, senderPhone: phone, amount: a } }, doneText: `Request started. Now transfer ${naira(a)} airtime from ${phone} to ${to}. Your wallet gets ${naira(payout)} once we confirm it.` });
    },

    // --- C9 ---
    async get_my_family() {
      const fam = require('./family');
      const [members, managedBy] = await Promise.all([fam.forParent(customerId), fam.forChild(customerId)]);
      return { members: members.map((x) => ({ id: x.id, name: x.nickname || x.name, username: x.username, status: x.status, balance: x.balance != null ? naira(x.balance) : undefined, spentToday: x.spentToday != null ? naira(x.spentToday) : undefined, dailyLimit: x.dailyLimit ? naira(x.dailyLimit) : 'none', allowance: x.allowanceAmount ? `${naira(x.allowanceAmount)} ${x.allowanceFrequency?.toLowerCase()}` : 'none', canBuy: x.allowedServices || 'everything', canSendMoney: x.allowSendMoney })), managedBy: managedBy ? { by: managedBy.parentName, status: managedBy.status } : null };
    },
    async prepare_family_action({ member, action, amount, frequency, services, allow }) {
      const members = await require('./family').forParent(customerId);
      const q = String(member || '').toLowerCase().replace(/^@/, '');
      const m = members.find((x) => x.status === 'ACTIVE' && [x.nickname, x.name, x.username].some((v) => v && String(v).toLowerCase().includes(q)));
      if (!m) return { error: 'No active family member by that name. Use get_my_family.' };
      const who = m.nickname || m.name;
      if (action === 'SEND_NOW') {
        if (!m.allowanceAmount) return { error: `${who} has no allowance set. Set one first.` };
        return card(collector, { icon: '💸', title: `Send ${who}'s allowance now`, lines: [['Amount', naira(m.allowanceAmount)], ['From', 'Your wallet']], button: `Send ${naira(m.allowanceAmount)}`, request: { method: 'POST', path: `/api/family/${m.id}/send-now` }, doneText: `${naira(m.allowanceAmount)} sent to ${who}.` });
      }
      let body;
      let lines;
      if (action === 'SET_ALLOWANCE') {
        const a = Math.round(Number(amount || 0));
        body = a ? { allowanceAmount: a, allowanceFrequency: frequency || m.allowanceFrequency || 'WEEKLY' } : { allowanceAmount: null };
        lines = [['Allowance', `${m.allowanceAmount ? naira(m.allowanceAmount) : 'none'} → ${a ? `${naira(a)} ${(body.allowanceFrequency || '').toLowerCase()}` : 'stopped'}`]];
      } else if (action === 'SET_DAILY_LIMIT') {
        const a = Math.round(Number(amount || 0));
        body = { dailyLimit: a || null };
        lines = [['Daily limit', `${m.dailyLimit ? naira(m.dailyLimit) : 'none'} → ${a ? naira(a) : 'none'}`]];
      } else if (action === 'SET_SERVICES') {
        const list = (services || []).map((x) => String(x).toUpperCase());
        body = { allowedServices: list };
        lines = [['Can buy', list.map((x) => SERVICE[x] || x).join(', ') || 'nothing']];
      } else if (action === 'ALLOW_SEND_MONEY') {
        body = { allowSendMoney: Boolean(allow) };
        lines = [['Sending money', allow ? 'allowed' : 'only back to you']];
      } else return { error: 'Unknown family action.' };
      return card(collector, { icon: '👨‍👩‍👧', title: `Update ${who}`, lines, button: 'Save', request: { method: 'PUT', path: `/api/family/${m.id}`, body }, doneText: `${who}'s settings saved.` });
    },

    // --- C10 ---
    async get_my_profit({ period }) {
      const pb = require('./profitBook');
      const today = lagosYmd(new Date());
      const from = period === 'today' ? today : period === '7d' ? lagosYmd(Date.now() - 6 * DAY) : `${today.slice(0, 8)}01`;
      try {
        const b = await pb.book(customerId, { from, to: today });
        return { period: period || 'month', ...Object.fromEntries(Object.entries(b.summary).map(([k, v]) => [k, typeof v === 'number' && k !== 'sales' && k !== 'owingCount' ? naira(v) : v])), byService: b.byService.map((x) => ({ service: SERVICE[x.service] || x.service, sales: x.sales, profit: naira(x.profit) })), recent: b.orders.slice(0, 5).map((o) => ({ orderId: o.id, what: `${SERVICE[o.service]} for ${o.recipient}`, soldFor: naira(o.soldFor), profit: naira(o.profit), customer: o.customerName, owing: o.owing })) };
      } catch (e) {
        return { error: e.message };
      }
    },
    async get_who_owes_me() {
      try {
        const list = await require('./profitBook').owing(customerId);
        return list.map((o) => ({ orderId: o.id, customer: o.customerName || o.recipient, amount: naira(o.soldFor), what: `${SERVICE[o.service]} for ${o.recipient}`, date: when(o.createdAt) }));
      } catch (e) {
        return { error: e.message };
      }
    },
    async prepare_record_sale({ orderId, recipient, soldFor, customerName, owing }) {
      const c = await me();
      if (!c?.isAgent) return { error: 'The profit book is for approved agents.' };
      const o = await findOrder({ orderId: orderId || 'latest', recipient });
      if (!o || o.status !== 'SUCCESS') return { error: 'No matching successful purchase found.' };
      const body = {};
      const lines = [['Sale', `${SERVICE[o.service]} ${naira(o.costAmount ?? o.amount)} for ${o.recipient}`], ['You paid', naira(o.amount)]];
      if (soldFor !== undefined) { body.soldFor = Number(soldFor); lines.push(['Sold for', `${naira(soldFor)} (profit ${naira(Number(soldFor) - Number(o.amount))})`]); }
      if (customerName) { body.customerName = String(customerName).slice(0, 60); lines.push(['Customer', body.customerName]); }
      if (owing !== undefined) { body.owing = Boolean(owing); lines.push(['Paid?', owing ? 'Not yet — owes you' : 'Paid ✓']); }
      if (!Object.keys(body).length) return { error: 'What should I record: the price, the customer, or paid/owing?' };
      return card(collector, { icon: '📒', title: 'Update profit book', lines, button: 'Save', request: { method: 'PUT', path: `/api/agent/book/${o.id}`, body }, doneText: 'Saved in your profit book.' });
    },
    async get_my_shop_link() {
      const s = await require('./shop').myShop(customerId);
      if (!s.isAgent) return { error: 'Shop links are for approved agents.' };
      if (!s.available) return { error: 'Shop links are not switched on yet.' };
      const appUrl = (process.env.APP_URL || 'https://www.zappipay.com.ng').replace(/\/$/, '');
      return { on: s.enabled, link: s.username ? `${appUrl}/shop/${s.username}` : null, commission: `${s.commissionPct}% up to ${naira(s.commissionMax)} a sale`, last30: s.last30, turnOnAt: s.enabled ? null : 'Profile → My shop link' };
    },
  };
}

module.exports = { TOOLS, PROMPT, handlers };
