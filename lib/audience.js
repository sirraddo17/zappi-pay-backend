const prisma = require('./prisma');

// Customer groups for broadcasts, push messages and promo codes.
const DAY = 24 * 60 * 60 * 1000;
const AUDIENCES = {
  ALL: 'Everyone',
  AGENTS: 'Agents only',
  NEW_7: 'Joined in the last 7 days',
  NEVER_BOUGHT: 'Signed up but never bought',
  ACTIVE_30: 'Bought in the last 30 days',
  INACTIVE_30: 'Bought before, but not in the last 30 days',
  SLIPPING: 'Regulars slipping away (bought often, nothing in 3 weeks)',
};

function clean(a) {
  return Object.prototype.hasOwnProperty.call(AUDIENCES, a) ? a : 'ALL';
}

// Prisma filter for active customers in the group.
function where(audience, now = new Date()) {
  const base = { active: true, deletedAt: null };
  const since30 = new Date(now.getTime() - 30 * DAY);
  switch (clean(audience)) {
    case 'AGENTS': return { ...base, isAgent: true };
    case 'NEW_7': return { ...base, createdAt: { gte: new Date(now.getTime() - 7 * DAY) } };
    case 'NEVER_BOUGHT': return { ...base, orders: { none: { status: 'SUCCESS' } } };
    case 'ACTIVE_30': return { ...base, orders: { some: { status: 'SUCCESS', createdAt: { gte: since30 } } } };
    case 'INACTIVE_30': return { ...base, AND: [{ orders: { some: { status: 'SUCCESS' } } }, { orders: { none: { status: 'SUCCESS', createdAt: { gte: since30 } } } }] };
    case 'SLIPPING': {
      const d21 = new Date(now.getTime() - 21 * DAY);
      const d81 = new Date(now.getTime() - 81 * DAY);
      return { ...base, AND: [{ orders: { some: { status: 'SUCCESS', createdAt: { gte: d81, lt: d21 } } } }, { orders: { none: { status: 'SUCCESS', createdAt: { gte: d21 } } } }] };
    }
    default: return base;
  }
}

async function customerIds(audience) {
  const rows = await prisma.customer.findMany({ where: where(audience), select: { id: true } });
  return rows.map((r) => r.id);
}

async function count(audience) {
  return prisma.customer.count({ where: where(audience) });
}

async function isMember(customerId, audience) {
  if (clean(audience) === 'ALL') return true;
  const n = await prisma.customer.count({ where: { id: customerId, ...where(audience) } });
  return n > 0;
}

module.exports = { AUDIENCES, clean, where, customerIds, count, isMember };
