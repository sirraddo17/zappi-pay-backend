const express = require('express');
const prisma = require('../lib/prisma');
const { requireAdminAuth } = require('../lib/auth');
const { notify } = require('../lib/notify');

// Support tools on a customer's page:
//  • scheduled top-ups: see them; pause (staff too — protective), resume or delete (owner)
//  • correct their name (owner)
//  • their own daily spending limit (owner)
//  • give a reward that didn't arrive: cashback, referral bonus, loyalty points (owner)
//  • open a support ticket for them (a complaint that came by WhatsApp/email/phone)
// Owner-only routes are kept from support staff by the staff gate; the AI
// assistant is refused on anything that changes money or identity.
const router = express.Router();
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const naira = (n) => `₦${r2(n).toLocaleString('en-NG')}`;
const noAi = (req, res) => (req.headers['x-admin-assistant'] ? res.status(403).json({ error: 'Only a person can do this.' }) : null);
const audit = (req, action, details) => prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action, details } }).catch(() => {});
const reasonOf = (b, min = 5) => {
  const r = String(b?.reason || '').trim().slice(0, 200);
  return r.length >= min ? r : null;
};

// --- Scheduled top-ups ------------------------------------------------------

router.get('/admin/customers/:id/schedules', requireAdminAuth, async (req, res) => {
  try {
    const rows = await prisma.scheduledPurchase.findMany({ where: { customerId: req.params.id }, orderBy: { createdAt: 'desc' } });
    res.json({ schedules: rows.map((x) => ({ ...x, amount: x.amount == null ? null : Number(x.amount) })) });
  } catch (error) {
    console.error('GET /admin/customers/:id/schedules failed:', error);
    res.status(500).json({ error: 'Could not load scheduled top-ups.' });
  }
});

router.patch('/admin/schedules/:id', requireAdminAuth, async (req, res) => {
  try {
    const active = req.body?.active === true;
    const s = await prisma.scheduledPurchase.findUnique({ where: { id: req.params.id } });
    if (!s) return res.status(404).json({ error: 'Scheduled top-up not found.' });
    await prisma.scheduledPurchase.update({ where: { id: s.id }, data: { active, ...(active ? { failCount: 0, lastError: null } : {}) } });
    if (active) require('../lib/schedules').kickScheduler?.();
    await audit(req, active ? 'SCHEDULE_RESUMED' : 'SCHEDULE_PAUSED', { scheduleId: s.id, customerId: s.customerId });
    Promise.resolve(notify(s.customerId, active ? 'Scheduled top-up resumed' : 'Scheduled top-up paused', `ZAPPI PAY support ${active ? 'resumed' : 'paused'} your scheduled ${String(s.service).toLowerCase()} for ${s.billersCode}${s.nickname ? ` (${s.nickname})` : ''}.`)).catch(() => {});
    res.json({ ok: true, active });
  } catch (error) {
    console.error('PATCH /admin/schedules/:id failed:', error);
    res.status(500).json({ error: 'Could not update the scheduled top-up.' });
  }
});

router.delete('/admin/schedules/:id', requireAdminAuth, async (req, res) => {
  try {
    const s = await prisma.scheduledPurchase.findUnique({ where: { id: req.params.id } });
    if (!s) return res.status(404).json({ error: 'Scheduled top-up not found.' });
    await prisma.scheduledPurchase.delete({ where: { id: s.id } });
    await audit(req, 'SCHEDULE_DELETED', { scheduleId: s.id, customerId: s.customerId, service: s.service, billersCode: s.billersCode });
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE /admin/schedules/:id failed:', error);
    res.status(500).json({ error: 'Could not delete the scheduled top-up.' });
  }
});

// --- Name correction ----------------------------------------------------------

router.patch('/admin/customers/:id/name', requireAdminAuth, async (req, res) => {
  if (noAi(req, res)) return;
  try {
    const name = String(req.body?.name || '').replace(/\s+/g, ' ').trim();
    const reason = reasonOf(req.body);
    if (!/^[\p{L}][\p{L}'’.\- ]{1,79}$/u.test(name) || name.split(' ').length < 2) return res.status(400).json({ error: 'Enter their full name (first and last name, letters only).' });
    if (!reason) return res.status(400).json({ error: 'Say why (e.g. "typo — matches their BVN slip").' });
    const c = await prisma.customer.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, deletedAt: true } });
    if (!c || c.deletedAt) return res.status(404).json({ error: 'Customer not found.' });
    if (c.name === name) return res.status(400).json({ error: 'That is already their name.' });
    await prisma.customer.update({ where: { id: c.id }, data: { name } });
    await audit(req, 'CUSTOMER_NAME_CHANGED', { customerId: c.id, from: c.name, to: name, reason });
    Promise.resolve(notify(c.id, 'Name updated', `ZAPPI PAY support updated the name on your account to ${name}.`)).catch(() => {});
    res.json({ ok: true, name, note: 'Account numbers already issued keep the name the bank partner registered. If that must change too, the customer gets new numbers after a reset.' });
  } catch (error) {
    console.error('PATCH /admin/customers/:id/name failed:', error);
    res.status(500).json({ error: 'Could not change the name.' });
  }
});

// --- Daily limit for one customer -----------------------------------------------

router.put('/admin/customers/:id/daily-limit', requireAdminAuth, async (req, res) => {
  if (noAi(req, res)) return;
  try {
    const raw = req.body?.limit;
    const limit = raw === null || raw === '' || raw === undefined ? null : r2(raw);
    if (limit !== null && !(limit >= 1000 && limit <= 10000000)) return res.status(400).json({ error: 'Enter a limit between ₦1,000 and ₦10,000,000, or clear it to use the normal limit.' });
    const reason = reasonOf(req.body);
    if (limit !== null && !reason) return res.status(400).json({ error: 'Say why (e.g. "agent buying in bulk, BVN verified").' });
    const c = await prisma.customer.findUnique({ where: { id: req.params.id }, select: { id: true, dailyLimitOverride: true } });
    if (!c) return res.status(404).json({ error: 'Customer not found.' });
    await prisma.customer.update({ where: { id: c.id }, data: { dailyLimitOverride: limit } });
    await audit(req, limit === null ? 'DAILY_LIMIT_CLEARED' : 'DAILY_LIMIT_SET', { customerId: c.id, from: c.dailyLimitOverride == null ? null : Number(c.dailyLimitOverride), to: limit, reason: reason || undefined });
    res.json({ ok: true, limit });
  } catch (error) {
    console.error('PUT /admin/customers/:id/daily-limit failed:', error);
    res.status(500).json({ error: 'Could not save the limit.' });
  }
});

// --- Rewards that didn't arrive -------------------------------------------------

const REWARDS = {
  CASHBACK: { max: 5000, label: 'cashback' },
  REFERRAL: { max: 5000, label: 'referral bonus' },
  LOYALTY: { max: 20000, label: 'loyalty points' },
};

router.post('/admin/customers/:id/grant-reward', requireAdminAuth, async (req, res) => {
  if (noAi(req, res)) return;
  try {
    const kind = String(req.body?.kind || '').toUpperCase();
    const def = REWARDS[kind];
    if (!def) return res.status(400).json({ error: 'Choose cashback, referral bonus or loyalty points.' });
    const amount = kind === 'LOYALTY' ? Math.floor(Number(req.body?.amount)) : r2(req.body?.amount);
    if (!(amount > 0) || amount > def.max) return res.status(400).json({ error: `Enter an amount between 1 and ${def.max.toLocaleString()}.` });
    const reason = reasonOf(req.body);
    if (!reason) return res.status(400).json({ error: 'Say why it is owed (e.g. "referral of 0803… finished target, bonus not paid").' });
    const c = await prisma.customer.findUnique({ where: { id: req.params.id }, select: { id: true, deletedAt: true } });
    if (!c || c.deletedAt) return res.status(404).json({ error: 'Customer not found.' });
    const settings = await require('../lib/vtpass').getSettings();
    const note = `Added by ZAPPI PAY support: ${reason}`.slice(0, 200);
    await prisma.$transaction(async (tx) => {
      if (kind === 'CASHBACK') await require('../lib/cashback').creditEarned(tx, settings, { customerId: c.id, amount, note });
      if (kind === 'REFERRAL') {
        await tx.customer.update({ where: { id: c.id }, data: { walletBalance: { increment: amount } } });
        await tx.walletTransaction.create({ data: { customerId: c.id, type: 'REFERRAL_BONUS', amount, status: 'APPROVED', note, reviewedByAdminId: req.admin.adminId, reviewedAt: new Date() } });
      }
      if (kind === 'LOYALTY') await tx.customer.update({ where: { id: c.id }, data: { loyaltyPoints: { increment: amount } } });
    });
    await audit(req, 'REWARD_GRANTED', { customerId: c.id, kind, amount, reason });
    const what = kind === 'LOYALTY' ? `${amount.toLocaleString()} loyalty points` : `${naira(amount)} ${def.label}`;
    Promise.resolve(notify(c.id, 'Reward added', `${what} has been added to your account by ZAPPI PAY support.`, { category: 'TRANSACTION' })).catch(() => {});
    res.json({ ok: true, message: `Added ${what}.` });
  } catch (error) {
    console.error('POST /admin/customers/:id/grant-reward failed:', error);
    res.status(500).json({ error: 'Could not add the reward.' });
  }
});

// --- Ticket for a complaint that came in another way ---------------------------

router.post('/admin/customers/:id/tickets', requireAdminAuth, async (req, res) => {
  try {
    const channel = ['WhatsApp', 'Email', 'Phone call', 'Instagram', 'X', 'In person', 'Other'].includes(req.body?.channel) ? req.body.channel : 'Other';
    const message = String(req.body?.message || '').trim().slice(0, 2000);
    if (message.length < 10) return res.status(400).json({ error: 'Write what the customer said (at least a sentence).' });
    const c = await prisma.customer.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!c) return res.status(404).json({ error: 'Customer not found.' });
    let orderId = req.body?.orderId ? String(req.body.orderId) : null;
    if (orderId && !(await prisma.order.findFirst({ where: { id: orderId, customerId: c.id }, select: { id: true } }))) orderId = null;
    const t = await prisma.supportTicket.create({ data: { customerId: c.id, orderId, message: `[Via ${channel}, logged by support] ${message}`, status: 'OPEN' } });
    await audit(req, 'TICKET_OPENED_FOR_CUSTOMER', { customerId: c.id, ticketId: t.id, channel });
    res.json({ ok: true, ticketId: t.id });
  } catch (error) {
    console.error('POST /admin/customers/:id/tickets failed:', error);
    res.status(500).json({ error: 'Could not open the ticket.' });
  }
});

module.exports = router;
