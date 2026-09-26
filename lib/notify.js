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
  emailAlert(customerId, title, message);
  require('./push').pushToCustomer(customerId, title, message).catch(() => {});
}

// Money in/out and security events also go out by email, when the
// admin has turned email alerts on and the customer hasn't opted out.
const EMAIL_TITLES = new Set([
  'Wallet Funded',
  'Purchase Successful',
  'Purchase Failed',
  'Money Received',
  'Money Sent',
  'Bank Transfer Successful',
  'Bank Transfer Failed',
  'Cashback Received',
  'Contest Prize',
  'Referral Bonus',
  'New Login',
  'PIN Changed',
  'PIN Created',
  'Password Changed',
]);

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function emailAlert(customerId, title, message) {
  if (!EMAIL_TITLES.has(title)) return;
  try {
    const { sendEmail, isEmailConfigured } = require('./email');
    if (!isEmailConfigured()) return;
    const settings = await prisma.settings.findFirst({ select: { emailAlertsEnabled: true } });
    if (!settings?.emailAlertsEnabled) return;
    const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { email: true, name: true, emailAlerts: true, deletedAt: true } });
    if (!customer?.email || !customer.emailAlerts || customer.deletedAt) return;
    const appUrl = (process.env.APP_URL || 'https://www.zappipay.com.ng').replace(/\/$/, '');
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#0f172a">
        <div style="background:#7c3aed;color:#fff;padding:18px 22px;border-radius:12px 12px 0 0;font-size:20px;font-weight:bold">ZAPPI PAY</div>
        <div style="border:1px solid #e5e7eb;border-top:none;padding:22px;border-radius:0 0 12px 12px">
          <p>Hi ${escapeHtml(customer.name.split(' ')[0])},</p>
          <h2 style="font-size:18px;margin:0 0 8px">${escapeHtml(title)}</h2>
          <p style="line-height:1.5">${escapeHtml(message)}</p>
          <p><a href="${appUrl}" style="background:#7c3aed;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open ZappiPay</a></p>
          <p style="color:#64748b;font-size:12px;margin-top:24px">${title === 'New Login' || title.startsWith('PIN') ? "If this wasn't you, change your password now and contact support@zappipay.com.ng." : 'You can turn these emails off in Profile → Email alerts.'}</p>
        </div>
      </div>`;
    await sendEmail({ to: customer.email, subject: `ZappiPay: ${title}`, html, text: `${title}\n\n${message}` });
  } catch (error) {
    console.error('emailAlert failed:', error.message);
  }
}

module.exports = { notify };
