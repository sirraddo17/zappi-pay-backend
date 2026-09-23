const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const prisma = require('./prisma');

// --- Transaction / quick-login PIN ---------------------------------

const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;

function isValidPinFormat(pin) {
  return typeof pin === 'string' && /^\d{4}$/.test(pin);
}

function hashPin(pin) {
  return bcrypt.hash(pin, 10);
}

// Checks a PIN against the customer's stored hash, counting failures.
// Returns { ok: true } or { ok: false, status, error, code }.
async function checkPin(customer, pin) {
  if (!customer.pinHash) {
    return { ok: false, status: 403, code: 'PIN_NOT_SET', error: 'Create your transaction PIN first.' };
  }
  if (customer.pinLockedUntil && customer.pinLockedUntil > new Date()) {
    const mins = Math.ceil((customer.pinLockedUntil - Date.now()) / 60000);
    return { ok: false, status: 423, code: 'PIN_LOCKED', error: `Too many wrong PIN attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}, or log in with your password.` };
  }
  if (!isValidPinFormat(pin) || !(await bcrypt.compare(pin, customer.pinHash))) {
    const attempts = customer.pinFailedAttempts + 1;
    const lock = attempts >= PIN_MAX_ATTEMPTS;
    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        pinFailedAttempts: lock ? 0 : attempts,
        pinLockedUntil: lock ? new Date(Date.now() + PIN_LOCK_MINUTES * 60000) : undefined,
      },
    });
    if (lock) {
      return { ok: false, status: 423, code: 'PIN_LOCKED', error: `Too many wrong PIN attempts. Your PIN is locked for ${PIN_LOCK_MINUTES} minutes.` };
    }
    const left = PIN_MAX_ATTEMPTS - attempts;
    return { ok: false, status: 401, code: 'PIN_WRONG', error: `Wrong PIN. ${left} attempt${left === 1 ? '' : 's'} left.` };
  }
  if (customer.pinFailedAttempts || customer.pinLockedUntil) {
    await prisma.customer.update({ where: { id: customer.id }, data: { pinFailedAttempts: 0, pinLockedUntil: null } });
  }
  return { ok: true };
}

// --- Trusted devices -----------------------------------------------

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function newDeviceToken() {
  return crypto.randomBytes(32).toString('base64url');
}

async function findDevice(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  return prisma.trustedDevice.findUnique({ where: { tokenHash: hashToken(rawToken) }, include: { customer: true } });
}

function deviceTokenFrom(req) {
  return req.headers['x-device-token'] || req.body?.deviceToken || null;
}

// --- WebAuthn (fingerprint / Face ID) ------------------------------

const APP_URL = (process.env.APP_URL || 'https://zappipay.com.ng').replace(/\/$/, '');
const RP_NAME = 'ZAPPI PAY';

function allowedOrigins() {
  if (process.env.WEBAUTHN_ORIGINS) {
    return process.env.WEBAUTHN_ORIGINS.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
  }
  const host = new URL(APP_URL).hostname.replace(/^www\./, '');
  return [`https://${host}`, `https://www.${host}`, 'http://localhost:5173'];
}

// The passkey is bound to the bare domain so it works on both
// zappipay.com.ng and www.zappipay.com.ng. Local dev uses localhost.
function rpContext(req) {
  const origins = allowedOrigins();
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  const useOrigin = origins.includes(origin) ? origin : origins[0];
  const host = new URL(useOrigin).hostname;
  const rpID = process.env.WEBAUTHN_RP_ID && host !== 'localhost' ? process.env.WEBAUTHN_RP_ID : host.replace(/^www\./, '');
  return { rpID, origins };
}

const CHALLENGE_MINUTES = 5;

async function saveChallenge(customerId, challenge) {
  await prisma.customer.update({
    where: { id: customerId },
    data: { webauthnChallenge: challenge, webauthnChallengeExpires: new Date(Date.now() + CHALLENGE_MINUTES * 60000) },
  });
}

async function takeChallenge(customer) {
  const { webauthnChallenge, webauthnChallengeExpires } = customer;
  // One-time use: cleared whether or not verification succeeds.
  await prisma.customer.update({ where: { id: customer.id }, data: { webauthnChallenge: null, webauthnChallengeExpires: null } });
  if (!webauthnChallenge || !webauthnChallengeExpires || webauthnChallengeExpires < new Date()) return null;
  return webauthnChallenge;
}

async function registrationOptions(req, customer, device) {
  const { rpID } = rpContext(req);
  const existing = await prisma.webAuthnCredential.findMany({ where: { customerId: customer.id } });
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: customer.username || customer.phone,
    userDisplayName: customer.name,
    userID: new TextEncoder().encode(customer.id),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports })),
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      userVerification: 'required',
      residentKey: 'preferred',
    },
  });
  await saveChallenge(customer.id, options.challenge);
  return options;
}

async function verifyRegistration(req, customer, device, response) {
  const challenge = await takeChallenge(customer);
  if (!challenge) return { ok: false, error: 'This request expired. Please try again.' };
  const { rpID, origins } = rpContext(req);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch (error) {
    console.error('WebAuthn registration verify failed:', error.message);
    return { ok: false, error: 'Could not verify your fingerprint / Face ID.' };
  }
  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, error: 'Could not verify your fingerprint / Face ID.' };
  }
  const { credential } = verification.registrationInfo;
  // Only one biometric per device — replace any older one.
  await prisma.webAuthnCredential.deleteMany({ where: { deviceId: device.id } });
  await prisma.webAuthnCredential.create({
    data: {
      customerId: customer.id,
      deviceId: device.id,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      transports: response?.response?.transports || credential.transports || [],
    },
  });
  return { ok: true };
}

async function authenticationOptions(req, customer, device) {
  const { rpID } = rpContext(req);
  const creds = await prisma.webAuthnCredential.findMany({ where: { customerId: customer.id, deviceId: device.id } });
  if (creds.length === 0) return null;
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: c.transports })),
  });
  await saveChallenge(customer.id, options.challenge);
  return options;
}

async function verifyAuthentication(req, customer, device, response) {
  const challenge = await takeChallenge(customer);
  if (!challenge) return { ok: false, error: 'This request expired. Please try again.' };
  const cred = response?.id
    ? await prisma.webAuthnCredential.findFirst({ where: { credentialId: response.id, customerId: customer.id, deviceId: device.id } })
    : null;
  if (!cred) return { ok: false, error: 'Fingerprint / Face ID is not set up on this device.' };
  const { rpID, origins } = rpContext(req);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: cred.credentialId,
        publicKey: new Uint8Array(cred.publicKey),
        counter: cred.counter,
        transports: cred.transports,
      },
    });
  } catch (error) {
    console.error('WebAuthn auth verify failed:', error.message);
    return { ok: false, error: 'Could not verify your fingerprint / Face ID.' };
  }
  if (!verification.verified) return { ok: false, error: 'Could not verify your fingerprint / Face ID.' };
  await prisma.webAuthnCredential.update({
    where: { id: cred.id },
    data: { counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() },
  });
  return { ok: true };
}

// --- Confirming a payment ------------------------------------------

// Used by purchase and transfer routes. The request body carries either
// `pin` (4 digits) or `webauthn` (a signed biometric assertion from
// this customer's trusted device, sent with the X-Device-Token header).
async function confirmTransaction(req) {
  const customer = await prisma.customer.findUnique({ where: { id: req.customer.customerId } });
  if (!customer) return { ok: false, status: 404, error: 'Account not found.' };
  const { pin, webauthn } = req.body || {};
  if (webauthn) {
    const device = await findDevice(deviceTokenFrom(req));
    if (!device || device.customerId !== customer.id) {
      return { ok: false, status: 401, code: 'BIOMETRIC_FAILED', error: 'Fingerprint / Face ID is not set up on this device. Use your PIN.' };
    }
    const result = await verifyAuthentication(req, customer, device, webauthn);
    if (!result.ok) return { ok: false, status: 401, code: 'BIOMETRIC_FAILED', error: result.error };
    return { ok: true };
  }
  if (!customer.pinHash) {
    return { ok: false, status: 403, code: 'PIN_NOT_SET', error: 'Create your transaction PIN first.' };
  }
  if (pin === undefined || pin === null || pin === '') {
    return { ok: false, status: 401, code: 'PIN_REQUIRED', error: 'Enter your PIN to confirm.' };
  }
  return checkPin(customer, String(pin));
}

module.exports = {
  isValidPinFormat,
  hashPin,
  checkPin,
  hashToken,
  newDeviceToken,
  findDevice,
  deviceTokenFrom,
  registrationOptions,
  verifyRegistration,
  authenticationOptions,
  verifyAuthentication,
  confirmTransaction,
};
