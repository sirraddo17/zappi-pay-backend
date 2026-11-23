// Launch waitlist: people leave a name, phone and (optionally) an email on the welcome page, and the owner
// tells them all when ZAPPI PAY goes live (email from Admin, phone numbers ready to paste into Bulk SMS).
const prisma = require('./prisma');

const INTERESTS = ['airtime', 'data', 'electricity', 'cable', 'exam', 'betting', 'transfer', 'savings'];

function cleanPhone(v) {
  let d = String(v || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+234')) d = '0' + d.slice(4);
  else if (d.startsWith('234') && d.length === 13) d = '0' + d.slice(3);
  return /^0[789][01]\d{8}$/.test(d) ? d : null;
}

function bad(msg) { return Object.assign(new Error(msg), { status: 400 }); }

async function join(input = {}) {
  if (String(input.website || '').trim()) return { ok: true }; // hidden field only robots fill in
  const name = String(input.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (name.length < 2 || !/\p{L}/u.test(name)) throw bad('Please type your name.');
  const phone = cleanPhone(input.phone);
  if (!phone) throw bad('Please type a Nigerian phone number, e.g. 08012345678.');
  let email = String(input.email || '').trim().toLowerCase().slice(0, 120) || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) throw bad('That email doesn’t look right. Leave it empty if you prefer.');
  const interests = [...new Set((Array.isArray(input.interests) ? input.interests : []).map(String).filter((x) => INTERESTS.includes(x)))];
  const source = String(input.source || '').replace(/[^\w.-]/g, '').slice(0, 40) || null;
  const existing = await prisma.waitlistEntry.findUnique({ where: { phone } });
  if (existing) {
    await prisma.waitlistEntry.update({ where: { phone }, data: { name, ...(email ? { email } : {}), ...(interests.length ? { interests } : {}) } });
    return { ok: true, already: true };
  }
  await prisma.waitlistEntry.create({ data: { name, phone, email, interests, source } });
  return { ok: true };
}

async function overview() {
  const [total, withEmail, notified, recent] = await Promise.all([
    prisma.waitlistEntry.count(),
    prisma.waitlistEntry.count({ where: { email: { not: null } } }),
    prisma.waitlistEntry.count({ where: { notifiedAt: { not: null } } }),
    prisma.waitlistEntry.findMany({ orderBy: { createdAt: 'desc' }, take: 500 }),
  ]);
  const byInterest = {};
  for (const r of recent) for (const i of r.interests || []) byInterest[i] = (byInterest[i] || 0) + 1;
  return { total, withEmail, notified, waitingEmail: recent.filter((r) => r.email && !r.notifiedAt).length, byInterest, entries: recent, emailReady: require('./email').isEmailConfigured() };
}

const csvCell = (v) => {
  let s = v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.join(' ') : String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formulas
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function csv() {
  const rows = await prisma.waitlistEntry.findMany({ orderBy: { createdAt: 'asc' } });
  const head = ['name', 'phone', 'email', 'interests', 'source', 'joined', 'emailed'];
  return [head.join(','), ...rows.map((r) => [r.name, r.phone, r.email, r.interests, r.source, r.createdAt, r.notifiedAt || ''].map(csvCell).join(','))].join('\n') + '\n';
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Emails everyone with an email who hasn't been told yet (up to `limit` per run). */
async function notify({ subject, message, limit = 100 } = {}, { send } = {}) {
  const email = require('./email');
  if (!send && !email.isEmailConfigured()) throw bad('Email isn’t set up on the server yet (RESEND_API_KEY and EMAIL_FROM).');
  const sendEmail = send || email.sendEmail;
  subject = String(subject || 'ZAPPI PAY is live 🎉').slice(0, 120);
  message = String(message || 'You asked us to tell you when ZAPPI PAY launches. It’s live now: buy airtime, data, electricity and cable TV in seconds at https://zappipay.com.ng').slice(0, 2000);
  const due = await prisma.waitlistEntry.findMany({ where: { email: { not: null }, notifiedAt: null }, orderBy: { createdAt: 'asc' }, take: Math.min(Number(limit) || 100, 200) });
  let sent = 0; const failed = [];
  for (const r of due) {
    const first = r.name.split(' ')[0];
    try {
      await sendEmail({ to: r.email, subject, text: `Hi ${first},\n\n${message}\n\n— ZAPPI PAY`, html: `<p>Hi ${esc(first)},</p><p>${esc(message).replace(/\n/g, '<br>').replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p><p>— ZAPPI PAY</p>` });
      await prisma.waitlistEntry.update({ where: { id: r.id }, data: { notifiedAt: new Date() } });
      sent++;
    } catch (e) { failed.push({ email: r.email, error: String(e.message || e).slice(0, 120) }); }
  }
  const left = await prisma.waitlistEntry.count({ where: { email: { not: null }, notifiedAt: null } });
  return { sent, failed, left };
}

async function phones() {
  const rows = await prisma.waitlistEntry.findMany({ orderBy: { createdAt: 'asc' }, select: { phone: true } });
  return rows.map((r) => r.phone);
}

async function remove(id) { await prisma.waitlistEntry.deleteMany({ where: { id: String(id) } }); }

module.exports = { join, overview, csv, notify, phones, remove, cleanPhone, INTERESTS };
