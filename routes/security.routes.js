const express = require('express');
const prisma = require('../lib/prisma');
const { comparePassword, signCustomerToken, issueCustomerToken, requireCustomerAuth } = require('../lib/auth');
const { notify } = require('../lib/notify');
const sec = require('../lib/security');

// Transaction PIN, quick login (PIN on a trusted device) and
// fingerprint / Face ID (WebAuthn passkeys).
const router = express.Router();

function quickLoginCustomer(customer) {
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
  };
}

async function currentDevice(req) {
  const device = await sec.findDevice(sec.deviceTokenFrom(req));
  return device && device.customerId === req.customer.customerId ? device : null;
}

router.get('/security/status', requireCustomerAuth, async (req, res) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    const device = await currentDevice(req);
    const biometric = device ? await prisma.webAuthnCredential.count({ where: { deviceId: device.id } }) : 0;
    const deviceCount = await prisma.trustedDevice.count({ where: { customerId: customer.id } });
    res.json({
      hasPin: Boolean(customer.pinHash),
      pinLocked: Boolean(customer.pinLockedUntil && customer.pinLockedUntil > new Date()),
      quickLoginOnThisDevice: Boolean(device),
      biometricOnThisDevice: biometric > 0,
      trustedDeviceCount: deviceCount,
    });
  } catch (error) {
    console.error('GET /security/status failed:', error);
    res.status(500).json({ error: 'Could not load security settings.' });
  }
});

// Create or change the PIN. Always needs the account password, so a
// borrowed unlocked phone can't be used to reset someone's PIN.
router.post('/security/pin', requireCustomerAuth, async (req, res) => {
  try {
    const { password, pin } = req.body;
    if (!sec.isValidPinFormat(pin)) return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
    const seq = '0123456789012';
    if (/^(\d)\1{3}$/.test(pin) || seq.includes(pin) || seq.split('').reverse().join('').includes(pin) || /^(\d\d)\1$/.test(pin)) {
      return res.status(400).json({ error: 'That PIN is too easy to guess. Please choose another.' });
    }
    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    if (!password || !(await comparePassword(password, customer.passwordHash))) {
      return res.status(401).json({ error: 'Your password is incorrect.' });
    }
    if (customer.dateOfBirth) {
      const d = new Date(customer.dateOfBirth).toISOString();
      if ([d.slice(0, 4), d.slice(5, 7) + d.slice(8, 10), d.slice(8, 10) + d.slice(5, 7)].includes(pin)) {
        return res.status(400).json({ error: "Don't use your birth year or birthday as your PIN. Please choose another." });
      }
    }
    if (customer.phone && String(customer.phone).replace(/\D/g, '').endsWith(pin)) {
      return res.status(400).json({ error: "Don't use the last 4 digits of your phone number as your PIN." });
    }
    const hadPin = Boolean(customer.pinHash);
    await prisma.customer.update({
      where: { id: customer.id },
      data: { pinHash: await sec.hashPin(pin), pinFailedAttempts: 0, pinLockedUntil: null, ...(hadPin ? { securityChangedAt: new Date() } : {}) },
    });
    notify(customer.id, hadPin ? 'PIN Changed' : 'PIN Created', hadPin
      ? 'Your ZappiPay PIN was changed. If this wasn\'t you, contact support right away.'
      : 'Your ZappiPay PIN is set. You\'ll use it to confirm payments.');
    res.json({ ok: true });
  } catch (error) {
    console.error('POST /security/pin failed:', error);
    res.status(500).json({ error: 'Could not save PIN.' });
  }
});

// Turn on quick login for this browser/phone. Returns the raw device
// token once; the browser keeps it, we only store its hash.
router.post('/security/devices', requireCustomerAuth, async (req, res) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    const check = await sec.checkPin(customer, String(req.body.pin || ''));
    if (!check.ok) return res.status(check.status).json({ error: check.error, code: check.code });

    const existing = await currentDevice(req);
    if (existing) await prisma.trustedDevice.delete({ where: { id: existing.id } });

    const deviceToken = sec.newDeviceToken();
    const label = String(req.body.label || '').slice(0, 80) || null;
    await prisma.trustedDevice.create({ data: { customerId: customer.id, tokenHash: sec.hashToken(deviceToken), label } });
    res.status(201).json({ deviceToken });
  } catch (error) {
    console.error('POST /security/devices failed:', error);
    res.status(500).json({ error: 'Could not turn on quick login.' });
  }
});

router.delete('/security/devices/current', requireCustomerAuth, async (req, res) => {
  try {
    const device = await currentDevice(req);
    if (device) await prisma.trustedDevice.delete({ where: { id: device.id } });
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE /security/devices/current failed:', error);
    res.status(500).json({ error: 'Could not turn off quick login.' });
  }
});

// Sign out every other trusted device (e.g. after losing a phone).
router.delete('/security/devices', requireCustomerAuth, async (req, res) => {
  try {
    const device = await currentDevice(req);
    await prisma.trustedDevice.deleteMany({
      where: { customerId: req.customer.customerId, ...(device ? { NOT: { id: device.id } } : {}) },
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE /security/devices failed:', error);
    res.status(500).json({ error: 'Could not remove devices.' });
  }
});

// --- Fingerprint / Face ID setup ---

router.post('/security/webauthn/register-options', requireCustomerAuth, async (req, res) => {
  try {
    const device = await currentDevice(req);
    if (!device) return res.status(400).json({ error: 'Turn on quick login for this device first.' });
    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    res.json({ options: await sec.registrationOptions(req, customer, device, { compat: Boolean(req.body?.compat) }) });
  } catch (error) {
    console.error('POST /security/webauthn/register-options failed:', error);
    res.status(500).json({ error: 'Could not start fingerprint / Face ID setup.' });
  }
});

router.post('/security/webauthn/register-verify', requireCustomerAuth, async (req, res) => {
  try {
    const device = await currentDevice(req);
    if (!device) return res.status(400).json({ error: 'Turn on quick login for this device first.' });
    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    const result = await sec.verifyRegistration(req, customer, device, req.body.response);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
  } catch (error) {
    console.error('POST /security/webauthn/register-verify failed:', error);
    res.status(500).json({ error: 'Could not finish fingerprint / Face ID setup.' });
  }
});

router.delete('/security/webauthn', requireCustomerAuth, async (req, res) => {
  try {
    const device = await currentDevice(req);
    if (device) await prisma.webAuthnCredential.deleteMany({ where: { deviceId: device.id } });
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE /security/webauthn failed:', error);
    res.status(500).json({ error: 'Could not turn off fingerprint / Face ID.' });
  }
});

// Challenge for confirming a payment with fingerprint / Face ID.
router.post('/security/webauthn/tx-options', requireCustomerAuth, async (req, res) => {
  try {
    const device = await currentDevice(req);
    const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
    const options = device ? await sec.authenticationOptions(req, customer, device) : null;
    if (!options) return res.status(400).json({ error: 'Fingerprint / Face ID is not set up on this device.' });
    res.json({ options });
  } catch (error) {
    console.error('POST /security/webauthn/tx-options failed:', error);
    res.status(500).json({ error: 'Could not start fingerprint / Face ID.' });
  }
});

// --- Quick login (no password) from a trusted device ---

async function loginDevice(req, res) {
  const device = await sec.findDevice(req.body.deviceToken);
  if (!device) {
    res.status(401).json({ error: 'Quick login is no longer set up on this device. Please log in with your password.', code: 'DEVICE_UNKNOWN' });
    return null;
  }
  const customer = device.customer;
  if (!customer.active) {
    res.status(403).json({ error: 'This account has been deactivated.' });
    return null;
  }
  if (customer.mustChangePassword) {
    res.status(403).json({ error: 'Please log in with your password.', code: 'PASSWORD_REQUIRED' });
    return null;
  }
  return { device, customer };
}

async function finishLogin(req, res, device, customer, method) {
  await prisma.trustedDevice.update({ where: { id: device.id }, data: { lastUsedAt: new Date() } });
  res.json({ token: await issueCustomerToken(customer, req, method, device.id), customer: quickLoginCustomer(customer) });
}

router.post('/auth/quick/pin', async (req, res) => {
  try {
    const found = await loginDevice(req, res);
    if (!found) return;
    const check = await sec.checkPin(found.customer, String(req.body.pin || ''));
    if (!check.ok) return res.status(check.status).json({ error: check.error, code: check.code });
    await finishLogin(req, res, found.device, found.customer, 'PIN');
  } catch (error) {
    console.error('POST /auth/quick/pin failed:', error);
    res.status(500).json({ error: 'Could not log in.' });
  }
});

router.post('/auth/quick/biometric-options', async (req, res) => {
  try {
    const found = await loginDevice(req, res);
    if (!found) return;
    const options = await sec.authenticationOptions(req, found.customer, found.device);
    if (!options) return res.status(400).json({ error: 'Fingerprint / Face ID is not set up on this device.', code: 'NO_BIOMETRIC' });
    res.json({ options });
  } catch (error) {
    console.error('POST /auth/quick/biometric-options failed:', error);
    res.status(500).json({ error: 'Could not start fingerprint / Face ID.' });
  }
});

router.post('/auth/quick/biometric', async (req, res) => {
  try {
    const found = await loginDevice(req, res);
    if (!found) return;
    const result = await sec.verifyAuthentication(req, found.customer, found.device, req.body.response);
    if (!result.ok) return res.status(401).json({ error: result.error });
    await finishLogin(req, res, found.device, found.customer, 'FINGERPRINT');
  } catch (error) {
    console.error('POST /auth/quick/biometric failed:', error);
    res.status(500).json({ error: 'Could not log in.' });
  }
});

// --- Where you're logged in ---

router.get('/security/sessions', requireCustomerAuth, async (req, res) => {
  try {
    res.json({ sessions: await require('../lib/sessions').list(req.customer.customerId, req.customer.sessionId), hasCurrent: Boolean(req.customer.sessionId) });
  } catch (error) {
    console.error('GET /security/sessions failed:', error);
    res.status(500).json({ error: 'Could not load your devices.' });
  }
});

router.delete('/security/sessions/:id', requireCustomerAuth, async (req, res) => {
  try {
    if (req.params.id === req.customer.sessionId) return res.status(400).json({ error: 'Use Log out to leave this device.' });
    const n = await require('../lib/sessions').revoke(req.customer.customerId, req.params.id);
    if (!n) return res.status(404).json({ error: 'That login was not found.' });
    res.json({ ok: true });
  } catch (error) {
    console.error('DELETE /security/sessions/:id failed:', error);
    res.status(500).json({ error: 'Could not log that device out.' });
  }
});

router.post('/security/sessions/logout-others', requireCustomerAuth, async (req, res) => {
  try {
    await require('../lib/sessions').revokeOthers(req.customer.customerId, req.customer.sessionId);
    notify(req.customer.customerId, 'Logged Out Other Devices', 'You logged out of ZAPPI PAY on all your other phones and browsers.');
    res.json({ ok: true, keptCurrent: Boolean(req.customer.sessionId) });
  } catch (error) {
    console.error('POST /security/sessions/logout-others failed:', error);
    res.status(500).json({ error: 'Could not log out other devices.' });
  }
});

// Log out of this device (ends the session on the server too).
router.post('/security/sessions/logout', requireCustomerAuth, async (req, res) => {
  try {
    if (req.customer.sessionId) await require('../lib/sessions').revoke(req.customer.customerId, req.customer.sessionId);
    res.json({ ok: true });
  } catch (error) {
    res.json({ ok: true });
  }
});

module.exports = router;
