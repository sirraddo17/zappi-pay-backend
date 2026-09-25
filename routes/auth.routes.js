const express = require('express');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { sendEmail } = require('../lib/email');
const { notify } = require('../lib/notify');
const {
  hashPassword,
  comparePassword,
  signAdminToken,
  signCustomerToken,
  requireCustomerAuth,
} = require('../lib/auth');

const router = express.Router();

function publicCustomer(customer) {
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    username: customer.username,
    email: customer.email,
    walletBalance: customer.walletBalance,
    avatarUrl: customer.avatarUrl,
    mustChangePassword: customer.mustChangePassword,
    hasPin: Boolean(customer.pinHash),
    verified: Boolean(customer.kycType),
    emailAlerts: customer.emailAlerts !== false,
    deletionRequestedAt: customer.deletionRequestedAt || null,
    isAgent: Boolean(customer.isAgent),
    agentRequestedAt: customer.agentRequestedAt || null,
  };
}

const APP_URL = (process.env.APP_URL || 'https://zappipay.com.ng').replace(/\/$/, '');
const RESET_TOKEN_MINUTES = 30;
const MAX_RESET_EMAILS_PER_HOUR = 3;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// --- Customer auth ---

router.post('/auth/signup', async (req, res) => {
  try {
    const { name, phone, email, password, username, referralCode } = req.body;
    if (!name || !phone || !password || !username) {
      return res.status(400).json({ error: 'name, phone, username, and password are required.' });
    }
    const normalizedUsername = username.trim().toLowerCase();
    const usernameError = require('./customers.routes').usernameProblem(normalizedUsername);
    if (usernameError) return res.status(400).json({ error: usernameError });

    const existing = await prisma.customer.findFirst({
      where: { OR: [{ phone: phone.trim() }, { username: normalizedUsername }] },
    });
    if (existing) {
      return res.status(409).json({
        error: existing.phone === phone.trim()
          ? 'An account with this phone number already exists.'
          : 'This username is already taken.',
      });
    }

    // Referral code = the referrer's username. An unknown code is an
    // error (rather than silently ignored) so the new customer can fix
    // a typo before their friend misses out on the bonus.
    let referredById;
    const code = String(referralCode || '').trim().toLowerCase().replace(/^@/, '');
    if (code) {
      const referrer = await prisma.customer.findFirst({ where: { username: code, active: true }, select: { id: true } });
      if (!referrer) return res.status(400).json({ error: 'That referral code was not found. Check it or leave it empty.' });
      referredById = referrer.id;
    }

    const passwordHash = await hashPassword(password);
    const customer = await prisma.customer.create({
      data: {
        name: name.trim(),
        phone: phone.trim(),
        username: normalizedUsername,
        email: email ? email.trim() : undefined,
        passwordHash,
        referredById,
      },
    });

    const token = signCustomerToken(customer);
    res.status(201).json({ token, customer: publicCustomer(customer) });
  } catch (error) {
    console.error('POST /auth/signup failed:', error);
    res.status(500).json({ error: 'Could not create account.' });
  }
});

router.post('/auth/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ error: 'identifier and password are required.' });
    }
    const trimmedIdentifier = identifier.trim();

    const customer = await prisma.customer.findFirst({
      where: { OR: [{ phone: trimmedIdentifier }, { username: trimmedIdentifier.toLowerCase() }] },
    });
    if (!customer || !(await comparePassword(password, customer.passwordHash))) {
      return res.status(401).json({ error: 'Invalid phone/username or password.' });
    }
    if (!customer.active) {
      return res.status(403).json({ error: 'This account has been deactivated.' });
    }
    if (customer.mustChangePassword && customer.tempPasswordExpiresAt && customer.tempPasswordExpiresAt < new Date()) {
      return res.status(403).json({ error: 'Your temporary password has expired. Please contact support for a new one.' });
    }

    // A successful password login unlocks a PIN that was locked by
    // too many wrong attempts.
    if (customer.pinFailedAttempts || customer.pinLockedUntil) {
      await prisma.customer.update({ where: { id: customer.id }, data: { pinFailedAttempts: 0, pinLockedUntil: null } });
    }

    // New-device alert: a password login from a browser/phone we
    // haven't seen for this account before.
    const fingerprint = require('crypto').createHash('sha256').update(String(req.headers['user-agent'] || 'unknown')).digest('hex').slice(0, 32);
    if (customer.lastLoginFingerprint !== fingerprint) {
      if (customer.lastLoginFingerprint) {
        const ua = String(req.headers['user-agent'] || '');
        const device = /iphone|ipad/i.test(ua) ? 'an iPhone/iPad' : /android/i.test(ua) ? 'an Android phone' : /windows/i.test(ua) ? 'a Windows computer' : /mac os/i.test(ua) ? 'a Mac' : 'a new device';
        notify(customer.id, 'New Login', `Your ZappiPay account was just logged into from ${device} (${new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}). If this wasn't you, change your password now.`);
      }
      prisma.customer.update({ where: { id: customer.id }, data: { lastLoginFingerprint: fingerprint, ...(customer.lastLoginFingerprint ? { securityChangedAt: new Date() } : {}) } }).catch(() => {});
    }

    const token = signCustomerToken(customer);
    res.json({ token, customer: publicCustomer(customer) });
  } catch (error) {
    console.error('POST /auth/login failed:', error);
    res.status(500).json({ error: 'Could not log in.' });
  }
});

router.get('/auth/me', requireCustomerAuth, async (req, res) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    if (!customer) return res.status(404).json({ error: 'Account not found.' });
    res.json({ customer: publicCustomer(customer) });
  } catch (error) {
    console.error('GET /auth/me failed:', error);
    res.status(500).json({ error: 'Could not load account.' });
  }
});

router.patch('/auth/me', requireCustomerAuth, async (req, res) => {
  try {
    const { name, email, avatarUrl } = req.body;
    const data = {};
    if (name !== undefined) data.name = name.trim();
    if (email !== undefined) data.email = email.trim() || null;
    if (avatarUrl !== undefined) {
      // A generous cap on the base64 string itself (roughly a 1.5MB
      // image once decoded) — there's no separate file storage doing
      // resizing for this app, so this is what stops someone's phone
      // photo from bloating a database row unreasonably.
      if (avatarUrl && avatarUrl.length > 2_000_000) {
        return res.status(400).json({ error: 'Image is too large. Please choose a smaller photo.' });
      }
      data.avatarUrl = avatarUrl || null;
    }

    const customer = await prisma.customer.update({
      where: { id: req.customer.customerId },
      data,
    });
    res.json({ customer: publicCustomer(customer) });
  } catch (error) {
    console.error('PATCH /auth/me failed:', error);
    res.status(500).json({ error: 'Could not update account.' });
  }
});

// --- Admin auth ---
// No self-service signup on purpose — admin accounts are seeded
// directly, same pattern used across the other apps in this ecosystem.

router.post('/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required.' });
    }

    const admin = await prisma.adminUser.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!admin || !(await comparePassword(password, admin.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    if (!admin.active) {
      return res.status(403).json({ error: 'This admin account has been deactivated.' });
    }

    // Two-step login: email a 6-digit code unless this browser was
    // remembered (signed 30-day token). ADMIN_2FA_DISABLED=1 on Render
    // is the emergency switch if email ever stops working.
    const settings = await require('../lib/vtpass').getSettings();
    const { isEmailConfigured, sendEmail } = require('../lib/email');
    const needs2fa = settings.adminTwoFactorEnabled && isEmailConfigured() && process.env.ADMIN_2FA_DISABLED !== '1';
    if (needs2fa && !validRememberToken(req.body.rememberToken, admin.id)) {
      const recent = await prisma.adminLoginCode.count({ where: { adminId: admin.id, createdAt: { gt: new Date(Date.now() - 15 * 60 * 1000) } } });
      if (recent >= 5) return res.status(429).json({ error: 'Too many login codes requested. Try again in 15 minutes.' });
      const code = String(require('crypto').randomInt(0, 1000000)).padStart(6, '0');
      const challenge = await prisma.adminLoginCode.create({
        data: { adminId: admin.id, codeHash: await hashPassword(code), expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
      });
      const sent = await sendEmail({
        to: admin.email,
        subject: `ZappiPay admin login code: ${code}`,
        html: `<p>Your ZappiPay admin login code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p><p>It expires in 10 minutes. If you didn't try to log in, change your admin password now.</p>`,
        text: `Your ZappiPay admin login code is ${code}. It expires in 10 minutes.`,
      });
      if (!sent.sent) return res.status(502).json({ error: 'Could not send your login code by email. Try again shortly.' });
      const [user, domain] = admin.email.split('@');
      return res.json({ twoFactor: true, challengeId: challenge.id, emailHint: `${user.slice(0, 2)}***@${domain}` });
    }

    const token = signAdminToken(admin);
    res.json({ token, admin: { id: admin.id, name: admin.name, email: admin.email } });
  } catch (error) {
    console.error('POST /admin/login failed:', error);
    res.status(500).json({ error: 'Could not log in.' });
  }
});

function validRememberToken(token, adminId) {
  if (!token) return false;
  try {
    const p = require('jsonwebtoken').verify(String(token), process.env.JWT_SECRET);
    return p.kind === 'admin2fa' && p.sub === adminId;
  } catch {
    return false;
  }
}

router.post('/admin/login/verify', async (req, res) => {
  try {
    const { challengeId, code, remember } = req.body || {};
    const challenge = challengeId ? await prisma.adminLoginCode.findUnique({ where: { id: String(challengeId) }, include: { admin: true } }) : null;
    if (!challenge || challenge.usedAt || challenge.expiresAt < new Date()) {
      return res.status(400).json({ error: 'This code has expired. Log in again to get a new one.' });
    }
    if (challenge.attempts >= 5) return res.status(429).json({ error: 'Too many wrong codes. Log in again to get a new one.' });
    const ok = /^\d{6}$/.test(String(code || '')) && (await comparePassword(String(code), challenge.codeHash));
    if (!ok) {
      await prisma.adminLoginCode.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
      return res.status(401).json({ error: 'Wrong code. Check the latest email and try again.' });
    }
    const claim = await prisma.adminLoginCode.updateMany({ where: { id: challenge.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claim.count !== 1) return res.status(400).json({ error: 'This code was already used.' });
    const admin = challenge.admin;
    if (!admin.active) return res.status(403).json({ error: 'This admin account has been deactivated.' });
    const token = signAdminToken(admin);
    const rememberToken = remember ? require('jsonwebtoken').sign({ sub: admin.id, kind: 'admin2fa' }, process.env.JWT_SECRET, { expiresIn: '30d' }) : undefined;
    res.json({ token, rememberToken, admin: { id: admin.id, name: admin.name, email: admin.email } });
  } catch (error) {
    console.error('POST /admin/login/verify failed:', error);
    res.status(500).json({ error: 'Could not verify the code.' });
  }
});

router.patch('/auth/password', requireCustomerAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }

    if (newPassword === currentPassword) {
      return res.status(400).json({ error: 'Choose a new password that is different from the current one.' });
    }

    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    if (!customer || !(await comparePassword(currentPassword, customer.passwordHash))) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    // Changing the password also clears any admin-issued temporary
    // password requirement.
    const passwordHash = await hashPassword(newPassword);
    await prisma.customer.update({
      where: { id: customer.id },
      data: { passwordHash, mustChangePassword: false, tempPasswordExpiresAt: null, securityChangedAt: new Date() },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('PATCH /auth/password failed:', error);
    res.status(500).json({ error: 'Could not change password.' });
  }
});

// --- Forgot password (email link) ---
// Always answers with the same generic message whether or not the
// account exists or has an email, so this can't be used to discover
// which phone numbers/usernames are registered.
router.post('/auth/forgot-password', async (req, res) => {
  const generic = { ok: true, message: 'If that account has an email address, a reset link is on its way. Check your inbox and spam folder.' };
  try {
    const identifier = String(req.body.identifier || '').trim();
    if (!identifier) return res.status(400).json({ error: 'Enter your phone number, username or email.' });

    const customer = await prisma.customer.findFirst({
      where: {
        OR: [
          { phone: identifier },
          { username: identifier.toLowerCase() },
          { email: { equals: identifier, mode: 'insensitive' } },
        ],
      },
    });
    if (!customer || !customer.active || !customer.email) return res.json(generic);

    const recent = await prisma.passwordResetToken.count({
      where: { customerId: customer.id, createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) } },
    });
    if (recent >= MAX_RESET_EMAILS_PER_HOUR) return res.json(generic);

    const rawToken = crypto.randomBytes(32).toString('hex');
    await prisma.passwordResetToken.create({
      data: {
        customerId: customer.id,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + RESET_TOKEN_MINUTES * 60 * 1000),
      },
    });

    const link = `${APP_URL}/reset-password?token=${rawToken}`;
    const firstName = customer.name.split(' ')[0];
    await sendEmail({
      to: customer.email,
      subject: 'Reset your ZappiPay password',
      text: `Hello ${firstName},\n\nWe received a request to reset your ZappiPay password. Open this link to choose a new one (it expires in ${RESET_TOKEN_MINUTES} minutes):\n\n${link}\n\nIf you didn't ask for this, you can ignore this email — your password won't change.\n\nNeed help? Email support@zappipay.com.ng\n\nZappiPay`,
      html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1a1a2e">
  <h2 style="color:#863bff;margin-bottom:4px">ZAPPI PAY</h2>
  <p>Hello ${firstName},</p>
  <p>We received a request to reset your ZappiPay password. Tap the button below to choose a new one. This link expires in ${RESET_TOKEN_MINUTES} minutes.</p>
  <p style="text-align:center;margin:28px 0"><a href="${link}" style="background:#863bff;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Reset password</a></p>
  <p style="font-size:13px;color:#555">Or copy this link into your browser:<br><span style="word-break:break-all">${link}</span></p>
  <p style="font-size:13px;color:#555">If you didn't ask for this, you can ignore this email — your password won't change. ZappiPay staff will never ask for your password.</p>
  <p style="font-size:13px;color:#555">Need help? Email <a href="mailto:support@zappipay.com.ng" style="color:#863bff">support@zappipay.com.ng</a></p>
</div>`,
    });

    res.json(generic);
  } catch (error) {
    console.error('POST /auth/forgot-password failed:', error);
    res.json(generic);
  }
});

router.post('/auth/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'token and newPassword are required.' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });

    const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(String(token)) } });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.$transaction([
      prisma.customer.update({
        where: { id: record.customerId },
        data: { passwordHash, mustChangePassword: false, tempPasswordExpiresAt: null, securityChangedAt: new Date() },
      }),
      // Burn this link and any other outstanding ones for the account.
      prisma.passwordResetToken.updateMany({
        where: { customerId: record.customerId, usedAt: null },
        data: { usedAt: new Date() },
      }),
    ]);

    notify(record.customerId, 'Password Changed', 'Your password was reset using the link sent to your email. If this wasn\'t you, contact support immediately.');
    res.json({ ok: true });
  } catch (error) {
    console.error('POST /auth/reset-password failed:', error);
    res.status(500).json({ error: 'Could not reset password.' });
  }
});

module.exports = router;
