// Today's key numbers for the owner dashboard (owner-hub on the VPS).
// GET /api/owner/summary with header x-owner-key = OWNER_KEY. Off (404) when OWNER_KEY is not set.
const crypto = require('crypto');
const prisma = require('./prisma');
const { vtpassRequest } = require('./vtpass');

const LAGOS = 60 * 60 * 1000;
const startOfLagosToday = () => { const ymd = new Date(Date.now() + LAGOS).toISOString().slice(0, 10); return new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() - LAGOS); };
const sum = async (model, where, field = 'amount') => Number((await prisma[model].aggregate({ where, _sum: { [field]: true } }))._sum[field] || 0);

function ownerKeyOk(req) {
  const want = process.env.OWNER_KEY || '';
  const got = String(req.headers['x-owner-key'] || '');
  if (want.length < 24 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

async function buildOwnerSummary() {
  const since = startOfLagosToday();
  const today = { gte: since };
  const [orders, failed, pending, customers, newCustomers, funded, pendingFunding, held, otp, openTickets] = await Promise.all([
    prisma.order.findMany({ where: { status: 'SUCCESS', isTest: false, createdAt: today }, select: { amount: true } }),
    prisma.order.count({ where: { status: 'FAILED', isTest: false, createdAt: today } }),
    prisma.order.count({ where: { status: 'PENDING' } }),
    prisma.customer.count(),
    prisma.customer.count({ where: { createdAt: today } }),
    sum('walletTransaction', { type: 'FUND', status: 'APPROVED', createdAt: today }),
    prisma.walletTransaction.count({ where: { type: 'FUND', status: 'PENDING' } }),
    prisma.bankTransfer.count({ where: { status: 'HELD' } }),
    prisma.bankTransfer.count({ where: { status: 'PENDING_AUTHORIZATION' } }),
    prisma.supportTicket.count({ where: { status: 'OPEN' } }),
  ]);
  let vtpass = null;
  try { const b = await vtpassRequest('GET', '/balance'); const n = Number(b?.contents?.balance ?? b?.content?.balance ?? b?.balance); vtpass = Number.isFinite(n) ? n : null; } catch { /* unknown */ }
  const attention = [
    pendingFunding && `${pendingFunding} wallet funding request(s) waiting`,
    held && `${held} bank transfer(s) held`,
    otp && `${otp} bank transfer(s) waiting for authorisation`,
    pending && `${pending} order(s) still pending`,
    openTickets && `${openTickets} open support ticket(s)`,
  ].filter(Boolean);
  return {
    app: 'ZAPPI PAY', at: new Date().toISOString(),
    users: { total: customers, newToday: newCustomers },
    today: { orders: orders.length, salesNGN: orders.reduce((s, o) => s + Number(o.amount), 0), failed, fundedNGN: funded },
    balances: { vtpassNGN: vtpass },
    attention,
  };
}

module.exports = { buildOwnerSummary, ownerKeyOk };
