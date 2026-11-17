// "Verify with BVN" + auto-fill for Wallet → Get your account number.
//  1. start(customer, bvn, consent) — checks, then the identity provider
//     sends a code to the phone linked to the BVN. Nothing about the person
//     is returned.
//  2. confirm(customer, sessionId, otp, bvn) — only after a correct code are
//     the name and date of birth returned and saved (locked):
//     kycVerifiedAt, kycType "BVN", kycHash, kycSource "BVN_AUTOFILL".
// The BVN itself is never stored or logged (only lib/idNumber's one-way
// code); the browser sends it again with the code and it must match.
// No money moves here: account numbers are then created by the normal route,
// which skips the old name + date-of-birth match because these details now
// come from the BVN itself.

const prisma = require('./prisma');
const { getSettings } = require('./vtpass');
const idn = require('./idNumber');
const { activeFor, BvnProviderError } = require('./bvnProviders');

const DAY = 24 * 60 * 60 * 1000;
const SESSION_MS = 10 * 60 * 1000;
const MAX_STARTS = 3;   // per customer per day
const MAX_OTP = 5;      // per customer per day
const MAX_IP = 10;      // consent starts per IP per day

class BvnError extends Error {
  constructor(message, status = 400, code) { super(message); this.status = status; this.code = code; }
}

const since = () => new Date(Date.now() - DAY);
const title = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/(^|[\s'-])\p{L}/gu, (m) => m.toUpperCase());

async function start(customer, { bvn, consent, ip } = {}) {
  const settings = await getSettings();
  const provider = activeFor(settings, customer.id);
  if (!provider) throw new BvnError('Verify with BVN isn’t available yet.', 503, 'OFF');
  if (!consent) throw new BvnError('Tick the box to agree to the BVN check first.', 400, 'CONSENT_NEEDED');
  if (customer.kycVerifiedAt) throw new BvnError('Your details are already verified.', 409, 'ALREADY_VERIFIED');
  const c = idn.check('BVN', bvn);
  if (c.error) throw new BvnError(c.error);

  const [starts, ipStarts] = await Promise.all([
    prisma.bvnSession.count({ where: { customerId: customer.id, createdAt: { gte: since() } } }),
    ip ? prisma.bvnSession.count({ where: { ip, createdAt: { gte: since() } } }) : 0,
  ]);
  if (starts >= MAX_STARTS) throw new BvnError('You have tried 3 times today. Please try again tomorrow, or contact support.', 429, 'LIMIT');
  if (ipStarts >= MAX_IP) throw new BvnError('Too many BVN checks from this network today. Please try again tomorrow.', 429, 'LIMIT');

  // One BVN = one account — checked BEFORE the (paid) provider call.
  const kycHash = idn.identityHash('BVN', c.number);
  const other = await prisma.customer.findFirst({ where: { kycHash, NOT: { id: customer.id } }, select: { id: true } });
  if (other) {
    await prisma.idCheck.create({ data: { customerId: customer.id, idType: 'BVN', result: 'DUPLICATE_ID', detail: 'already linked to another account (BVN auto-fill)' } }).catch(() => {});
    throw new BvnError('This BVN is already linked to another ZAPPI PAY account. Each person can have only one account — contact support if this is a mistake.', 409, 'IDENTITY_IN_USE');
  }

  const base = { customerId: customer.id, provider: provider.key, kycHash, ip: ip || null, expiresAt: new Date(Date.now() + SESSION_MS) };
  let r;
  try {
    r = await provider.startConsent(c.number, provider.cfg);
  } catch (error) {
    await prisma.bvnSession.create({ data: { ...base, status: 'FAILED_START', otpTries: 0 } }).catch(() => {});
    console.warn('BVN auto-fill start failed:', idn.scrub(error.message));
    if (error instanceof BvnProviderError && error.code === 'NOT_FOUND') throw new BvnError('We couldn’t find that BVN. Check the 11 digits and try again.', 400, 'NOT_FOUND');
    throw new BvnError('We couldn’t start the BVN check right now. Please try again in a few minutes.', 502, 'DOWN');
  }
  const hint = String(r.phoneHint || '').replace(/\D/g, '').slice(-2);
  const s = await prisma.bvnSession.create({ data: { ...base, status: 'STARTED', otpTries: 0, providerRef: String(r.ref), phoneHint: hint || null } });
  return { sessionId: s.id, phoneHint: hint ? `••••${hint}` : null, expiresInMinutes: SESSION_MS / 60000 };
}

async function confirm(customer, { sessionId, otp, bvn } = {}) {
  const s = await prisma.bvnSession.findUnique({ where: { id: String(sessionId || '') } });
  if (!s || s.customerId !== customer.id) throw new BvnError('Start the BVN check again.', 400, 'NO_SESSION');
  if (s.status !== 'STARTED' || new Date(s.expiresAt).getTime() < Date.now()) throw new BvnError('That code has expired. Start the BVN check again.', 400, 'EXPIRED');
  const tries = await prisma.bvnSession.aggregate({ where: { customerId: customer.id, createdAt: { gte: since() } }, _sum: { otpTries: true } });
  if ((tries._sum.otpTries || 0) >= MAX_OTP) throw new BvnError('Too many wrong codes today. Please try again tomorrow, or contact support.', 429, 'LIMIT');
  const c = idn.check('BVN', bvn);
  if (c.error || idn.identityHash('BVN', c.number) !== s.kycHash) throw new BvnError('Start the BVN check again.', 400, 'NO_SESSION');
  const code = String(otp || '').replace(/\D/g, '');
  if (code.length < 4 || code.length > 8) throw new BvnError('Enter the code sent to your phone.', 400, 'WRONG_OTP');

  await prisma.bvnSession.update({ where: { id: s.id }, data: { otpTries: { increment: 1 } } });
  const provider = activeFor(await getSettings(), customer.id);
  if (!provider || provider.key !== s.provider) throw new BvnError('Verify with BVN isn’t available right now.', 503, 'OFF');

  let d;
  try {
    d = await provider.confirm(s.providerRef, code, provider.cfg);
  } catch (error) {
    // Wrong or expired code: say nothing about the person.
    const left = Math.max(0, MAX_OTP - (tries._sum.otpTries || 0) - 1);
    if (error instanceof BvnProviderError && error.code === 'WRONG_OTP') throw new BvnError(`That code isn’t right.${left ? ` ${left} ${left === 1 ? 'try' : 'tries'} left today.` : ''}`, 400, 'WRONG_OTP');
    if (error instanceof BvnProviderError && error.code === 'EXPIRED') {
      await prisma.bvnSession.update({ where: { id: s.id }, data: { status: 'FAILED' } }).catch(() => {});
      throw new BvnError('That code has expired. Start the BVN check again.', 400, 'EXPIRED');
    }
    console.warn('BVN auto-fill confirm failed:', idn.scrub(error.message));
    throw new BvnError('We couldn’t check the code right now. Please try again in a few minutes.', 502, 'DOWN');
  }

  const first = title(d.firstName);
  const last = title(d.lastName);
  const middle = title(d.middleName);
  const dob = /^\d{4}-\d{2}-\d{2}$/.test(String(d.dateOfBirth || '')) ? new Date(`${d.dateOfBirth}T00:00:00.000Z`) : null;
  if (!first || !last || !dob || Number.isNaN(dob.getTime())) {
    console.warn('BVN auto-fill: provider returned incomplete details');
    throw new BvnError('We couldn’t read your BVN details. Please use the normal form, or contact support.', 502, 'DOWN');
  }
  const name = [first, middle, last].filter(Boolean).join(' ');
  try {
    await prisma.$transaction([
      prisma.customer.update({ where: { id: customer.id }, data: { name, dateOfBirth: dob, kycVerifiedAt: new Date(), kycType: 'BVN', kycHash: s.kycHash, kycSource: 'BVN_AUTOFILL' } }),
      prisma.bvnSession.update({ where: { id: s.id }, data: { status: 'CONFIRMED' } }),
    ]);
  } catch (error) {
    if (error.code === 'P2002') throw new BvnError('This BVN is already linked to another ZAPPI PAY account.', 409, 'IDENTITY_IN_USE');
    throw error;
  }
  await prisma.idCheck.create({ data: { customerId: customer.id, idType: 'BVN', result: 'AUTOFILL', detail: `via ${s.provider}` } }).catch(() => {});
  return { verified: true, firstName: first, middleName: middle || null, lastName: last, dateOfBirth: d.dateOfBirth };
}

// Admin: counts this month (each start is a paid lookup with a real provider).
async function monthCounts() {
  const now = new Date(Date.now() + 60 * 60 * 1000);
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 60 * 60 * 1000);
  const [lookups, confirmed, real] = await Promise.all([
    prisma.bvnSession.count({ where: { createdAt: { gte: from } } }),
    prisma.bvnSession.count({ where: { createdAt: { gte: from }, status: 'CONFIRMED' } }),
    prisma.bvnSession.count({ where: { createdAt: { gte: from }, provider: { not: 'test' } } }),
  ]);
  return { lookups, confirmed, paidLookups: real };
}

module.exports = { start, confirm, monthCounts, BvnError, MAX_STARTS, MAX_OTP, MAX_IP };
