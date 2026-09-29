const bcrypt = require('bcryptjs');

// Password rules for customer-chosen passwords (signup, change, reset).
// Returns an error message, or null when the password is strong enough.
const COMMON = ['password', 'qwerty', '12345678', '123456789', 'zappipay', 'iloveyou', 'abc12345', 'password1'];
function passwordProblem(pw, { name, phone, username } = {}) {
  const p = String(pw || '');
  if (p.length < 8) return 'Password must be at least 8 characters.';
  if (p.length > 100) return 'Password is too long.';
  if (!/[A-Z]/.test(p)) return 'Password must include a capital letter (A–Z).';
  if (!/[a-z]/.test(p)) return 'Password must include a small letter (a–z).';
  if (!/[0-9]/.test(p)) return 'Password must include a number (0–9).';
  if (!/[^A-Za-z0-9]/.test(p)) return 'Password must include a special character, e.g. @ # $ ! %.';
  const low = p.toLowerCase();
  if (COMMON.some((c) => low.includes(c))) return 'That password is too easy to guess. Please choose another.';
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length >= 7 && p.includes(digits.slice(-7))) return 'Do not use your phone number in your password.';
  if (username && username.length >= 4 && low.includes(String(username).toLowerCase())) return 'Do not use your username in your password.';
  const first = String(name || '').trim().split(/\s+/)[0]?.toLowerCase();
  if (first && first.length >= 4 && low.includes(first)) return 'Do not use your name in your password.';
  return null;
}

const SECURITY_QUESTIONS = [
  "What is your mother's maiden name?",
  'What was the name of your first school?',
  'In which town or city were you born?',
  'What was the name of your first pet?',
  'What is the name of your best childhood friend?',
  'What was your first phone brand?',
  'What is your favourite food?',
];

function normalizeAnswer(a) {
  return String(a || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Accepts YYYY-MM-DD. Returns a Date (UTC midnight) or an error string.
function parseDob(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return { error: 'Enter your date of birth.' };
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[3])) return { error: 'That date of birth is not valid.' };
  const age = (Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
  if (age < 10 || age > 110) return { error: 'Please enter your real date of birth.' };
  return { date: d };
}

function sameDay(a, b) {
  return a && b && new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);
}

// Validates { dateOfBirth, securityQuestion, securityAnswer } and returns
// the fields to save, or { error }.
async function securityDetailsData(body, { requireDob = true } = {}) {
  const out = {};
  if (body.dateOfBirth !== undefined || requireDob) {
    const dob = parseDob(body.dateOfBirth);
    if (dob.error) return { error: dob.error };
    out.dateOfBirth = dob.date;
  }
  const q = String(body.securityQuestion || '').trim();
  if (!SECURITY_QUESTIONS.includes(q)) return { error: 'Choose a security question.' };
  const ans = normalizeAnswer(body.securityAnswer);
  if (ans.length < 2) return { error: 'Enter an answer to your security question.' };
  if (ans.length > 80) return { error: 'Security answer is too long.' };
  out.securityQuestion = q;
  out.securityAnswerHash = await bcrypt.hash(ans, 10);
  return { data: out };
}

async function answerMatches(customer, answer) {
  if (!customer.securityAnswerHash) return null;
  return bcrypt.compare(normalizeAnswer(answer), customer.securityAnswerHash);
}

module.exports = { passwordProblem, SECURITY_QUESTIONS, normalizeAnswer, parseDob, sameDay, securityDetailsData, answerMatches };
