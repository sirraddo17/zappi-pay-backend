// Exact money maths in integer kobo (₦1 = 100 kobo). The database keeps
// naira as exact decimals (numeric 14,2); the bugs come from JavaScript
// floats (4948.73 * 100 = 494872.99999…). So: convert to kobo once,
// add/subtract whole numbers, convert back only to save or show.

// Any naira value (Prisma Decimal, string, number) → integer kobo.
// Rounds half away from zero at the 3rd decimal (only reached by bad input).
function toKobo(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'bigint') return Number(v) * 100;
  const s = String(typeof v === 'object' && typeof v.toFixed === 'function' ? v.toFixed(4) : v).trim();
  const m = /^([+-])?(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(s);
  if (!m) {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`Not a money value: ${s}`);
    return Math.round(n * 100);
  }
  if (m[4]) return Math.round(Number(s) * 100); // 1e-7 style: tiny, round normally
  const neg = m[1] === '-';
  const whole = Number(m[2] || 0);
  const frac = (m[3] || '').padEnd(3, '0');
  let k = whole * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) k += 1;
  return neg ? -k : k;
}

// Integer kobo → exact naira string for the database ("4948.73").
function toNaira(k) {
  if (!Number.isInteger(k)) throw new Error(`Kobo must be a whole number, got ${k}`);
  const neg = k < 0;
  const a = Math.abs(k);
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

// Integer kobo → JS number of naira, for display and JSON only.
const nairaNum = (k) => Number(toNaira(k));

// ₦ text for messages: "₦4,948.73" (drops ".00").
function fmt(k) {
  const n = nairaNum(k);
  return `₦${n.toLocaleString('en-NG', { minimumFractionDigits: k % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

// floor(k × num / den) on whole numbers, safe for money sizes.
const mulDivFloor = (k, num, den) => Math.floor((k * num) / den);

// A percentage of kobo, rounded down (never gives away a fraction of a kobo).
const pctOf = (k, pct) => Math.floor((k * Math.round(Number(pct) * 100)) / 10000);

module.exports = { toKobo, toNaira, nairaNum, fmt, mulDivFloor, pctOf };
