const prisma = require('./prisma');

// Web push notifications (phone/desktop notifications for the installed
// app). VAPID keys are created automatically the first time and kept in
// Settings, so nothing needs setting up on Render.
let webpush = null;
try {
  webpush = require('web-push');
} catch {
  console.warn('web-push not installed — push notifications disabled.');
}

let keysReady = null;
async function ensureKeys() {
  if (!webpush) return null;
  if (keysReady) return keysReady;
  let s = await prisma.settings.findFirst();
  if (!s) s = await prisma.settings.create({ data: {} });
  if (!s.vapidPublicKey || !s.vapidPrivateKey) {
    const k = webpush.generateVAPIDKeys();
    // Only fill if still empty, so two servers starting together agree.
    await prisma.settings.updateMany({ where: { id: s.id, vapidPublicKey: null }, data: { vapidPublicKey: k.publicKey, vapidPrivateKey: k.privateKey } });
    s = await prisma.settings.findUnique({ where: { id: s.id } });
  }
  webpush.setVapidDetails(`mailto:${process.env.EMAIL_REPLY_TO || 'support@zappipay.com.ng'}`, s.vapidPublicKey, s.vapidPrivateKey);
  keysReady = { publicKey: s.vapidPublicKey };
  return keysReady;
}

async function publicKey() {
  const k = await ensureKeys();
  return k ? k.publicKey : null;
}

async function sendTo(subs, payload) {
  if (!subs.length || !(await ensureKeys())) return { sent: 0 };
  const body = JSON.stringify(payload);
  let sent = 0;
  const dead = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body, { TTL: 24 * 3600 });
      sent += 1;
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) dead.push(sub.id);
      else console.error('push failed:', error.statusCode, error.body || error.message);
    }
  }
  if (dead.length) await prisma.pushSubscription.deleteMany({ where: { id: { in: dead } } }).catch(() => {});
  return { sent, removed: dead.length };
}

async function pushToCustomer(customerId, title, message, url = '/notifications') {
  try {
    const subs = await prisma.pushSubscription.findMany({ where: { customerId } });
    return await sendTo(subs, { title, body: message, url });
  } catch (error) {
    console.error('pushToCustomer failed:', error.message);
    return { sent: 0 };
  }
}

// Admin announcement to everyone who turned notifications on.
async function pushToAll(title, message, url = '/') {
  let sent = 0;
  let cursor;
  for (;;) {
    const subs = await prisma.pushSubscription.findMany({ take: 200, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}), orderBy: { id: 'asc' } });
    if (!subs.length) break;
    sent += (await sendTo(subs, { title, body: message, url })).sent;
    cursor = subs[subs.length - 1].id;
  }
  return { sent };
}

module.exports = { publicKey, pushToCustomer, pushToAll };
