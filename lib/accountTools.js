const prisma = require('./prisma');
const { notify } = require('./notify');

// Account fixes support can't do alone — used by the owner's Account
// tools and by approved escalations.

async function resetPin(customerId) {
  // Quick login on a device uses the PIN, so those are cleared too.
  await prisma.$transaction([
    prisma.customer.update({ where: { id: customerId }, data: { pinHash: null, pinFailedAttempts: 0, pinLockedUntil: null, securityChangedAt: new Date() } }),
    prisma.trustedDevice.deleteMany({ where: { customerId } }),
  ]);
  notify(customerId, 'PIN Reset', 'Your transaction PIN was reset by support. Open Security to create a new PIN before your next payment.');
  return 'PIN cleared — customer creates a new one in Security';
}

async function unlockPin(customerId) {
  await prisma.customer.update({ where: { id: customerId }, data: { pinFailedAttempts: 0, pinLockedUntil: null } });
  notify(customerId, 'PIN Unlocked', 'Your PIN has been unlocked. You can use it again.');
  return 'PIN unlocked';
}

async function removeDevices(customerId) {
  const [creds, devices] = await prisma.$transaction([
    prisma.webAuthnCredential.deleteMany({ where: { customerId } }),
    prisma.trustedDevice.deleteMany({ where: { customerId } }),
  ]);
  await prisma.customer.update({ where: { id: customerId }, data: { securityChangedAt: new Date() } });
  notify(customerId, 'Devices Removed', 'Quick login and fingerprint were turned off on all your devices. Log in with your password and turn them on again on your own phone.');
  return `Removed ${devices.count} quick-login device(s) and ${creds.count} fingerprint login(s)`;
}

function cleanPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (!d) return null;
  if (!/^0\d{10}$/.test(d) && !/^234\d{10}$/.test(d)) throw new Error('Enter a valid Nigerian phone number, e.g. 08031234567.');
  return d.startsWith('234') ? `0${d.slice(3)}` : d;
}
function cleanEmail(e) {
  const v = String(e || '').trim().toLowerCase();
  if (!v) return null;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw new Error('Enter a valid email address.');
  return v;
}

// Validates a phone/email change without saving (for escalations).
async function checkContact(customerId, { phone, email }) {
  const data = {};
  if (phone) data.phone = cleanPhone(phone);
  if (email) data.email = cleanEmail(email);
  if (!data.phone && !data.email) throw new Error('Enter the new phone number or email.');
  const clash = await prisma.customer.findFirst({ where: { id: { not: customerId }, OR: [data.phone ? { phone: data.phone } : null, data.email ? { email: data.email } : null].filter(Boolean) } });
  if (clash) throw new Error('Another account already uses that phone number or email.');
  return data;
}

async function changeContact(customerId, input) {
  const data = await checkContact(customerId, input);
  const before = await prisma.customer.findUnique({ where: { id: customerId }, select: { phone: true, email: true } });
  await prisma.customer.update({ where: { id: customerId }, data: { ...data, securityChangedAt: new Date() } });
  notify(customerId, 'Contact Details Changed', `Support updated your ${[data.phone && 'phone number', data.email && 'email'].filter(Boolean).join(' and ')}. If you didn't ask for this, contact us immediately.`);
  return { summary: `Updated ${[data.phone && `phone ${before.phone} → ${data.phone}`, data.email && `email ${before.email || '—'} → ${data.email}`].filter(Boolean).join(', ')}`, data };
}

module.exports = { resetPin, unlockPin, removeDevices, changeContact, checkContact };
