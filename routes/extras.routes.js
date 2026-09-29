const express = require('express');
const { Prisma } = require('@prisma/client');
const prisma = require('../lib/prisma');
const { requireCustomerAuth, requireAdminAuth, comparePassword } = require('../lib/auth');
const { getSettings } = require('../lib/vtpass');
const { limitInfo } = require('../lib/limits');
const promoLib = require('../lib/promo');

// Promo codes, service notices, daily limits, email-alert preference,
// account deletion and the WhatsApp support number.
const router = express.Router();

const SERVICES = ['AIRTIME', 'DATA', 'ELECTRICITY', 'CABLE', 'EDUCATION', 'INTERNET', 'BETTING'];

function activeNoticeWhere() {
  return { active: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] };
}

async function audit(req, action, details) {
  await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action, details } }).catch(() => {});
}

// --- Public / customer ---------------------------------------------

router.get('/app/info', async (req, res) => {
  try {
    const [settings, notices] = await Promise.all([
      getSettings(),
      prisma.serviceNotice.findMany({ where: activeNoticeWhere(), orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);
    const manualList = require('../lib/funding').activeManualAccounts(settings);
    res.json({
      supportWhatsapp: settings.supportWhatsapp || null,
      // True while VTpass or Monnify is still on sandbox (test) keys —
      // customers see a "test mode, no real money" banner. It turns off
      // by itself once both are switched to live.
      testMode: settings.vtpassMode !== 'live' || (await require('../lib/monnify').getConfig().then((c) => c.mode !== 'live').catch(() => true)),
      manualFunding: manualList[0] ? { bankName: manualList[0].bankName, accountNumber: manualList[0].accountNumber, accountName: manualList[0].accountName } : null,
      manualAccounts: manualList.map((m) => ({ id: m.id, bankName: m.bankName, accountNumber: m.accountNumber, accountName: m.accountName })),
      notices: notices.map((n) => ({ id: n.id, message: n.message, service: n.service, level: n.level })),
      cashback: settings.cashbackEnabled ? settings.cashbackPercentByService || {} : {},
    });
  } catch (error) {
    console.error('GET /app/info failed:', error);
    res.status(500).json({ error: 'Could not load app info.' });
  }
});

router.get('/account/limits', requireCustomerAuth, async (req, res) => {
  try {
    const [customer, settings] = await Promise.all([
      prisma.customer.findUnique({ where: { id: req.customer.customerId } }),
      getSettings(),
    ]);
    const info = await limitInfo(customer, settings);
    res.json({ ...info, unverifiedLimit: Number(settings.dailyLimitUnverified), verifiedLimit: Number(settings.dailyLimitVerified) });
  } catch (error) {
    console.error('GET /account/limits failed:', error);
    res.status(500).json({ error: 'Could not load your limits.' });
  }
});

router.patch('/account/preferences', requireCustomerAuth, async (req, res) => {
  try {
    const data = {};
    if (req.body?.emailAlerts !== undefined) data.emailAlerts = Boolean(req.body.emailAlerts);
    await prisma.customer.update({ where: { id: req.customer.customerId }, data });
    res.json({ ok: true, ...data });
  } catch (error) {
    console.error('PATCH /account/preferences failed:', error);
    res.status(500).json({ error: 'Could not save your preferences.' });
  }
});

router.post('/account/delete-request', requireCustomerAuth, async (req, res) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    if (!req.body?.password || !(await comparePassword(String(req.body.password), customer.passwordHash))) {
      return res.status(401).json({ error: 'Your password is incorrect.' });
    }
    await prisma.customer.update({
      where: { id: customer.id },
      data: { deletionRequestedAt: new Date(), deletionReason: String(req.body.reason || '').slice(0, 300) || null },
    });
    require('../lib/adminAlert').alertAdmins('Account deletion request', 'A customer asked to delete their account. Review it on the Overview page.', '/admin');
    res.json({ ok: true, deletionRequestedAt: new Date() });
  } catch (error) {
    console.error('POST /account/delete-request failed:', error);
    res.status(500).json({ error: 'Could not submit your request.' });
  }
});

router.delete('/account/delete-request', requireCustomerAuth, async (req, res) => {
  try {
    await prisma.customer.update({ where: { id: req.customer.customerId }, data: { deletionRequestedAt: null, deletionReason: null } });
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE /account/delete-request failed:', error);
    res.status(500).json({ error: 'Could not cancel your request.' });
  }
});

// --- Agents -------------------------------------------------------

router.get('/agent/info', requireCustomerAuth, async (req, res) => {
  try {
    const [settings, customer] = await Promise.all([
      getSettings(),
      prisma.customer.findUnique({ where: { id: req.customer.customerId }, select: { isAgent: true, agentRequestedAt: true, agentBusinessName: true, agentShopAddress: true, agentRejectedAt: true, agentRejectReason: true } }),
    ]);
    res.json({ enabled: Boolean(settings.agentPricingEnabled), rates: settings.agentPricingEnabled ? settings.agentDiscountPercentByService || {} : {}, ...customer });
  } catch (error) {
    console.error('GET /agent/info failed:', error);
    res.status(500).json({ error: 'Could not load agent info.' });
  }
});

router.post('/agent/request', requireCustomerAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    if (!settings.agentPricingEnabled) return res.status(400).json({ error: 'Agent accounts are not open right now.' });
    const businessName = String(req.body?.businessName || '').trim().slice(0, 80);
    if (!businessName) return res.status(400).json({ error: 'Enter your business or shop name.' });
    const shopAddress = String(req.body?.shopAddress || '').trim().replace(/\s+/g, ' ').slice(0, 200);
    if (shopAddress.length < 10) return res.status(400).json({ error: 'Enter your full shop address (street, area, town, state).' });
    const me = await prisma.customer.findUnique({ where: { id: req.customer.customerId }, select: { isAgent: true, agentRequestedAt: true, agentRejectedAt: true } });
    if (me.isAgent) return res.status(400).json({ error: 'You are already an agent.' });
    if (me.agentRequestedAt) return res.status(400).json({ error: 'Your application is already being reviewed.' });
    if (me.agentRejectedAt && Date.now() - new Date(me.agentRejectedAt).getTime() < 7 * 24 * 3600 * 1000) {
      return res.status(400).json({ error: 'You can apply again 7 days after your last application was declined.' });
    }
    await prisma.customer.update({ where: { id: req.customer.customerId }, data: { agentRequestedAt: new Date(), agentBusinessName: businessName, agentShopAddress: shopAddress, agentRejectedAt: null, agentRejectReason: null } });
    require('../lib/adminAlert').alertAdmins('New agent application', `${businessName || 'A customer'} applied to become an agent. Review it on the Overview page.`, '/admin');
    res.json({ ok: true });
  } catch (error) {
    console.error('POST /agent/request failed:', error);
    res.status(500).json({ error: 'Could not send your request.' });
  }
});

router.get('/admin/agent-requests', requireAdminAuth, async (req, res) => {
  try {
    const customers = await prisma.customer.findMany({
      where: { agentRequestedAt: { not: null }, isAgent: false, deletedAt: null },
      select: { id: true, name: true, phone: true, agentBusinessName: true, agentShopAddress: true, agentRequestedAt: true, kycType: true },
      orderBy: { agentRequestedAt: 'asc' },
    });
    res.json({ customers });
  } catch (error) {
    console.error('GET /admin/agent-requests failed:', error);
    res.status(500).json({ error: 'Could not load agent requests.' });
  }
});

router.post('/admin/customers/:id/agent', requireAdminAuth, async (req, res) => {
  try {
    const isAgent = Boolean(req.body?.isAgent);
    const c = await prisma.customer.update({
      where: { id: req.params.id },
      data: isAgent ? { isAgent: true } : { isAgent: false, agentRequestedAt: null },
    });
    await audit(req, isAgent ? 'AGENT_APPROVED' : 'AGENT_REMOVED', { customerId: c.id, name: c.name });
    if (isAgent) require('../lib/notify').notify(c.id, 'Agent Account Approved', 'You are now a ZappiPay agent. Agent prices are applied automatically when you buy.');
    res.json({ isAgent: c.isAgent });
  } catch (error) {
    console.error('POST /admin/customers/:id/agent failed:', error);
    res.status(500).json({ error: 'Could not update agent status.' });
  }
});

// Decline an agent application (with a reason the customer sees).
router.post('/admin/customers/:id/agent-reject', requireAdminAuth, async (req, res) => {
  try {
    const reason = String(req.body?.reason || '').trim().slice(0, 300);
    const r = await prisma.customer.updateMany({
      where: { id: req.params.id, isAgent: false, agentRequestedAt: { not: null } },
      data: { agentRequestedAt: null, agentRejectedAt: new Date(), agentRejectReason: reason || null },
    });
    if (r.count !== 1) return res.status(400).json({ error: 'There is no agent application waiting for this customer.' });
    const c = await prisma.customer.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, agentBusinessName: true } });
    await audit(req, 'AGENT_REJECTED', { customerId: c.id, name: c.name, reason });
    require('../lib/notify').notify(c.id, 'Agent Application', `Your agent application was not approved this time.${reason ? ` Reason: ${reason}` : ''} You can apply again after 7 days.`);
    res.json({ ok: true });
  } catch (error) {
    console.error('POST /admin/customers/:id/agent-reject failed:', error);
    res.status(500).json({ error: 'Could not decline the application.' });
  }
});

// Bank names used by customers' automatic funding accounts, so the
// admin can pause one that's having network problems.
router.get('/admin/funding-banks', requireAdminAuth, async (req, res) => {
  try {
    const rows = await prisma.customer.findMany({ where: { bankAccountRef: { not: null } }, select: { bankAccounts: true }, orderBy: { bankAccountAt: 'desc' }, take: 300 });
    const counts = {};
    for (const r of rows) for (const a of Array.isArray(r.bankAccounts) ? r.bankAccounts : []) if (a?.bankName) counts[a.bankName] = (counts[a.bankName] || 0) + 1;
    res.json({ banks: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, customers]) => ({ name, customers })) });
  } catch (error) {
    console.error('GET /admin/funding-banks failed:', error);
    res.status(500).json({ error: 'Could not load banks.' });
  }
});

const couponTries = new Map();
router.post('/wallet/coupon', requireCustomerAuth, async (req, res) => {
  try {
    // Stops guessing codes: 10 tries per 10 minutes.
    const now = Date.now();
    const tries = (couponTries.get(req.customer.customerId) || []).filter((t) => now - t < 10 * 60 * 1000);
    if (tries.length >= 10) return res.status(429).json({ error: 'Too many tries. Please wait a few minutes.' });
    tries.push(now);
    couponTries.set(req.customer.customerId, tries);
    if (couponTries.size > 5000) couponTries.clear();
    const r = await promoLib.redeemCredit(req.customer.customerId, req.body?.code);
    require('../lib/notify').notify(req.customer.customerId, 'Coupon Redeemed', `₦${r.amount.toLocaleString()} from coupon ${r.code} was added to your wallet.`);
    res.json(r);
  } catch (error) {
    if (!error.message || error.code) {
      console.error('POST /wallet/coupon failed:', error);
      return res.status(500).json({ error: 'Could not redeem the coupon.' });
    }
    res.status(400).json({ error: error.message });
  }
});

router.get('/promo/check', requireCustomerAuth, async (req, res) => {
  try {
    const amount = Number(req.query.amount || 0);
    const service = String(req.query.service || '');
    const evaluated = await promoLib.evaluatePromo(req.customer.customerId, req.query.code, service, amount);
    const { promo } = evaluated;
    let { discount } = evaluated;
    // Same safety limit as the purchase itself, when the Buy page sends
    // the plan's face value and provider.
    const base = Number(req.query.base || 0);
    if (base > 0) {
      const { computePrice, settingsForCustomer } = require('../lib/pricing');
      const buyer = await prisma.customer.findUnique({ where: { id: req.customer.customerId }, select: { isAgent: true } });
      const s = settingsForCustomer(await getSettings(), buyer);
      const priced = computePrice(base, service, s);
      const left = require('../lib/rewardGuard').room({ service, provider: String(req.query.provider || ''), face: base, markedUp: priced.markedUp, alreadyGiven: priced.discountAmount }, s);
      if (left !== null && discount > left) discount = Math.floor(left);
      if (!(discount > 0)) throw new Error("That promo code can't be used on this purchase.");
    }
    res.json({ code: promo.code, discount, description: promo.description });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// --- Admin: promo codes --------------------------------------------

function promoData(body, partial) {
  const data = {};
  const has = (k) => body[k] !== undefined;
  if (has('code') || !partial) {
    const code = promoLib.normalize(body.code);
    if (!/^[A-Z0-9_-]{3,20}$/.test(code)) throw new Error('Code must be 3–20 letters or numbers.');
    data.code = code;
  }
  if (has('description')) data.description = String(body.description || '').slice(0, 120) || null;
  if (has('type') || !partial) {
    if (!['FLAT', 'PERCENT', 'CREDIT'].includes(body.type)) throw new Error('Type must be FLAT (₦), PERCENT (%) or CREDIT (wallet gift).');
    data.type = body.type;
  }
  if (has('value') || !partial) {
    const v = Number(body.value);
    if (!(v > 0)) throw new Error('Value must be more than 0.');
    if ((body.type || 'FLAT') === 'PERCENT' && v > 100) throw new Error('A percentage must be 100 or less.');
    if (body.type === 'CREDIT' && v > 100000) throw new Error('A wallet coupon can be at most ₦100,000.');
    data.value = v;
  }
  if (has('maxDiscount')) data.maxDiscount = body.maxDiscount === '' || body.maxDiscount == null ? null : Number(body.maxDiscount);
  if (has('minAmount')) data.minAmount = Number(body.minAmount || 0);
  if (has('services')) data.services = (Array.isArray(body.services) ? body.services : []).filter((s) => SERVICES.includes(s));
  if (has('usageLimit')) data.usageLimit = body.usageLimit === '' || body.usageLimit == null ? null : Math.max(1, parseInt(body.usageLimit, 10));
  if (has('perCustomerLimit')) data.perCustomerLimit = Math.max(1, parseInt(body.perCustomerLimit, 10) || 1);
  if (has('newCustomersOnly')) data.newCustomersOnly = Boolean(body.newCustomersOnly);
  if (has('active')) data.active = Boolean(body.active);
  if (has('expiresAt')) data.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  if (!partial && data.type === 'CREDIT') {
    // Wallet gifts cost real money on every use, so a cap is required.
    if (!data.usageLimit) throw new Error('Set “Total uses allowed” for a wallet gift coupon.');
    data.services = [];
    data.minAmount = 0;
  }
  return data;
}

router.get('/admin/promos', requireAdminAuth, async (req, res) => {
  try {
    const promos = await prisma.promoCode.findMany({ orderBy: { createdAt: 'desc' } });
    const totals = await prisma.promoRedemption.groupBy({ by: ['promoId'], _sum: { discount: true } });
    const given = Object.fromEntries(totals.map((t) => [t.promoId, Number(t._sum.discount || 0)]));
    res.json({ promos: promos.map((p) => ({ ...p, totalDiscount: given[p.id] || 0 })) });
  } catch (error) {
    console.error('GET /admin/promos failed:', error);
    res.status(500).json({ error: 'Could not load promo codes.' });
  }
});

router.post('/admin/promos', requireAdminAuth, async (req, res) => {
  try {
    const data = promoData(req.body || {}, false);
    const promo = await prisma.promoCode.create({ data });
    await audit(req, 'PROMO_CREATED', { code: promo.code });
    res.status(201).json({ promo });
  } catch (error) {
    if (error.code === 'P2002') return res.status(400).json({ error: 'That code already exists.' });
    res.status(400).json({ error: error.message || 'Could not create the promo code.' });
  }
});

router.patch('/admin/promos/:id', requireAdminAuth, async (req, res) => {
  try {
    const promo = await prisma.promoCode.update({ where: { id: req.params.id }, data: promoData(req.body || {}, true) });
    await audit(req, 'PROMO_UPDATED', { code: promo.code });
    res.json({ promo });
  } catch (error) {
    if (error.code === 'P2002') return res.status(400).json({ error: 'That code already exists.' });
    res.status(400).json({ error: error.message || 'Could not update the promo code.' });
  }
});

// --- Admin: service notices ----------------------------------------

router.get('/admin/notices', requireAdminAuth, async (req, res) => {
  try {
    res.json({ notices: await prisma.serviceNotice.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }) });
  } catch (error) {
    console.error('GET /admin/notices failed:', error);
    res.status(500).json({ error: 'Could not load notices.' });
  }
});

router.post('/admin/notices', requireAdminAuth, async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim().slice(0, 200);
    if (!message) return res.status(400).json({ error: 'Write the notice message.' });
    const service = SERVICES.includes(req.body?.service) ? req.body.service : null;
    const level = req.body?.level === 'WARNING' ? 'WARNING' : 'INFO';
    const hours = Number(req.body?.hours || 0);
    const notice = await prisma.serviceNotice.create({
      data: { message, service, level, expiresAt: hours > 0 ? new Date(Date.now() + hours * 3600 * 1000) : null },
    });
    await audit(req, 'NOTICE_POSTED', { message, service });
    res.status(201).json({ notice });
  } catch (error) {
    console.error('POST /admin/notices failed:', error);
    res.status(500).json({ error: 'Could not post the notice.' });
  }
});

router.patch('/admin/notices/:id', requireAdminAuth, async (req, res) => {
  try {
    const notice = await prisma.serviceNotice.update({ where: { id: req.params.id }, data: { active: Boolean(req.body?.active) } });
    res.json({ notice });
  } catch (error) {
    console.error('PATCH /admin/notices failed:', error);
    res.status(500).json({ error: 'Could not update the notice.' });
  }
});

// --- Admin: account deletion ---------------------------------------

router.get('/admin/deletion-requests', requireAdminAuth, async (req, res) => {
  try {
    const customers = await prisma.customer.findMany({
      where: { deletionRequestedAt: { not: null }, deletedAt: null },
      select: { id: true, name: true, phone: true, walletBalance: true, deletionRequestedAt: true, deletionReason: true },
      orderBy: { deletionRequestedAt: 'asc' },
    });
    res.json({ customers });
  } catch (error) {
    console.error('GET /admin/deletion-requests failed:', error);
    res.status(500).json({ error: 'Could not load deletion requests.' });
  }
});

// Wipes personal details but keeps the transaction ledger (needed for
// accounting). Only when the wallet is empty, so no money is lost.
router.post('/admin/customers/:id/delete-account', requireAdminAuth, async (req, res) => {
  try {
    if (req.body?.confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm.' });
    const c = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!c) return res.status(404).json({ error: 'Customer not found.' });
    if (c.deletedAt) return res.status(400).json({ error: 'This account is already deleted.' });
    if (Number(c.walletBalance) > 0) {
      return res.status(400).json({ error: `This customer still has ₦${Number(c.walletBalance).toLocaleString()} in their wallet. Pay it out or ask them to spend it first.` });
    }
    const tag = `deleted-${c.id.slice(-8)}`;
    await prisma.$transaction([
      prisma.trustedDevice.deleteMany({ where: { customerId: c.id } }),
      prisma.beneficiary.deleteMany({ where: { customerId: c.id } }),
      prisma.scheduledPurchase.deleteMany({ where: { customerId: c.id } }),
      prisma.customer.update({
        where: { id: c.id },
        data: {
          name: 'Deleted user',
          phone: tag,
          username: null,
          email: null,
          avatarUrl: null,
          pinHash: null,
          active: false,
          emailAlerts: false,
          bankAccountRef: null,
          bankAccounts: Prisma.DbNull,
          kycType: null,
          kycHash: null,
          deletedAt: new Date(),
        },
      }),
    ]);
    await audit(req, 'CUSTOMER_DELETED', { customerId: c.id, name: c.name, phone: c.phone });
    res.json({ ok: true });
  } catch (error) {
    console.error('POST /admin/customers/:id/delete-account failed:', error);
    res.status(500).json({ error: 'Could not delete the account.' });
  }
});

module.exports = router;
