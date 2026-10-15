// Conditions a data plan carries, read from its name (same rules as the
// app's PlanGrid): weekend-only, night-only, social-only, router.
// Used so "best deal" lists and the AI never offer a restricted plan as an
// everyday one, and so the customer is always told before paying.

const RULES = [
  ['Weekend', /week\s*-?\s*end|\bsat(urday)?\b|\bsun(day)?\b/],
  ['Night', /night|midnight|\b(12|1|2)\s*(am|a\.m)\s*(-|–|to)/],
  ['Social', /social|whatsapp|youtube|tiktok|instagram|facebook|\bfb\b|twitter/],
  ['Broadband', /router|broadband|\bmifi\b|unlimited/],
];

function conditions(name) {
  const n = String(name || '').toLowerCase();
  return RULES.filter(([, re]) => re.test(n)).map(([k]) => k);
}

const TEXT = { Weekend: 'works only on weekends (Sat/Sun)', Night: 'works only at night', Social: 'only for the apps named', Broadband: 'for routers/MiFi' };
// "⚠️ Weekend only — works only on weekends (Sat/Sun)" or ''.
function warning(name) {
  const c = conditions(name).filter((k) => k !== 'Broadband');
  return c.length ? `⚠️ ${c.map((k) => `${k} only`).join(', ')} — ${c.map((k) => TEXT[k]).join('; ')}` : '';
}

module.exports = { conditions, warning };
