const prisma = require('./prisma');
const { getSettings } = require('./vtpass');
const { estimateCommission } = require('./earnings');

// "AI, set the rewards split to 30%": the admin assistant can PROPOSE
// changes to reward, pricing and promotion settings. Each proposal is
// stored here with the exact admin API calls it would make and how to
// undo them. Nothing changes until the owner taps Apply; then the
// server replays those calls against its own admin API with the
// owner's login, so every normal check and audit log applies.
//
// Never available to the assistant: VTpass / Monnify / AI keys and
// modes, bank and funding accounts, transfer limits and fees, security
// (2FA, fraud holds, daily limits), staff, passwords, savings interest,
// customer wallets, refunds and payouts.

const SERVICES = ['AIRTIME', 'DATA', 'ELECTRICITY', 'CABLE', 'EDUCATION', 'INTERNET', 'BETTING'];
const SPLIT_KEYS = ['CASHBACK', 'LOYALTY', 'REFERRAL', 'CHALLENGES', 'PROMISE', 'SHOP'];
const TYPICAL_PROVIDER = { AIRTIME: 'mtn', DATA: 'mtn-data', ELECTRICITY: 'ikeja-electric', CABLE: 'dstv', EDUCATION: 'waec', INTERNET: 'smile-direct', BETTING: 'bet9ja' };
const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const EXPIRES_MS = 30 * 60 * 1000;
const UNDO_MS = 24 * 60 * 60 * 1000;

class ActionError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// name → where it lives, how to check it, how to show it.
const S = (ep, field, type, label, extra = {}) => ({ ep, field, type, label, ...extra });
const SPECS = {
  split_enabled: S('split', 'enabled', 'bool', 'Rewards split on'),
  split_percent: S('split', 'pct', 'int', 'Rewards split: give back % of earnings', { min: 0, max: 90, unit: '%' }),
  split_shares: S('split', 'shares', 'shares', 'Rewards split shares'),
  cashback_enabled: S('settings', 'cashbackEnabled', 'bool', 'Cashback on'),
  cashback_percent: S('settings', 'cashbackPercentByService', 'svc', 'Cashback % (when the split is off)', { min: 0, max: 20, unit: '%' }),
  cashback_max_per_order: S('settings', 'cashbackMaxPerOrder', 'num', 'Cashback cap per order', { min: 0, max: 100000, unit: '₦' }),
  loyalty_enabled: S('settings', 'loyaltyEnabled', 'bool', 'Loyalty points on'),
  loyalty_point_value: S('settings', 'loyaltyPointValue', 'num', 'Value of 1 point', { min: 0.01, max: 100, unit: '₦' }),
  loyalty_min_redeem: S('settings', 'loyaltyMinRedeem', 'int', 'Points needed to redeem', { min: 1, max: 1000000 }),
  loyalty_points_per_100: S('settings', 'loyaltyPointsPer100', 'num', 'Points per ₦100 (when the split is off)', { min: 0, max: 100 }),
  referral_enabled: S('settings', 'referralEnabled', 'bool', 'Referral programme on'),
  referral_bonus: S('settings', 'referralBonusAmount', 'num', 'Referral bonus', { min: 0, max: 100000, unit: '₦' }),
  referral_min_purchase: S('settings', 'referralMinPurchase', 'num', "Friend's minimum first purchase", { min: 0, max: 1000000, unit: '₦' }),
  discount_percent: S('settings', 'discountPercentByService', 'svc', 'Discount % (everyone)', { min: 0, max: 50, unit: '%' }),
  agent_pricing_enabled: S('settings', 'agentPricingEnabled', 'bool', 'Agent prices on'),
  agent_discount_percent: S('settings', 'agentDiscountPercentByService', 'svc', 'Agent discount %', { min: 0, max: 20, unit: '%' }),
  markup_percent: S('settings', 'markupPercentByService', 'svc', 'Markup %', { min: 0, max: 30, unit: '%' }),
  markup_cap: S('settings', 'markupCapByService', 'svc', 'Markup cap per purchase', { min: 0, max: 10000, unit: '₦' }),
  safety_limit_enabled: S('settings', 'rewardGuardEnabled', 'bool', 'Giveaway safety limit on'),
  safety_limit_percent: S('settings', 'rewardGuardPercent', 'int', 'Giveaway safety limit', { min: 0, max: 100, unit: '%' }),
  pause_all_purchases: S('settings', 'purchasesPaused', 'bool', 'Pause ALL purchases'),
  paused_services: S('settings', 'pausedServices', 'svclist', 'Paused services'),
  maintenance_message: S('settings', 'maintenanceMessage', 'text', 'Maintenance message', { max: 200 }),
  delivery_promise_enabled: S('promise', 'enabled', 'bool', 'Delivery promise on'),
  delivery_promise_seconds: S('promise', 'seconds', 'int', 'Delivery promise time', { min: 30, max: 600, unit: 's' }),
  delivery_promise_bonus: S('promise', 'bonus', 'int', 'Delivery promise bonus', { min: 1, max: 500, unit: '₦' }),
  delivery_promise_min_amount: S('promise', 'minAmount', 'int', 'Delivery promise minimum purchase', { min: 0, max: 100000, unit: '₦' }),
  delivery_promise_daily_budget: S('promise', 'dailyBudget', 'int', 'Delivery promise daily budget', { min: 0, max: 10000000, unit: '₦' }),
  delivery_promise_services: S('promise', 'services', 'svclist', 'Delivery promise services'),
  shop_links_enabled: S('shops', 'enabled', 'bool', 'Agent shop links on'),
  shop_commission_percent: S('shops', 'pct', 'num', 'Shop commission', { min: 0, max: 10, unit: '%' }),
  shop_commission_max: S('shops', 'max', 'int', 'Shop commission max per sale', { min: 0, max: 5000, unit: '₦' }),
};
const ENDPOINT = {
  settings: { method: 'PATCH', path: '/api/admin/settings' },
  split: { method: 'PUT', path: '/api/admin/reward-split' },
  promise: { method: 'PUT', path: '/api/admin/delivery-promise' },
  shops: { method: 'PUT', path: '/api/admin/shops' },
};

// Current values for every endpoint, in the shape its PUT/PATCH takes.
async function current() {
  const s = await getSettings();
  return {
    settings: s,
    split: require('./rewardSplit').config(s),
    promise: require('./deliveryPromise').config(s),
    shops: require('./shop').config(s),
  };
}

function show(spec, v) {
  if (v === null || v === undefined || v === '') return '—';
  if (spec.type === 'bool') return v ? 'On' : 'Off';
  if (spec.type === 'svc') return Object.entries(v || {}).filter(([, x]) => Number(x) > 0).map(([k, x]) => `${k.toLowerCase()} ${spec.unit === '₦' ? naira(x) : `${x}%`}`).join(', ') || 'none';
  if (spec.type === 'svclist') return (v || []).map((x) => x.toLowerCase()).join(', ') || 'none';
  if (spec.type === 'shares') return SPLIT_KEYS.map((k) => `${k.toLowerCase()} ${v?.[k] ?? 0}%`).join(', ');
  if (spec.unit === '₦') return naira(v);
  if (spec.unit) return `${v}${spec.unit}`;
  return String(v);
}

function check(name, spec, value, before) {
  const bad = (m) => { throw new ActionError(`${spec.label}: ${m}`); };
  switch (spec.type) {
    case 'bool':
      if (value === 'true' || value === 'on') return true;
      if (value === 'false' || value === 'off') return false;
      if (typeof value !== 'boolean') bad('use true or false.');
      return value;
    case 'int':
    case 'num': {
      const n = Number(value);
      if (!Number.isFinite(n)) bad('enter a number.');
      if (n < spec.min || n > spec.max) bad(`must be between ${spec.min} and ${spec.max}.`);
      return spec.type === 'int' ? Math.round(n) : Math.round(n * 100) / 100;
    }
    case 'text':
      return String(value || '').trim().slice(0, spec.max) || null;
    case 'svclist': {
      const list = (Array.isArray(value) ? value : [value]).map((x) => String(x).toUpperCase()).filter((x) => SERVICES.includes(x));
      return [...new Set(list)];
    }
    case 'svc': {
      if (!value || typeof value !== 'object') bad('give a % per service, e.g. {"AIRTIME": 1}.');
      const merged = { ...(before || {}) };
      for (const [k, v] of Object.entries(value)) {
        const key = k.toUpperCase();
        if (!SERVICES.includes(key)) bad(`unknown service ${k}.`);
        const n = Number(v);
        if (!(n >= spec.min && n <= spec.max)) bad(`${key} must be between ${spec.min} and ${spec.max}.`);
        merged[key] = Math.round(n * 100) / 100;
      }
      return merged;
    }
    case 'shares': {
      if (!value || typeof value !== 'object') bad('give a share per reward.');
      const merged = { ...(before || {}) };
      for (const [k, v] of Object.entries(value)) {
        const key = k.toUpperCase();
        if (!SPLIT_KEYS.includes(key)) bad(`unknown share ${k}.`);
        const n = Math.round(Number(v));
        if (!(n >= 0 && n <= 100)) bad(`${key} must be 0–100.`);
        merged[key] = n;
      }
      const sum = SPLIT_KEYS.reduce((a, k) => a + Number(merged[k] || 0), 0);
      if (sum !== 100) bad(`shares must add up to 100% (these add up to ${sum}%).`);
      return merged;
    }
    default:
      return bad('not supported.');
  }
}

// Rough earnings per ₦1,000 on each service, to warn about discounts
// that eat the whole margin.
function earningsPct(service, settings) {
  const mk = Number(settings.markupPercentByService?.[service] || 0);
  const cap = Number(settings.markupCapByService?.[service] || 0);
  const markup = cap > 0 ? Math.min(10 * mk, cap) : 10 * mk; // on ₦1,000
  const commission = estimateCommission(service, TYPICAL_PROVIDER[service], 1000);
  return (markup + commission) / 10; // % of face value
}

function warnings(after) {
  const out = [];
  const s = after.settings;
  const limit = after.split.enabled ? after.split.pct : Number(s.rewardGuardPercent ?? 50);
  for (const svc of ['AIRTIME', 'DATA', 'ELECTRICITY', 'CABLE']) {
    const earn = earningsPct(svc, s);
    const disc = Number(s.discountPercentByService?.[svc] || 0);
    const agent = s.agentPricingEnabled ? Number(s.agentDiscountPercentByService?.[svc] || 0) : 0;
    if (disc > 0 && disc >= earn) out.push(`${svc.toLowerCase()}: a ${disc}% discount is about all you earn there (~${earn.toFixed(1)}%) — you'd make almost nothing on each sale.`);
    else if (disc + agent > 0 && disc + agent > (earn * limit) / 100) out.push(`${svc.toLowerCase()}: agent price ${disc + agent}% off uses more than your ${limit}% give-back (you earn ~${earn.toFixed(1)}%), so agents get no cashback or points there.`);
  }
  if (after.split.enabled && after.split.pct > 60) out.push(`Giving back ${after.split.pct}% of your earnings leaves only ${100 - after.split.pct}% to run the business.`);
  if (s.purchasesPaused) out.push('ALL purchases will stop until you switch this back off.');
  return out;
}

// --- Proposals ------------------------------------------------------

async function save(adminId, kind, summary, changes, requests, undo, warns = []) {
  return prisma.adminAction.create({ data: { adminId, kind, summary, changes, requests, undo, warnings: warns, status: 'PENDING' } });
}

const card = (a) => ({ id: a.id, kind: a.kind, summary: a.summary, changes: a.changes, warnings: a.warnings || [], status: a.status, canUndo: Boolean(a.undo), createdAt: a.createdAt });

async function proposeSettings(adminId, { changes, reason } = {}) {
  const list = Array.isArray(changes) ? changes : Object.entries(changes || {}).map(([setting, value]) => ({ setting, value }));
  if (!list.length) throw new ActionError('No changes given.');
  const now = await current();
  const after = JSON.parse(JSON.stringify(now));
  const bodies = {};
  const undos = {};
  const rows = [];
  for (const { setting, value } of list) {
    const spec = SPECS[setting];
    if (!spec) throw new ActionError(`"${setting}" can't be changed by the assistant (sensitive or unknown). Use the Settings page.`);
    const before = spec.ep === 'settings' ? now.settings[spec.field] : now[spec.ep][spec.field];
    const v = check(setting, spec, value, before);
    (bodies[spec.ep] ||= {})[spec.field] = v;
    (undos[spec.ep] ||= {})[spec.field] = before ?? (spec.type === 'svc' ? {} : spec.type === 'svclist' ? [] : null);
    if (spec.ep === 'settings') after.settings[spec.field] = v; else after[spec.ep][spec.field] = v;
    if (spec.ep === 'split' && spec.field === 'enabled') after.settings.rewardSplitEnabled = v;
    rows.push({ label: spec.label, from: show(spec, before), to: show(spec, v) });
  }
  // The split endpoint takes whole shares; keep the current ones.
  if (bodies.split && !bodies.split.shares) bodies.split.shares = now.split.shares;
  if (undos.split && !undos.split.shares) undos.split.shares = now.split.shares;
  const req = (bs) => Object.entries(bs).map(([ep, body]) => ({ ...ENDPOINT[ep], body }));
  const summary = String(reason || '').trim().slice(0, 200) || `Change ${rows.length} setting${rows.length === 1 ? '' : 's'}`;
  return card(await save(adminId, 'SETTINGS', summary, rows, req(bodies), req(undos), warnings(after)));
}

async function proposeChallenge(adminId, input = {}) {
  const ch = require('./challenges');
  const body = ch.validate({ ...input, active: true });
  const rows = [
    { label: 'Challenge', from: '—', to: body.title },
    { label: 'Goal', from: '—', to: `${body.kind === 'COUNT' ? `${body.target} purchases` : body.kind === 'SPEND' ? `spend ${naira(body.target)}` : `${body.target} days in a row`}${body.service ? ` of ${body.service.toLowerCase()}` : ''}${body.minAmount ? `, ${naira(body.minAmount)}+ each` : ''} · ${body.period.toLowerCase()}` },
    { label: 'Reward', from: '—', to: `${naira(body.reward)}${body.budget ? ` · total budget ${naira(body.budget)}` : ' · no total budget'}` },
  ];
  const warns = body.budget ? [] : ['No total budget — add one so it stops by itself.'];
  return card(await save(adminId, 'CHALLENGE', `New challenge: ${body.title}`, rows, [{ method: 'POST', path: '/api/admin/challenges', body: { ...input, active: true }, capture: 'challenge' }], [{ method: 'PATCH', path: '/api/admin/challenges/:challenge', body: { active: false } }], warns));
}

async function proposeChallengeToggle(adminId, { challengeId, active } = {}) {
  const c = await prisma.challenge.findUnique({ where: { id: String(challengeId || '') } });
  if (!c) throw new ActionError('Challenge not found. Look it up with get_rewards_and_pricing first.');
  return card(await save(adminId, 'CHALLENGE', `${active ? 'Restart' : 'Stop'} challenge: ${c.title}`, [{ label: c.title, from: c.active ? 'Running' : 'Stopped', to: active ? 'Running' : 'Stopped' }], [{ method: 'PATCH', path: `/api/admin/challenges/${c.id}`, body: { active: Boolean(active) } }], [{ method: 'PATCH', path: `/api/admin/challenges/${c.id}`, body: { active: c.active } }]));
}

async function proposePromo(adminId, input = {}) {
  const code = String(input.code || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (!/^[A-Z0-9_-]{3,20}$/.test(code)) throw new ActionError('Promo code must be 3–20 letters or numbers.');
  if (!['FLAT', 'PERCENT', 'CREDIT'].includes(input.type)) throw new ActionError('type must be FLAT (₦ off), PERCENT (% off) or CREDIT (wallet gift).');
  if (!(Number(input.value) > 0)) throw new ActionError('value must be more than 0.');
  if (input.type === 'CREDIT' && !input.usageLimit) throw new ActionError('A wallet gift coupon needs usageLimit (total uses).');
  if (await prisma.promoCode.findUnique({ where: { code } })) throw new ActionError('That code already exists.');
  const body = { ...input, code };
  const what = input.type === 'PERCENT' ? `${input.value}% off${input.maxDiscount ? ` (max ${naira(input.maxDiscount)})` : ''}` : input.type === 'FLAT' ? `${naira(input.value)} off` : `${naira(input.value)} wallet gift`;
  const rows = [
    { label: 'Promo code', from: '—', to: code },
    { label: 'Gives', from: '—', to: `${what}${input.minAmount ? ` on ${naira(input.minAmount)}+` : ''}${input.services?.length ? ` · ${input.services.join(', ').toLowerCase()}` : ''}` },
    { label: 'Limits', from: '—', to: `${input.usageLimit ? `${input.usageLimit} uses total` : 'no total limit'} · ${input.perCustomerLimit || 1} per customer${input.newCustomersOnly ? ' · new customers only' : ''}${input.expiresAt ? ` · ends ${String(input.expiresAt).slice(0, 10)}` : ''}` },
  ];
  const warns = [];
  if (!input.usageLimit && !input.expiresAt) warns.push('No total uses or end date — it runs until you turn it off.');
  if (input.type !== 'CREDIT') warns.push('Promo discounts count inside your give-back %, so they may be trimmed on low-margin purchases.');
  return card(await save(adminId, 'PROMO', `New promo code ${code}`, rows, [{ method: 'POST', path: '/api/admin/promos', body, capture: 'promo' }], [{ method: 'PATCH', path: '/api/admin/promos/:promo', body: { active: false } }], warns));
}

async function proposeNotice(adminId, { message, service, level, hours } = {}) {
  const m = String(message || '').trim().slice(0, 200);
  if (!m) throw new ActionError('Write the notice message.');
  const body = { message: m, service: SERVICES.includes(service) ? service : null, level: level === 'WARNING' ? 'WARNING' : 'INFO', hours: Number(hours || 0) };
  return card(await save(adminId, 'NOTICE', 'Post a service notice', [{ label: `Notice${body.service ? ` (${body.service.toLowerCase()})` : ''}`, from: '—', to: m }, { label: 'Shows for', from: '—', to: body.hours ? `${body.hours} hours` : 'until you remove it' }], [{ method: 'POST', path: '/api/admin/notices', body, capture: 'notice' }], [{ method: 'PATCH', path: '/api/admin/notices/:notice', body: { active: false } }]));
}

async function proposeBroadcast(adminId, { title, message, type, audience, showBanner } = {}) {
  const t = String(title || '').trim();
  const m = String(message || '').trim();
  if (!t || t.length > 100) throw new ActionError('Title is required (max 100 characters).');
  if (!m || m.length > 1000) throw new ActionError('Message is required (max 1000 characters).');
  const aud = require('./audience');
  const group = aud.clean(audience);
  const count = await aud.count(group).catch(() => null);
  const body = { title: t, message: m, type: ['INFO', 'WARNING', 'MAINTENANCE'].includes(type) ? type : 'INFO', audience: group, showBanner: Boolean(showBanner) };
  return card(await save(adminId, 'BROADCAST', `Send "${t}"`, [{ label: 'To', from: '—', to: `${group === 'ALL' ? 'All customers' : group}${count != null ? ` (${count})` : ''}` }, { label: 'Title', from: '—', to: t }, { label: 'Message', from: '—', to: m.slice(0, 300) }], [{ method: 'POST', path: '/api/admin/broadcasts', body }], null, ['This sends a notification to every customer in the group straight away and cannot be undone.']));
}


// --- Support, accounts, campaigns, Help Centre -------------------------

async function proposeTicketReplies(adminId, { replies } = {}) {
  const list = (Array.isArray(replies) ? replies : []).slice(0, 15);
  if (!list.length) throw new ActionError('No replies given.');
  const rows = [];
  const reqs = [];
  for (const r of list) {
    const t = await prisma.supportTicket.findUnique({ where: { id: String(r.ticketId || '') }, include: { customer: { select: { name: true } } } });
    if (!t) throw new ActionError(`Ticket ${r.ticketId} not found.`);
    const reply = String(r.reply || '').trim();
    if (!reply || reply.length > 2000) throw new ActionError('Each reply must be 1–2000 characters.');
    rows.push({ label: `${t.customer?.name || 'Customer'}: “${t.message.slice(0, 70)}${t.message.length > 70 ? '…' : ''}”`, from: '—', to: `${reply}${r.resolve ? '  ✓ resolve' : ''}` });
    reqs.push({ method: 'POST', path: `/api/admin/support/tickets/${t.id}/reply`, body: { reply, resolve: Boolean(r.resolve) } });
  }
  return card(await save(adminId, 'SUPPORT', `Reply to ${list.length} ticket${list.length === 1 ? '' : 's'}`, rows, reqs, null, ['Replies are sent to customers straight away and cannot be unsent. Read each one first.']));
}

const ACCOUNT_TOOLS = { UNLOCK_LOGIN: 'Unlock login (wrong-password lock)', UNLOCK_PIN: 'Unlock PIN (too many wrong PINs)', RESET_PIN: 'Reset PIN (customer creates a new one)', REMOVE_DEVICES: 'Remove quick-login devices' };
async function proposeAccountTool(adminId, { customerId, action, verified } = {}) {
  if (!ACCOUNT_TOOLS[action]) throw new ActionError(`Allowed: ${Object.keys(ACCOUNT_TOOLS).join(', ')}. Changing phone/email or security answers stays on the Customers page.`);
  const c = await prisma.customer.findUnique({ where: { id: String(customerId || '') }, select: { id: true, name: true, phone: true } });
  if (!c) throw new ActionError('Customer not found. Use find_customers first.');
  const warns = action === 'RESET_PIN' && !verified ? ['Only reset a PIN after confirming it is really them (date of birth + security question).'] : [];
  return card(await save(adminId, 'ACCOUNT', `${ACCOUNT_TOOLS[action]}: ${c.name}`, [{ label: 'Customer', from: '—', to: `${c.name} (${c.phone})` }, { label: 'Action', from: '—', to: ACCOUNT_TOOLS[action] }], [{ method: 'POST', path: `/api/admin/customers/${c.id}/account-tool`, body: { action } }], null, warns));
}

async function proposeFreeze(adminId, { customerId, reason } = {}) {
  const c = await prisma.customer.findUnique({ where: { id: String(customerId || '') }, select: { id: true, name: true, phone: true, active: true } });
  if (!c) throw new ActionError('Customer not found.');
  if (!c.active) throw new ActionError('That account is already frozen. Unfreezing stays on the Customers page (owner check).');
  return card(await save(adminId, 'ACCOUNT', `Freeze ${c.name}'s account`, [{ label: 'Customer', from: 'Active', to: `Frozen — ${c.name} (${c.phone})` }, { label: 'Why', from: '—', to: String(reason || '—').slice(0, 200) }], [{ method: 'PATCH', path: `/api/admin/customers/${c.id}`, body: { active: false } }], [{ method: 'PATCH', path: `/api/admin/customers/${c.id}`, body: { active: true } }], ['They cannot log in or spend until you unfreeze them.']));
}

async function proposeCampaign(adminId, { name, audience, promo, broadcast } = {}) {
  const aud = require('./audience');
  const group = aud.clean(audience);
  const count = await aud.count(group).catch(() => null);
  const rows = [{ label: 'Who', from: '—', to: `${group === 'ALL' ? 'All customers' : group}${count != null ? ` (${count})` : ''}` }];
  const reqs = [];
  const undo = [];
  const warns = [];
  if (promo) {
    const p = await proposePromo(adminId, { ...promo, audience: group }).catch((e) => { throw new ActionError(`Promo: ${e.message}`); });
    await prisma.adminAction.update({ where: { id: p.id }, data: { status: 'DISMISSED' } });
    rows.push(...p.changes);
    warns.push(...p.warnings);
    reqs.push({ method: 'POST', path: '/api/admin/promos', body: { ...promo, code: String(promo.code).toUpperCase().replace(/[^A-Z0-9_-]/g, ''), audience: group }, capture: 'promo' });
    undo.push({ method: 'PATCH', path: '/api/admin/promos/:promo', body: { active: false } });
  }
  if (broadcast) {
    const t = String(broadcast.title || '').trim();
    const m = String(broadcast.message || '').trim();
    if (!t || !m) throw new ActionError('The campaign message needs a title and text.');
    rows.push({ label: 'Message title', from: '—', to: t }, { label: 'Message', from: '—', to: m.slice(0, 300) });
    reqs.push({ method: 'POST', path: '/api/admin/broadcasts', body: { title: t.slice(0, 100), message: m.slice(0, 1000), type: 'INFO', audience: group, showBanner: Boolean(broadcast.showBanner) } });
    warns.push('The message goes out straight away and cannot be unsent (the promo code can still be switched off with Undo).');
  }
  if (!reqs.length) throw new ActionError('A campaign needs a promo code and/or a message.');
  return card(await save(adminId, 'CAMPAIGN', `Campaign: ${String(name || 'New campaign').slice(0, 60)}`, rows, reqs, undo.length ? undo : null, warns));
}

async function proposeFaq(adminId, { topic, question, answer } = {}) {
  const q = String(question || '').trim();
  const a = String(answer || '').trim();
  if (!q || !a) throw new ActionError('Give the question and the answer.');
  return card(await save(adminId, 'FAQ', 'Add to the Help Centre', [{ label: 'Topic', from: '—', to: String(topic || 'Other').slice(0, 40) }, { label: 'Question', from: '—', to: q.slice(0, 200) }, { label: 'Answer', from: '—', to: a.slice(0, 600) }], [{ method: 'POST', path: '/api/admin/faqs', body: { topic: String(topic || 'Other').slice(0, 40), question: q.slice(0, 200), answer: a.slice(0, 1500) }, capture: 'faq' }], [{ method: 'PATCH', path: '/api/admin/faqs/:faq', body: { active: false } }]));
}

async function proposeDismissFlag(adminId, { flagId } = {}) {
  const f = await prisma.riskFlag.findUnique({ where: { id: String(flagId || '') } });
  if (!f) throw new ActionError('Flag not found.');
  return card(await save(adminId, 'SETTINGS', `Dismiss risk flag`, [{ label: f.title, from: 'Open', to: 'Dismissed' }], [{ method: 'POST', path: `/api/admin/risk-flags/${f.id}/dismiss`, body: {} }], null));
}

// --- Apply / undo ----------------------------------------------------

async function call(base, auth, r, ids) {
  const path = r.path.replace(/:(\w+)/g, (_, k) => ids[k] || 'missing');
  const res = await fetch(`${base}${path}`, { method: r.method, headers: { 'Content-Type': 'application/json', Authorization: auth, 'X-Admin-Assistant': '1' }, body: JSON.stringify(r.body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ActionError(json.error || `That change was refused (${res.status}).`, 400);
  if (r.capture) ids[r.capture] = json[r.capture]?.id;
  return json;
}

async function apply(adminId, id, { base, auth }) {
  const a = await prisma.adminAction.findFirst({ where: { id, adminId } });
  if (!a) throw new ActionError('Proposal not found.', 404);
  if (a.status !== 'PENDING') throw new ActionError(`Already ${a.status.toLowerCase()}.`, 409);
  if (Date.now() - new Date(a.createdAt).getTime() > EXPIRES_MS) {
    await prisma.adminAction.update({ where: { id }, data: { status: 'EXPIRED' } });
    throw new ActionError('This proposal is more than 30 minutes old. Ask the assistant again so it uses today’s values.', 409);
  }
  const claim = await prisma.adminAction.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'APPLYING' } });
  if (claim.count !== 1) throw new ActionError('Already being applied.', 409);
  const ids = {};
  let done = 0;
  try {
    for (const r of a.requests) { await call(base, auth, r, ids); done += 1; }
  } catch (e) {
    // Put back whatever was already applied.
    if (done && a.undo) for (const r of a.undo.slice(0, done)) await call(base, auth, r, ids).catch(() => {});
    await prisma.adminAction.update({ where: { id }, data: { status: 'FAILED', error: e.message.slice(0, 300) } });
    throw e;
  }
  const updated = await prisma.adminAction.update({ where: { id }, data: { status: 'APPLIED', appliedAt: new Date(), ids } });
  await prisma.auditLog.create({ data: { actorAdminId: adminId, action: 'AI_ACTION_APPLIED', details: { id, kind: a.kind, summary: a.summary } } }).catch(() => {});
  return card(updated);
}

async function undo(adminId, id, { base, auth }) {
  const a = await prisma.adminAction.findFirst({ where: { id, adminId } });
  if (!a) throw new ActionError('Proposal not found.', 404);
  if (a.status !== 'APPLIED' || !a.undo) throw new ActionError('This can’t be undone.', 409);
  if (Date.now() - new Date(a.appliedAt).getTime() > UNDO_MS) throw new ActionError('Undo is only available for 24 hours. Change it on the Settings page.', 409);
  const claim = await prisma.adminAction.updateMany({ where: { id, status: 'APPLIED' }, data: { status: 'UNDOING' } });
  if (claim.count !== 1) throw new ActionError('Already being undone.', 409);
  try {
    for (const r of a.undo) await call(base, auth, r, a.ids || {});
  } catch (e) {
    await prisma.adminAction.update({ where: { id }, data: { status: 'APPLIED' } });
    throw e;
  }
  const updated = await prisma.adminAction.update({ where: { id }, data: { status: 'UNDONE' } });
  await prisma.auditLog.create({ data: { actorAdminId: adminId, action: 'AI_ACTION_UNDONE', details: { id, kind: a.kind, summary: a.summary } } }).catch(() => {});
  return card(updated);
}

async function dismiss(adminId, id) {
  const r = await prisma.adminAction.updateMany({ where: { id, adminId, status: 'PENDING' }, data: { status: 'DISMISSED' } });
  if (!r.count) throw new ActionError('Nothing to dismiss.', 409);
}

// What the assistant reads before suggesting changes.
async function overview() {
  const now = await current();
  const s = now.settings;
  const [challenges, promos] = await Promise.all([
    prisma.challenge.findMany({ where: { active: true }, take: 10 }).catch(() => []),
    prisma.promoCode.findMany({ where: { active: true }, take: 10 }).catch(() => []),
  ]);
  const pick = Object.fromEntries(Object.entries(SPECS).map(([k, spec]) => [k, spec.ep === 'settings' ? s[spec.field] : now[spec.ep][spec.field]]));
  return {
    settings: pick,
    estimatedEarningsPercentOfSale: Object.fromEntries(SERVICES.map((svc) => [svc, Math.round(earningsPct(svc, s) * 100) / 100])),
    runningChallenges: challenges.map((c) => ({ id: c.id, title: c.title, reward: Number(c.reward), budget: c.budget == null ? null : Number(c.budget), paid: Number(c.paidTotal || 0) })),
    activePromoCodes: promos.map((p) => ({ code: p.code, type: p.type, value: Number(p.value), used: p.usedCount, limit: p.usageLimit })),
    note: 'Earnings % = markup + typical VTpass commission on a ₦1,000 sale. Keep discount + agent discount below split % × earnings.',
  };
}

module.exports = { SPECS, ActionError, overview, proposeSettings, proposeChallenge, proposeChallengeToggle, proposePromo, proposeNotice, proposeBroadcast, proposeTicketReplies, proposeAccountTool, proposeFreeze, proposeCampaign, proposeFaq, proposeDismissFlag, apply, undo, dismiss, card };
