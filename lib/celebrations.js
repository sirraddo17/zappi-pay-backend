// Celebrations with customers: verified-member milestones (100, 500,
// 1,000 …), plus the thank-you message used on launch day, anniversaries
// and Customer Service Week (lib/festivals.js). Each milestone is
// celebrated once: an in-app slide for 3 days, a thank-you message to
// every customer, an admin alert, and pictures + caption in Ad Studio.
//
// "Verified" = gave BVN/NIN for their account number (kycType) or passed
// the name + date-of-birth check (kycVerifiedAt) — not just signed up.

const prisma = require('./prisma');

const MILESTONES = [50, 100, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 75000, 100000, 250000, 500000, 1000000];
const SHOW_DAYS = 3;
const SITE = 'www.zappipay.com.ng';
const fmt = (n) => Number(n).toLocaleString('en-NG');

function verifiedWhere() {
  return { active: true, OR: [{ kycType: { not: null } }, { kycVerifiedAt: { not: null } }] };
}

async function verifiedCount() {
  return prisma.customer.count({ where: verifiedWhere() });
}

function design(n) {
  return {
    headline: `${fmt(n)} verified members!`,
    highlight: fmt(n),
    subtext: 'Thank you for trusting ZAPPI PAY. Every top-up, every bill, every referral got us here — we’re just getting started',
    emoji: '🎉',
    theme: n >= 10000 ? 'gold' : 'purple',
    badges: ['Thank you', 'Verified & growing'],
    cta: 'Open ZAPPI PAY',
    link: '/',
    caption: `🎉 We just hit ${fmt(n)} VERIFIED members on ZAPPI PAY!\n\nThank you for trusting us with your airtime, data, bills and payments. Every top-up, every referral and every bit of feedback got us here 💜\n\nNot on ZAPPI PAY yet? Join the family 👉 ${SITE}\n#ZappiPay #${n >= 1000 ? `${n / 1000}K` : n}Strong #ThankYou`,
    notice: `🎉 ZAPPI PAY now has ${fmt(n)} verified members! Thank you for trusting us — we’re grateful you’re part of this journey.`,
  };
}

// One in-app message to every active customer (bell). No push/email so
// it never feels like spam.
async function messageEveryone(title, message) {
  const ids = await prisma.customer.findMany({ where: { active: true }, select: { id: true } });
  for (let i = 0; i < ids.length; i += 1000) {
    await prisma.notification.createMany({ data: ids.slice(i, i + 1000).map((c) => ({ customerId: c.id, title, message, category: 'UPDATE' })) });
  }
  return ids.length;
}

async function checkMilestones() {
  const settings = await require('./vtpass').getSettings();
  if (settings.festivalGreetingsEnabled === false) return null;
  const count = await verifiedCount();
  const reached = MILESTONES.filter((m) => m <= count);
  if (!reached.length) return { count, milestone: null };
  const top = reached[reached.length - 1];
  const id = `milestone-${top}`;
  if (await prisma.celebration.findUnique({ where: { id } })) return { count, milestone: top, already: true };
  try {
    await prisma.celebration.create({ data: { id, kind: 'MILESTONE', value: top, showUntil: new Date(Date.now() + SHOW_DAYS * 24 * 3600 * 1000) } });
  } catch {
    return { count, milestone: top, already: true };
  }
  const d = design(top);
  await messageEveryone(d.headline, d.notice).catch((e) => console.error('milestone message failed:', e.message));
  require('./adminAlert').alertAdmins(`🎉 ${fmt(top)} verified members!`, `ZAPPI PAY just passed ${fmt(top)} verified members. Every customer got a thank-you message and the app shows a celebration slide for ${SHOW_DAYS} days. The post for social media is ready in Ad Studio → Celebrations.`, `/admin/ad-studio?festival=${id}`).catch?.(() => {});
  return { count, milestone: top, celebrated: true };
}

// The milestone slide the app shows right now, if any.
async function current() {
  const c = await prisma.celebration.findFirst({ where: { kind: 'MILESTONE', showUntil: { gt: new Date() } }, orderBy: { value: 'desc' } }).catch(() => null);
  if (!c) return null;
  const d = design(c.value);
  return { id: c.id, name: 'Milestone', title: d.headline, body: d.subtext, emoji: d.emoji, theme: d.theme };
}

// For Ad Studio: past milestones + the next one.
async function overview() {
  const count = await verifiedCount();
  const done = await prisma.celebration.findMany({ where: { kind: 'MILESTONE' }, orderBy: { value: 'desc' }, take: 10 });
  const next = MILESTONES.find((m) => m > count) || null;
  return {
    verified: count,
    next,
    toGo: next ? next - count : null,
    celebrated: done.map((c) => ({ id: c.id, value: c.value, reachedAt: c.createdAt, live: c.showUntil > new Date(), design: design(c.value) })),
    preview: next ? { id: `milestone-${next}`, value: next, design: design(next) } : null,
  };
}

module.exports = { MILESTONES, verifiedCount, design, messageEveryone, checkMilestones, current, overview };
