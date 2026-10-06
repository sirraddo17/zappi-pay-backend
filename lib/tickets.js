// Event tickets. Organisers sell tickets; buyers pay by card / transfer
// through Monnify checkout and the ticket money is SPLIT straight to the
// organiser's bank account (a Monnify sub-account). ZAPPI PAY only keeps
// the booking fee — it never holds the organiser's money.

const crypto = require('crypto');
const prisma = require('./prisma');
const { getSettings } = require('./vtpass');
const { notify } = require('./notify');
const F = require('./features');

const APP_URL = (process.env.APP_URL || 'https://www.zappipay.com.ng').replace(/\/$/, '');
const HOLD_MIN = 45; // a checkout holds its tickets this long
const MAX_PER_ORDER = 10;

const monnify = () => require('./monnify');
const ticketCode = () => Array.from(crypto.randomBytes(8), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');

// Booking fee per ticket (whole naira) × how many.
function feeFor(price, qty, s) {
  if (!(price > 0)) return 0;
  return Math.round(Number(s.ticketFeeFlat || 0) + (price * Number(s.ticketFeePercent || 0)) / 100) * qty;
}

async function verifiedCustomer(id) {
  const c = await prisma.customer.findUnique({ where: { id }, select: { id: true, name: true, email: true, phone: true, kycType: true, kycVerifiedAt: true } });
  return { c, verified: Boolean(c?.kycType || c?.kycVerifiedAt) };
}

// --- Organiser ---
async function create(organiserId, b = {}) {
  await F.requireOn('tickets', organiserId);
  const { c, verified } = await verifiedCustomer(organiserId);
  if (!verified) throw new F.FeatureError('Verify your account (get your account number on the Wallet page) to sell tickets.', 403, 'NOT_VERIFIED');
  const title = String(b.title || '').trim().slice(0, 80);
  const venue = String(b.venue || '').trim().slice(0, 120);
  const startsAt = new Date(b.startsAt);
  if (title.length < 3) throw new F.FeatureError('Give the event a name.');
  if (venue.length < 3) throw new F.FeatureError('Where is the event?');
  if (!(startsAt > new Date())) throw new F.FeatureError('Choose a date and time in the future.');
  const types = (Array.isArray(b.types) ? b.types : []).slice(0, 6).map((t) => ({ name: String(t.name || '').trim().slice(0, 40), price: F.r2(t.price || 0), quantity: Math.floor(Number(t.quantity)) }));
  if (!types.length) throw new F.FeatureError('Add at least one ticket type (e.g. Regular, VIP).');
  for (const t of types) {
    if (!t.name) throw new F.FeatureError('Every ticket type needs a name.');
    if (t.price !== 0 && !(t.price >= 100 && t.price <= 5000000)) throw new F.FeatureError('Ticket prices are free (₦0) or between ₦100 and ₦5,000,000.');
    if (!(t.quantity >= 1 && t.quantity <= 100000)) throw new F.FeatureError('How many tickets of each type? (1 to 100,000)');
  }
  const paid = types.some((t) => t.price > 0);
  let bank = {};
  if (paid) {
    const accountNumber = String(b.accountNumber || '').replace(/\D/g, '');
    if (!b.bankCode || accountNumber.length !== 10) throw new F.FeatureError('Choose the bank account ticket money should go to.');
    const acct = await require('./disbursement').lookupAccount(b.bankCode, accountNumber).catch((e) => { throw new F.FeatureError(`We couldn’t find that bank account (${e.message}).`); });
    let sub;
    try {
      const r = await monnify().api('POST', '/api/v1/sub-accounts', [{ currencyCode: 'NGN', bankCode: String(b.bankCode), accountNumber, email: c.email || `${String(c.phone).replace(/\D/g, '')}@customers.zappipay.com.ng`, defaultSplitPercentage: 100 }]);
      sub = Array.isArray(r) ? r[0] : r;
    } catch (e) {
      throw new F.FeatureError(`We couldn’t set up payouts to that account (${e.message}). Please try again later.`, 502);
    }
    if (!sub?.subAccountCode) throw new F.FeatureError('We couldn’t set up payouts to that account. Please try again later.', 502);
    bank = { bankCode: String(b.bankCode), accountNumber, accountName: acct.accountName, subAccountCode: sub.subAccountCode };
  }
  const ev = await prisma.ticketEvent.create({ data: { code: F.newCode(5), organiserId, title, description: String(b.description || '').trim().slice(0, 1500) || null, venue, startsAt, status: 'ON_SALE', ...bank } });
  for (const t of types) await prisma.ticketType.create({ data: { eventId: ev.id, ...t } });
  return ev;
}

async function soldCounts(eventId) {
  const since = new Date(Date.now() - HOLD_MIN * 60 * 1000);
  const orders = await prisma.ticketOrder.findMany({ where: { eventId, status: { in: ['PAID', 'PENDING'] } } });
  const sold = new Map();
  const held = new Map();
  for (const o of orders) {
    if (o.status === 'PAID') sold.set(o.typeId, (sold.get(o.typeId) || 0) + o.quantity);
    else if (new Date(o.createdAt) > since) held.set(o.typeId, (held.get(o.typeId) || 0) + o.quantity);
  }
  return { sold, held };
}

async function publicView(code, viewerId) {
  const ev = await prisma.ticketEvent.findUnique({ where: { code: String(code || '') } });
  if (!ev) throw new F.FeatureError('This event link is not valid.', 404);
  const types = await prisma.ticketType.findMany({ where: { eventId: ev.id } });
  const { sold, held } = await soldCounts(ev.id);
  const s = await getSettings();
  const org = await prisma.customer.findUnique({ where: { id: ev.organiserId }, select: { name: true, username: true } });
  const mine = viewerId ? await prisma.ticket.count({ where: { eventId: ev.id, buyerId: viewerId } }) : 0;
  return {
    event: { code: ev.code, title: ev.title, description: ev.description, venue: ev.venue, startsAt: ev.startsAt, status: ev.startsAt < new Date() && ev.status === 'ON_SALE' ? 'ENDED' : ev.status, organiser: org?.name, organiserUsername: org?.username },
    types: types.map((t) => {
      const left = Math.max(0, t.quantity - (sold.get(t.id) || 0) - (held.get(t.id) || 0));
      return { id: t.id, name: t.name, price: Number(t.price), left, soldOut: left === 0, fee: feeFor(Number(t.price), 1, s) };
    }),
    isOrganiser: viewerId === ev.organiserId,
    myTickets: mine,
  };
}

// --- Buyer ---
async function checkout(code, buyerId, { typeId, quantity } = {}) {
  await F.requireOn('tickets', buyerId);
  const ev = await prisma.ticketEvent.findUnique({ where: { code: String(code || '') } });
  if (!ev || ev.status !== 'ON_SALE' || ev.startsAt < new Date()) throw new F.FeatureError('Tickets for this event are not on sale.');
  const type = await prisma.ticketType.findUnique({ where: { id: String(typeId || '') } });
  if (!type || type.eventId !== ev.id) throw new F.FeatureError('Choose a ticket type.');
  const qty = Math.floor(Number(quantity));
  if (!(qty >= 1 && qty <= MAX_PER_ORDER)) throw new F.FeatureError(`Buy 1 to ${MAX_PER_ORDER} tickets at a time.`);
  const { sold, held } = await soldCounts(ev.id);
  const left = type.quantity - (sold.get(type.id) || 0) - (held.get(type.id) || 0);
  if (qty > left) throw new F.FeatureError(left > 0 ? `Only ${left} left.` : 'Sold out.');
  const s = await getSettings();
  const amount = F.r2(Number(type.price) * qty);
  const fee = feeFor(Number(type.price), qty, s);
  const reference = `TKT-${crypto.randomBytes(8).toString('hex')}`;
  const buyer = await prisma.customer.findUnique({ where: { id: buyerId }, select: { name: true, email: true, phone: true } });
  if (amount === 0) {
    const mineFree = await prisma.ticket.count({ where: { eventId: ev.id, buyerId } });
    if (mineFree + qty > MAX_PER_ORDER) throw new F.FeatureError(`You can get up to ${MAX_PER_ORDER} free tickets for this event.`);
    const order = await prisma.ticketOrder.create({ data: { reference, eventId: ev.id, typeId: type.id, buyerId, quantity: qty, amount: 0, fee: 0, status: 'PENDING' } });
    await issue(order.id);
    return { free: true, reference };
  }
  if (!ev.subAccountCode) throw new F.FeatureError('This event can’t take payments yet.');
  const order = await prisma.ticketOrder.create({ data: { reference, eventId: ev.id, typeId: type.id, buyerId, quantity: qty, amount, fee, status: 'PENDING' } });
  const c = await monnify().getConfig();
  let r;
  try {
    r = await monnify().api('POST', '/api/v1/merchant/transactions/init-transaction', {
      amount: F.r2(amount + fee),
      customerName: buyer.name,
      customerEmail: buyer.email || `${String(buyer.phone).replace(/\D/g, '')}@customers.zappipay.com.ng`,
      paymentReference: reference,
      paymentDescription: `${qty} × ${type.name} — ${ev.title}`.slice(0, 80),
      currencyCode: 'NGN',
      contractCode: c.contractCode,
      redirectUrl: `${APP_URL}/tickets/order/${reference}`,
      paymentMethods: ['CARD', 'ACCOUNT_TRANSFER', 'USSD'],
      incomeSplitConfig: [{ subAccountCode: ev.subAccountCode, splitAmount: amount, feePercentage: 0, feeBearer: false }],
    });
  } catch (e) {
    await prisma.ticketOrder.update({ where: { id: order.id }, data: { status: 'FAILED' } });
    throw new F.FeatureError(`Payment couldn’t start (${e.message}). Please try again.`, 502);
  }
  await prisma.ticketOrder.update({ where: { id: order.id }, data: { monnifyRef: r.transactionReference, checkoutUrl: r.checkoutUrl } });
  return { reference, checkoutUrl: r.checkoutUrl, total: F.r2(amount + fee) };
}

async function issue(orderId) {
  const o = await prisma.ticketOrder.findUnique({ where: { id: orderId } });
  const done = await prisma.ticketOrder.updateMany({ where: { id: orderId, status: 'PENDING' }, data: { status: 'PAID', paidAt: new Date() } });
  if (done.count !== 1) return false;
  for (let i = 0; i < o.quantity; i++) {
    for (let tries = 0; tries < 5; tries++) {
      try { await prisma.ticket.create({ data: { code: ticketCode(), orderId: o.id, eventId: o.eventId, typeId: o.typeId, buyerId: o.buyerId } }); break; } catch (e) { if (e.code !== 'P2002' || tries === 4) throw e; }
    }
  }
  const ev = await prisma.ticketEvent.findUnique({ where: { id: o.eventId } });
  notify(o.buyerId, 'Your tickets 🎟️', `${o.quantity} ticket${o.quantity === 1 ? '' : 's'} for “${ev.title}” — open My tickets to show the QR code at the door.`, { category: 'TRANSACTION' });
  if (Number(o.amount) > 0) notify(ev.organiserId, 'Ticket sale 🎟️', `${o.quantity} ticket${o.quantity === 1 ? '' : 's'} sold for “${ev.title}” — ${F.naira(o.amount)} is on its way to your bank account.`, { category: 'TRANSACTION' });
  return true;
}

// Asks Monnify whether a checkout was paid; issues the tickets if so.
async function confirm(reference) {
  const o = await prisma.ticketOrder.findUnique({ where: { reference: String(reference || '') } });
  if (!o) return { status: 'UNKNOWN' };
  if (o.status !== 'PENDING' || !o.monnifyRef) return { status: o.status };
  const txn = await monnify().api('GET', `/api/v2/transactions/${encodeURIComponent(o.monnifyRef)}`).catch(() => null);
  if (!txn) return { status: 'PENDING' };
  if (txn.paymentStatus === 'PAID') {
    if (Number(txn.amountPaid) + 0.01 < Number(o.amount) + Number(o.fee)) {
      await prisma.ticketOrder.update({ where: { id: o.id }, data: { status: 'FAILED' } });
      require('./adminAlert').alertAdmins('Ticket payment short', `${o.reference}: paid ${txn.amountPaid}, expected ${Number(o.amount) + Number(o.fee)}`, '/admin/extra-services').catch?.(() => {});
      return { status: 'FAILED' };
    }
    await issue(o.id);
    return { status: 'PAID' };
  }
  if (['FAILED', 'EXPIRED', 'CANCELLED', 'ABANDONED'].includes(txn.paymentStatus) || Date.now() - new Date(o.createdAt) > 3 * 3600 * 1000) {
    await prisma.ticketOrder.updateMany({ where: { id: o.id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
    return { status: 'EXPIRED' };
  }
  return { status: 'PENDING' };
}

async function orderView(reference, viewerId) {
  let o = await prisma.ticketOrder.findUnique({ where: { reference: String(reference || '') } });
  if (!o || o.buyerId !== viewerId) throw new F.FeatureError('Order not found.', 404);
  if (o.status === 'PENDING') { await confirm(o.reference); o = await prisma.ticketOrder.findUnique({ where: { id: o.id } }); }
  const ev = await prisma.ticketEvent.findUnique({ where: { id: o.eventId } });
  return { status: o.status, event: { code: ev.code, title: ev.title }, quantity: o.quantity, total: F.r2(Number(o.amount) + Number(o.fee)), checkoutUrl: o.status === 'PENDING' ? o.checkoutUrl : null };
}

async function myTickets(buyerId) {
  const tickets = await prisma.ticket.findMany({ where: { buyerId }, take: 100 });
  const evIds = [...new Set(tickets.map((t) => t.eventId))];
  const events = new Map((await prisma.ticketEvent.findMany({ where: { id: { in: evIds } } })).map((e) => [e.id, e]));
  const types = new Map((await prisma.ticketType.findMany({ where: { eventId: { in: evIds } } })).map((t) => [t.id, t]));
  return tickets.map((t) => {
    const e = events.get(t.eventId);
    return { code: t.code, event: e?.title, eventCode: e?.code, venue: e?.venue, startsAt: e?.startsAt, type: types.get(t.typeId)?.name, checkedInAt: t.checkedInAt };
  }).sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
}

// --- Organiser dashboard ---
async function mine(organiserId) {
  const list = await prisma.ticketEvent.findMany({ where: { organiserId } });
  return list.sort((a, b) => new Date(b.startsAt) - new Date(a.startsAt)).map((e) => ({ id: e.id, code: e.code, title: e.title, startsAt: e.startsAt, status: e.status }));
}

async function dashboard(eventId, organiserId) {
  const ev = await prisma.ticketEvent.findUnique({ where: { id: eventId } });
  if (!ev || ev.organiserId !== organiserId) throw new F.FeatureError('Event not found.', 404);
  const types = await prisma.ticketType.findMany({ where: { eventId } });
  const paid = await prisma.ticketOrder.findMany({ where: { eventId, status: 'PAID' } });
  const tickets = await prisma.ticket.findMany({ where: { eventId } });
  const buyers = new Map((await prisma.customer.findMany({ where: { id: { in: [...new Set(tickets.map((t) => t.buyerId))] } }, select: { id: true, name: true, phone: true } })).map((c) => [c.id, c]));
  const tName = new Map(types.map((t) => [t.id, t.name]));
  return {
    event: { id: ev.id, code: ev.code, title: ev.title, venue: ev.venue, startsAt: ev.startsAt, status: ev.status, description: ev.description, payout: ev.accountName ? `${ev.accountName} · ${ev.accountNumber}` : null },
    types: types.map((t) => ({ id: t.id, name: t.name, price: Number(t.price), quantity: t.quantity, sold: paid.filter((o) => o.typeId === t.id).reduce((n, o) => n + o.quantity, 0) })),
    totals: { tickets: tickets.length, checkedIn: tickets.filter((t) => t.checkedInAt).length, money: F.r2(paid.reduce((n, o) => n + Number(o.amount), 0)) },
    attendees: tickets.map((t) => ({ code: t.code, name: buyers.get(t.buyerId)?.name, phone: buyers.get(t.buyerId)?.phone, type: tName.get(t.typeId), checkedInAt: t.checkedInAt })),
  };
}

async function checkIn(eventId, organiserId, codeIn) {
  const ev = await prisma.ticketEvent.findUnique({ where: { id: eventId } });
  if (!ev || ev.organiserId !== organiserId) throw new F.FeatureError('Event not found.', 404);
  const code = String(codeIn || '').toUpperCase().match(/[A-Z2-9]{8}/)?.[0];
  if (!code) throw new F.FeatureError('That doesn’t look like a ticket code.');
  const t = await prisma.ticket.findUnique({ where: { code } });
  if (!t || t.eventId !== ev.id) return { ok: false, reason: 'NOT_FOUND', message: '❌ Not a ticket for this event.' };
  const who = await prisma.customer.findUnique({ where: { id: t.buyerId }, select: { name: true } });
  const type = await prisma.ticketType.findUnique({ where: { id: t.typeId } });
  if (t.checkedInAt) return { ok: false, reason: 'USED', message: `⚠️ Already used at ${new Date(t.checkedInAt).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' })}.`, name: who?.name, type: type?.name };
  const r = await prisma.ticket.updateMany({ where: { id: t.id, checkedInAt: null }, data: { checkedInAt: new Date() } });
  if (r.count !== 1) return { ok: false, reason: 'USED', message: '⚠️ Already used.' };
  return { ok: true, message: `✅ Welcome, ${who?.name || 'guest'}!`, name: who?.name, type: type?.name };
}

async function setStatus(eventId, organiserId, status) {
  const ev = await prisma.ticketEvent.findUnique({ where: { id: eventId } });
  if (!ev || ev.organiserId !== organiserId) throw new F.FeatureError('Event not found.', 404);
  if (!['ON_SALE', 'CLOSED', 'CANCELLED'].includes(status)) throw new F.FeatureError('Unknown status.');
  if (status === 'CANCELLED' && (await prisma.ticketOrder.count({ where: { eventId, status: 'PAID', amount: { gt: 0 } } }))) throw new F.FeatureError('Tickets have been sold, so the event can’t be cancelled here. Close sales instead, and refund buyers yourself if the event won’t hold.');
  await prisma.ticketEvent.update({ where: { id: eventId }, data: { status } });
  return { ok: true };
}

// Background: confirm checkouts whose webhook we missed.
async function sweep() {
  if (!(await F.anyOn('tickets'))) return;
  const list = await prisma.ticketOrder.findMany({ where: { status: 'PENDING', createdAt: { gte: new Date(Date.now() - 6 * 3600 * 1000) } }, take: 50 });
  for (const o of list) await confirm(o.reference).catch(() => {});
}

async function adminOverview() {
  const events = (await prisma.ticketEvent.findMany({ take: 50 })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const orgs = new Map((await prisma.customer.findMany({ where: { id: { in: [...new Set(events.map((e) => e.organiserId))] } }, select: { id: true, name: true, phone: true } })).map((c) => [c.id, c]));
  const paid = await prisma.ticketOrder.findMany({ where: { status: 'PAID' } });
  return {
    events: events.map((e) => {
      const o = paid.filter((x) => x.eventId === e.id);
      return { id: e.id, code: e.code, title: e.title, startsAt: e.startsAt, status: e.status, organiser: orgs.get(e.organiserId), sold: o.reduce((n, x) => n + x.quantity, 0), money: F.r2(o.reduce((n, x) => n + Number(x.amount), 0)), fees: F.r2(o.reduce((n, x) => n + Number(x.fee), 0)) };
    }),
    totals: { fees: F.r2(paid.reduce((n, x) => n + Number(x.fee), 0)), tickets: paid.reduce((n, x) => n + x.quantity, 0) },
  };
}

async function adminStop(eventId) {
  await prisma.ticketEvent.update({ where: { id: eventId }, data: { status: 'CLOSED' } });
  return { ok: true };
}

module.exports = { feeFor, create, publicView, checkout, confirm, issue, orderView, myTickets, mine, dashboard, checkIn, setStatus, sweep, adminOverview, adminStop };
