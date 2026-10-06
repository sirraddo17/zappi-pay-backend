// Bulk SMS: customers send SMS to their own contacts through VTpass
// Messaging (messaging.vtpass.com), paid from their wallet per SMS page.
// Sender names must be the default one or approved by the admin (who
// registers it on the VTpass Messaging dashboard first).

const prisma = require('./prisma');
const { getSettings } = require('./vtpass');
const F = require('./features');

const NORMAL_URL = 'https://messaging.vtpass.com/api/sms/sendsms';
const DND_URL = 'https://messaging.vtpass.com/v2/api/sms/dnd-route';
const MAX_PAGES = 6;
const CHUNK = 200;

// GSM-7 characters fit 160 per SMS (153 when split); anything else
// (emoji, some accents) makes it a "unicode" SMS: 70 (67 when split).
const GSM = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = '^{}\\[~]|€';
function pagesFor(message) {
  const text = String(message || '');
  let gsm = true;
  let len = 0;
  for (const ch of text) {
    if (GSM.includes(ch)) len += 1;
    else if (GSM_EXT.includes(ch)) len += 2;
    else { gsm = false; break; }
  }
  if (!gsm) {
    const n = [...text].length;
    return { unicode: true, chars: n, pages: n <= 70 ? 1 : Math.ceil(n / 67) };
  }
  return { unicode: false, chars: len, pages: len <= 160 ? 1 : Math.ceil(len / 153) };
}

// Nigerian numbers only, as 234XXXXXXXXXX, de-duplicated.
function parseRecipients(input) {
  const raw = String(input || '').split(/[\s,;]+/).map((x) => x.replace(/[^\d+]/g, '')).filter(Boolean);
  const good = [];
  const bad = [];
  const seen = new Set();
  for (const r of raw) {
    let n = r.replace(/^\+/, '');
    if (/^0\d{10}$/.test(n)) n = `234${n.slice(1)}`;
    else if (/^\d{10}$/.test(n) && /^[789]/.test(n)) n = `234${n}`;
    if (!/^234[789][01]\d{8}$/.test(n)) { bad.push(r); continue; }
    if (!seen.has(n)) { seen.add(n); good.push(n); }
  }
  return { numbers: good, invalid: bad };
}

// Names nobody but the real owner should send as.
const BLOCKED = /\b(cbn|efcc|nimc|firs|ncc|police|army|dss|inec|govt|government|mtn|glo|airtel|9mobile|etisalat|zenith|gtb|gtbank|access|firstbank|first\s*bank|uba|fidelity|union|sterling|wema|polaris|ecobank|stanbic|fcmb|keystone|opay|palmpay|moniepoint|kuda|paystack|flutterwave|monnify|vtpass|whatsapp|facebook|google|apple|dhl|nipost|jamb|waec|neco|bank|loan|lottery|bet9ja|sportybet)\b/i;
function checkSenderName(name) {
  const n = String(name || '').trim();
  if (!/^[A-Za-z0-9 .&-]{3,11}$/.test(n) || !/[A-Za-z]/.test(n)) throw new F.FeatureError('Sender names are 3–11 letters or numbers (for example “MAMAPUT” or “GraceChurch”).');
  if (BLOCKED.test(n.replace(/[-.&]/g, ' '))) throw new F.FeatureError('That sender name looks like a bank, network, government agency or another company. Use your own business name.');
  return n;
}

const SCAM = /\b(bvn|pin|otp|password|passcode|atm card|card number|cvv)\b/i;
function checkMessage(message) {
  const m = String(message || '').trim();
  if (m.length < 2) throw new F.FeatureError('Type your message.');
  if (SCAM.test(m) && /\b(send|share|give|reply|tell|confirm|update|verify|click)\b/i.test(m)) throw new F.FeatureError('Messages asking people for a PIN, OTP, BVN, password or card details can’t be sent.');
  const p = pagesFor(m);
  if (p.pages > MAX_PAGES) throw new F.FeatureError(`That message is too long (${p.pages} SMS pages). Keep it to ${MAX_PAGES} pages or fewer.`);
  return { message: m, ...p };
}

async function keys(s) {
  const pk = String(s.smsPublicKey || process.env.VTPASS_SMS_PUBLIC_KEY || '').trim();
  const sk = String(s.smsSecretKey || process.env.VTPASS_SMS_SECRET_KEY || '').trim();
  if (!pk || !sk) throw new F.FeatureError('Bulk SMS isn’t set up yet.', 503, 'NOT_CONFIGURED');
  return { 'X-Token': pk, 'X-Secret': sk };
}

async function senders(customerId) {
  const s = await getSettings();
  const mine = await prisma.smsSender.findMany({ where: { customerId } });
  return { defaultSender: s.smsDefaultSender || 'ZAPPIPAY', senders: mine.sort((a, b) => a.name.localeCompare(b.name)).map((x) => ({ id: x.id, name: x.name, status: x.status, note: x.note })) };
}

async function requestSender(customerId, { name, purpose } = {}) {
  await F.requireOn('bulkSms', customerId);
  const n = checkSenderName(name);
  const p = String(purpose || '').trim().slice(0, 200);
  if (p.length < 10) throw new F.FeatureError('Tell us what you’ll use it for (for example “Sales alerts for my shop customers”).');
  const count = await prisma.smsSender.count({ where: { customerId, status: 'PENDING' } });
  if (count >= 3) throw new F.FeatureError('You already have 3 sender names waiting for approval.');
  try {
    const r = await prisma.smsSender.create({ data: { customerId, name: n, purpose: p, status: 'PENDING' } });
    require('./adminAlert').alertAdmins('Sender name request', `“${n}” — ${p}`, '/admin/extra-services').catch?.(() => {});
    return r;
  } catch (e) {
    if (e.code === 'P2002') throw new F.FeatureError('You’ve already asked for that name.');
    throw e;
  }
}

async function quote(customerId, b = {}) {
  const s = await getSettings();
  const { numbers, invalid } = parseRecipients(b.recipients);
  const m = checkMessage(b.message);
  const dnd = Boolean(b.dnd);
  const price = Number(dnd ? s.smsDndPricePerPage : s.smsPricePerPage);
  return { recipients: numbers.length, invalid, pages: m.pages, unicode: m.unicode, chars: m.chars, pricePerPage: price, cost: F.r2(numbers.length * m.pages * price), dnd };
}

async function callProvider(headers, { sender, numbers, message, dnd }) {
  const params = new URLSearchParams({ sender, recipient: numbers.join(','), message, responsetype: 'json' });
  const res = dnd
    ? await fetch(DND_URL, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() })
    : await fetch(`${NORMAL_URL}?${params.toString()}`, { method: 'GET', headers });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  const ok = data.responseCode === 'TG00';
  const list = Array.isArray(data.messages) ? data.messages : [];
  const sent = ok ? (list.length ? list.filter((x) => String(x.statusCode) === '0000').length : numbers.length) : 0;
  return { sent, failed: numbers.length - sent, ref: data.batchId ? String(data.batchId) : null, data: { responseCode: data.responseCode, response: data.response, batchId: data.batchId, failed: list.filter((x) => String(x.statusCode) !== '0000').slice(0, 20) } };
}

async function send(customerId, b = {}) {
  const s = await F.requireOn('bulkSms', customerId);
  const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { kycType: true, kycVerifiedAt: true } });
  if (!c?.kycType && !c?.kycVerifiedAt) throw new F.FeatureError('Verify your account (get your account number on the Wallet page) to send bulk SMS.', 403, 'NOT_VERIFIED');
  await F.checkSpend(customerId);
  const headers = await keys(s);
  const def = s.smsDefaultSender || 'ZAPPIPAY';
  const sender = String(b.sender || def).trim();
  if (sender !== def) {
    const ok = await prisma.smsSender.findUnique({ where: { customerId_name: { customerId, name: sender } } });
    if (!ok || ok.status !== 'APPROVED') throw new F.FeatureError('That sender name hasn’t been approved yet.');
  }
  const q = await quote(customerId, b);
  const { numbers } = parseRecipients(b.recipients);
  if (!numbers.length) throw new F.FeatureError('Add at least one valid Nigerian phone number.');
  if (numbers.length > Number(s.smsMaxRecipients || 1000)) throw new F.FeatureError(`You can send to up to ${Number(s.smsMaxRecipients || 1000).toLocaleString()} numbers at once.`);
  const message = checkMessage(b.message).message;
  let batch;
  const ok = await F.move({
    fromId: customerId, toId: null, amount: q.cost, outType: 'SMS', outNote: `Bulk SMS to ${numbers.length} number${numbers.length === 1 ? '' : 's'} (${q.pages} page${q.pages === 1 ? '' : 's'})`,
    extra: async (tx) => { batch = await tx.smsBatch.create({ data: { customerId, sender, route: q.dnd ? 'DND' : 'NORMAL', message, recipients: numbers.length, pages: q.pages, cost: q.cost, status: 'SENDING' } }); },
  });
  if (!ok) throw new F.FeatureError('Insufficient wallet balance.', 402, 'INSUFFICIENT_BALANCE');

  let sent = 0;
  const refs = [];
  const details = [];
  for (let i = 0; i < numbers.length; i += CHUNK) {
    const part = numbers.slice(i, i + CHUNK);
    try {
      const r = await callProvider(headers, { sender, numbers: part, message, dnd: q.dnd });
      sent += r.sent;
      if (r.ref) refs.push(r.ref);
      details.push(r.data);
    } catch (e) {
      details.push({ error: String(e.message).slice(0, 200) });
    }
  }
  const failed = numbers.length - sent;
  const refund = F.r2(failed * q.pages * q.pricePerPage);
  if (refund > 0) await prisma.$transaction(async (tx) => { await F.credit(tx, customerId, refund, 'REFUND', `Bulk SMS: ${failed} number${failed === 1 ? '' : 's'} not sent — refunded`); });
  const status = sent === 0 ? 'FAILED' : failed ? 'PARTIAL' : 'SENT';
  await prisma.smsBatch.update({ where: { id: batch.id }, data: { sent, failed, refunded: refund, status, providerRef: refs.join(',') || null, response: details } });
  return { id: batch.id, status, sent, failed, cost: q.cost, refunded: refund };
}

async function history(customerId) {
  const list = (await prisma.smsBatch.findMany({ where: { customerId }, take: 30, orderBy: { createdAt: 'desc' } })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return list.map((x) => ({ id: x.id, sender: x.sender, route: x.route, message: x.message, recipients: x.recipients, pages: x.pages, cost: Number(x.cost), refunded: Number(x.refunded), sent: x.sent, failed: x.failed, status: x.status, createdAt: x.createdAt }));
}

// --- Admin ---
async function adminOverview() {
  const s = await getSettings();
  const pending = await prisma.smsSender.findMany({ where: { status: 'PENDING' }, take: 50 });
  const ids = [...new Set(pending.map((p) => p.customerId))];
  const who = new Map((await prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, phone: true } })).map((c) => [c.id, c]));
  const batches = (await prisma.smsBatch.findMany({ take: 20, orderBy: { createdAt: 'desc' } })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return {
    config: { keysSet: Boolean((s.smsPublicKey || process.env.VTPASS_SMS_PUBLIC_KEY) && (s.smsSecretKey || process.env.VTPASS_SMS_SECRET_KEY)), pricePerPage: Number(s.smsPricePerPage), dndPricePerPage: Number(s.smsDndPricePerPage), defaultSender: s.smsDefaultSender, maxRecipients: s.smsMaxRecipients },
    pending: pending.map((p) => ({ id: p.id, name: p.name, purpose: p.purpose, customer: who.get(p.customerId), createdAt: p.createdAt })),
    batches: batches.map((x) => ({ id: x.id, sender: x.sender, message: x.message.slice(0, 160), recipients: x.recipients, cost: Number(x.cost), refunded: Number(x.refunded), status: x.status, createdAt: x.createdAt })),
  };
}

async function reviewSender(id, approve, note) {
  const x = await prisma.smsSender.findUnique({ where: { id } });
  if (!x) throw new F.FeatureError('Not found.', 404);
  await prisma.smsSender.update({ where: { id }, data: { status: approve ? 'APPROVED' : 'REJECTED', note: String(note || '').slice(0, 200) || null } });
  require('./notify').notify(x.customerId, approve ? 'Sender name approved ✅' : 'Sender name not approved', approve ? `You can now send SMS as “${x.name}”.` : `“${x.name}” wasn’t approved${note ? `: ${note}` : '.'}`, { category: 'ACCOUNT' });
  return { ok: true };
}

module.exports = { pagesFor, parseRecipients, checkSenderName, checkMessage, senders, requestSender, quote, send, history, adminOverview, reviewSender };
