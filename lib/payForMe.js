// Pay It For Me: the customer builds a purchase on the Buy screen (their
// own number / meter / decoder) and, instead of paying, shares a link.
// Whoever opens it pays from their wallet and the service goes straight to
// the customer — nobody can "collect money for light" and spend it elsewhere.

const prisma = require('./prisma');
const { notify } = require('./notify');
const { vtpassRequest, getSettings } = require('./vtpass');
const { computePrice } = require('./pricing');
const F = require('./features');

const SERVICES = ['AIRTIME', 'DATA', 'ELECTRICITY', 'CABLE', 'INTERNET', 'EDUCATION'];
const LABEL = { AIRTIME: 'airtime', DATA: 'data', ELECTRICITY: 'electricity', CABLE: 'TV subscription', INTERNET: 'internet', EDUCATION: 'exam PIN' };
const mask = (s) => (String(s).length > 4 ? `••••${String(s).slice(-4)}` : String(s));

async function price(r) {
  const s = await getSettings();
  let base;
  if (r.variationCode) {
    const v = await vtpassRequest('GET', '/service-variations', { query: { serviceID: r.serviceID } });
    const list = v?.content?.variations || v?.content?.varations || [];
    const match = list.find((x) => x.variation_code === r.variationCode);
    if (!match) throw new F.FeatureError('That plan is no longer available.');
    base = Number(match.variation_amount);
  } else base = Number(r.amount);
  return { base, total: computePrice(base, r.service, s).chargeAmount };
}

async function create(requesterId, b = {}) {
  await F.requireOn('payForMe');
  const service = String(b.service || '').toUpperCase();
  if (!SERVICES.includes(service)) throw new F.FeatureError('Choose airtime, data, electricity, TV, internet or an exam PIN.');
  const billersCode = String(b.billersCode || '').trim().slice(0, 40);
  if (!billersCode || !b.serviceID) throw new F.FeatureError('Fill in the number, meter or smartcard first.');
  if (!b.variationCode && !(Number(b.amount) >= 50)) throw new F.FeatureError('Enter an amount.');
  const open = await prisma.payForMe.count({ where: { requesterId, status: 'OPEN' } });
  if (open >= 10) throw new F.FeatureError('You already have 10 open requests. Cancel some first.');
  const r = { service, serviceID: String(b.serviceID), variationCode: b.variationCode || null, billersCode, meterType: service === 'ELECTRICITY' ? (b.meterType === 'postpaid' ? 'postpaid' : 'prepaid') : null, amount: b.variationCode ? null : F.r2(b.amount) };
  const p = await price(r);
  const label = String(b.label || '').trim().slice(0, 80) || `${LABEL[service]}${b.planName ? ` — ${String(b.planName).slice(0, 50)}` : ''}`;
  return prisma.payForMe.create({ data: { token: F.newCode(6), requesterId, ...r, label, note: String(b.note || '').trim().slice(0, 200) || null, status: 'OPEN', expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000) } }).then((x) => ({ ...x, price: p.total }));
}

async function byToken(token) {
  const r = await prisma.payForMe.findUnique({ where: { token: String(token || '') } });
  if (!r) throw new F.FeatureError('This link is not valid.', 404);
  // A paid request whose purchase later failed goes back to open.
  if (r.status === 'PAID' && r.orderId) {
    const o = await prisma.order.findUnique({ where: { id: r.orderId }, select: { status: true } });
    if (o?.status === 'FAILED') return prisma.payForMe.update({ where: { id: r.id }, data: { status: 'OPEN', paidById: null, orderId: null, paidAt: null } });
  }
  return r;
}

async function view(token, viewerId) {
  const r = await byToken(token);
  const who = await prisma.customer.findUnique({ where: { id: r.requesterId }, select: { name: true } });
  const expired = r.status === 'OPEN' && new Date(r.expiresAt) < new Date();
  const p = r.status === 'OPEN' && !expired ? await price(r).catch(() => null) : null;
  const order = r.orderId ? await prisma.order.findUnique({ where: { id: r.orderId } }) : null;
  const isRequester = viewerId === r.requesterId;
  let delivered = null;
  if (isRequester && order?.status === 'SUCCESS') {
    const pl = order.responsePayload || {};
    delivered = String(pl.purchased_code || pl.mainToken || pl.token || pl.content?.transactions?.purchased_code || '').replace(/^Token\s*:\s*/i, '').trim() || null;
  }
  const payer = r.paidById ? await prisma.customer.findUnique({ where: { id: r.paidById }, select: { name: true } }) : null;
  return {
    request: { token: r.token, label: r.label, note: r.note, service: r.service, serviceID: r.serviceID, recipient: isRequester ? r.billersCode : mask(r.billersCode), status: expired ? 'EXPIRED' : r.status, price: p?.total ?? null, requester: who?.name, expiresAt: r.expiresAt, createdAt: r.createdAt, paidBy: payer?.name || null, orderStatus: order?.status || null },
    isRequester,
    delivered,
    orderId: isRequester ? null : r.orderId,
  };
}

async function pay(token, payerId) {
  await F.requireOn('payForMe');
  const r = await byToken(token);
  if (r.status !== 'OPEN') throw new F.FeatureError(r.status === 'PAID' ? 'Someone has already paid this. Thank you!' : 'This request is closed.');
  if (new Date(r.expiresAt) < new Date()) throw new F.FeatureError('This request has expired.');
  // Lock it while we pay, so two people can't pay at once.
  const lock = await prisma.payForMe.updateMany({ where: { id: r.id, status: 'OPEN' }, data: { status: 'PAYING', paidById: payerId } });
  if (lock.count !== 1) throw new F.FeatureError('Someone is paying this right now.');
  const requester = await prisma.customer.findUnique({ where: { id: r.requesterId }, select: { name: true, phone: true } });
  const result = await require('./purchase').performPurchase(payerId, { service: r.service, serviceID: r.serviceID, variationCode: r.variationCode || undefined, billersCode: r.billersCode, phone: requester.phone, amount: r.amount ? Number(r.amount) : undefined, meterType: r.meterType || undefined }, { source: 'payforme' });
  if (result.status === 201 || result.status === 202) {
    await prisma.payForMe.update({ where: { id: r.id }, data: { status: 'PAID', orderId: result.body.order.id, paidAt: new Date() } });
    const payer = await prisma.customer.findUnique({ where: { id: payerId }, select: { name: true } });
    notify(r.requesterId, 'Paid for you 🙏', `${payer?.name} paid your ${r.label} (${r.billersCode}).${r.service === 'ELECTRICITY' ? ' Your token is on the request page in the app.' : ''}`, { category: 'TRANSACTION' });
    return { paid: true, pending: result.status === 202, orderId: result.body.order.id };
  }
  await prisma.payForMe.updateMany({ where: { id: r.id, status: 'PAYING' }, data: { status: 'OPEN', paidById: null } });
  throw new F.FeatureError(result.body?.error || 'The payment didn’t go through.', result.status >= 500 ? 502 : result.status, result.body?.code);
}

async function cancel(token, requesterId) {
  const r = await byToken(token);
  if (r.requesterId !== requesterId) throw new F.FeatureError('Only you can cancel your request.', 403);
  if (r.status !== 'OPEN') throw new F.FeatureError('This request can’t be cancelled now.');
  await prisma.payForMe.update({ where: { id: r.id }, data: { status: 'CANCELLED' } });
  return { cancelled: true };
}

async function mine(requesterId) {
  const list = await prisma.payForMe.findMany({ where: { requesterId }, orderBy: { createdAt: 'desc' }, take: 30 });
  return list.map((r) => ({ token: r.token, label: r.label, recipient: r.billersCode, status: r.status === 'OPEN' && new Date(r.expiresAt) < new Date() ? 'EXPIRED' : r.status, createdAt: r.createdAt, paidAt: r.paidAt }));
}

module.exports = { SERVICES, create, view, pay, cancel, mine };
