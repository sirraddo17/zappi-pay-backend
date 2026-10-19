// The ZAPPI PAY Support Guide (lib/supportGuide.md): how support handles
// each customer problem, who may do what, and ready replies. Shown in
// Admin → 📘 Support guide (owner and support staff) and used by the
// admin AI assistant (tool get_support_guide) so it guides staff the same way.

const fs = require('fs');
const path = require('path');

let cache = null;
function load() {
  if (cache) return cache;
  const raw = fs.readFileSync(path.join(__dirname, 'supportGuide.md'), 'utf8').replace(/^<!--[\s\S]*?-->\s*/, '');
  const [head, ...rest] = raw.split(/\n(?=## )/);
  const sections = rest.map((s) => {
    const title = s.split('\n')[0].replace(/^##\s*/, '').trim();
    return { id: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), title, body: s.trim() };
  });
  cache = { markdown: raw.trim(), title: head.replace(/^#\s*/, '').trim(), sections };
  return cache;
}

const STOP = new Set('the a an and or of to for in on with my is it how do does what why can i me you your we our they their this that customer customers says said'.split(' '));
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9₦\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));

// The sections that best match a question (whole guide when nothing does).
function lookup(query) {
  const g = load();
  const q = words(query);
  if (!q.length) return { found: true, sections: g.sections.map((s) => s.body).join('\n\n') };
  const scored = g.sections.map((s) => {
    const hay = s.body.toLowerCase();
    let score = 0;
    for (const w of q) if (hay.includes(w)) score += w.length > 4 ? 2 : 1;
    if (q.some((w) => s.title.toLowerCase().includes(w))) score += 3;
    return { s, score };
  }).sort((a, b) => b.score - a.score);
  const hits = scored.filter((x) => x.score > 0).slice(0, 2).map((x) => x.s);
  // "Before you help anyone" holds the who-can-do-what table and money rules: always included.
  const first = g.sections[0];
  const pick = hits.length ? [first, ...hits.filter((s) => s !== first)] : g.sections;
  return { found: hits.length > 0, sections: pick.map((s) => s.body).join('\n\n') };
}

const index = () => load().sections.map((s, i) => `${i + 1}. ${s.title}`).join('\n');

module.exports = { load, lookup, index, _reset: () => { cache = null; } };
