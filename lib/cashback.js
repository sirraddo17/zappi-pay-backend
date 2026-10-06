// Separate cashback balance (like OPay): cashback earned is kept apart
// from the wallet; at checkout the customer can switch "Use cashback" on
// and up to cashbackUseMaxPercent of the price is paid from it. It isn't
// cash: it can't be sent or withdrawn, only used on purchases.
// The order's `amount` stays the full price, so earnings reports are not
// changed — the cashback was already counted as a cost when it was earned.

const r2 = (n) => Math.floor(Number(n) * 100) / 100;

const separate = (settings) => settings.cashbackSeparate !== false;

// How much cashback can go towards a purchase of `price`.
function usable(balance, price, settings) {
  const pct = Number(settings.cashbackUseMaxPercent ?? 20);
  return Math.max(0, r2(Math.min(Number(balance || 0), (Number(price) * pct) / 100)));
}

// Credits earned cashback inside a transaction (tx). Returns nothing.
async function creditEarned(tx, settings, { customerId, amount, order, note }) {
  if (separate(settings)) {
    await tx.customer.update({ where: { id: customerId }, data: { cashbackBalance: { increment: amount } } });
    await tx.cashbackEntry.create({ data: { customerId, amount, orderId: order?.id, note: note || 'Cashback earned' } });
  } else {
    await tx.customer.update({ where: { id: customerId }, data: { walletBalance: { increment: amount } } });
    await tx.walletTransaction.create({ data: { customerId, type: 'CASHBACK', amount, status: 'APPROVED', reference: order?.vtpassRequestId, note } });
  }
}

// Splits a refund of `amount` of an order between wallet and cashback,
// in the same proportion it was paid.
function refundSplit(order, amount) {
  const total = Number(order.amount);
  const used = Number(order.cashbackUsed || 0);
  if (!(used > 0) || !(total > 0)) return { wallet: r2(amount), cashback: 0 };
  const cashback = r2(Math.min(used, (Number(amount) * used) / total));
  return { wallet: r2(Number(amount) - cashback), cashback };
}

module.exports = { separate, usable, creditEarned, refundSplit };
