const prisma = require('./prisma');
const { getSettings } = require('./vtpass');
const { notify } = require('./notify');
const guard = require('./rewardGuard');

// Agent shop links: zappipay.com.ng/shop/<username>. A customer who buys
// through an agent's link earns that agent a commission — a % of the
// purchase, capped per order, and never more than the reward safety
// limit leaves after cashback and points (so it can't cost more than
// the owner earns on the order).

const kobo = (n) => Math.floor(Number(n) * 100) / 100;
const cleanUser = (u) => String(u || '').trim().toLowerCase().replace(/^@/, '');

function config(s) {
  return {
    enabled: Boolean(s.shopLinksEnabled),
    pct: Math.min(10, Math.max(0, Number(s.shopCommissionPct ?? 1))),
    max: Math.max(0, Number(s.shopCommissionMax ?? 50)),
  };
}

async function findShop(username) {
  const u = cleanUser(username);
  if (!u) return null;
  const agent = await prisma.customer.findFirst({ where: { username: u } });
  if (!agent || !agent.isAgent || !agent.shopEnabled || agent.active === false || agent.deletedAt) return null;
  return agent;
}

// Which agent (if any) a purchase is credited to.
async function agentForPurchase(customerId, shop) {
  if (!shop) return null;
  const s = config(await getSettings());
  if (!s.enabled) return null;
  const agent = await findShop(shop);
  if (!agent || agent.id === customerId) return null;
  return agent.id;
}

function waNumber(p) {
  const s = String(p || '').replace(/\D/g, '');
  if (/^0[789]\d{9}$/.test(s)) return `234${s.slice(1)}`;
  if (/^234[789]\d{9}$/.test(s)) return s;
  return null;
}

async function publicView(username) {
  const s = config(await getSettings());
  if (!s.enabled) return null;
  const agent = await findShop(username);
  if (!agent) return null;
  return {
    username: agent.username,
    name: agent.agentBusinessName || String(agent.name || '').split(/\s+/)[0],
    owner: String(agent.name || '').split(/\s+/)[0],
    tagline: agent.shopTagline || null,
    whatsapp: agent.shopShowWhatsapp ? waNumber(agent.phone) : null,
  };
}

// After a successful order: pay the agent. Runs once per order (the
// unique providerRef stops a second payment).
async function payCommission(order, settings, { cashback = 0, points = 0 } = {}) {
  try {
    if (!order.shopAgentId || order.shopAgentId === order.customerId) return 0;
    const s = config(settings);
    if (!s.enabled || !(s.pct > 0)) return 0;
    const face = order.costAmount == null ? Number(order.amount) : Number(order.costAmount);
    let amount = Math.min(kobo((face * s.pct) / 100), s.max || Infinity);
    const pointValue = Number(settings.loyaltyPointValue || 0);
    const room = guard.roomForOrder(order, settings, Number(cashback || 0) + Number(points || 0) * pointValue);
    if (room !== null) amount = Math.min(amount, room);
    amount = kobo(amount);
    if (!(amount >= 0.01)) return 0;
    const agent = await prisma.customer.findUnique({ where: { id: order.shopAgentId }, select: { id: true, isAgent: true, active: true } });
    if (!agent || !agent.isAgent || agent.active === false) return 0;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.walletTransaction.create({ data: { customerId: agent.id, type: 'SHOP_COMMISSION', amount, status: 'APPROVED', providerRef: `shop:${order.id}`, reference: order.vtpassRequestId, note: `Shop commission — ${String(order.service).toLowerCase()} sale` } });
        await tx.customer.update({ where: { id: agent.id }, data: { walletBalance: { increment: amount } } });
        await tx.order.update({ where: { id: order.id }, data: { shopCommission: amount } });
      });
    } catch (e) {
      if (e.code === 'P2002') return 0;
      throw e;
    }
    notify(agent.id, 'Shop Sale', `A customer bought ₦${face.toLocaleString()} ${String(order.service).toLowerCase()} through your shop link. ₦${amount.toLocaleString()} commission added to your wallet.`);
    return amount;
  } catch (error) {
    console.error('shop.payCommission failed:', error.message);
    return 0;
  }
}

async function myShop(customerId) {
  const me = await prisma.customer.findUnique({ where: { id: customerId } });
  const s = config(await getSettings());
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [sales, earned] = await Promise.all([
    prisma.order.count({ where: { shopAgentId: customerId, status: 'SUCCESS', createdAt: { gte: since } } }),
    prisma.walletTransaction.aggregate({ where: { customerId, type: 'SHOP_COMMISSION', status: 'APPROVED', createdAt: { gte: since } }, _sum: { amount: true } }),
  ]);
  return {
    available: s.enabled,
    isAgent: Boolean(me?.isAgent),
    username: me?.username || null,
    enabled: Boolean(me?.shopEnabled),
    tagline: me?.shopTagline || '',
    showWhatsapp: Boolean(me?.shopShowWhatsapp),
    commissionPct: s.pct,
    commissionMax: s.max,
    last30: { sales, earned: Number(earned?._sum?.amount || 0) },
  };
}

async function updateMyShop(customerId, { enabled, tagline, showWhatsapp }) {
  const me = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!me?.isAgent) throw Object.assign(new Error('Shop links are for approved agents. Apply under Profile → Become an agent.'), { status: 403 });
  if (enabled && !me.username) throw Object.assign(new Error('Choose a username first — it becomes your shop link.'), { status: 400 });
  const data = {};
  if (enabled !== undefined) data.shopEnabled = Boolean(enabled);
  if (tagline !== undefined) data.shopTagline = String(tagline || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 100) || null;
  if (showWhatsapp !== undefined) data.shopShowWhatsapp = Boolean(showWhatsapp);
  await prisma.customer.update({ where: { id: customerId }, data });
  return myShop(customerId);
}

module.exports = { config, findShop, agentForPurchase, publicView, payCommission, myShop, updateMyShop, cleanUser };
