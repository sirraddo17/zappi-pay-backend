const prisma = require('./prisma');
const { sendEmail, isEmailConfigured } = require('./email');

// Emails every active admin (fraud holds, daily summary, etc.).
// ADMIN_ALERT_EMAIL on Render overrides the recipient list.
async function adminEmails() {
  if (process.env.ADMIN_ALERT_EMAIL) return process.env.ADMIN_ALERT_EMAIL.split(',').map((e) => e.trim()).filter(Boolean);
  const admins = await prisma.adminUser.findMany({ where: { active: true }, select: { email: true } });
  return admins.map((a) => a.email).filter(Boolean);
}

async function emailAdmins(subject, html, text) {
  if (!isEmailConfigured()) return { sent: 0 };
  const to = await adminEmails();
  let sent = 0;
  for (const email of to) {
    const r = await sendEmail({ to: email, subject, html, text });
    if (r.sent) sent += 1;
  }
  return { sent };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Something is waiting for an admin: push to the admin app and email,
// following the switches in Admin → Settings → Alerts & Limits.
// Fire-and-forget: never throws, never blocks the customer's action.
async function alertAdmins(title, message, path = '/admin') {
  try {
    const settings = await prisma.settings.findFirst({ select: { adminAlertPush: true, adminAlertEmail: true } });
    const adminUrl = (process.env.ADMIN_APP_URL || 'https://admin.zappipay.com.ng').replace(/\/$/, '');
    const jobs = [];
    if (settings?.adminAlertPush !== false) jobs.push(require('./push').pushToAdmins(`ZP Admin: ${title}`, message, path));
    if (settings?.adminAlertEmail !== false) {
      jobs.push(emailAdmins(
        `ZappiPay admin: ${title}`,
        `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#0f172a">
          <div style="background:#0f1628;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;font-weight:bold">ZAPPI PAY · Admin</div>
          <div style="border:1px solid #e5e7eb;border-top:none;padding:18px;border-radius:0 0 10px 10px">
            <h2 style="font-size:17px;margin:0 0 8px">${esc(title)}</h2>
            <p style="line-height:1.5;white-space:pre-wrap">${esc(message)}</p>
            <p><a href="${adminUrl}${path}" style="background:#7c3aed;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open admin</a></p>
          </div></div>`,
        `${title}\n\n${message}\n\n${adminUrl}${path}`
      ));
    }
    await Promise.allSettled(jobs);
  } catch (error) {
    console.error('alertAdmins failed:', error.message);
  }
}

module.exports = { emailAdmins, adminEmails, alertAdmins };
