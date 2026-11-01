// BVN / NIN format checks before anything is sent to a partner. A real
// check of the name and date of birth is done by lib/idCheck.js (Monnify)
// — always once Monnify is live. The number itself is never stored (only
// a keyed hash) and never written to logs (scrub() masks it).

const SEQUENCES = ['01234567890', '12345678901', '23456789012', '10987654321', '09876543210', '98765432109'];

// → { number } or { error }
function check(idType, raw) {
  const type = String(idType || '').toUpperCase();
  const s = String(raw ?? '').trim();
  if (!['BVN', 'NIN'].includes(type)) return { error: 'Choose BVN or NIN.' };
  if (/[^\d\s-]/.test(s)) return { error: `Your ${type} should only contain numbers.` };
  const n = s.replace(/\D/g, '');
  if (n.length !== 11) return { error: `Your ${type} must be exactly 11 digits.` };
  if (/^(\d)\1{10}$/.test(n) || SEQUENCES.includes(n) || /^0{5}/.test(n)) return { error: `That doesn’t look like a real ${type}. Please check it and try again.` };
  return { number: n, type };
}

// Masks any 11-digit run (BVN/NIN/phone) in text before it is logged.
const scrub = (v) => String(typeof v === 'string' ? v : JSON.stringify(v ?? '')).replace(/\d{11}/g, (m) => `${'•'.repeat(7)}${m.slice(-4)}`).slice(0, 2000);

// For free text a customer types (support tickets, the AI assistant):
// when the text mentions a BVN or NIN, any 11-digit number in it that
// isn't a phone number (phones start with 0) is masked before it is saved
// or sent on. Meter numbers etc. in other messages are left alone.
const maskIdsInText = (v) => {
  const s = String(v ?? '');
  if (!/\b(bvn|nin|n\.i\.n|b\.v\.n)\b/i.test(s)) return s;
  return s.replace(/(^|[^\d])([1-9]\d{10})(?!\d)/g, (m, pre, n) => `${pre}${'•'.repeat(7)}${n.slice(-4)}`);
};

// The real name + date-of-birth check is required once Monnify is live
// (the owner's switch can only add it earlier, not skip it when live).
async function mustVerify(settings) {
  if (settings.idMatchEnabled) return true;
  const mode = await require('./monnify').getConfig().then((c) => c.mode).catch(() => 'sandbox');
  return mode === 'live';
}

module.exports = { check, scrub, maskIdsInText, mustVerify };
