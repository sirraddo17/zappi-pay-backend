const express = require('express');
const prisma = require('../lib/prisma');
const { requireCustomerAuth, requireAdminAuth } = require('../lib/auth');
const { getSettings } = require('../lib/vtpass');
const push = require('../lib/push');
const contest = require('../lib/contest');

// Admin alerts on the admin app, email-alert test, purchase feedback,
// referral contests and in-app adverts.
const router = express.Router();

async function audit(req, action, details) {
  await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action, details } }).catch(() => {});
}

// --- Admin push alerts ---------------------------------------------

router.get('/admin/push/key', requireAdminAuth, async (req, res) => {
  try {
    const count = await prisma.adminPushSubscription.count({ where: { adminId: req.admin.adminId } });
    res.json({ publicKey: await push.publicKey(), devices: count });
  } catch (error) {
    console.error('GET /admin/push/key failed:', error);
    res.status(500).json({ error: 'Alerts are not available.' });
  }
});

router.post('/admin/push/subscribe', requireAdminAuth, async (req, res) => {
  try {
    const sub = req.body?.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return res.status(400).json({ error: 'Invalid subscription.' });
    await prisma.adminPushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      update: { adminId: req.admin.adminId, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      create: { adminId: req.admin.adminId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('POST /admin/push/subscribe failed:', error);
    res.status(500).json({ error: 'Could not turn on alerts.' });
  }
});

router.post('/admin/push/unsubscribe', requireAdminAuth, async (req, res) => {
  try {
    if (req.body?.endpoint) await prisma.adminPushSubscription.deleteMany({ where: { endpoint: String(req.body.endpoint) } });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Could not turn off alerts.' });
  }
});

router.post('/admin/alerts/test', requireAdminAuth, async (req, res) => {
  try {
    const s = await getSettings();
    const pushResult = await push.pushToAdmins('ZP Admin: test alert', 'Alerts are working on this device ✅', '/admin');
    let emailResult = { sent: 0 };
    if (s.adminAlertEmail !== false) {
      emailResult = await require('../lib/adminAlert').emailAdmins('ZappiPay admin: test alert', '<p>Admin email alerts are working ✅</p>', 'Admin email alerts are working.');
    }
    res.json({ pushSent: pushResult.sent || 0, emailSent: emailResult.sent || 0, emailConfigured: require('../lib/email').isEmailConfigured() });
  } catch (error) {
    console.error('POST /admin/alerts/test failed:', error);
    res.status(500).json({ error: 'Could not send a test alert.' });
  }
});

// Explains exactly why a customer does or doesn't get money in/out
// emails, and sends them a test if everything is in place.
router.post('/admin/email/test-customer-alert', requireAdminAuth, async (req, res) => {
  try {
    const { isEmailConfigured, sendEmail } = require('../lib/email');
    const s = await getSettings();
    const c = await prisma.customer.findUnique({ where: { id: String(req.body?.customerId || '') }, select: { name: true, email: true, emailAlerts: true, deletedAt: true } });
    if (!c) return res.status(404).json({ error: 'Customer not found.' });
    const problems = [];
    if (!isEmailConfigured()) problems.push('Email sending is not set up on Render (RESEND_API_KEY / EMAIL_FROM).');
    if (!s.emailAlertsEnabled) problems.push('"Email alerts for money in/out" is OFF in Admin → Settings → Alerts & Limits.');
    if (!c.email) problems.push('This customer has no email address on their account (they can add one in Profile).');
    if (!c.emailAlerts) problems.push('This customer turned email alerts off in their Profile.');
    if (c.deletedAt) problems.push('This account is deleted.');
    if (problems.length) return res.json({ ok: false, problems });
    const r = await sendEmail({
      to: c.email,
      subject: 'ZappiPay: test alert',
      html: `<p>Hi ${c.name.split(' ')[0]},</p><p>This is a test of ZAPPI PAY money alerts. You'll get an email like this when money goes in or out of your wallet.</p>`,
      text: 'This is a test of ZAPPI PAY money alerts.',
    });
    res.json({ ok: r.sent, problems: r.sent ? [] : [`The email provider refused it (${r.reason}). Check the Resend dashboard → Logs.`], email: c.email });
  } catch (error) {
    console.error('POST /admin/email/test-customer-alert failed:', error);
    res.status(500).json({ error: 'Could not run the email test.' });
  }
});

// --- Purchase feedback ---------------------------------------------

router.get('/feedback/should-ask', requireCustomerAuth, async (req, res) => {
  try {
    const s = await getSettings();
    if (!s.feedbackPromptEnabled) return res.json({ ask: false });
    const last = await prisma.feedback.findFirst({ where: { customerId: req.customer.customerId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    const ask = !last || Date.now() - new Date(last.createdAt).getTime() > 14 * 24 * 3600 * 1000;
    res.json({ ask, referralEnabled: s.referralEnabled, referralBonus: Number(s.referralBonusAmount || 0) });
  } catch (error) {
    res.json({ ask: false });
  }
});

router.post('/feedback', requireCustomerAuth, async (req, res) => {
  try {
    const rating = parseInt(req.body?.rating, 10);
    if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Choose 1 to 5 stars.' });
    const comment = String(req.body?.comment || '').trim().slice(0, 1000) || null;
    const orderId = req.body?.orderId ? String(req.body.orderId) : null;
    const fb = await prisma.feedback.create({ data: { customerId: req.customer.customerId, orderId, rating, comment } });
    if (rating <= 2 && comment) {
      const c = await prisma.customer.findUnique({ where: { id: req.customer.customerId }, select: { name: true, phone: true } });
      require('../lib/adminAlert').alertAdmins(`${rating}★ rating from a customer`, `${c?.name || 'A customer'} (${c?.phone || ''}): ${comment}`, '/admin/feedback');
    }
    res.status(201).json({ id: fb.id });
  } catch (error) {
    console.error('POST /feedback failed:', error);
    res.status(500).json({ error: 'Could not save your feedback.' });
  }
});

router.post('/feedback/:id/shared', requireCustomerAuth, async (req, res) => {
  await prisma.feedback.updateMany({ where: { id: req.params.id, customerId: req.customer.customerId }, data: { shared: true } }).catch(() => {});
  res.json({ ok: true });
});

router.get('/admin/feedback', requireAdminAuth, async (req, res) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const [list, agg, byRating, shared] = await Promise.all([
      prisma.feedback.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.feedback.aggregate({ where: { createdAt: { gte: since } }, _avg: { rating: true }, _count: true }),
      prisma.feedback.groupBy({ by: ['rating'], where: { createdAt: { gte: since } }, _count: { rating: true } }),
      prisma.feedback.count({ where: { createdAt: { gte: since }, shared: true } }),
    ]);
    const people = await prisma.customer.findMany({ where: { id: { in: [...new Set(list.map((f) => f.customerId))] } }, select: { id: true, name: true, phone: true } });
    const who = new Map(people.map((p) => [p.id, p]));
    res.json({
      average: agg._avg.rating ? Number(agg._avg.rating.toFixed(2)) : null,
      count: agg._count,
      shared,
      byRating: Object.fromEntries(byRating.map((g) => [g.rating, g._count.rating])),
      feedback: list.map((f) => ({ ...f, customer: who.get(f.customerId) || null })),
    });
  } catch (error) {
    console.error('GET /admin/feedback failed:', error);
    res.status(500).json({ error: 'Could not load feedback.' });
  }
});

// --- Referral contests ---------------------------------------------

function publicContest(c) {
  return {
    id: c.id,
    title: c.title,
    description: c.description,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    prizes: contest.prizeList(c),
    minReferrals: c.minReferrals,
    minQualifyingAmount: Number(c.minQualifyingAmount || 0),
    requireVerified: c.requireVerified !== false,
    phase: contest.phase(c),
    winners: (Array.isArray(c.winners) ? c.winners : []).map((w) => ({ rank: w.rank, name: w.displayName, qualified: w.qualified, prize: w.prize })),
  };
}

// The contest to show customers: live or upcoming, else one that ended
// in the last 7 days (to show winners).
async function currentContest() {
  const live = await prisma.referralContest.findFirst({ where: { status: 'ACTIVE' }, orderBy: { startsAt: 'asc' } });
  if (live) {
    if (new Date(live.endsAt) <= new Date()) return contest.finalizeContest(live.id);
    return live;
  }
  return prisma.referralContest.findFirst({
    where: { status: { in: ['AWAITING_PAYOUT', 'PAYING', 'PAID'] }, endsAt: { gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) } },
    orderBy: { endsAt: 'desc' },
  });
}

router.get('/contest', requireCustomerAuth, async (req, res) => {
  try {
    const c = await currentContest();
    if (!c) return res.json({ contest: null });
    const me = req.customer.customerId;
    const out = { contest: publicContest(c) };
    if (contest.phase(c) === 'LIVE' || contest.phase(c) === 'ENDED') {
      const rows = await contest.standings(c);
      const mine = rows.findIndex((r) => r.customerId === me);
      out.leaderboard = rows.slice(0, 10).map((r, i) => ({ rank: i + 1, name: contest.maskName(r.name), qualified: r.qualified, you: r.customerId === me }));
      out.me = mine >= 0 ? { rank: mine + 1, qualified: rows[mine].qualified, pending: rows[mine].pending } : { rank: null, qualified: 0, pending: 0 };
    }
    const won = (Array.isArray(c.winners) ? c.winners : []).find((w) => w.customerId === me);
    if (won) out.won = { rank: won.rank, prize: won.prize, qualified: won.qualified, paid: Boolean(won.paidAt) || c.status === 'PAID' };
    res.json(out);
  } catch (error) {
    console.error('GET /contest failed:', error);
    res.status(500).json({ error: 'Could not load the contest.' });
  }
});

function readContestInput(body, existing) {
  const title = String(body.title ?? existing?.title ?? '').trim().slice(0, 80);
  const description = body.description !== undefined ? String(body.description || '').trim().slice(0, 500) || null : existing?.description ?? null;
  const startsAt = new Date(body.startsAt ?? existing?.startsAt);
  const endsAt = new Date(body.endsAt ?? existing?.endsAt);
  const prizes = (Array.isArray(body.prizes) ? body.prizes : existing ? contest.prizeList(existing) : []).map(Number).filter((n) => n > 0).slice(0, 20);
  const minReferrals = Math.max(1, parseInt(body.minReferrals ?? existing?.minReferrals ?? 1, 10) || 1);
  const minQualifyingAmount = Math.max(0, Number(body.minQualifyingAmount ?? existing?.minQualifyingAmount ?? 0) || 0);
  const autoPay = body.autoPay !== undefined ? Boolean(body.autoPay) : Boolean(existing?.autoPay);
  const requireVerified = body.requireVerified !== undefined ? Boolean(body.requireVerified) : existing ? existing.requireVerified !== false : true;
  if (!title) return { error: 'Give the contest a title.' };
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return { error: 'Choose a start and end date.' };
  if (endsAt <= startsAt) return { error: 'The end must be after the start.' };
  if (endsAt - startsAt > 92 * 24 * 3600 * 1000) return { error: 'A contest can last at most 3 months.' };
  if (!prizes.length) return { error: 'Add at least one prize.' };
  return { data: { title, description, startsAt, endsAt, prizes, minReferrals, minQualifyingAmount, autoPay, requireVerified } };
}

async function overlapping(startsAt, endsAt, exceptId) {
  return prisma.referralContest.findFirst({
    where: { status: { not: 'CANCELLED' }, startsAt: { lt: endsAt }, endsAt: { gt: startsAt }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { title: true },
  });
}

router.get('/admin/contests', requireAdminAuth, async (req, res) => {
  try {
    const list = await prisma.referralContest.findMany({ orderBy: { startsAt: 'desc' }, take: 50 });
    res.json({ contests: list.map((c) => ({ ...c, prizes: contest.prizeList(c), phase: contest.phase(c), minQualifyingAmount: Number(c.minQualifyingAmount || 0) })) });
  } catch (error) {
    console.error('GET /admin/contests failed:', error);
    res.status(500).json({ error: 'Could not load contests.' });
  }
});

router.get('/admin/contests/:id', requireAdminAuth, async (req, res) => {
  try {
    let c = await prisma.referralContest.findUnique({ where: { id: req.params.id } });
    if (!c) return res.status(404).json({ error: 'Contest not found.' });
    if (c.status === 'ACTIVE' && new Date(c.endsAt) <= new Date()) c = await contest.finalizeContest(c.id);
    const rows = await contest.standings(c);
    const preview = contest.pickWinners(c, rows);
    res.json({
      contest: { ...c, prizes: contest.prizeList(c), phase: contest.phase(c), minQualifyingAmount: Number(c.minQualifyingAmount || 0) },
      standings: rows.slice(0, 50).map((r, i) => ({ rank: i + 1, customerId: r.customerId, name: r.name, phone: r.phone, username: r.username, qualified: r.qualified, pending: r.pending, reachedAt: r.reachedAt })),
      projectedWinners: preview,
    });
  } catch (error) {
    console.error('GET /admin/contests/:id failed:', error);
    res.status(500).json({ error: 'Could not load the contest.' });
  }
});

router.post('/admin/contests', requireAdminAuth, async (req, res) => {
  try {
    const input = readContestInput(req.body || {});
    if (input.error) return res.status(400).json({ error: input.error });
    const clash = await overlapping(input.data.startsAt, input.data.endsAt);
    if (clash) return res.status(400).json({ error: `These dates overlap "${clash.title}". Contests can't overlap, so each one counts new sign-ups only.` });
    const c = await prisma.referralContest.create({ data: input.data });
    await audit(req, 'CONTEST_CREATED', { contestId: c.id, title: c.title });
    contest.armContestTimer();
    res.status(201).json({ contest: c });
  } catch (error) {
    console.error('POST /admin/contests failed:', error);
    res.status(500).json({ error: 'Could not create the contest.' });
  }
});

router.patch('/admin/contests/:id', requireAdminAuth, async (req, res) => {
  try {
    const existing = await prisma.referralContest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Contest not found.' });
    if (existing.status !== 'ACTIVE') return res.status(400).json({ error: 'Only a running or upcoming contest can be edited.' });
    const body = { ...(req.body || {}) };
    // Once it has started, the start date and rules are fixed (fairness).
    if (new Date(existing.startsAt) <= new Date()) {
      delete body.startsAt;
      delete body.minQualifyingAmount;
      delete body.requireVerified;
    }
    const input = readContestInput(body, existing);
    if (input.error) return res.status(400).json({ error: input.error });
    const clash = await overlapping(input.data.startsAt, input.data.endsAt, existing.id);
    if (clash) return res.status(400).json({ error: `These dates overlap "${clash.title}".` });
    const c = await prisma.referralContest.update({ where: { id: existing.id }, data: input.data });
    await audit(req, 'CONTEST_UPDATED', { contestId: c.id });
    contest.armContestTimer();
    res.json({ contest: c });
  } catch (error) {
    console.error('PATCH /admin/contests/:id failed:', error);
    res.status(500).json({ error: 'Could not update the contest.' });
  }
});

router.post('/admin/contests/:id/end-now', requireAdminAuth, async (req, res) => {
  try {
    const c = await prisma.referralContest.findUnique({ where: { id: req.params.id } });
    if (!c || c.status !== 'ACTIVE') return res.status(400).json({ error: 'This contest is not running.' });
    if (new Date(c.startsAt) > new Date()) return res.status(400).json({ error: 'It has not started yet — cancel it instead.' });
    await prisma.referralContest.update({ where: { id: c.id }, data: { endsAt: new Date() } });
    const done = await contest.finalizeContest(c.id);
    await audit(req, 'CONTEST_ENDED_EARLY', { contestId: c.id });
    contest.armContestTimer();
    res.json({ contest: done });
  } catch (error) {
    console.error('POST /admin/contests/:id/end-now failed:', error);
    res.status(500).json({ error: 'Could not end the contest.' });
  }
});

router.post('/admin/contests/:id/pay', requireAdminAuth, async (req, res) => {
  try {
    const c = await contest.payWinners(req.params.id);
    await audit(req, 'CONTEST_PAID', { contestId: c.id, winners: (c.winners || []).map((w) => ({ customerId: w.customerId, prize: w.prize })) });
    res.json({ contest: c });
  } catch (error) {
    console.error('POST /admin/contests/:id/pay failed:', error);
    res.status(400).json({ error: error.message || 'Could not pay the winners.' });
  }
});

router.post('/admin/contests/:id/cancel', requireAdminAuth, async (req, res) => {
  try {
    const r = await prisma.referralContest.updateMany({ where: { id: req.params.id, status: { in: ['ACTIVE', 'AWAITING_PAYOUT'] } }, data: { status: 'CANCELLED' } });
    if (r.count !== 1) return res.status(400).json({ error: 'This contest can no longer be cancelled.' });
    await audit(req, 'CONTEST_CANCELLED', { contestId: req.params.id });
    contest.armContestTimer();
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Could not cancel the contest.' });
  }
});

// Remove (or restore) a suspicious customer from the contest.
router.post('/admin/contests/:id/disqualify', requireAdminAuth, async (req, res) => {
  try {
    const c = await prisma.referralContest.findUnique({ where: { id: req.params.id } });
    if (!c || c.status !== 'ACTIVE') return res.status(400).json({ error: 'Only a running contest can be changed.' });
    const id = String(req.body?.customerId || '');
    const list = new Set(Array.isArray(c.disqualified) ? c.disqualified : []);
    if (req.body?.restore) list.delete(id); else list.add(id);
    await prisma.referralContest.update({ where: { id: c.id }, data: { disqualified: [...list] } });
    await audit(req, req.body?.restore ? 'CONTEST_REQUALIFIED' : 'CONTEST_DISQUALIFIED', { contestId: c.id, customerId: id });
    res.json({ disqualified: [...list] });
  } catch (error) {
    res.status(500).json({ error: 'Could not update the contest.' });
  }
});

// --- In-app adverts ------------------------------------------------

const AD_PLACEMENTS = ['HOME', 'POPUP', 'BOTH'];

function liveAdWhere() {
  const now = new Date();
  return { active: true, AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }] };
}

function publicAd(a) {
  return {
    id: a.id,
    title: a.title,
    body: a.body,
    hasImage: Boolean(a.image),
    imageVersion: new Date(a.updatedAt).getTime(),
    linkUrl: a.linkUrl,
    buttonText: a.buttonText,
    placement: a.placement,
  };
}

router.get('/ads', async (req, res) => {
  try {
    const ads = await prisma.appAd.findMany({
      where: liveAdWhere(),
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      take: 10,
      select: { id: true, title: true, body: true, linkUrl: true, buttonText: true, placement: true, updatedAt: true, image: false },
    });
    const withImage = await prisma.appAd.findMany({ where: { id: { in: ads.map((a) => a.id) }, image: { not: null } }, select: { id: true } });
    const has = new Set(withImage.map((a) => a.id));
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ ads: ads.map((a) => publicAd({ ...a, image: has.has(a.id) ? 'x' : null })) });
  } catch (error) {
    console.error('GET /ads failed:', error);
    res.json({ ads: [] });
  }
});

// The picture itself, as a real image file the phone can cache.
router.get('/ads/:id/image', async (req, res) => {
  try {
    const ad = await prisma.appAd.findUnique({ where: { id: req.params.id }, select: { image: true } });
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(ad?.image || '');
    if (!m) return res.status(404).end();
    res.set('Content-Type', m[1]);
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.send(Buffer.from(m[2], 'base64'));
  } catch (error) {
    res.status(404).end();
  }
});

router.post('/ads/:id/click', async (req, res) => {
  await prisma.appAd.update({ where: { id: req.params.id }, data: { clicks: { increment: 1 } } }).catch(() => {});
  res.json({ ok: true });
});

function readAdInput(body, existing) {
  const data = {};
  if (body.title !== undefined || !existing) {
    data.title = String(body.title || '').trim().slice(0, 80);
    if (!data.title) return { error: 'Give the advert a title.' };
  }
  if (body.body !== undefined) data.body = String(body.body || '').trim().slice(0, 300) || null;
  if (body.linkUrl !== undefined) {
    const link = String(body.linkUrl || '').trim();
    if (link && !/^\/[^\s]*$/.test(link) && !/^https:\/\/[^\s]+$/.test(link)) return { error: 'Link must be an app page like /buy/data or a full https:// address.' };
    data.linkUrl = link || null;
  }
  if (body.buttonText !== undefined) data.buttonText = String(body.buttonText || '').trim().slice(0, 30) || null;
  if (body.placement !== undefined) {
    if (!AD_PLACEMENTS.includes(body.placement)) return { error: 'Choose where to show it.' };
    data.placement = body.placement;
  }
  if (body.active !== undefined) data.active = Boolean(body.active);
  if (body.sortOrder !== undefined) data.sortOrder = parseInt(body.sortOrder, 10) || 0;
  for (const k of ['startsAt', 'endsAt']) {
    if (body[k] === undefined) continue;
    if (!body[k]) { data[k] = null; continue; }
    const d = new Date(body[k]);
    if (Number.isNaN(d.getTime())) return { error: 'Check the dates.' };
    data[k] = d;
  }
  if (body.image !== undefined) {
    if (!body.image) data.image = null;
    else {
      const img = String(body.image);
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(img)) return { error: 'The picture must be a JPG, PNG or WebP.' };
      if (img.length > 1.5 * 1024 * 1024) return { error: 'The picture is too large (max about 1 MB).' };
      data.image = img;
    }
  }
  return { data };
}

router.get('/admin/ads', requireAdminAuth, async (req, res) => {
  try {
    const ads = await prisma.appAd.findMany({
      orderBy: [{ active: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
      select: { id: true, title: true, body: true, linkUrl: true, buttonText: true, placement: true, active: true, startsAt: true, endsAt: true, sortOrder: true, clicks: true, createdAt: true, updatedAt: true },
    });
    const withImage = new Set((await prisma.appAd.findMany({ where: { image: { not: null } }, select: { id: true } })).map((a) => a.id));
    res.json({ ads: ads.map((a) => ({ ...a, hasImage: withImage.has(a.id), imageVersion: new Date(a.updatedAt).getTime() })) });
  } catch (error) {
    console.error('GET /admin/ads failed:', error);
    res.status(500).json({ error: 'Could not load adverts.' });
  }
});

router.post('/admin/ads', requireAdminAuth, async (req, res) => {
  try {
    const input = readAdInput(req.body || {});
    if (input.error) return res.status(400).json({ error: input.error });
    const ad = await prisma.appAd.create({ data: input.data, select: { id: true } });
    await audit(req, 'AD_CREATED', { adId: ad.id, title: input.data.title });
    res.status(201).json({ id: ad.id });
  } catch (error) {
    console.error('POST /admin/ads failed:', error);
    res.status(500).json({ error: 'Could not save the advert.' });
  }
});

router.patch('/admin/ads/:id', requireAdminAuth, async (req, res) => {
  try {
    const existing = await prisma.appAd.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!existing) return res.status(404).json({ error: 'Advert not found.' });
    const input = readAdInput(req.body || {}, existing);
    if (input.error) return res.status(400).json({ error: input.error });
    await prisma.appAd.update({ where: { id: existing.id }, data: input.data });
    res.json({ ok: true });
  } catch (error) {
    console.error('PATCH /admin/ads/:id failed:', error);
    res.status(500).json({ error: 'Could not save the advert.' });
  }
});

router.delete('/admin/ads/:id', requireAdminAuth, async (req, res) => {
  try {
    await prisma.appAd.delete({ where: { id: req.params.id } });
    await audit(req, 'AD_DELETED', { adId: req.params.id });
    res.json({ ok: true });
  } catch (error) {
    res.status(404).json({ error: 'Advert not found.' });
  }
});

module.exports = router;
