// Conditions a data plan carries, read from its name (same rules as the
// app's PlanGrid): weekend-only, night-only, social-only, router.
// Used so "best deal" lists and the AI never offer a restricted plan as an
// everyday one, and so the customer is always told before paying.

const RULES = [
  ['Weekend', /week\s*-?\s*end|\bsat(urday)?\b|\bsun(day)?\b/],
  ['Night', /night|midnight|\b(12|1|2)\s*(am|a\.m)\s*(-|–|to)/],
  ['Social', /social|whatsapp|youtube|tiktok|instagram|facebook|\bfb\b|twitter|\bx\s*only\b|glo\s*tv|\bvod\b|myg\b|\byt\b/],
  ['Broadband', /router|broadband|\bmifi\b|unlimited/],
  ['Calls', /smilevoice|voice\s*only/],
];

// Only the main allowance sets conditions: "N800 1GB + 1GB YouTube Night +
// 100MB YouTube Music - Weekly" is everyday data with night extras. Each
// "+ …" bonus runs until the next " - ", "(" or ","; what follows
// ("- 5G Router Data (30 Days)") is about the whole plan again.
// Same rules as splitPlan in the app's PlanGrid.
function splitPlan(name) {
  const segs = String(name || '').toLowerCase().split('+');
  let main = segs[0];
  let bonus = '';
  for (const seg of segs.slice(1)) {
    const cut = seg.search(/\s[-–]|\(|,/);
    if (cut < 0) bonus += ` ${seg}`;
    else { bonus += ` ${seg.slice(0, cut)}`; main += ` ${seg.slice(cut)}`; }
  }
  return { main, bonus };
}
function conditions(name) {
  const n = splitPlan(name).main;
  return RULES.filter(([, re]) => re.test(n)).map(([k]) => k);
}

const TEXT = { Weekend: 'works only on weekends (Sat/Sun)', Night: 'works only at night', Social: 'only for the apps named', Broadband: 'for routers/MiFi', Calls: 'call minutes only, no data' };
// "⚠️ Weekend only — works only on weekends (Sat/Sun)" or ''.
function warning(name) {
  const c = conditions(name).filter((k) => k !== 'Broadband');
  const h = hours(name);
  const hrs = h && h < 24 ? `⚠️ Lasts only ${h} hour${h === 1 ? '' : 's'}` : '';
  const main = c.length ? `⚠️ ${c.map((k) => `${k} only`).join(', ')} — ${c.map((k) => TEXT[k]).join('; ')}` : '';
  return [main, hrs].filter(Boolean).join(' · ');
}

// Plans that last only hours ("2GB 3hrs"); null when the name doesn't say.
function hours(name) {
  const n = String(name || '').toLowerCase();
  const m = n.match(/(\d+)\s*-?\s*(?:hrs?|hours?)\b/);
  if (!m || /\d+\s*-?\s*(?:days?|weeks?|months?)\b|\b(daily|weekly|monthly)\b/.test(n)) return null;
  return Number(m[1]);
}

module.exports = { conditions, warning, splitPlan, hours };
