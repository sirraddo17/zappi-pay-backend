const prisma = require('./prisma');

// Daily spending limits by verification level. "Verified" = the
// customer has done BVN/NIN (to get their personal account number).
// Counts purchases, ZappiPay transfers and bank transfers made today
// (Nigerian time). Off unless an admin turns it on.

const LAGOS_MS = 60 * 60 * 1000;
function startOfTodayLagos() {
  const ymd = new Date(Date.now() + LAGOS_MS).toISOString().slice(0, 10);
  return new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() - LAGOS_MS);
}

async function spentToday(customerId) {
  const agg = await prisma.walletTransaction.aggregate({
    where: { customerId, status: 'APPROVED', type: { in: ['DEBIT', 'TRANSFER_OUT'] }, createdAt: { gte: startOfTodayLagos() } },
    _sum: { amount: true },
  });
  // Refunds of today's failed spends give the room back.
  const refunds = await prisma.walletTransaction.aggregate({
    where: { customerId, status: 'APPROVED', type: 'REFUND', createdAt: { gte: startOfTodayLagos() } },
    _sum: { amount: true },
  });
  return Math.max(0, Number(agg._sum.amount || 0) - Number(refunds._sum.amount || 0));
}

async function limitInfo(customer, settings) {
  const verified = Boolean(customer.kycType);
  const enabled = Boolean(settings.kycLimitsEnabled);
  const limit = Number(verified ? settings.dailyLimitVerified : settings.dailyLimitUnverified);
  const spent = enabled ? await spentToday(customer.id) : 0;
  return { enabled, verified, limit, spent, remaining: Math.max(0, limit - spent) };
}

// Returns null if fine, or an error message.
async function checkDailyLimit(customer, amount, settings) {
  if (!settings.kycLimitsEnabled) return null;
  const info = await limitInfo(customer, settings);
  if (info.spent + Number(amount) <= info.limit) return null;
  const left = `₦${info.remaining.toLocaleString()}`;
  return info.verified
    ? `This is over your daily limit of ₦${info.limit.toLocaleString()} (${left} left today).`
    : `This is over the ₦${info.limit.toLocaleString()} daily limit for unverified accounts (${left} left today). Verify with your BVN or NIN on the Wallet page to raise your limit.`;
}

module.exports = { spentToday, limitInfo, checkDailyLimit };
