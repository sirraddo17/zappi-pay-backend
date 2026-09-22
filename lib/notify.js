const prisma = require('./prisma');

// Creates one notification row for a customer. Called from every
// place an event should surface via the notification bell —
// funding approved/rejected, a purchase succeeding or failing, an
// admin wallet adjustment, or a support ticket being resolved.
// Deliberately fire-and-forget: a notification failing to write
// should never block the actual action (a payment, an admin
// decision) that triggered it, so callers should not await this
// inside a transaction and should swallow/log any error here
// rather than let it propagate.
async function notify(customerId, title, message) {
  try {
    await prisma.notification.create({ data: { customerId, title, message } });
  } catch (error) {
    console.error('notify() failed:', error);
  }
}

module.exports = { notify };
