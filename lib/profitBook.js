const prisma = require('./prisma');

// Agent profit book. Profit on a sale = what the agent charged their
// customer (soldFor; face value unless they changed it) − what their
// wallet paid. Shop-link commissions count as extra income.

const LAGOS = 60 * 60 * 1000;
const DAY = 24 * LAGOS;
const lagosYmd = (d) => new Date(new Date(d).getTime() + LAGOS).toISOString().slice(0, 10);
const startOfLagosDay = (ymd) => new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() - LAGOS);
const r2 = (n) => Math.round(Number(n) * 100) / 100;

class BookError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

function range({ from, to } = {}, now = new Date()) {
  const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const toYmd = ok(to) ? to : lagosYmd(now);
  const fromYmd = ok(from) ? from : `${lagosYmd(now).slice(0, 8)}01`;
  const start = startOfLagosDay(fromYmd);
  const end = new Date(startOfLagosDay(toYmd).getTime() + DAY);
  if (!(end > start)) throw new BookError('Pick a start date before the end date.');
  if (end - start > 370 * DAY) throw new BookError('Pick at most one year.');
  return { fromYmd, toYmd, start, end };
}

async function requireAgent(customerId) {
  const me = await prisma.customer.findUnique({ where: { id: customerId }, select: { isAgent: true } });
  if (!me?.isAgent) throw new BookError('The profit book is for approved agents.', 403);
}

const face = (o) => Number(o.costAmount ?? o.amount);

async function book(customerId, q = {}) {
  await requireAgent(customerId);
  const { fromYmd, toYmd, start, end } = range(q);
  const [orders, commissions, owingAll] = await Promise.all([
    prisma.order.findMany({ where: { customerId, status: 'SUCCESS', createdAt: { gte: start, lt: end } }, orderBy: { createdAt: 'desc' }, take: 5000 }),
    prisma.walletTransaction.findMany({ where: { customerId, type: 'SHOP_COMMISSION', status: 'APPROVED', createdAt: { gte: start, lt: end } }, select: { amount: true, createdAt: true } }),
    prisma.agentSale.findMany({ where: { agentId: customerId, owing: true } }),
  ]);
  const sales = orders.length
    ? await prisma.agentSale.findMany({ where: { agentId: customerId, orderId: { in: orders.map((o) => o.id) } } })
    : [];
  const byOrder = new Map(sales.map((s) => [s.orderId, s]));

  const days = new Map();
  for (let t = start.getTime(); t < end.getTime() && days.size < 400; t += DAY) days.set(lagosYmd(t), { date: lagosYmd(t), profit: 0, sales: 0 });
  const byService = {};
  let soldTotal = 0;
  let costTotal = 0;
  const rows = orders.map((o) => {
    const s = byOrder.get(o.id);
    const soldFor = s ? Number(s.soldFor) : face(o);
    const paid = Number(o.amount);
    const profit = r2(soldFor - paid);
    soldTotal += soldFor;
    costTotal += paid;
    const d = days.get(lagosYmd(o.createdAt));
    if (d) { d.profit += profit; d.sales += 1; }
    const b = (byService[o.service] ||= { service: o.service, sales: 0, profit: 0 });
    b.sales += 1;
    b.profit += profit;
    return { id: o.id, service: o.service, provider: o.provider, recipient: o.recipient, face: face(o), paid, soldFor, profit, customerName: s?.customerName || null, owing: Boolean(s?.owing), note: s?.note || null, edited: Boolean(s), createdAt: o.createdAt };
  });
  let commission = 0;
  for (const c of commissions) {
    commission += Number(c.amount);
    const d = days.get(lagosYmd(c.createdAt));
    if (d) d.profit += Number(c.amount);
  }
  // Money owed to the agent, across all time (not just this range).
  const owedOrders = owingAll.length ? await prisma.order.findMany({ where: { id: { in: owingAll.map((s) => s.orderId) } }, select: { id: true } }) : [];
  const owed = owingAll.filter((s) => owedOrders.some((o) => o.id === s.orderId)).reduce((a, s) => a + Number(s.soldFor), 0);

  return {
    from: fromYmd,
    to: toYmd,
    summary: { sales: rows.length, soldTotal: r2(soldTotal), costTotal: r2(costTotal), salesProfit: r2(soldTotal - costTotal), commission: r2(commission), profit: r2(soldTotal - costTotal + commission), owed: r2(owed), owingCount: owingAll.length },
    byService: Object.values(byService).map((b) => ({ ...b, profit: r2(b.profit) })).sort((a, b) => b.profit - a.profit),
    days: [...days.values()].map((d) => ({ ...d, profit: r2(d.profit) })),
    orders: rows.slice(0, 300),
  };
}

// Who still owes the agent (all time).
async function owing(customerId) {
  await requireAgent(customerId);
  const list = await prisma.agentSale.findMany({ where: { agentId: customerId, owing: true }, take: 500 });
  const orders = list.length ? await prisma.order.findMany({ where: { id: { in: list.map((s) => s.orderId) }, customerId } }) : [];
  const map = new Map(orders.map((o) => [o.id, o]));
  return list.filter((s) => map.has(s.orderId)).map((s) => {
    const o = map.get(s.orderId);
    return { id: o.id, service: o.service, recipient: o.recipient, soldFor: Number(s.soldFor), customerName: s.customerName, note: s.note, createdAt: o.createdAt };
  }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function record(customerId, orderId, { soldFor, customerName, owing: isOwing, note } = {}) {
  await requireAgent(customerId);
  const order = await prisma.order.findFirst({ where: { id: orderId, customerId } });
  if (!order) throw new BookError('Purchase not found.', 404);
  if (order.status !== 'SUCCESS') throw new BookError('Only successful purchases go in the profit book.');
  const existing = await prisma.agentSale.findUnique({ where: { orderId } });
  const data = {};
  if (soldFor !== undefined) {
    const n = r2(soldFor);
    if (!(n >= 0 && n <= 10000000)) throw new BookError('Enter what you sold it for.');
    data.soldFor = n;
  }
  if (customerName !== undefined) data.customerName = String(customerName || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 60) || null;
  if (note !== undefined) data.note = String(note || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 140) || null;
  if (isOwing !== undefined) {
    data.owing = Boolean(isOwing);
    data.paidAt = isOwing ? null : existing?.owing ? new Date() : existing?.paidAt || null;
  }
  if (existing) return prisma.agentSale.update({ where: { id: existing.id }, data });
  return prisma.agentSale.create({ data: { agentId: customerId, orderId, soldFor: face(order), ...data } });
}

module.exports = { BookError, book, owing, record, range };
