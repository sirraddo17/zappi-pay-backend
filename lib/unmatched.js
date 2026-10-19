// Unmatched payments: money a partner (Monnify / Squad / Nomba) confirmed
// arriving on an account number that no customer owns any more — a test
// number that was removed, a deleted account, a Monnify reset. Before,
// these were dropped silently. Now they wait here for support to:
//   • assign → credit the right customer's wallet (same reference a normal
//     credit uses, so it can never be added twice), or
//   • mark RETURNED (sent back to the payer outside the app) / IGNORED (test money).
// Every account number taken off a customer is remembered
// (RetiredAccountRef) so the list can say who it used to belong to.

const prisma = require('./prisma');

const PROVIDERS = ['monnify', 'squad', 'nomba'];
const NAMES = { monnify: 'Monnify', squad: 'Squad (GTBank)', nomba: 'Nomba' };
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const naira = (n) => `₦${r2(n).toLocaleString('en-NG')}`;
const clean = (v) => (v === undefined || v === null || v === '' ? null : String(v).trim().slice(0, 120));

class UnmatchedError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Remember account numbers before they're taken off a customer.
async function retire(provider, ref, customerId, reason, accounts = null) {
  if (!ref || !customerId || !PROVIDERS.includes(provider)) return;
  await prisma.retiredAccountRef.create({ data: { provider, ref: String(ref), customerId, reason: String(reason).slice(0, 80), accounts: accounts || undefined } }).catch((e) => console.error('retire ref failed:', e.message));
}

// Everything a customer row holds, for one call before clearing it.
async function retireAllFor(c, reason, only = PROVIDERS) {
  const list = Array.isArray(c.bankAccounts) ? c.bankAccounts : [];
  const pick = (p) => list.filter((a) => String(a.provider || 'monnify').toLowerCase() === p);
  if (only.includes('monnify') && c.bankAccountRef) await retire('monnify', c.bankAccountRef, c.id, reason, pick('monnify'));
  if (only.includes('squad') && c.squadAccountRef) await retire('squad', c.squadAccountRef, c.id, reason, pick('squad'));
  if (only.includes('nomba') && c.nombaAccountRef) await retire('nomba', c.nombaAccountRef, c.id, reason, pick('nomba'));
}

let alertedAt = 0;
// Called by the partner credit paths when no customer owns the account.
// Safe to call many times for the same payment.
async function record(p) {
  try {
    const provider = PROVIDERS.includes(p.provider) ? p.provider : null;
    const providerRef = clean(p.providerRef);
    const amount = r2(p.amount);
    if (!provider || !providerRef || !(amount > 0)) return null;
    if (await prisma.walletTransaction.findUnique({ where: { providerRef } })) return null; // already credited somewhere
    const existing = await prisma.unmatchedPayment.findUnique({ where: { providerRef } });
    if (existing) return existing;
    const accountRef = clean(p.accountRef);
    const old = accountRef ? await prisma.retiredAccountRef.findFirst({ where: { provider, ref: accountRef }, orderBy: { retiredAt: 'desc' } }) : null;
    const row = await prisma.unmatchedPayment.create({
      data: {
        provider, providerRef, amount, accountRef, status: 'OPEN',
        accountNumber: clean(p.accountNumber), payerName: clean(p.payerName), payerAccount: clean(p.payerAccount), payerBank: clean(p.payerBank),
        raw: p.raw ? JSON.parse(JSON.stringify(p.raw)) : undefined,
        suggestedCustomerId: old?.customerId || null,
      },
    }).catch((e) => (e.code === 'P2002' ? null : Promise.reject(e)));
    if (row && Date.now() - alertedAt > 10 * 60 * 1000) {
      alertedAt = Date.now();
      require('./adminAlert').alertAdmins('Payment with no customer', `${naira(amount)} arrived through ${NAMES[provider]}${row.payerName ? ` from ${row.payerName}` : ''} on an account number no customer owns now. Nothing was credited — assign it or send it back.`, '/admin/unmatched-payments').catch(() => {});
    }
    return row;
  } catch (error) {
    console.error('unmatched.record failed:', error.message);
    return null;
  }
}

async function list(status = 'OPEN') {
  const where = status === 'ALL' ? {} : { status };
  const rows = await prisma.unmatchedPayment.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
  const ids = [...new Set(rows.flatMap((r) => [r.suggestedCustomerId, r.customerId]).filter(Boolean))];
  const people = ids.length ? await prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, phone: true, deletedAt: true, active: true } }) : [];
  const byId = Object.fromEntries(people.map((c) => [c.id, c]));
  const open = await prisma.unmatchedPayment.aggregate({ where: { status: 'OPEN' }, _sum: { amount: true }, _count: { _all: true } });
  return {
    payments: rows.map((r) => ({ ...r, amount: Number(r.amount), providerName: NAMES[r.provider], suggested: byId[r.suggestedCustomerId] || null, customer: byId[r.customerId] || null })),
    open: { count: open._count._all, amount: Number(open._sum.amount || 0) },
  };
}

// Credit the payment to a customer's wallet. chargeFee = take the same
// funding fee a normal deposit through that partner would.
async function assign(id, customerId, { adminId, note, chargeFee = true } = {}) {
  const row = await prisma.unmatchedPayment.findUnique({ where: { id } });
  if (!row) throw new UnmatchedError('Payment not found.', 404);
  if (row.status !== 'OPEN') throw new UnmatchedError('This payment has already been handled.', 409);
  const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true, name: true, active: true, deletedAt: true } });
  if (!customer || customer.deletedAt) throw new UnmatchedError('Choose an existing customer. (A deleted account can’t receive it — send the money back to the payer instead.)', 400);
  const amount = Number(row.amount);
  // Nomba's message is checked against Nomba's own records first.
  if (row.provider === 'nomba' && row.raw?.transactionId) {
    const t = await require('./nomba').fetchTransaction({ transactionRef: row.raw.transactionId }).catch(() => undefined);
    if (t === null) throw new UnmatchedError('Nomba has no record of this payment — check the Nomba dashboard before crediting it.', 409);
    if (t && t.status && String(t.status).toUpperCase() !== 'SUCCESS') throw new UnmatchedError(`Nomba says this payment is ${t.status}. Don't credit it yet.`, 409);
    if (t && t.amount !== undefined && r2(t.amount) !== r2(amount)) throw new UnmatchedError(`Nomba's records say ${naira(t.amount)}, not ${naira(amount)}. Check the Nomba dashboard.`, 409);
  }
  let fee = 0;
  if (chargeFee) {
    const settings = await require('./vtpass').getSettings();
    fee = require('./fundingFees').computeFee(amount, settings, row.provider);
  }
  const net = r2(amount - fee);
  const text = note ? String(note).trim().slice(0, 200) : '';
  try {
    await prisma.$transaction(async (tx) => {
      const r = await tx.unmatchedPayment.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'ASSIGNED', customerId, note: text || null, resolvedById: adminId || null, resolvedAt: new Date() } });
      if (r.count !== 1) throw new UnmatchedError('This payment has already been handled.', 409);
      await tx.walletTransaction.create({
        data: {
          customerId, type: 'FUND', amount: net, status: 'APPROVED', reference: row.providerRef, providerRef: row.providerRef,
          note: `Bank transfer of ${naira(amount)} via ${NAMES[row.provider]} (matched by support${fee > 0 ? `, ${naira(fee)} fee` : ''})`, reviewedAt: new Date(),
        },
      });
      await tx.customer.update({ where: { id: customerId }, data: { walletBalance: { increment: net } } });
    });
  } catch (error) {
    if (error.code === 'P2002') throw new UnmatchedError('This payment was already credited to a wallet.', 409);
    throw error;
  }
  await prisma.auditLog.create({ data: { actorAdminId: adminId || null, action: 'UNMATCHED_PAYMENT_ASSIGNED', details: { id, customerId, amount, fee, net, provider: row.provider, providerRef: row.providerRef, note: text || undefined } } }).catch(() => {});
  Promise.resolve(require('./notify').notify(customerId, 'Wallet Funded', `${naira(net)} from your bank transfer has been added to your wallet.`, { category: 'TRANSACTION' })).catch(() => {});
  return { credited: net, fee, customer: customer.name };
}

// RETURNED (money sent back to the payer outside the app) or IGNORED.
async function close(id, status, { adminId, note } = {}) {
  if (!['RETURNED', 'IGNORED'].includes(status)) throw new UnmatchedError('Choose returned or ignored.');
  const text = String(note || '').trim();
  if (text.length < 5) throw new UnmatchedError(status === 'RETURNED' ? 'Say how it was sent back (bank, account, reference).' : 'Say why it can be ignored (e.g. sandbox test money).');
  const r = await prisma.unmatchedPayment.updateMany({ where: { id, status: 'OPEN' }, data: { status, note: text.slice(0, 300), resolvedById: adminId || null, resolvedAt: new Date() } });
  if (r.count !== 1) throw new UnmatchedError('This payment has already been handled.', 409);
  await prisma.auditLog.create({ data: { actorAdminId: adminId || null, action: `UNMATCHED_PAYMENT_${status}`, details: { id, note: text.slice(0, 300) } } }).catch(() => {});
  return { ok: true };
}

module.exports = { record, list, assign, close, retire, retireAllFor, UnmatchedError, NAMES };
