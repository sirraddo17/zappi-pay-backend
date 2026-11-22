// Help chat → quick airtime buy WITHOUT the AI: "₦500 MTN airtime to
// 0816…", "airtime 1k for me". The app reads the message itself and shows
// the same Pay card the AI would (lib/chatBuy.js prepare_purchase), so it
// works when the AI is off, busy or over budget — and costs nothing.
// Nothing is bought here: the customer still taps Pay and confirms with
// their PIN or fingerprint (normal purchase route and checks).

const prisma = require('./prisma');

const NETWORKS = [[/\bmtn\b/i, 'mtn'], [/\bairtel\b/i, 'airtel'], [/\bglo\b/i, 'glo'], [/\b(9mobile|etisalat|t2|t2mobile)\b/i, '9mobile']];

// Returns { amount, network, phone, self } or null when it isn't a clear
// airtime request.
function parse(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length > 120) return null;
  if (!/\b(airtime|recharge|credit|vtu|top ?up)\b/i.test(t)) return null;
  if (/\b(data|bundle|gb|mb|cash|convert|print|pin|refund|fail|didn.?t|not|why|how)\b/i.test(t)) return null;
  // Phone numbers may be typed with spaces or dashes ("0805 123 4567").
  const phoneM = /(?:\+?234|\b0)[789][01](?:[\s-]?\d){8}(?!\d)/.exec(t);
  const phone = phoneM ? phoneM[0].replace(/[\s-]/g, '').replace(/^\+?234/, '0') : null;
  const rest = phoneM ? t.replace(phoneM[0], ' ') : t;
  const amtM = /(?:₦|\bn|\bngn)?\s*(\d{1,3}(?:,\d{3})+|\d{1,6})(\s*k\b)?/i.exec(rest);
  if (!amtM) return null;
  const amount = Number(amtM[1].replace(/,/g, '')) * (amtM[2] ? 1000 : 1);
  if (!(amount >= 50)) return null;
  const self = !phone && /\b(me|my|myself|mine|my line|my number)\b/i.test(t);
  if (!phone && !self) return null;
  const network = (NETWORKS.find(([re]) => re.test(t)) || [])[1] || null;
  return { amount, network, phone, self };
}

async function prepare(customerId, settings, text) {
  const p = parse(text);
  if (!p) return null;
  let phone = p.phone;
  if (!phone) {
    const me = await prisma.customer.findUnique({ where: { id: customerId }, select: { phone: true } });
    phone = me?.phone || null;
    if (!phone) return null;
  }
  const collector = { purchase: null, transfer: null, cards: [], notes: [] };
  const h = require('./chatBuy').handlers(customerId, settings, collector);
  const r = await h.prepare_purchase({ service: 'AIRTIME', network: p.network, recipient: phone, amount: p.amount });
  if (collector.purchase) return { purchase: collector.purchase, reply: `Here’s your airtime — check the number and amount, then tap Pay and confirm with your PIN.` };
  return { reply: r?.error ? r.error.replace(/ Ask for the 11-digit number\.$/, ' Please send the 11-digit number.') : 'I couldn’t prepare that. Try “₦500 MTN airtime to 0803…”.' };
}

module.exports = { parse, prepare };
