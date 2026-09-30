const express = require('express');
const prisma = require('../lib/prisma');
const { getSettings, invalidateSettings } = require('../lib/vtpass');
const { notify } = require('../lib/notify');
const { requireAdminAuth, hashPassword, comparePassword } = require('../lib/auth');

const router = express.Router();

// The AI key never goes back to the browser — only whether one is saved
// and its last 4 characters.
function safeSettings(settings) {
  const out = { ...settings };
  delete out.vapidPrivateKey;
  out.aiApiKeySet = Boolean(out.aiApiKey);
  out.aiApiKeyHint = out.aiApiKey ? `…${out.aiApiKey.slice(-4)}` : null;
  delete out.aiApiKey;
  return out;
}

router.get('/admin/settings', requireAdminAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ settings: safeSettings(settings) });
  } catch (error) {
    console.error('GET /admin/settings failed:', error);
    res.status(500).json({ error: 'Could not load settings.' });
  }
});

// The one place VTpass credentials and markup get changed — logged to
// AuditLog since this is the most sensitive endpoint in the app (wrong
// keys here means every purchase fails; a wrong mode flips live money
// to sandbox or back).
router.patch('/admin/settings', requireAdminAuth, async (req, res) => {
  try {
    const { vtpassMode, vtpassApiKey, vtpassSecretKey, vtpassPublicKey, markupPercentByService, markupCapByService, discountPercentByService, minFundingAmount, minPurchaseAmount,
      airtimeToCashEnabled, airtimeToCashFeePercent, airtimeToCashMinAmount, airtimeToCashNumbers,
      referralEnabled, referralBonusAmount, referralMinPurchase, bankFundingFeePercent, bankFundingFeeCap,
      monnifyMode, monnifyApiKey, monnifySecretKey, monnifyContractCode,
      monnifyWalletAccount, bankTransferEnabled, bankTransferFee, bankTransferFeeMid, bankTransferFeeHigh, bankTransferMin, bankTransferMax, bankTransferDailyMax,
      emailAlertsEnabled, kycLimitsEnabled, dailyLimitUnverified, dailyLimitVerified, cashbackEnabled, cashbackPercentByService, cashbackMaxPerOrder, supportWhatsapp, fraudHoldEnabled, fraudHoldAmount, fraudHoldHours, adminTwoFactorEnabled, dailySummaryEnabled, loyaltyEnabled, loyaltyPointsPer100, loyaltyPointValue, loyaltyMinRedeem, manualFundingEnabled, manualBankName, manualAccountNumber, manualAccountName, manualAccounts, hiddenFundingBanks,
      agentPricingEnabled, agentDiscountPercentByService,
      aiApiKey, aiApiKeyClear, aiCustomerEnabled, aiChatBuyEnabled, adminAlertPush, adminAlertEmail, feedbackPromptEnabled, rewardGuardEnabled, rewardGuardPercent, escalationHours, vtpassSupportEmail, savingsEnabled, savingsRatePct, savingsMinBalance, savingsMaxBalance, savingsDailyBudget, savingsPartnerNote, purchasesPaused, pausedServices, maintenanceMessage, errorAlertsEnabled, aiAdminEnabled, aiCustomerModel, aiAdminModel, aiCustomerDailyLimit, aiMonthlyBudgetUsd } = req.body;
    if (vtpassMode !== undefined && !['sandbox', 'live'].includes(vtpassMode)) {
      return res.status(400).json({ error: 'vtpassMode must be "sandbox" or "live".' });
    }

    // Every discount must be a real percentage between 0 and 100 — a
    // typo like 500 would otherwise make purchases free (clamped to
    // ₦0 in lib/pricing.js) with nothing flagging it.
    if (discountPercentByService !== undefined) {
      if (typeof discountPercentByService !== 'object' || discountPercentByService === null || Array.isArray(discountPercentByService)) {
        return res.status(400).json({ error: 'discountPercentByService must be an object.' });
      }
      for (const [svc, pct] of Object.entries(discountPercentByService)) {
        const n = Number(pct);
        if (!Number.isFinite(n) || n < 0 || n > 100) {
          return res.status(400).json({ error: `Discount for ${svc} must be between 0 and 100.` });
        }
      }
    }

    if (airtimeToCashFeePercent !== undefined) {
      const n = Number(airtimeToCashFeePercent);
      if (!Number.isFinite(n) || n < 0 || n >= 100) {
        return res.status(400).json({ error: 'Airtime-to-Cash fee must be at least 0 and below 100.' });
      }
    }
    if (airtimeToCashNumbers !== undefined && (typeof airtimeToCashNumbers !== 'object' || airtimeToCashNumbers === null || Array.isArray(airtimeToCashNumbers))) {
      return res.status(400).json({ error: 'airtimeToCashNumbers must be an object.' });
    }

    for (const [label, v] of [['Referral bonus', referralBonusAmount], ['Referral minimum purchase', referralMinPurchase]]) {
      if (v !== undefined && (!Number.isFinite(Number(v)) || Number(v) < 0)) {
        return res.status(400).json({ error: `${label} must be 0 or more.` });
      }
    }

    for (const [label, v] of [['Bank transfer fee', bankTransferFee], ['Minimum transfer', bankTransferMin], ['Maximum transfer', bankTransferMax], ['Daily transfer limit', bankTransferDailyMax]]) {
      if (v !== undefined && (!Number.isFinite(Number(v)) || Number(v) < 0)) return res.status(400).json({ error: `${label} must be 0 or more.` });
    }
    for (const [label, v] of [['Unverified daily limit', dailyLimitUnverified], ['Verified daily limit', dailyLimitVerified], ['Cashback cap', cashbackMaxPerOrder]]) {
      if (v !== undefined && (!Number.isFinite(Number(v)) || Number(v) < 0)) return res.status(400).json({ error: `${label} must be 0 or more.` });
    }
    if (cashbackPercentByService !== undefined) {
      if (typeof cashbackPercentByService !== 'object' || cashbackPercentByService === null || Array.isArray(cashbackPercentByService)) {
        return res.status(400).json({ error: 'cashbackPercentByService must be an object.' });
      }
      for (const [svc, pct] of Object.entries(cashbackPercentByService)) {
        const n = Number(pct);
        if (!Number.isFinite(n) || n < 0 || n > 20) return res.status(400).json({ error: `Cashback for ${svc} must be between 0 and 20%.` });
      }
    }
    if (agentDiscountPercentByService !== undefined) {
      if (typeof agentDiscountPercentByService !== 'object' || agentDiscountPercentByService === null || Array.isArray(agentDiscountPercentByService)) {
        return res.status(400).json({ error: 'agentDiscountPercentByService must be an object.' });
      }
      for (const [svc, pct] of Object.entries(agentDiscountPercentByService)) {
        const n = Number(pct);
        if (!Number.isFinite(n) || n < 0 || n > 50) return res.status(400).json({ error: `Agent discount for ${svc} must be between 0 and 50%.` });
      }
    }
    if (monnifyMode !== undefined && !['sandbox', 'live'].includes(monnifyMode)) {
      return res.status(400).json({ error: 'monnifyMode must be "sandbox" or "live".' });
    }
    if (bankFundingFeePercent !== undefined) {
      const n = Number(bankFundingFeePercent);
      if (!Number.isFinite(n) || n < 0 || n > 10) return res.status(400).json({ error: 'Bank funding fee must be between 0 and 10%.' });
    }
    if (bankFundingFeeCap !== undefined && (!Number.isFinite(Number(bankFundingFeeCap)) || Number(bankFundingFeeCap) < 0)) {
      return res.status(400).json({ error: 'Bank funding fee cap must be 0 or more.' });
    }

    const existing = await getSettings();
    const wasSavingsOn = Boolean(existing.savingsEnabled);
    const data = {};
    if (vtpassMode !== undefined) data.vtpassMode = vtpassMode;
    if (vtpassApiKey !== undefined) data.vtpassApiKey = vtpassApiKey;
    if (vtpassSecretKey !== undefined) data.vtpassSecretKey = vtpassSecretKey;
    if (vtpassPublicKey !== undefined) data.vtpassPublicKey = vtpassPublicKey;
    if (markupPercentByService !== undefined) data.markupPercentByService = markupPercentByService;
    if (markupCapByService !== undefined) {
      if (!markupCapByService || typeof markupCapByService !== 'object') return res.status(400).json({ error: 'Invalid markup maximums.' });
      data.markupCapByService = Object.fromEntries(Object.entries(markupCapByService).map(([k, v]) => [k, Number(v)]).filter(([, v]) => Number.isFinite(v) && v > 0));
    }
    if (discountPercentByService !== undefined) {
      data.discountPercentByService = Object.fromEntries(
        Object.entries(discountPercentByService).map(([svc, pct]) => [svc, Number(pct)])
      );
    }
    if (minFundingAmount !== undefined) data.minFundingAmount = Number(minFundingAmount);
    if (minPurchaseAmount !== undefined) data.minPurchaseAmount = Number(minPurchaseAmount);
    if (airtimeToCashEnabled !== undefined) data.airtimeToCashEnabled = Boolean(airtimeToCashEnabled);
    if (airtimeToCashFeePercent !== undefined) data.airtimeToCashFeePercent = Number(airtimeToCashFeePercent);
    if (airtimeToCashMinAmount !== undefined) data.airtimeToCashMinAmount = Number(airtimeToCashMinAmount);
    if (referralEnabled !== undefined) data.referralEnabled = Boolean(referralEnabled);
    if (referralBonusAmount !== undefined) data.referralBonusAmount = Number(referralBonusAmount);
    if (referralMinPurchase !== undefined) data.referralMinPurchase = Number(referralMinPurchase);
    if (bankFundingFeePercent !== undefined) data.bankFundingFeePercent = Number(bankFundingFeePercent);
    if (bankFundingFeeCap !== undefined) data.bankFundingFeeCap = Number(bankFundingFeeCap);
    if (monnifyMode !== undefined) data.monnifyMode = monnifyMode;
    if (monnifyApiKey !== undefined) data.monnifyApiKey = String(monnifyApiKey).trim() || null;
    if (monnifySecretKey !== undefined) data.monnifySecretKey = String(monnifySecretKey).trim() || null;
    if (monnifyContractCode !== undefined) data.monnifyContractCode = String(monnifyContractCode).trim() || null;
    if (monnifyWalletAccount !== undefined) data.monnifyWalletAccount = String(monnifyWalletAccount).replace(/\D/g, '') || null;
    if (bankTransferEnabled !== undefined) data.bankTransferEnabled = Boolean(bankTransferEnabled);
    if (bankTransferFee !== undefined) data.bankTransferFee = Number(bankTransferFee);
    for (const [key, v] of [['bankTransferFeeMid', bankTransferFeeMid], ['bankTransferFeeHigh', bankTransferFeeHigh]]) {
      if (v === undefined) continue;
      if (v === null || v === '') { data[key] = null; continue; }
      if (!Number.isFinite(Number(v)) || Number(v) < 0) return res.status(400).json({ error: 'Transfer fees must be 0 or more.' });
      data[key] = Number(v);
    }
    if (bankTransferMin !== undefined) data.bankTransferMin = Number(bankTransferMin);
    if (bankTransferMax !== undefined) data.bankTransferMax = Number(bankTransferMax);
    if (bankTransferDailyMax !== undefined) data.bankTransferDailyMax = Number(bankTransferDailyMax);
    if (emailAlertsEnabled !== undefined) data.emailAlertsEnabled = Boolean(emailAlertsEnabled);
    if (kycLimitsEnabled !== undefined) data.kycLimitsEnabled = Boolean(kycLimitsEnabled);
    if (dailyLimitUnverified !== undefined) data.dailyLimitUnverified = Number(dailyLimitUnverified);
    if (dailyLimitVerified !== undefined) data.dailyLimitVerified = Number(dailyLimitVerified);
    if (cashbackEnabled !== undefined) data.cashbackEnabled = Boolean(cashbackEnabled);
    if (cashbackPercentByService !== undefined) {
      data.cashbackPercentByService = Object.fromEntries(Object.entries(cashbackPercentByService).map(([k, v]) => [k, Number(v)]).filter(([, v]) => v > 0));
    }
    if (cashbackMaxPerOrder !== undefined) data.cashbackMaxPerOrder = Number(cashbackMaxPerOrder);
    if (agentPricingEnabled !== undefined) data.agentPricingEnabled = Boolean(agentPricingEnabled);
    if (agentDiscountPercentByService !== undefined) {
      data.agentDiscountPercentByService = Object.fromEntries(Object.entries(agentDiscountPercentByService).map(([k, v]) => [k, Number(v)]).filter(([, v]) => v > 0));
    }
    if (manualFundingEnabled !== undefined) data.manualFundingEnabled = Boolean(manualFundingEnabled);
    if (fraudHoldEnabled !== undefined) data.fraudHoldEnabled = Boolean(fraudHoldEnabled);
    if (fraudHoldAmount !== undefined) data.fraudHoldAmount = Math.max(0, Number(fraudHoldAmount) || 0);
    if (fraudHoldHours !== undefined) data.fraudHoldHours = Math.min(720, Math.max(1, parseInt(fraudHoldHours, 10) || 24));
    if (dailySummaryEnabled !== undefined) data.dailySummaryEnabled = Boolean(dailySummaryEnabled);
    if (loyaltyEnabled !== undefined) data.loyaltyEnabled = Boolean(loyaltyEnabled);
    if (loyaltyPointsPer100 !== undefined) data.loyaltyPointsPer100 = Math.min(100, Math.max(0, Number(loyaltyPointsPer100) || 0));
    if (loyaltyPointValue !== undefined) data.loyaltyPointValue = Math.min(100, Math.max(0, Number(loyaltyPointValue) || 0));
    if (loyaltyMinRedeem !== undefined) data.loyaltyMinRedeem = Math.max(1, parseInt(loyaltyMinRedeem, 10) || 1);
    if (adminTwoFactorEnabled !== undefined) {
      if (adminTwoFactorEnabled && !require('../lib/email').isEmailConfigured()) {
        return res.status(400).json({ error: 'Set up email (Resend) on Render before turning on two-step login.' });
      }
      data.adminTwoFactorEnabled = Boolean(adminTwoFactorEnabled);
    }
    if (manualBankName !== undefined) data.manualBankName = String(manualBankName).trim().slice(0, 60) || null;
    if (manualAccountName !== undefined) data.manualAccountName = String(manualAccountName).trim().slice(0, 80) || null;
    if (manualAccountNumber !== undefined) {
      const n = String(manualAccountNumber).replace(/\D/g, '');
      if (n && n.length !== 10) return res.status(400).json({ error: 'Account number must be 10 digits.' });
      data.manualAccountNumber = n || null;
    }
    if (manualAccounts !== undefined) {
      if (!Array.isArray(manualAccounts) || manualAccounts.length > 10) return res.status(400).json({ error: 'Add up to 10 business accounts.' });
      const list = [];
      for (const a of manualAccounts) {
        const accountNumber = String(a?.accountNumber || '').replace(/\D/g, '');
        const bankName = String(a?.bankName || '').trim().slice(0, 60);
        const accountName = String(a?.accountName || '').trim().slice(0, 80);
        if (!accountNumber && !bankName && !accountName) continue;
        if (accountNumber.length !== 10) return res.status(400).json({ error: `Account number for ${bankName || 'a bank'} must be 10 digits.` });
        if (!bankName || !accountName) return res.status(400).json({ error: 'Each business account needs a bank name and account name.' });
        list.push({ id: String(a.id || require('crypto').randomBytes(4).toString('hex')).slice(0, 20), bankName, accountNumber, accountName, enabled: a.enabled !== false });
      }
      data.manualAccounts = list;
      // Keep the old single-account fields in step (first account).
      data.manualBankName = list[0]?.bankName || null;
      data.manualAccountNumber = list[0]?.accountNumber || null;
      data.manualAccountName = list[0]?.accountName || null;
    }
    if (hiddenFundingBanks !== undefined) {
      data.hiddenFundingBanks = Array.isArray(hiddenFundingBanks) ? [...new Set(hiddenFundingBanks.map((b) => String(b).trim().slice(0, 60)).filter(Boolean))].slice(0, 20) : [];
    }
    if (adminAlertPush !== undefined) data.adminAlertPush = Boolean(adminAlertPush);
    if (adminAlertEmail !== undefined) data.adminAlertEmail = Boolean(adminAlertEmail);
    if (feedbackPromptEnabled !== undefined) data.feedbackPromptEnabled = Boolean(feedbackPromptEnabled);
    if (rewardGuardEnabled !== undefined) data.rewardGuardEnabled = Boolean(rewardGuardEnabled);
    if (escalationHours !== undefined) data.escalationHours = Math.min(168, Math.max(1, parseInt(escalationHours, 10) || 24));
    if (vtpassSupportEmail !== undefined) {
      const e = String(vtpassSupportEmail || '').trim();
      if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return res.status(400).json({ error: 'Enter a valid VTpass support email.' });
      data.vtpassSupportEmail = e || null;
    }
    if (rewardGuardPercent !== undefined) {
      const p = parseInt(rewardGuardPercent, 10);
      if (!(p >= 0 && p <= 100)) return res.status(400).json({ error: 'Safety limit must be between 0 and 100%.' });
      data.rewardGuardPercent = p;
    }
    // Maintenance mode (lib/maintenance.js).
    if (purchasesPaused !== undefined) data.purchasesPaused = Boolean(purchasesPaused);
    if (errorAlertsEnabled !== undefined) data.errorAlertsEnabled = Boolean(errorAlertsEnabled);
    if (pausedServices !== undefined) {
      if (!Array.isArray(pausedServices)) return res.status(400).json({ error: 'pausedServices must be a list.' });
      const allowed = require('../lib/maintenance').SERVICES;
      data.pausedServices = [...new Set(pausedServices.filter((x) => allowed.includes(x)))];
    }
    if (maintenanceMessage !== undefined) data.maintenanceMessage = String(maintenanceMessage || '').trim().slice(0, 200) || null;
    // Savings with daily interest (lib/savings.js).
    if (savingsPartnerNote !== undefined) data.savingsPartnerNote = String(savingsPartnerNote || '').trim().slice(0, 300) || null;
    if (savingsRatePct !== undefined) {
      const r = Math.round(Number(savingsRatePct) * 100) / 100;
      if (!(r > 0 && r <= 30)) return res.status(400).json({ error: 'Savings interest must be more than 0% and at most 30% a year.' });
      data.savingsRatePct = r;
    }
    for (const [field, value, lo, hi] of [['savingsMinBalance', savingsMinBalance, 0, 10000000], ['savingsMaxBalance', savingsMaxBalance, 1, 100000000], ['savingsDailyBudget', savingsDailyBudget, 0, 100000000]]) {
      if (value === undefined) continue;
      const n = parseInt(value, 10);
      if (!(n >= lo && n <= hi)) return res.status(400).json({ error: `${field} must be between ${lo} and ${hi}.` });
      data[field] = n;
    }
    if ((data.savingsMinBalance ?? existing.savingsMinBalance) > (data.savingsMaxBalance ?? existing.savingsMaxBalance)) {
      return res.status(400).json({ error: 'The minimum savings balance can’t be more than the maximum.' });
    }
    if (savingsEnabled !== undefined) data.savingsEnabled = Boolean(savingsEnabled);
    if (data.savingsEnabled && !wasSavingsOn) {
      const note = data.savingsPartnerNote !== undefined ? data.savingsPartnerNote : existing.savingsPartnerNote;
      if (!note || note.length < 5) {
        return res.status(400).json({ error: 'Paying interest on customer money needs a CBN licence or a licensed partner. Enter which one before turning savings on.' });
      }
    }
    if (aiApiKeyClear) data.aiApiKey = null;
    else if (aiApiKey !== undefined && String(aiApiKey).trim()) {
      const k = String(aiApiKey).trim();
      if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) return res.status(400).json({ error: 'That does not look like a Claude API key (it should start with sk-ant-).' });
      data.aiApiKey = k;
    }
    if (aiCustomerEnabled !== undefined) data.aiCustomerEnabled = Boolean(aiCustomerEnabled);
    if (aiChatBuyEnabled !== undefined) data.aiChatBuyEnabled = Boolean(aiChatBuyEnabled);
    if (aiAdminEnabled !== undefined) data.aiAdminEnabled = Boolean(aiAdminEnabled);
    for (const [field, value] of [['aiCustomerModel', aiCustomerModel], ['aiAdminModel', aiAdminModel]]) {
      if (value === undefined) continue;
      const m = String(value).trim();
      if (!/^claude-[a-z0-9.-]{3,60}$/.test(m)) return res.status(400).json({ error: 'Model names look like claude-haiku-4-5.' });
      data[field] = m;
    }
    if (aiCustomerDailyLimit !== undefined) data.aiCustomerDailyLimit = Math.min(500, Math.max(1, parseInt(aiCustomerDailyLimit, 10) || 20));
    if (aiMonthlyBudgetUsd !== undefined) data.aiMonthlyBudgetUsd = Math.min(10000, Math.max(0, Number(aiMonthlyBudgetUsd) || 0));
    if ((data.aiCustomerEnabled || data.aiAdminEnabled) && !data.aiApiKey && !existing.aiApiKey && !process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ error: 'Paste your Claude API key before turning the assistant on.' });
    }
    if (supportWhatsapp !== undefined) {
      let n = String(supportWhatsapp).replace(/\D/g, '');
      if (n.startsWith('0')) n = `234${n.slice(1)}`;
      data.supportWhatsapp = n || null;
    }
    if (airtimeToCashNumbers !== undefined) {
      // Only keep networks that actually have a number filled in.
      data.airtimeToCashNumbers = Object.fromEntries(
        Object.entries(airtimeToCashNumbers)
          .map(([net, num]) => [net, String(num || '').trim()])
          .filter(([, num]) => num)
      );
    }

    const settings = safeSettings(await prisma.settings.update({ where: { id: existing.id }, data }));
    invalidateSettings();

    await prisma.auditLog.create({
      data: {
        actorAdminId: req.admin.adminId,
        action: 'SETTINGS_UPDATED',
        // Discount values are logged in full (unlike keys, they're not
        // secret) so there's a record of who set what discount when.
        details: {
          changedFields: Object.keys(data),
          ...(data.discountPercentByService ? { discountPercentByService: data.discountPercentByService } : {}),
        },
      },
    });

    if (data.savingsEnabled === false && wasSavingsOn) {
      require('../lib/savings').tellSaversItIsOff().catch(() => {});
    }
    res.json({ settings });
  } catch (error) {
    console.error('PATCH /admin/settings failed:', error);
    res.status(500).json({ error: 'Could not update settings.' });
  }
});

router.post('/admin/daily-summary/test', requireAdminAuth, async (req, res) => {
  try {
    if (!require('../lib/email').isEmailConfigured()) return res.status(400).json({ error: 'Email (Resend) is not set up on Render yet.' });
    const r = await require('../lib/dailySummary').sendDailySummary({ force: true });
    res.json(r);
  } catch (error) {
    console.error('POST /admin/daily-summary/test failed:', error);
    res.status(500).json({ error: 'Could not send the summary.' });
  }
});

router.post('/admin/monnify/test', requireAdminAuth, async (req, res) => {
  try {
    res.json(await require('../lib/monnify').testConnection());
  } catch (error) {
    console.error('POST /admin/monnify/test failed:', error);
    res.status(500).json({ error: 'Could not test the connection.' });
  }
});

router.get('/admin/customers', requireAdminAuth, async (req, res) => {
  try {
    const customers = await prisma.customer.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, phone: true, email: true, walletBalance: true, active: true, createdAt: true },
    });
    res.json({ customers });
  } catch (error) {
    console.error('GET /admin/customers failed:', error);
    res.status(500).json({ error: 'Could not load customers.' });
  }
});

// Everything about one customer in a single call — their profile,
// every order, and every wallet transaction — rather than making the
// frontend stitch together three separate fetches for what's really
// one detail view.
router.get('/admin/customers/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const customer = await prisma.customer.findUnique({
      where: { id },
      select: {
        id: true, name: true, phone: true, username: true, email: true, walletBalance: true, active: true, mustChangePassword: true, tempPasswordExpiresAt: true, createdAt: true,
        pinHash: true, referralBonusPaidAt: true, referralBonusAmount: true, bankAccounts: true, kycType: true, deletionRequestedAt: true, deletionReason: true, deletedAt: true, isAgent: true, agentRequestedAt: true, agentBusinessName: true, agentShopAddress: true, agentRejectedAt: true, agentRejectReason: true, dateOfBirth: true, securityQuestion: true, securityAnswerHash: true,
        referredBy: { select: { id: true, name: true, username: true } },
        pinLockedUntil: true,
        loginLockedUntil: true,
        _count: { select: { referrals: true, trustedDevices: true, webauthnCredentials: true } },
      },
    });
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });
    // Never send the PIN hash itself — just whether one exists.
    customer.hasPin = Boolean(customer.pinHash);
    delete customer.pinHash;
    // Support sees only whether these exist (and the question to ask),
    // never the date of birth or answer — they check what the caller
    // says with the identity check below.
    customer.hasDob = Boolean(customer.dateOfBirth);
    customer.hasSecurityAnswer = Boolean(customer.securityAnswerHash);
    delete customer.dateOfBirth;
    delete customer.securityAnswerHash;
    customer.referralCount = customer._count.referrals;
    customer.quickLoginDevices = customer._count.trustedDevices;
    customer.fingerprintLogins = customer._count.webauthnCredentials;
    customer.pinLocked = Boolean(customer.pinLockedUntil && new Date(customer.pinLockedUntil) > new Date());
    customer.loginLocked = Boolean(customer.loginLockedUntil && new Date(customer.loginLockedUntil) > new Date());
    delete customer._count;

    const [orders, walletTransactions] = await Promise.all([
      prisma.order.findMany({ where: { customerId: id }, orderBy: { createdAt: 'desc' } }),
      prisma.walletTransaction.findMany({ where: { customerId: id }, orderBy: { createdAt: 'desc' } }),
    ]);

    res.json({ customer, orders, walletTransactions });
  } catch (error) {
    console.error('GET /admin/customers/:id failed:', error);
    res.status(500).json({ error: 'Could not load customer.' });
  }
});

router.patch('/admin/customers/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { active } = req.body;
    if (active === undefined) return res.status(400).json({ error: 'active is required.' });

    const customer = await prisma.customer.update({
      where: { id },
      data: { active: !!active },
      select: { id: true, name: true, phone: true, active: true },
    });

    await prisma.auditLog.create({
      data: {
        actorAdminId: req.admin.adminId,
        action: active ? 'CUSTOMER_REACTIVATED' : 'CUSTOMER_DEACTIVATED',
        details: { customerId: id },
      },
    });

    res.json({ customer });
  } catch (error) {
    console.error('PATCH /admin/customers/:id failed:', error);
    res.status(500).json({ error: 'Could not update customer.' });
  }
});

// Forgotten-password support: issues a random temporary password the
// admin passes to the customer (e.g. on WhatsApp). The customer must
// replace it on their next login, and it stops working after 24 hours
// if unused. The password itself is only returned once, here — it is
// never stored in plain text or written to the audit log.
const TEMP_PASSWORD_HOURS = 24;
function generateTempPassword() {
  // No 0/O/1/I/l so it's easy to read out or type from a message.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = require('crypto').randomBytes(8);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `ZP-${out}`;
}

router.post('/admin/customers/:id/reset-password', requireAdminAuth, async (req, res) => {
  try {
    const existing = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Customer not found.' });

    const temporaryPassword = generateTempPassword();
    const expiresAt = new Date(Date.now() + TEMP_PASSWORD_HOURS * 60 * 60 * 1000);
    await prisma.customer.update({
      where: { id: existing.id },
      data: {
        passwordHash: await hashPassword(temporaryPassword),
        mustChangePassword: true,
        tempPasswordExpiresAt: expiresAt,
        loginFailedAttempts: 0,
        loginLockedUntil: null,
      },
    });

    await prisma.auditLog.create({
      data: { actorAdminId: req.admin.adminId, action: 'CUSTOMER_PASSWORD_RESET', details: { customerId: existing.id } },
    });
    notify(existing.id, 'Password Reset by Support', 'Your password was reset by ZappiPay support. Log in with the temporary password you were given, then choose a new one.');

    res.json({ temporaryPassword, expiresAt });
  } catch (error) {
    console.error('POST /admin/customers/:id/reset-password failed:', error);
    res.status(500).json({ error: 'Could not reset password.' });
  }
});

// Identity check before helping someone on WhatsApp/phone: support types
// what the caller says and gets match / no match back. At most 5 checks
// per customer per 15 minutes so it can't be used to guess.
const idChecks = new Map();
router.post('/admin/customers/:id/verify-identity', requireAdminAuth, async (req, res) => {
  try {
    const identity = require('../lib/identity');
    const key = req.params.id;
    const now = Date.now();
    const recent = (idChecks.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
    if (recent.length >= 5) return res.status(429).json({ error: 'Too many checks for this customer. Wait 15 minutes.' });
    recent.push(now);
    idChecks.set(key, recent);
    if (idChecks.size > 5000) idChecks.clear();

    const c = await prisma.customer.findUnique({ where: { id: key }, select: { id: true, name: true, dateOfBirth: true, securityAnswerHash: true } });
    if (!c) return res.status(404).json({ error: 'Customer not found.' });
    const result = {};
    if (req.body.dateOfBirth) {
      const dob = identity.parseDob(req.body.dateOfBirth);
      result.dob = !c.dateOfBirth ? 'NOT_SET' : dob.error ? 'NO_MATCH' : identity.sameDay(dob.date, c.dateOfBirth) ? 'MATCH' : 'NO_MATCH';
    }
    if (req.body.answer) {
      const ok = await identity.answerMatches(c, req.body.answer);
      result.answer = ok === null ? 'NOT_SET' : ok ? 'MATCH' : 'NO_MATCH';
    }
    if (!Object.keys(result).length) return res.status(400).json({ error: 'Enter the date of birth or answer the caller gave.' });
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'IDENTITY_CHECK', details: { customerId: c.id, name: c.name, ...result } } }).catch(() => {});
    res.json({ result, checksLeft: 5 - recent.length });
  } catch (error) {
    console.error('POST /admin/customers/:id/verify-identity failed:', error);
    res.status(500).json({ error: 'Could not check identity.' });
  }
});

// Clears date of birth + security question (e.g. customer typed a wrong
// date at signup). They'll be asked to set them again.
router.post('/admin/customers/:id/clear-security-details', requireAdminAuth, async (req, res) => {
  try {
    const c = await prisma.customer.update({ where: { id: req.params.id }, data: { dateOfBirth: null, securityQuestion: null, securityAnswerHash: null }, select: { id: true, name: true } });
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'SECURITY_DETAILS_CLEARED', details: { customerId: c.id, name: c.name } } }).catch(() => {});
    notify(c.id, 'Security Details Reset', 'Support reset your date of birth and security question. Please set them again in Profile → Security details.');
    res.json({ ok: true });
  } catch (error) {
    console.error('POST /admin/customers/:id/clear-security-details failed:', error);
    res.status(500).json({ error: 'Could not reset security details.' });
  }
});

router.get('/admin/audit-log', requireAdminAuth, async (req, res) => {
  try {
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ logs });
  } catch (error) {
    console.error('GET /admin/audit-log failed:', error);
    res.status(500).json({ error: 'Could not load audit log.' });
  }
});

// Direct wallet correction — unlike the customer-submitted fund
// requests in wallet.routes.js, this doesn't need approval since an
// admin is the one initiating it. CREDIT/DEBIT both funnel through the
// same WalletTransaction ledger as everything else, so the customer's
// transaction history stays a complete, honest record of every balance
// change, not just the ones they requested themselves.
router.post('/admin/customers/:id/adjust-wallet', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { type, amount, note } = req.body;
    if (!['CREDIT', 'DEBIT'].includes(type)) {
      return res.status(400).json({ error: 'type must be CREDIT or DEBIT.' });
    }
    const amountNum = Number(amount);
    if (!amountNum || amountNum <= 0) {
      return res.status(400).json({ error: 'A positive amount is required.' });
    }

    const customer = await prisma.customer.findUnique({ where: { id } });
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });
    if (type === 'DEBIT' && Number(customer.walletBalance) < amountNum) {
      return res.status(400).json({ error: 'Customer does not have enough balance for this debit.' });
    }

    const [, transaction] = await prisma.$transaction([
      prisma.customer.update({
        where: { id },
        data: { walletBalance: type === 'CREDIT' ? { increment: amountNum } : { decrement: amountNum } },
      }),
      prisma.walletTransaction.create({
        data: {
          customerId: id,
          type: type === 'CREDIT' ? 'FUND' : 'DEBIT',
          amount: amountNum,
          status: 'APPROVED',
          note: note || `Manual ${type.toLowerCase()} by admin`,
          reviewedByAdminId: req.admin.adminId,
          reviewedAt: new Date(),
        },
      }),
    ]);

    await prisma.auditLog.create({
      data: {
        actorAdminId: req.admin.adminId,
        action: type === 'CREDIT' ? 'WALLET_MANUAL_CREDIT' : 'WALLET_MANUAL_DEBIT',
        details: { customerId: id, amount: amountNum, note },
      },
    });

    notify(
      id,
      type === 'CREDIT' ? 'Wallet Credited' : 'Wallet Debited',
      note || `An admin ${type === 'CREDIT' ? 'credited' : 'debited'} ₦${amountNum.toLocaleString()} to your wallet.`
    );

    res.json({ transaction });
  } catch (error) {
    console.error('POST /admin/customers/:id/adjust-wallet failed:', error);
    res.status(500).json({ error: 'Could not adjust wallet.' });
  }
});

// --- Admin/staff management ---
// Any logged-in admin can add another — there's no separate
// super-admin role in this V1, so anyone with the admin login can
// create more admin accounts and hand out access to staff.

router.get('/admin/admins', requireAdminAuth, async (req, res) => {
  try {
    const admins = await prisma.adminUser.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, email: true, active: true, role: true, createdAt: true },
    });
    res.json({ admins });
  } catch (error) {
    console.error('GET /admin/admins failed:', error);
    res.status(500).json({ error: 'Could not load admins.' });
  }
});

// The very first admin (earliest createdAt) is protected from
// deactivation in code — there's no separate super-admin role, so
// without this, the last person to deactivate everyone else could
// lock the whole team out of the panel with no way back in.
router.patch('/admin/admins/:id/active', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { active } = req.body;
    if (typeof active !== 'boolean') {
      return res.status(400).json({ error: 'active must be true or false.' });
    }

    const firstAdmin = await prisma.adminUser.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!active && firstAdmin?.id === id) {
      return res.status(400).json({ error: 'The original admin account cannot be deactivated.' });
    }

    const admin = await prisma.adminUser.update({
      where: { id },
      data: { active },
      select: { id: true, name: true, email: true, active: true, createdAt: true },
    });

    await prisma.auditLog.create({
      data: {
        actorAdminId: req.admin.adminId,
        action: active ? 'ADMIN_REACTIVATED' : 'ADMIN_DEACTIVATED',
        details: { targetAdminId: id },
      },
    });

    require('../lib/staffAccess').forget(id);
    res.json({ admin });
  } catch (error) {
    console.error('PATCH /admin/admins/:id/active failed:', error);
    res.status(500).json({ error: 'Could not update admin.' });
  }
});

// Lets one admin reset another's password directly — useful when a
// staff member is locked out and forgot-password isn't set up yet.
router.post('/admin/admins/:id/reset-password', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'A new password of at least 6 characters is required.' });
    }

    const passwordHash = await hashPassword(newPassword);
    const admin = await prisma.adminUser.update({
      where: { id },
      data: { passwordHash },
      select: { id: true, name: true, email: true },
    });

    await prisma.auditLog.create({
      data: {
        actorAdminId: req.admin.adminId,
        action: 'ADMIN_PASSWORD_RESET_BY_ADMIN',
        details: { targetAdminId: id },
      },
    });

    res.json({ admin });
  } catch (error) {
    console.error('POST /admin/admins/:id/reset-password failed:', error);
    res.status(500).json({ error: 'Could not reset password.' });
  }
});

// Change a staff member's access: OWNER (everything) or SUPPORT
// (customer care only). There must always be at least one active owner.
router.patch('/admin/admins/:id/role', requireAdminAuth, async (req, res) => {
  try {
    const role = req.body?.role === 'OWNER' ? 'OWNER' : req.body?.role === 'SUPPORT' ? 'SUPPORT' : null;
    if (!role) return res.status(400).json({ error: 'role must be OWNER or SUPPORT.' });
    const target = await prisma.adminUser.findUnique({ where: { id: req.params.id } });
    if (!target) return res.status(404).json({ error: 'Staff member not found.' });
    if (role === 'SUPPORT') {
      const owners = await prisma.adminUser.count({ where: { active: true, role: 'OWNER', id: { not: target.id } } });
      if (owners < 1) return res.status(400).json({ error: 'You need at least one other active owner first.' });
    }
    const admin = await prisma.adminUser.update({ where: { id: target.id }, data: { role }, select: { id: true, name: true, email: true, role: true, active: true } });
    require('../lib/staffAccess').forget(target.id);
    await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action: 'ADMIN_ROLE_CHANGED', details: { targetAdminId: target.id, name: target.name, role } } });
    res.json({ admin });
  } catch (error) {
    console.error('PATCH /admin/admins/:id/role failed:', error);
    res.status(500).json({ error: 'Could not change access.' });
  }
});

router.post('/admin/admins', requireAdminAuth, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const role = req.body.role === 'OWNER' ? 'OWNER' : 'SUPPORT';
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existing = await prisma.adminUser.findUnique({ where: { email: normalizedEmail } });
    if (existing) return res.status(409).json({ error: 'An admin with this email already exists.' });

    const passwordHash = await hashPassword(password);
    const admin = await prisma.adminUser.create({
      data: { name: name.trim(), email: normalizedEmail, passwordHash, role },
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    });

    await prisma.auditLog.create({
      data: {
        actorAdminId: req.admin.adminId,
        action: 'ADMIN_CREATED',
        details: { newAdminId: admin.id, email: admin.email, role },
      },
    });

    res.status(201).json({ admin });
  } catch (error) {
    console.error('POST /admin/admins failed:', error);
    res.status(500).json({ error: 'Could not create admin.' });
  }
});

router.patch('/admin/password', requireAdminAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }

    const admin = await prisma.adminUser.findUnique({ where: { id: req.admin.adminId } });
    if (!admin || !(await comparePassword(currentPassword, admin.passwordHash))) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.adminUser.update({ where: { id: admin.id }, data: { passwordHash } });

    await prisma.auditLog.create({
      data: { actorAdminId: admin.id, action: 'ADMIN_PASSWORD_CHANGED', details: {} },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('PATCH /admin/password failed:', error);
    res.status(500).json({ error: 'Could not change password.' });
  }
});

module.exports = router;
