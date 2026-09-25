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

module.exports = { emailAdmins, adminEmails };
