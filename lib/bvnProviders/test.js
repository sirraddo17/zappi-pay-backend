// TEST identity provider — for owner testing only ("Testers only" mode with
// no real provider). Any valid-looking BVN starts a session; the code is
// always 123456; it returns fixed sample details. Never used for real
// customers.
const crypto = require('crypto');

const sessions = new Map(); // ref → { at }
const SAMPLE = { firstName: 'Adaeze', middleName: 'Test', lastName: 'Okafor', dateOfBirth: '1990-05-14', phone: '08000000023' };

async function startConsent() {
  const ref = `test_${crypto.randomBytes(8).toString('hex')}`;
  sessions.set(ref, { at: Date.now() });
  if (sessions.size > 500) sessions.clear();
  return { ref, phoneHint: '23' };
}

async function confirm(ref, otp) {
  const { BvnProviderError } = require('./index');
  if (!sessions.has(ref)) throw new BvnProviderError('Session expired. Start again.', 'EXPIRED');
  if (String(otp || '').trim() !== '123456') throw new BvnProviderError('Wrong code.', 'WRONG_OTP');
  sessions.delete(ref);
  return { ...SAMPLE };
}

module.exports = { key: 'test', name: 'TEST provider (code 123456, sample names)', startConsent, confirm, SAMPLE };
