// Recharge card printing: customers (mostly agents / shops) buy airtime
// e-PINs from their wallet and print them as cards to resell.
//
// Money rules (same as purchases): the wallet is debited first, the
// order is sent to ClubKonnect, and it settles exactly once. Only a
// definite "not done" reply is refunded straight away; anything unclear
// stays PENDING and is re-checked until ClubKonnect gives the cards or
// a clear failure. If fewer cards arrive than ordered, the missing ones
// are refunded.

const crypto = require('crypto');
const prisma = require('./prisma');
const { getSettings } = require('./vtpass');
const ck = require('./clubkonnect');
const { notify } = require('./notify');

class EpinError extends Error {
  constructor(message, status = 400, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const naira = (n) => `₦${Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

function pricing(settings, isAgent) {
  const disc = Number(isAgent ? settings.epinAgentDiscountPct : settings.epinCustomerDiscountPct) || 0;
  const supplier = Number(settings.epinSupplierDiscountPct) || 0;
  return { discountPct: Math.max(0, disc), supplierPct: Math.max(0, supplier) };
}

function unitPrice(value, discountPct) {
  return round2(value * (1 - discountPct / 100));
}

async function configured(settings) {
  return Boolean(settings.ckEnabled && (await ck.creds(settings)));
}

// What the Print Cards screen needs.
async function options(customerId) {
  const settings = await getSettings();
  const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { isAgent: true, name: true } });
  const { discountPct } = pricing(settings, c?.isAgent);
  return {
    enabled: await configured(settings),
    networks: Object.entries(ck.NETWORKS).map(([key, n]) => ({ key, label: n.label, load: n.load, color: n.color, ink: n.ink })),
    values: ck.VALUES.map((v) => ({ value: v, price: unitPrice(v, discountPct) })),
    discountPct,
    maxPerOrder: ck.MAX_PER_ORDER,
    dailyCards: Number(settings.epinDailyCards) || 300,
    businessName: c?.name || '',
  };
}

function lagosDayStart() {
  const H = 60 * 60 * 1000;
  const ymd = new Date(Date.now() + H).toISOString().slice(0, 10);
  return new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() - H);
}

function newRequestId() {
  return `ZPE${Date.now()}${crypto.randomBytes(3).toString('hex')}`.toUpperCase();
}

// Wallet debit + order. Returns the batch (with cards if delivered).
async function buy(customerId, input) {
  const network = String(input.network || '').toUpperCase();
  const value = Number(input.value);
  const quantity = parseInt(input.quantity, 10);
  if (!ck.NETWORKS[network]) throw new EpinError('Choose a network.');
  if (!ck.VALUES.includes(value)) throw new EpinError('Choose ₦100, ₦200 or ₦500 cards.');
  if (!(quantity >= 1 && quantity <= ck.MAX_PER_ORDER)) throw new EpinError(`You can print 1 to ${ck.MAX_PER_ORDER} cards at a time.`);
  const businessName = String(input.businessName || '').replace(/[<>]/g, '').trim().slice(0, 40) || null;

  const settings = await getSettings();
  if (!(await configured(settings))) throw new EpinError('Recharge card printing is not available yet.', 503, 'EPIN_OFF');
  const paused = require('./maintenance').pauseMessage(settings, 'AIRTIME');
  if (paused) throw new EpinError(paused, 503, 'PAUSED');

  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw new EpinError('Account not found.', 404);
  if (!customer.active) throw new EpinError('This account has been deactivated.', 403);
  const { discountPct, supplierPct } = pricing(settings, customer.isAgent);
  const unit = unitPrice(value, discountPct);
  const amount = round2(unit * quantity);
  const cost = round2(value * (1 - supplierPct / 100) * quantity);

  const today = await prisma.pinBatch.aggregate({ where: { customerId, status: { in: ['PENDING', 'SUCCESS'] }, createdAt: { gte: lagosDayStart() } }, _sum: { quantity: true } });
  const used = Number(today._sum.quantity || 0);
  const cap = Number(settings.epinDailyCards) || 300;
  if (used + quantity > cap) throw new EpinError(`You can print up to ${cap} cards a day (${Math.max(0, cap - used)} left today).`, 403, 'EPIN_DAILY');
  const limitError = await require('./limits').checkDailyLimit(customer, amount, settings);
  if (limitError) throw new EpinError(limitError, 403, 'DAILY_LIMIT');
  const familyError = await require('./family').checkPurchase(customer.id, 'AIRTIME', amount);
  if (familyError) throw new EpinError(familyError, 403, 'FAMILY_LIMIT');
  if (Number(customer.walletBalance) < amount) throw new EpinError('Insufficient wallet balance.', 402, 'INSUFFICIENT_BALANCE');

  const requestId = newRequestId();
  const label = `${quantity} × ${naira(value)} ${ck.NETWORKS[network].label} recharge card${quantity === 1 ? '' : 's'}`;
  let batch;
  await prisma.$transaction(async (tx) => {
    const r = await tx.customer.updateMany({ where: { id: customer.id, walletBalance: { gte: amount } }, data: { walletBalance: { decrement: amount } } });
    if (r.count !== 1) throw new EpinError('Insufficient wallet balance.', 402, 'INSUFFICIENT_BALANCE');
    await tx.walletTransaction.create({ data: { customerId: customer.id, type: 'DEBIT', amount, status: 'APPROVED', reference: requestId, note: `Print ${label}` } });
    batch = await tx.pinBatch.create({ data: { customerId: customer.id, network, value, quantity, unitPrice: unit, amount, costAmount: cost, requestId, businessName, status: 'PENDING' } });
  });

  let reply = null;
  try {
    reply = await ck.buyEpins({ network, value, quantity, requestId }, settings);
  } catch (error) {
    if (error.code !== 'NO_RESPONSE') console.error('ClubKonnect e-PIN order failed:', error.code, error.message);
  }
  const settled = await settle(batch, reply, { first: true });
  if (settled.status === 'PENDING') scheduleChecks(batch.id);
  return view(settled.id, customerId);
}

// Moves a PENDING batch to SUCCESS / FAILED exactly once.
async function settle(batch, reply, { first = false, forceFail = false } = {}) {
  const outcome = forceFail ? 'FAILED' : reply ? ck.classify(reply) : 'PENDING';
  const st = reply ? ck.statusOf(reply) : first ? 'NO_RESPONSE' : batch.providerStatus;
  const orderId = reply?.ORDER_ID || reply?.orderid || reply?.OrderID || undefined;

  if (outcome === 'PENDING') {
    return prisma.pinBatch.update({ where: { id: batch.id }, data: { providerStatus: st || null, ...(orderId ? { providerOrderId: String(orderId) } : {}) } });
  }

  if (outcome === 'FAILED') {
    let claimed = false;
    await prisma.$transaction(async (tx) => {
      const r = await tx.pinBatch.updateMany({ where: { id: batch.id, status: 'PENDING' }, data: { status: 'FAILED', providerStatus: st || 'FAILED', refunded: batch.amount } });
      if (r.count !== 1) return;
      claimed = true;
      await tx.customer.update({ where: { id: batch.customerId }, data: { walletBalance: { increment: batch.amount } } });
      await tx.walletTransaction.create({ data: { customerId: batch.customerId, type: 'REFUND', amount: batch.amount, status: 'APPROVED', reference: batch.requestId, note: 'Refund for recharge cards not printed' } });
    });
    if (claimed) {
      notify(batch.customerId, 'Recharge cards not printed', `Your ${batch.quantity} × ${naira(batch.value)} cards could not be printed. ${naira(batch.amount)} is back in your wallet.`);
      if (/^(INVALID_|MISSING_|INSUFFICIENT_)/.test(st || '')) {
        Promise.resolve(require('./adminAlert').alertAdmins('Recharge card printing failed', `${ck.errorText(st)} A customer was refunded ${naira(batch.amount)}.`, '/admin/settings')).catch(() => {});
      }
    }
    return prisma.pinBatch.findUnique({ where: { id: batch.id } });
  }

  // SUCCESS: store the cards, refund any shortfall.
  const cards = ck.cardsOf(reply).slice(0, batch.quantity);
  const missing = batch.quantity - cards.length;
  const refund = missing > 0 ? round2(Number(batch.unitPrice) * missing) : 0;
  let claimed = false;
  await prisma.$transaction(async (tx) => {
    const r = await tx.pinBatch.updateMany({ where: { id: batch.id, status: 'PENDING' }, data: { status: 'SUCCESS', delivered: cards.length, providerStatus: st || 'ORDER_COMPLETED', refunded: refund, ...(orderId ? { providerOrderId: String(orderId) } : {}) } });
    if (r.count !== 1) return;
    claimed = true;
    await tx.pinCard.createMany({ data: cards.map((c) => ({ batchId: batch.id, pin: c.pin, serial: c.serial, batchNo: c.batchNo })), skipDuplicates: true });
    if (refund > 0) {
      await tx.customer.update({ where: { id: batch.customerId }, data: { walletBalance: { increment: refund } } });
      await tx.walletTransaction.create({ data: { customerId: batch.customerId, type: 'REFUND', amount: refund, status: 'APPROVED', reference: batch.requestId, note: `Refund for ${missing} recharge card${missing === 1 ? '' : 's'} not delivered` } });
    }
  });
  if (claimed) {
    const extra = refund > 0 ? ` ${missing} could not be printed and ${naira(refund)} was refunded.` : '';
    notify(batch.customerId, 'Recharge cards ready', `Your ${cards.length} × ${naira(batch.value)} ${ck.NETWORKS[batch.network]?.label || batch.network} cards are ready to print.${extra}`);
  }
  return prisma.pinBatch.findUnique({ where: { id: batch.id } });
}

// Ask ClubKonnect again about a pending batch.
async function recheck(batchId) {
  const batch = await prisma.pinBatch.findUnique({ where: { id: batchId } });
  if (!batch || batch.status !== 'PENDING') return batch;
  await prisma.pinBatch.update({ where: { id: batch.id }, data: { checks: { increment: 1 } } });
  let reply = null;
  try {
    reply = await ck.query(batch.requestId);
  } catch {
    return prisma.pinBatch.findUnique({ where: { id: batch.id } });
  }
  // "Not found" only counts as failed once enough time has passed for
  // the order to have reached ClubKonnect.
  const st = ck.statusOf(reply);
  if (/NOT_FOUND|INVALID_ORDERID|INVALID_REQUESTID/.test(st) && !ck.cardsOf(reply).length) {
    const age = Date.now() - new Date(batch.createdAt).getTime();
    if (age > 15 * 60 * 1000 && batch.checks >= 3) return settle(batch, reply, { forceFail: true });
    return prisma.pinBatch.findUnique({ where: { id: batch.id } });
  }
  return settle(batch, reply);
}

const CHECK_DELAYS = [8000, 30000, 90000, 5 * 60000, 15 * 60000];
function scheduleChecks(batchId) {
  for (const ms of CHECK_DELAYS) setTimeout(() => recheck(batchId).catch(() => {}), ms).unref?.();
}

// Every 10 minutes: re-check anything still pending (e.g. after a
// restart); alert the owner about batches stuck for over 2 hours.
const alerted = new Set();
async function sweep() {
  const pending = await prisma.pinBatch.findMany({ where: { status: 'PENDING', createdAt: { lte: new Date(Date.now() - 60000) } }, take: 30 });
  for (const b of pending) {
    const after = await recheck(b.id).catch(() => null);
    if (after?.status === 'PENDING' && Date.now() - new Date(b.createdAt).getTime() > 2 * 3600 * 1000 && !alerted.has(b.id)) {
      alerted.add(b.id);
      Promise.resolve(require('./adminAlert').alertAdmins('Recharge cards stuck', `A ${b.quantity} × ₦${b.value} ${b.network} batch (${b.requestId}) has been pending for over 2 hours. Check ClubKonnect, then refund or re-check it in Admin → Settings → Recharge Cards.`, '/admin/settings')).catch(() => {});
    }
  }
}
function startSweeper() {
  setInterval(() => sweep().catch((e) => console.error('e-PIN sweep failed:', e.message)), 10 * 60 * 1000).unref?.();
  setTimeout(() => sweep().catch(() => {}), 30000).unref?.();
}

// --- Views --------------------------------------------------------------

function batchOut(b, cards) {
  const n = ck.NETWORKS[b.network] || {};
  return {
    id: b.id,
    network: b.network,
    networkLabel: n.label || b.network,
    load: n.load,
    color: n.color,
    ink: n.ink,
    value: b.value,
    quantity: b.quantity,
    delivered: b.delivered,
    unitPrice: Number(b.unitPrice),
    amount: Number(b.amount),
    refunded: Number(b.refunded || 0),
    status: b.status,
    businessName: b.businessName,
    printedAt: b.printedAt,
    createdAt: b.createdAt,
    ...(cards ? { cards: cards.map((c) => ({ id: c.id, pin: c.pin, serial: c.serial, soldAt: c.soldAt })) } : {}),
  };
}

async function view(batchId, customerId) {
  const b = await prisma.pinBatch.findFirst({ where: { id: batchId, customerId } });
  if (!b) return null;
  const cards = await prisma.pinCard.findMany({ where: { batchId: b.id }, orderBy: { createdAt: 'asc' } });
  return batchOut(b, cards);
}

async function list(customerId, { take = 30 } = {}) {
  const rows = await prisma.pinBatch.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, take: Math.min(100, take) });
  const out = rows.map((b) => batchOut(b));
  for (const b of out) {
    if (b.status === 'SUCCESS') b.unsold = await prisma.pinCard.count({ where: { batchId: b.id, soldAt: null } });
  }
  return out;
}

async function markPrinted(batchId, customerId) {
  const r = await prisma.pinBatch.updateMany({ where: { id: batchId, customerId, status: 'SUCCESS' }, data: { printedAt: new Date() } });
  if (!r.count) throw new EpinError('Batch not found.', 404);
}

// Agents tick cards off as they sell them.
async function markSold(batchId, customerId, cardIds, sold = true) {
  const b = await prisma.pinBatch.findFirst({ where: { id: batchId, customerId } });
  if (!b) throw new EpinError('Batch not found.', 404);
  const ids = (Array.isArray(cardIds) ? cardIds : []).map(String).slice(0, 100);
  await prisma.pinCard.updateMany({ where: { batchId: b.id, id: { in: ids } }, data: { soldAt: sold ? new Date() : null } });
}

// --- Admin ----------------------------------------------------------------

async function adminOverview() {
  const settings = await getSettings();
  let balance = null;
  let balanceError = null;
  if (await ck.creds(settings)) {
    try { balance = await ck.balance(settings); } catch (e) { balanceError = e.message; }
  }
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const done = await prisma.pinBatch.findMany({ where: { status: 'SUCCESS', createdAt: { gte: since } }, select: { amount: true, refunded: true, costAmount: true, delivered: true, quantity: true }, take: 10000 });
  let cards = 0;
  let sales = 0;
  let cost = 0;
  for (const b of done) {
    cards += b.delivered;
    sales += Number(b.amount) - Number(b.refunded || 0);
    cost += b.quantity ? (Number(b.costAmount || 0) * b.delivered) / b.quantity : 0;
  }
  const pending = await prisma.pinBatch.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 20 });
  const recent = await prisma.pinBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
  return {
    enabled: Boolean(settings.ckEnabled),
    userId: settings.ckUserId || '',
    envCreds: Boolean(process.env.CLUBKONNECT_USER_ID && process.env.CLUBKONNECT_API_KEY),
    keySet: Boolean(settings.ckApiKey || process.env.CLUBKONNECT_API_KEY),
    keyHint: settings.ckApiKey ? `…${String(settings.ckApiKey).slice(-4)}` : null,
    customerDiscountPct: Number(settings.epinCustomerDiscountPct),
    agentDiscountPct: Number(settings.epinAgentDiscountPct),
    supplierDiscountPct: Number(settings.epinSupplierDiscountPct),
    dailyCards: Number(settings.epinDailyCards),
    balance,
    balanceError,
    last30: { cards, sales: round2(sales), estProfit: round2(sales - cost) },
    pending: pending.map((b) => ({ ...batchOut(b), requestId: b.requestId, providerStatus: b.providerStatus })),
    recent: recent.map((b) => ({ ...batchOut(b), customerId: b.customerId, requestId: b.requestId, providerStatus: b.providerStatus })),
  };
}

async function updateSettings(body) {
  const settings = await getSettings();
  const data = {};
  const pct = (v) => Math.min(50, Math.max(0, Math.round(Number(v) * 100) / 100 || 0));
  if (body.ckUserId !== undefined) data.ckUserId = String(body.ckUserId).trim().slice(0, 40) || null;
  if (body.ckApiKeyClear) data.ckApiKey = null;
  else if (body.ckApiKey !== undefined && String(body.ckApiKey).trim()) {
    const k = String(body.ckApiKey).trim();
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(k)) throw new EpinError('That does not look like a ClubKonnect API key.');
    data.ckApiKey = k;
  }
  if (body.epinSupplierDiscountPct !== undefined) data.epinSupplierDiscountPct = pct(body.epinSupplierDiscountPct);
  if (body.epinCustomerDiscountPct !== undefined) data.epinCustomerDiscountPct = pct(body.epinCustomerDiscountPct);
  if (body.epinAgentDiscountPct !== undefined) data.epinAgentDiscountPct = pct(body.epinAgentDiscountPct);
  if (body.epinDailyCards !== undefined) data.epinDailyCards = Math.min(5000, Math.max(1, parseInt(body.epinDailyCards, 10) || 300));
  const supplier = Number(data.epinSupplierDiscountPct ?? settings.epinSupplierDiscountPct);
  for (const k of ['epinCustomerDiscountPct', 'epinAgentDiscountPct']) {
    if (Number(data[k] ?? settings[k]) > supplier) throw new EpinError(`Discounts can't be more than the ${supplier}% ClubKonnect gives you, or you would sell at a loss.`);
  }
  if (body.ckEnabled !== undefined) data.ckEnabled = Boolean(body.ckEnabled);
  const willHaveKey = data.ckApiKey !== undefined ? Boolean(data.ckApiKey || process.env.CLUBKONNECT_API_KEY) : Boolean(settings.ckApiKey || process.env.CLUBKONNECT_API_KEY);
  const willHaveUser = data.ckUserId !== undefined ? Boolean(data.ckUserId || process.env.CLUBKONNECT_USER_ID) : Boolean(settings.ckUserId || process.env.CLUBKONNECT_USER_ID);
  if ((data.ckEnabled ?? settings.ckEnabled) && !(willHaveKey && willHaveUser)) {
    if (data.ckEnabled) throw new EpinError('Save your ClubKonnect UserID and API key first.');
    data.ckEnabled = false;
  }
  await prisma.settings.update({ where: { id: settings.id }, data });
  require('./vtpass').invalidateSettings();
}

// Owner: settle a stuck batch by hand after checking ClubKonnect.
async function adminResolve(batchId, action) {
  const b = await prisma.pinBatch.findUnique({ where: { id: batchId } });
  if (!b) throw new EpinError('Batch not found.', 404);
  if (action === 'recheck') return recheck(b.id);
  if (action === 'refund') {
    if (b.status !== 'PENDING') throw new EpinError('Only pending batches can be refunded.');
    return settle(b, { status: 'ADMIN_REFUND' }, { forceFail: true });
  }
  throw new EpinError('Unknown action.');
}

module.exports = { EpinError, options, buy, settle, recheck, sweep, startSweeper, view, list, markPrinted, markSold, adminOverview, updateSettings, adminResolve, unitPrice };
