// More bills through Flutterwave Bills (tax, waste, water, tolls, schools
// & professional bodies, religious institutions, donations …). The
// customer pays from their wallet; ZAPPI PAY pays the biller from its
// Flutterwave balance (which the admin keeps funded).

const crypto = require('crypto');
const prisma = require('./prisma');
const { getSettings } = require('./vtpass');
const { notify } = require('./notify');
const F = require('./features');

const flw = () => require('./flutterwave');
const cache = new Map();
async function cached(key, ms, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}
const call = async (method, path, body) => {
  try { return await flw().api(method, path, body); } catch (e) {
    if (e.code === 'NOT_CONFIGURED') throw new F.FeatureError('More bills isn’t set up yet.', 503, 'NOT_CONFIGURED');
    throw new F.FeatureError(e.message || 'The biller service is not available right now.', e.status || 502, e.code);
  }
};
const hidden = (s) => (Array.isArray(s.billsHiddenCategories) ? s.billsHiddenCategories.map(String) : []);

async function categories() {
  const s = await getSettings();
  const all = await cached('cats', 6 * 3600 * 1000, async () => (await call('GET', '/top-bill-categories?country=NG')).data || []);
  return all.filter((c) => !hidden(s).includes(String(c.code))).map((c) => ({ code: c.code, name: c.name, description: c.description }));
}

async function allCategories() {
  const s = await getSettings();
  const all = await cached('cats', 6 * 3600 * 1000, async () => (await call('GET', '/top-bill-categories?country=NG')).data || []);
  return all.map((c) => ({ code: c.code, name: c.name, hidden: hidden(s).includes(String(c.code)) }));
}

async function billers(category) {
  const cat = String(category || '').replace(/[^A-Za-z0-9_-]/g, '');
  const s = await getSettings();
  if (!cat || hidden(s).includes(cat)) throw new F.FeatureError('That category isn’t available.');
  const list = await cached(`b:${cat}`, 6 * 3600 * 1000, async () => (await call('GET', `/bills/${encodeURIComponent(cat)}/billers?country=NG`)).data || []);
  return list.map((b) => ({ code: b.biller_code, name: b.name, shortName: b.short_name, description: b.description, logo: b.logo || null }));
}

async function items(billerCode) {
  const code = String(billerCode || '').replace(/[^A-Za-z0-9_-]/g, '');
  const s = await getSettings();
  const list = await cached(`i:${code}`, 3600 * 1000, async () => (await call('GET', `/billers/${encodeURIComponent(code)}/items`)).data || []);
  return list.map((i) => ({ code: i.item_code, name: i.name || i.short_name, billerName: i.biller_name, label: i.label_name || 'Customer ID', amount: Number(i.amount || 0), fixed: Number(i.amount || 0) > 0, providerFee: Number(i.fee || 0), ourFee: Number(s.billsFee || 0), category: i.category_name }));
}

async function findItem(billerCode, itemCode) {
  const it = (await items(billerCode)).find((i) => i.code === itemCode);
  if (!it) throw new F.FeatureError('That option is no longer available.');
  return it;
}

async function validate(customerId, { billerCode, itemCode, customer } = {}) {
  await F.requireOn('moreBills', customerId);
  const ref = String(customer || '').trim().slice(0, 40);
  if (!ref) throw new F.FeatureError('Enter the customer / account number.');
  const r = await call('GET', `/bill-items/${encodeURIComponent(itemCode)}/validate?code=${encodeURIComponent(billerCode)}&customer=${encodeURIComponent(ref)}`).catch((e) => ({ error: e.message }));
  if (r.error) return { ok: false, message: r.error };
  const d = r.data || {};
  return { ok: true, name: d.name || d.customer_name || null, minimum: d.minimum || null, maximum: d.maximum || null };
}

function readStatus(data) {
  const st = String(data?.status || data?.transaction_status || data?.response_message || '').toLowerCase();
  if (/success|completed|delivered/.test(st)) return 'SUCCESS';
  if (/fail|error|declin|revers/.test(st)) return 'FAILED';
  return 'PENDING';
}
const tokenOf = (d) => String(d?.recharge_token || d?.extra || d?.token || '').replace(/^Token\s*:\s*/i, '').trim() || null;

async function pay(customerId, b = {}) {
  await F.requireOn('moreBills', customerId);
  await F.checkSpend(customerId);
  const billerCode = String(b.billerCode || '');
  const itemCode = String(b.itemCode || '');
  const it = await findItem(billerCode, itemCode); // also fails early if Flutterwave isn't set up
  const customerRef = String(b.customer || '').trim().slice(0, 40);
  if (!customerRef) throw new F.FeatureError(`Enter the ${it.label.toLowerCase()}.`);
  const amount = it.fixed ? it.amount : F.r2(b.amount);
  if (!(amount >= 50 && amount <= 2000000)) throw new F.FeatureError('Enter an amount between ₦50 and ₦2,000,000.');
  const fee = F.r2(it.providerFee + it.ourFee);
  const total = F.r2(amount + fee);
  const reference = `BIL-${crypto.randomBytes(8).toString('hex')}`;
  let bill;
  const ok = await F.move({
    fromId: customerId, toId: null, amount: total, outType: 'BILL_PAY', outNote: `${it.billerName || it.name}: ${customerRef}`,
    extra: async (tx) => { bill = await tx.billPayment.create({ data: { reference, customerId, category: String(b.category || it.category || ''), billerCode, billerName: it.billerName || '', itemCode, itemName: it.name, customerRef, customerName: b.customerName ? String(b.customerName).slice(0, 80) : null, amount, fee, status: 'PENDING' } }); },
  });
  if (!ok) throw new F.FeatureError('Insufficient wallet balance.', 402, 'INSUFFICIENT_BALANCE');
  let status = 'PENDING';
  let data = null;
  try {
    const r = await flw().api('POST', `/billers/${encodeURIComponent(billerCode)}/items/${encodeURIComponent(itemCode)}/payment`, { country: 'NG', customer_id: customerRef, amount, reference });
    data = r.data || {};
    status = r.status === 'success' ? (readStatus(data) === 'FAILED' ? 'FAILED' : readStatus(data) === 'SUCCESS' ? 'SUCCESS' : 'PENDING') : 'FAILED';
  } catch (e) {
    // A clear "bad request" from Flutterwave means nothing was paid.
    status = e.status === 400 || e.code === 'NOT_CONFIGURED' ? 'FAILED' : 'PENDING';
    data = { error: String(e.message).slice(0, 300) };
  }
  await finish(bill.id, status, data);
  return { reference, status: status === 'FAILED' ? 'FAILED' : status, total, message: status === 'FAILED' ? (data?.error || 'The payment didn’t go through — your money is back in your wallet.') : null };
}

async function finish(id, status, data) {
  const bill = await prisma.billPayment.findUnique({ where: { id } });
  if (!bill || bill.status !== 'PENDING') return bill;
  if (status === 'PENDING') { await prisma.billPayment.update({ where: { id }, data: { response: data || undefined, providerRef: data?.flw_ref || data?.tx_ref || bill.providerRef } }); return bill; }
  const r = await prisma.billPayment.updateMany({ where: { id, status: 'PENDING' }, data: { status, response: data || undefined, token: tokenOf(data), providerRef: data?.flw_ref || data?.tx_ref || null } });
  if (r.count !== 1) return bill;
  const total = F.r2(Number(bill.amount) + Number(bill.fee));
  if (status === 'FAILED') {
    await prisma.$transaction(async (tx) => { await F.credit(tx, bill.customerId, total, 'REFUND', `${bill.billerName || 'Bill'} payment failed — refunded`); });
    notify(bill.customerId, 'Bill payment failed — refunded', `Your ${bill.billerName || 'bill'} payment for ${bill.customerRef} didn’t go through. ${F.naira(total)} is back in your wallet.`, { category: 'TRANSACTION' });
  } else {
    const t = tokenOf(data);
    notify(bill.customerId, 'Bill paid ✅', `${bill.billerName || 'Bill'} (${bill.itemName}) for ${bill.customerRef}: ${F.naira(bill.amount)} paid.${t ? ` Token/receipt: ${t}` : ''}`, { category: 'TRANSACTION' });
  }
  return bill;
}

async function refresh(reference) {
  const bill = await prisma.billPayment.findUnique({ where: { reference } });
  if (!bill || bill.status !== 'PENDING') return bill?.status;
  const r = await flw().api('GET', `/bills/${encodeURIComponent(reference)}`).catch(() => null);
  if (!r) return 'PENDING';
  const st = r.status === 'success' ? readStatus(r.data) : 'PENDING';
  // Older than 2 hours with no answer and a clear success missing: leave for the admin.
  if (st !== 'PENDING') await finish(bill.id, st, r.data);
  return st;
}

async function history(customerId) {
  const list = (await prisma.billPayment.findMany({ where: { customerId }, take: 30, orderBy: { createdAt: 'desc' } })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return list.map((x) => ({ reference: x.reference, biller: x.billerName, item: x.itemName, customer: x.customerRef, amount: Number(x.amount), fee: Number(x.fee), status: x.status, token: x.token, createdAt: x.createdAt }));
}

async function view(customerId, reference) {
  let bill = await prisma.billPayment.findUnique({ where: { reference: String(reference || '') } });
  if (!bill || bill.customerId !== customerId) throw new F.FeatureError('Not found.', 404);
  if (bill.status === 'PENDING') { await refresh(bill.reference); bill = await prisma.billPayment.findUnique({ where: { id: bill.id } }); }
  return { reference: bill.reference, biller: bill.billerName, item: bill.itemName, customer: bill.customerRef, amount: Number(bill.amount), fee: Number(bill.fee), status: bill.status, token: bill.token, createdAt: bill.createdAt };
}

async function sweep() {
  if (!(await F.anyOn('moreBills'))) return;
  const list = await prisma.billPayment.findMany({ where: { status: 'PENDING', createdAt: { gte: new Date(Date.now() - 48 * 3600 * 1000) } }, take: 50 });
  for (const b of list) await refresh(b.reference).catch(() => {});
}

// --- Admin ---
async function adminOverview() {
  const s = await getSettings();
  const recent = (await prisma.billPayment.findMany({ take: 40, orderBy: { createdAt: 'desc' } })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return {
    config: { fee: Number(s.billsFee), hidden: hidden(s) },
    categories: await allCategories().catch((e) => ({ error: e.message })),
    recent: recent.map((x) => ({ reference: x.reference, biller: x.billerName, item: x.itemName, customer: x.customerRef, amount: Number(x.amount), fee: Number(x.fee), status: x.status, createdAt: x.createdAt })),
  };
}

// Admin settles a payment stuck on pending after checking Flutterwave.
async function adminResolve(reference, outcome) {
  const bill = await prisma.billPayment.findUnique({ where: { reference } });
  if (!bill) throw new F.FeatureError('Not found.', 404);
  if (bill.status !== 'PENDING') throw new F.FeatureError('This payment is already settled.');
  if (!['SUCCESS', 'FAILED'].includes(outcome)) throw new F.FeatureError('Choose paid or failed.');
  await finish(bill.id, outcome, { status: outcome.toLowerCase(), resolvedBy: 'admin' });
  return { ok: true };
}

module.exports = { categories, allCategories, billers, items, validate, pay, refresh, history, view, sweep, adminOverview, adminResolve, readStatus };
