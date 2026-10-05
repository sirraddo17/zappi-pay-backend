// Cashback balance, kept apart from the wallet (like OPay's "Use
// Cashback"). Earned cashback lands here; at checkout the customer can
// switch it on to take part of it off the price. How much can be used
// depends on the purchase: at most cashbackUseMaxPercent of the price,
// and never more than they have. The rest stays for next time.
//
// The order's amount stays the full price, so earnings are unchanged —
// the cashback was already counted as a reward when it was earned.

const r2 = (n) => Math.floor(Number(n) * 100) / 100;

function pocketOn(settings) {
  return settings.cashbackPocketEnabled !== false;
}

// How much of `balance` can go towards a purchase costing `price`.
function usable(balance, price, settings) {
  const pct = Math.min(100, Math.max(0, Number(settings.cashbackUseMaxPercent ?? 15)));
  return Math.max(0, r2(Math.min(Number(balance) || 0, (Number(price) * pct) / 100, Number(price))));
}

// Credits earned cashback (inside a transaction): to the cashback
// balance, or straight into the wallet when the pocket is switched off.
async function credit(tx, { customerId, amount, reference, note }, settings) {
  const pocket = pocketOn(settings) ? 'CASHBACK' : 'WALLET';
  await tx.customer.update({ where: { id: customerId }, data: pocket === 'CASHBACK' ? { cashbackBalance: { increment: amount } } : { walletBalance: { increment: amount } } });
  await tx.walletTransaction.create({ data: { customerId, type: 'CASHBACK', amount, status: 'APPROVED', reference, note, pocket } });
  return pocket;
}

// Takes `amount` off the cashback balance for an order (inside a
// transaction). Throws if the balance changed and is now too low.
async function spend(tx, { customerId, amount, reference, service }) {
  const r = await tx.customer.updateMany({ where: { id: customerId, cashbackBalance: { gte: amount } }, data: { cashbackBalance: { decrement: amount } } });
  if (r.count !== 1) {
    const e = new Error('Your cashback balance changed. Please try again.');
    e.code = 'CASHBACK_CHANGED';
    throw e;
  }
  await tx.walletTransaction.create({ data: { customerId, type: 'CASHBACK_USED', amount, status: 'APPROVED', reference, pocket: 'CASHBACK', note: `Cashback used on ${String(service).toLowerCase()} purchase` } });
}

// Gives cashback back after a failed (or partly delivered) order.
async function giveBack(tx, { customerId, amount, reference, note, providerRef }) {
  await tx.customer.update({ where: { id: customerId }, data: { cashbackBalance: { increment: amount } } });
  await tx.walletTransaction.create({ data: { customerId, type: 'CASHBACK_REFUND', amount, status: 'APPROVED', reference, note, pocket: 'CASHBACK', ...(providerRef ? { providerRef } : {}) } });
}

// Splits an order's refund into the wallet part and the cashback part,
// in the same proportion they were paid.
function splitRefund(order, refund) {
  const total = Number(order.amount);
  const used = Number(order.cashbackUsed || 0);
  if (!(used > 0) || !(total > 0)) return { wallet: r2(refund), cashback: 0 };
  const cashback = r2(Math.min(used, (refund * used) / total));
  return { wallet: Math.round((refund - cashback) * 100) / 100, cashback };
}

module.exports = { pocketOn, usable, credit, spend, giveBack, splitRefund };
