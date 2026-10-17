// Name + date of birth check against BVN/NIN (Monnify verification),
// before a customer gets their personal account number. Switched on by
// the owner in Settings → Security once Monnify live keys are active.
//  - BVN: Monnify "BVN details match" (≈ ₦10) says whether the name and
//    date of birth match.
//  - NIN: Monnify "NIN details" (≈ ₦60) returns the NIN record; we
//    compare the name and date of birth ourselves.
// No ID numbers are stored — only the result. After a pass, the name and
// date of birth are locked (Customer.kycVerifiedAt).

const prisma = require('./prisma');

const DAY = 24 * 60 * 60 * 1000;
const MAX_CHECKS_PER_DAY = 3; // each check costs money and stops ID fishing
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

class IdCheckError extends Error {
  constructor(msg, code, status = 400) { super(msg); this.code = code; this.status = status; }
}

const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const monnifyDate = (d) => { const x = new Date(d); return `${String(x.getUTCDate()).padStart(2, '0')}-${MON[x.getUTCMonth()]}-${x.getUTCFullYear()}`; };
const words = (s) => String(s || '').toUpperCase().replace(/[^A-Z\s-]/g, ' ').split(/[\s-]+/).filter((w) => w.length > 1);

// "1995-03-12", "12-03-1995", "12/03/1995", "12-Mar-1995", "1995-03-12T00:00:00" → "1995-03-12"
function normDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[-/ ](\d{1,2})[-/ ](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{4})$/.exec(s);
  if (m) { const i = MON.findIndex((x) => x.toLowerCase() === m[2].toLowerCase()); if (i >= 0) return `${m[3]}-${String(i + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  return null;
}

// Two of the customer's names (or all, if they gave one/two) must be on the ID.
function namesMatch(given, idNames) {
  const g = words(given);
  const id = new Set(words(idNames));
  if (!g.length || !id.size) return false;
  const hits = g.filter((w) => id.has(w)).length;
  return hits >= Math.min(2, g.length);
}

function pick(o, keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((a, p) => (a == null ? a : a[p]), o);
    if (v != null && v !== '') return v;
  }
  return null;
}

// Only tries that were the customer's own mistake count (a mismatch or an
// ID that doesn't exist). Our or the partner's trouble (ERROR) never
// uses up a try. Support can give fresh tries with a RESET row.
const COUNTED = ['MISMATCH', 'NOT_FOUND'];
async function recentChecks(customerId) {
  const since = new Date(Date.now() - DAY);
  const reset = await prisma.idCheck.findFirst({ where: { customerId, result: 'RESET', createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  return prisma.idCheck.count({ where: { customerId, result: { in: COUNTED }, createdAt: { gt: reset ? reset.createdAt : since } } });
}

async function triesLeft(customerId) {
  return Math.max(0, MAX_CHECKS_PER_DAY - (await recentChecks(customerId)));
}

// For the admin customer page: the last tries and why each one failed.
const WHY = {
  PASS: 'Matched',
  MISMATCH: 'Did not match',
  NOT_FOUND: 'ID number not found',
  ERROR: 'Could not check (not counted)',
  RESET: 'Support gave fresh tries',
};
async function history(customerId) {
  const rows = await prisma.idCheck.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, take: 10 });
  return rows.map((r) => ({ at: r.createdAt, idType: r.idType, result: r.result, label: WHY[r.result] || r.result, detail: r.result === 'MISMATCH' ? (r.detail === 'name dob' ? 'name and date of birth' : r.detail === 'name' ? 'name' : 'date of birth') : r.detail }));
}

async function resetTries(customerId, byName) {
  await prisma.idCheck.create({ data: { customerId, idType: '-', result: 'RESET', detail: byName ? `by ${String(byName).slice(0, 80)}` : null } });
}

let sandboxAlertAt = 0;

async function log(customerId, idType, result, detail) {
  await prisma.idCheck.create({ data: { customerId, idType, result, detail: detail ? String(detail).slice(0, 300) : null } }).catch(() => {});
}

// Throws IdCheckError on mismatch / limit / provider trouble; returns
// { ok: true } when the name and date of birth match.
async function verify(customer, { idType, idNumber, dateOfBirth }) {
  if (!dateOfBirth) throw new IdCheckError('Enter your date of birth exactly as on your ' + idType + '.', 'DOB_NEEDED');
  if ((await recentChecks(customer.id)) >= MAX_CHECKS_PER_DAY) {
    throw new IdCheckError(`You have tried ${MAX_CHECKS_PER_DAY} times today. Check your name and date of birth against your ${idType} and try again tomorrow, or contact support.`, 'ID_CHECK_LIMIT', 429);
  }
  const { api, MonnifyError, getConfig } = require('./monnify');
  // Monnify's test mode can't look up real IDs — every try would fail.
  if ((await getConfig()).mode !== 'live') {
    await log(customer.id, idType, 'ERROR', 'Monnify is in test mode, which cannot check real IDs');
    if (Date.now() - sandboxAlertAt > 3600e3) {
      sandboxAlertAt = Date.now();
      require('./adminAlert').alertAdmins('BVN/NIN check can’t run', 'Customers can’t get account numbers: the BVN/NIN check is on but Monnify is in test mode, which can’t check real IDs. Switch Monnify to live, or turn off Settings → Security → BVN/NIN check.', '/admin/settings').catch(() => {});
    }
    throw new IdCheckError(`We could not check your ${idType} right now. Please try again later — this did not use up a try.`, 'ID_CHECK_DOWN', 502);
  }
  let body;
  try {
    body = idType === 'BVN'
      ? await api('POST', '/api/v1/vas/bvn-details-match', { bvn: idNumber, name: customer.name, dateOfBirth: monnifyDate(dateOfBirth), mobileNo: String(customer.phone || '').replace(/\D/g, '').replace(/^234/, '0') })
      : await api('POST', '/api/v1/vas/nin-details', { nin: idNumber });
  } catch (e) {
    const msg = e instanceof MonnifyError ? e.message : 'network';
    const notFound = e instanceof MonnifyError && e.status && e.status < 500 && /invalid|not found|no record/i.test(msg);
    await log(customer.id, idType, notFound ? 'NOT_FOUND' : 'ERROR', msg);
    if (notFound) {
      throw new IdCheckError(`We could not find that ${idType}. Check the 11 digits and try again.`, 'ID_NOT_FOUND');
    }
    throw new IdCheckError(`We could not check your ${idType} right now. Please try again in a few minutes.`, 'ID_CHECK_DOWN', 502);
  }

  const wantDob = isoDay(dateOfBirth);
  let nameOk; let dobOk;
  if (idType === 'BVN') {
    const n = body?.name || {};
    nameOk = n.matchStatus === 'FULL_MATCH' || (n.matchStatus === 'PARTIAL_MATCH' && Number(n.matchPercentage) >= 60);
    dobOk = body?.dateOfBirth === 'FULL_MATCH';
  } else {
    const rec = body?.ninDetails || body?.data || body || {};
    if (rec.ninInformationMatch === false) { nameOk = false; dobOk = false; } else {
      const idName = [pick(rec, ['firstName', 'firstname', 'first_name']), pick(rec, ['middleName', 'middlename', 'middle_name']), pick(rec, ['lastName', 'surname', 'lastname', 'last_name']), pick(rec, ['fullName', 'name'])].filter(Boolean).join(' ');
      const idDob = normDate(pick(rec, ['dateOfBirth', 'birthDate', 'birthdate', 'dob', 'date_of_birth']));
      if (!idName || !idDob) {
        await log(customer.id, idType, 'ERROR', 'NIN record had no name/date of birth');
        throw new IdCheckError('We could not check your NIN right now. Please try your BVN instead, or try again later.', 'ID_CHECK_DOWN', 502);
      }
      nameOk = namesMatch(customer.name, idName);
      dobOk = idDob === wantDob;
    }
  }
  if (!nameOk || !dobOk) {
    await log(customer.id, idType, 'MISMATCH', `${nameOk ? '' : 'name '}${dobOk ? '' : 'dob'}`.trim());
    const what = !nameOk && !dobOk ? 'Your name and date of birth do' : !nameOk ? 'Your name does' : 'Your date of birth does';
    const fix = !nameOk ? ' Update your name in Profile to match your ' + idType + ' exactly (same spelling, at least first name and surname).' : ' Enter the date of birth on your ' + idType + '.';
    throw new IdCheckError(`${what} not match your ${idType}.${fix}`, 'ID_MISMATCH');
  }
  await log(customer.id, idType, 'PASS', null);
  return { ok: true };
}

module.exports = { verify, IdCheckError, history, triesLeft, resetTries, namesMatch, normDate, monnifyDate, MAX_CHECKS_PER_DAY };
