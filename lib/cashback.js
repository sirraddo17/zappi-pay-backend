// Cashback — a closed-loop discount kept apart from the wallet.
//  • Earned only after an order succeeds (EARNED), never on pending or
//    failed orders, never on test orders.
//  • Spent only on purchases: at checkout up to cashbackUseMaxPercent
//    (20%) of the price (USED). It can't be sent, withdrawn or paid out.
//  • A failed order gives back exactly the cashback it used (RETURNED).
//  • Expires cashbackExpiryDays (90) after it is earned; the soonest-
//    expiring cashback is used first (EXPIRED).
// Every change is a new CashbackEntry row in integer kobo; rows are never
// edited. Customer.cashbackBalance is the running total, changed in the
// same transaction as the row. One order can only EARN / USE / RETURN
// once (unique orderId + type), so retries and duplicate webhooks can't
// pay twice.

const prisma = require('./prisma');
const { toKobo, toNaira, nairaNum, pctOf } = require('./money');

const DAY = 24 * 60 * 60 * 1000;
// Cashback from before the ledger (no expiry date) expires counting from here.
const LEDGER_START = new Date('2026-11-01T00:00:00+01:00');
const CREDIT_TYPES = new Set(['EARNED', 'RETURNED', 'ADJUSTMENT']);

const separate = (settings) => settings.cashbackSeparate !== false;
const maxPercent = (settings) => Number(settings.cashbackUseMaxPercent ?? 20);
const expiryDays = (settings) => Math.max(1, parseInt(settings.cashbackExpiryDays ?? 90, 10) || 90);

class CashbackError extends Error {}

// ---- spending ---------------------------------------------------------------

// Kobo of cashback that can pay for a purchase of priceKobo.
function usableKobo(balanceKobo, priceKobo, settings) {
  return Math.max(0, Math.min(Math.max(0, balanceKobo), pctOf(Math.max(0, priceKobo), maxPercent(settings))));
}

// Same in naira (older callers / screens).
function usable(balance, price, settings) {
  return nairaNum(usableKobo(toKobo(balance), toKobo(price), settings));
}

// ---- the ledger ---------------------------------------------------------------

function entryKobo(e) {
  return e.amountKobo ?? toKobo(e.amount);
}

function entryType(e) {
  if (e.type) return e.type;
  const k = entryKobo(e);
  if (k < 0) return 'USED';
  return /^returned:/i.test(String(e.note || '')) ? 'RETURNED' : 'EARNED';
}

// When a credit row expires (older rows: counted from LEDGER_START).
function expiryOf(e, settings) {
  if (e.expiresAt) return new Date(e.expiresAt);
  const from = Math.max(new Date(e.createdAt).getTime(), LEDGER_START.getTime());
  return new Date(from + expiryDays(settings) * DAY);
}

// Replays a customer's rows into "lots" (each credit and what is left of
// it). Debits use the soonest-expiring lot that was still valid then.
function lots(entries, settings) {
  const list = [];
  const sorted = [...entries].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt) || String(a.id).localeCompare(String(b.id)));
  for (const e of sorted) {
    const k = entryKobo(e);
    const type = entryType(e);
    const at = new Date(e.createdAt);
    if (k > 0) {
      list.push({ id: e.id, orderId: e.orderId, type, kobo: k, left: k, expiresAt: expiryOf(e, settings), createdAt: at });
      continue;
    }
    let need = -k;
    if (type === 'EXPIRED' && e.reference && e.reference.startsWith('exp:')) {
      const lot = list.find((l) => l.id === e.reference.slice(4));
      if (lot) { const t = Math.min(lot.left, need); lot.left -= t; need -= t; }
    }
    if (type === 'REVERSED' && e.orderId) {
      const lot = list.find((l) => l.orderId === e.orderId && l.type === 'EARNED');
      if (lot) { const t = Math.min(lot.left, need); lot.left -= t; need -= t; }
    }
    const open = list.filter((l) => l.left > 0 && (type === 'EXPIRED' || l.expiresAt > at)).sort((a, b) => a.expiresAt - b.expiresAt);
    for (const lot of open) {
      if (need <= 0) break;
      const t = Math.min(lot.left, need);
      lot.left -= t;
      need -= t;
    }
  }
  return list;
}

async function balanceRow(tx, customerId) {
  const c = await tx.customer.findUnique({ where: { id: customerId }, select: { cashbackBalance: true } });
  return toKobo(c?.cashbackBalance || 0);
}

// Inside a transaction: adds a row and moves Customer.cashbackBalance.
// For a debit the balance must cover it (else CashbackError).
async function addEntry(tx, { customerId, kobo, type, orderId, note, reference, expiresAt, skipBalance }) {
  if (!Number.isInteger(kobo) || kobo === 0) throw new CashbackError(`Bad cashback amount: ${kobo}`);
  if (!skipBalance) {
    if (kobo < 0) {
      const r = await tx.customer.updateMany({ where: { id: customerId, cashbackBalance: { gte: toNaira(-kobo) } }, data: { cashbackBalance: { decrement: toNaira(-kobo) } } });
      if (r.count !== 1) throw new CashbackError('Not enough cashback.');
    } else {
      await tx.customer.update({ where: { id: customerId }, data: { cashbackBalance: { increment: toNaira(kobo) } } });
    }
  }
  const after = await balanceRow(tx, customerId);
  return tx.cashbackEntry.create({ data: { customerId, amount: toNaira(kobo), amountKobo: kobo, balanceAfterKobo: after, type, orderId: orderId || null, note: note || null, reference: reference || null, expiresAt: expiresAt || null } });
}

// Soonest expiry among the cashback still usable (for USED rows and screens).
async function oldestExpiry(db, customerId, settings) {
  const rows = await db.cashbackEntry.findMany({ where: { customerId } });
  const open = lots(rows, settings).filter((l) => l.left > 0 && l.expiresAt > new Date()).sort((a, b) => a.expiresAt - b.expiresAt);
  return open[0]?.expiresAt || null;
}

// ---- earning ------------------------------------------------------------------

// Credits cashback (a reward) inside a transaction. `amount` in naira, or
// `kobo`. Separate balance: an EARNED row (ADJUSTMENT for an admin's
// manual credit). Old mode (cashback straight into the wallet): a wallet
// CASHBACK transaction. Returns the kobo credited.
async function creditEarned(tx, settings, { customerId, amount, kobo, order, note, type, expiresAt }) {
  const k = Number.isInteger(kobo) ? kobo : toKobo(amount);
  if (!(k > 0)) return 0;
  if (order?.isTest) return 0; // test orders earn nothing
  if (separate(settings)) {
    await addEntry(tx, {
      customerId,
      kobo: k,
      type: type || 'EARNED',
      orderId: order?.id,
      note: note || 'Cashback earned',
      expiresAt: expiresAt || new Date(Date.now() + expiryDays(settings) * DAY),
    });
  } else {
    await tx.customer.update({ where: { id: customerId }, data: { walletBalance: { increment: toNaira(k) } } });
    await tx.walletTransaction.create({ data: { customerId, type: 'CASHBACK', amount: toNaira(k), status: 'APPROVED', reference: order?.vtpassRequestId, note } });
  }
  return k;
}

// ---- checkout -------------------------------------------------------------------

// Inside the purchase transaction, after the balance was taken: the USED row.
async function recordUsed(tx, settings, { customerId, orderId, kobo, service }) {
  const exp = await oldestExpiry(tx, customerId, settings);
  return addEntry(tx, { customerId, kobo: -kobo, type: 'USED', orderId, note: `Used on ${String(service || 'a').toLowerCase()} purchase`, expiresAt: exp, skipBalance: true });
}

// ---- refunds ------------------------------------------------------------------

// Splits a refund of `amount` (naira) of an order between the wallet (cash)
// and cashback, exactly, in kobo. A full refund gives back exactly the cash
// that left the wallet and exactly the cashback used. Throws if the parts
// don't add up — the caller must not refund, and alerts the owner.
function refundSplit(order, amount = order.amount) {
  const totalK = toKobo(order.amount);
  const usedK = Math.max(0, Math.min(toKobo(order.cashbackUsed || 0), totalK));
  const refundK = Math.min(toKobo(amount), totalK);
  let cashbackK;
  if (refundK === totalK) cashbackK = usedK;
  else cashbackK = totalK > 0 ? Math.floor((refundK * usedK) / totalK) : 0;
  const walletK = refundK - cashbackK;
  if (walletK < 0 || cashbackK < 0 || walletK + cashbackK !== refundK) throw new CashbackError(`Refund split does not add up for order ${order.id}: ${walletK} + ${cashbackK} ≠ ${refundK}`);
  if (refundK === totalK && walletK !== totalK - usedK) throw new CashbackError(`Full refund for order ${order.id} is not the cash debited: ${walletK} vs ${totalK - usedK}`);
  return { walletKobo: walletK, cashbackKobo: cashbackK, wallet: nairaNum(walletK), cashback: nairaNum(cashbackK) };
}

// Inside the refund transaction: gives back cashback used on an order.
// type RETURNED (order failed) or ADJUSTMENT (part of an order refunded).
async function returnUsed(tx, settings, { order, kobo, type = 'RETURNED', note }) {
  if (!(kobo > 0)) return null;
  const used = await tx.cashbackEntry.findFirst({ where: { orderId: order.id, type: 'USED' } });
  const soon = new Date(Date.now() + 3 * DAY);
  const exp = used?.expiresAt && new Date(used.expiresAt) > soon ? new Date(used.expiresAt) : soon;
  return addEntry(tx, { customerId: order.customerId, kobo, type, orderId: order.id, note: note || `Returned: failed ${String(order.service).toLowerCase()} purchase`, expiresAt: exp });
}

// A delivered order refunded later: take back the cashback it earned
// (as much as is still in the balance).
async function reverseEarned(tx, { order, note }) {
  const earned = await tx.cashbackEntry.findFirst({ where: { orderId: order.id, type: 'EARNED' } });
  if (!earned) return 0;
  const k = Math.min(entryKobo(earned), await balanceRow(tx, order.customerId));
  if (!(k > 0)) return 0;
  await addEntry(tx, { customerId: order.customerId, kobo: -k, type: 'REVERSED', orderId: order.id, note: note || 'Cashback taken back: purchase refunded' });
  return k;
}

// ---- expiry -------------------------------------------------------------------

// Writes EXPIRED rows for cashback past its date (once per lot).
async function expireDue({ now = new Date(), limit = 500 } = {}) {
  const settings = await require('./vtpass').getSettings();
  const holders = await prisma.customer.findMany({ where: { cashbackBalance: { gt: 0 } }, select: { id: true }, take: limit });
  let count = 0;
  let kobo = 0;
  for (const { id } of holders) {
    const rows = await prisma.cashbackEntry.findMany({ where: { customerId: id } });
    const due = lots(rows, settings).filter((l) => l.left > 0 && l.expiresAt <= now);
    for (const lot of due) {
      try {
        await prisma.$transaction(async (tx) => {
          const bal = await balanceRow(tx, id);
          const k = Math.min(lot.left, bal);
          if (k > 0) await addEntry(tx, { customerId: id, kobo: -k, type: 'EXPIRED', reference: `exp:${lot.id}`, note: 'Cashback expired' });
        });
        count += 1;
        kobo += lot.left;
      } catch (e) {
        if (e.code !== 'P2002') console.error('cashback expiry failed:', e.message);
      }
    }
  }
  return { count, kobo };
}

function startExpiry() {
  if (process.env.DISABLE_SCHEDULER === '1') return;
  require('./quietClock').every('cashback expiry', 6 * 60 * 60 * 1000, () => expireDue().catch((e) => console.error('cashback expiry:', e.message)), { firstAfter: 15 * 60 * 1000 });
}

// ---- for screens ----------------------------------------------------------------

async function summary(customerId, settings) {
  const [c, rows] = await Promise.all([
    prisma.customer.findUnique({ where: { id: customerId }, select: { cashbackBalance: true } }),
    prisma.cashbackEntry.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, take: 200 }),
  ]);
  const now = new Date();
  const open = lots(rows, settings).filter((l) => l.left > 0 && l.expiresAt > now).sort((a, b) => a.expiresAt - b.expiresAt);
  return {
    balanceKobo: toKobo(c?.cashbackBalance || 0),
    oldestExpiry: open[0]?.expiresAt || null,
    oldestExpiryKobo: open[0]?.left || 0,
    entries: rows.slice(0, 30).map((e) => ({ id: e.id, type: entryType(e), amountKobo: entryKobo(e), amount: nairaNum(entryKobo(e)), note: e.note, orderId: e.orderId, expiresAt: CREDIT_TYPES.has(entryType(e)) ? expiryOf(e, settings) : null, createdAt: e.createdAt })),
  };
}

// Express middleware for every route that moves money out (transfers,
// bank payouts): asking to use cashback there is refused.
function refuseOut(req, res, next) {
  const b = req.body || {};
  const asked = [b.source, b.from, b.fromBalance, b.balance, b.wallet, b.fundingSource].some((v) => /cashback/i.test(String(v || ''))) || b.useCashback === true || b.fromCashback === true;
  if (asked) return res.status(400).json({ error: 'Cashback can only be used to pay for purchases. It can’t be sent, withdrawn or paid out.', code: 'CASHBACK_NOT_CASH' });
  return next();
}

module.exports = { refuseOut, separate, maxPercent, expiryDays, usable, usableKobo, creditEarned, recordUsed, refundSplit, returnUsed, reverseEarned, expireDue, startExpiry, summary, lots, entryType, entryKobo, addEntry, CashbackError, LEDGER_START };
