// Reads a data plan's size and validity from the name VTpass sends
// ("MTN N1000 1.5GB - 30 days"). A small port of the frontend's
// PlanGrid size() / validityDays() so the backend can find the closest
// replacement when VTpass removes a plan code. Read-only helpers.

// Size in GB (MB and TB converted), or null when the name doesn't say.
function sizeGb(name) {
  const n = String(name || '');
  const toGb = (value, unit) => {
    const v = Number(value);
    const u = String(unit).toUpperCase();
    return u === 'TB' ? v * 1024 : u === 'MB' ? v / 1024 : v;
  };
  // "6.5GB + 3.5GB": both parts count.
  const both = /(\d+(?:\.\d+)?)\s*(TB|GB|MB)\s*\+\s*(\d+(?:\.\d+)?)\s*(TB|GB|MB)\b/i.exec(n);
  if (both) return round(toGb(both[1], both[2]) + toGb(both[3], both[4]));
  // VTpass typo "3GB 5GB - 2,475 Naira": two sizes side by side, the second is the plan.
  const two = /(\d+(?:\.\d+)?)\s*(TB|GB|MB)\s+(\d+(?:\.\d+)?)\s*(TB|GB|MB)\b/i.exec(n);
  if (two) return round(toGb(two[3], two[4]));
  const m = /(\d+(?:\.\d+)?)\s*(TB|GB|MB)\b/i.exec(n);
  if (m) return round(toGb(m[1], m[2]));
  const g = /(\d+(?:\.\d+)?)\s*G(?=\s*[-–(]|\s*$)/.exec(n); // "T2 6.2G - 3,000 Naira"
  return g ? round(Number(g[1])) : null;
}
const round = (x) => Math.round(x * 1000) / 1000;

// Validity in days (0 for plans that last only hours), or null.
function validityDays(name) {
  const n = String(name || '').toLowerCase().replace(/\+\s*\d+(?:\.\d+)?\s*(?:gb|mb)\s+(?:daily|per\s+day)/g, ' ');
  const found = [];
  const add = (re, mul) => { for (const m of n.matchAll(re)) found.push(Math.round(Number(m[1]) * mul)); };
  add(/(\d+)\s*-?\s*(?:hrs?|hours?)\b/g, 1 / 24);
  add(/(\d+)\s*-?\s*(?:days?|dys?)\b/g, 1);
  add(/(\d+)\s*-?\s*(?:weeks?|wks?)\b/g, 7);
  add(/(\d+)\s*-?\s*(?:months?|mnths?)\b/g, 30);
  add(/(\d+)\s*-?\s*(?:years?|yrs?)\b/g, 365);
  if (/\bdaily\b/.test(n)) found.push(1);
  if (/\bweekly\b/.test(n)) found.push(7);
  if (/\bmonthly\b/.test(n)) found.push(30);
  if (/\byearly\b|\bannual\b/.test(n)) found.push(365);
  return found.length ? Math.max(...found) : null;
}

const parsePlan = (name) => ({ gb: sizeGb(name), days: validityDays(name) });

// The closest plan to `old` ({ name, priceKobo }) among `candidates`
// ([{ variationCode, name, priceKobo }]): same size and validity first,
// nearest price; then same validity, nearest size; else nearest price.
function closestPlan(old, candidates) {
  const list = (candidates || []).filter((c) => c && c.variationCode);
  if (!list.length) return null;
  const o = parsePlan(old.name);
  const oPrice = Number(old.priceKobo) || 0;
  const byPrice = (a, b) => Math.abs((a.priceKobo || 0) - oPrice) - Math.abs((b.priceKobo || 0) - oPrice);
  const withParts = list.map((c) => ({ ...c, ...parsePlan(c.name) }));
  const pick = (c, match) => ({ variationCode: c.variationCode, name: c.name, priceKobo: c.priceKobo, match });
  if (o.gb != null && o.days != null) {
    const same = withParts.filter((c) => c.gb === o.gb && c.days === o.days).sort(byPrice);
    if (same.length) return pick(same[0], 'same size and validity');
  }
  if (o.days != null && o.gb != null) {
    const sameDays = withParts.filter((c) => c.days === o.days && c.gb != null).sort((a, b) => Math.abs(a.gb - o.gb) - Math.abs(b.gb - o.gb) || byPrice(a, b));
    if (sameDays.length) return pick(sameDays[0], 'same validity, nearest size');
  }
  return pick([...withParts].sort(byPrice)[0], 'nearest price only (check it)');
}

module.exports = { sizeGb, validityDays, parsePlan, closestPlan };
