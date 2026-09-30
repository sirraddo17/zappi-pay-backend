const crypto = require('crypto');
const prisma = require('./prisma');

// Gift cards for airtime / data bought for someone else.
const THEMES = ['BIRTHDAY', 'THANKS', 'LOVE', 'CONGRATS', 'JUST_BECAUSE'];
const GIFTABLE = ['AIRTIME', 'DATA'];
const APP_URL = (process.env.APP_URL || 'https://www.zappipay.com.ng').replace(/\/$/, '');

class GiftError extends Error {}

function cleanMessage(m) {
  const s = String(m || '')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 160);
  return s || null;
}

function firstName(c) {
  const n = String(c?.name || '').trim().split(/\s+/)[0];
  return (n || c?.username || 'A friend').slice(0, 30);
}

const maskPhone = (p) => {
  const s = String(p || '').replace(/\D/g, '');
  return s.length >= 4 ? `•••• ${s.slice(-4)}` : '••••';
};

// "0803 123 4567" → "2348031234567" for a WhatsApp chat link.
function waNumber(p) {
  const s = String(p || '').replace(/\D/g, '');
  if (/^0[789]\d{9}$/.test(s)) return `234${s.slice(1)}`;
  if (/^234[789]\d{9}$/.test(s)) return s;
  return null;
}

function linkFor(gift) {
  return `${APP_URL}/gift/${gift.token}`;
}

async function createGift(customerId, orderId, { message, theme, fromName } = {}) {
  const order = await prisma.order.findFirst({ where: { id: orderId, customerId } });
  if (!order) throw new GiftError('Purchase not found.');
  if (!GIFTABLE.includes(order.service)) throw new GiftError('Only airtime and data can be sent as a gift.');
  if (!['SUCCESS', 'PENDING'].includes(order.status)) throw new GiftError("This purchase didn't go through, so it can't be a gift.");
  const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { name: true, username: true, phone: true } });
  if (customer?.phone && String(customer.phone).replace(/\D/g, '').slice(-10) === String(order.recipient).replace(/\D/g, '').slice(-10)) {
    throw new GiftError("You can't send a gift to your own number.");
  }
  const data = {
    message: cleanMessage(message),
    theme: THEMES.includes(theme) ? theme : 'JUST_BECAUSE',
    fromName: String(fromName || '').trim().slice(0, 30) || firstName(customer),
  };
  const existing = await prisma.gift.findUnique({ where: { orderId } });
  if (existing) return prisma.gift.update({ where: { id: existing.id }, data });
  return prisma.gift.create({ data: { ...data, orderId, customerId, token: crypto.randomBytes(9).toString('base64url') } });
}

function planLabel(order) {
  // Plan names aren't stored on the order; the data amount is enough.
  return order.service === 'AIRTIME' ? 'airtime' : 'data';
}

const NETWORK = { mtn: 'MTN', airtel: 'Airtel', glo: 'Glo', etisalat: '9mobile', '9mobile': '9mobile' };

// What the public gift page shows.
async function publicView(token, { countView = true } = {}) {
  const gift = await prisma.gift.findUnique({ where: { token: String(token || '') } });
  if (!gift) return null;
  const order = await prisma.order.findUnique({ where: { id: gift.orderId } });
  if (!order || ['FAILED', 'REFUNDED'].includes(order.status)) return null;
  if (countView) {
    prisma.gift.update({ where: { id: gift.id }, data: { viewCount: { increment: 1 }, ...(gift.firstViewedAt ? {} : { firstViewedAt: new Date() }) } }).catch(() => {});
  }
  const sender = await prisma.customer.findUnique({ where: { id: gift.customerId }, select: { username: true } });
  return {
    fromName: gift.fromName,
    message: gift.message,
    theme: gift.theme,
    service: order.service,
    kind: planLabel(order),
    network: NETWORK[String(order.provider).toLowerCase().split('-')[0]] || null,
    // Face value (what VTpass delivered), not what the sender paid.
    value: Math.round(Number(order.costAmount || order.amount)),
    to: maskPhone(order.recipient),
    delivered: order.status === 'SUCCESS',
    sentAt: gift.createdAt,
    ref: sender?.username || null,
  };
}

async function forOrder(customerId, orderId) {
  const gift = await prisma.gift.findFirst({ where: { orderId, customerId } });
  if (!gift) return null;
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  return { ...gift, link: linkFor(gift), whatsapp: waNumber(order?.recipient) };
}

module.exports = { THEMES, GIFTABLE, GiftError, createGift, publicView, forOrder, linkFor, waNumber, cleanMessage, maskPhone };
