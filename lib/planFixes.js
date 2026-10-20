// Owner corrections for data/internet plans (model PlanFix). VTpass names
// sometimes don't match what the network actually gives — e.g. a plan
// named "1GB 1 Day" that lasts 2 hours. A fix can set the real validity
// in hours, add a note customers see, or hide the plan so it can't be bought.

const prisma = require('./prisma');

let cache = null;
let cachedAt = 0;
async function all() {
  if (cache && Date.now() - cachedAt < 60 * 1000) return cache;
  const rows = await prisma.planFix.findMany().catch(() => []);
  cache = new Map(rows.map((r) => [`${r.serviceID}:${r.variationCode}`, r]));
  cachedAt = Date.now();
  return cache;
}
function invalidate() { cache = null; }

async function get(serviceID, variationCode) {
  return (await all()).get(`${serviceID}:${variationCode}`) || null;
}

// Variations as customers see them: hidden plans removed, fixes attached
// as zpHours / zpNote (the PlanGrid reads these).
async function apply(serviceID, variations) {
  const map = await all();
  if (!map.size || !Array.isArray(variations)) return variations;
  return variations
    .filter((v) => !map.get(`${serviceID}:${v.variation_code}`)?.hidden)
    .map((v) => {
      const f = map.get(`${serviceID}:${v.variation_code}`);
      if (!f) return v;
      return { ...v, ...(f.validityHours ? { zpHours: f.validityHours } : {}), ...(f.note ? { zpNote: f.note } : {}), zpFixed: true };
    });
}

// Same on a whole VTpass /service-variations reply.
async function applyToCatalog(serviceID, data) {
  if (!data?.content) return data;
  const key = Array.isArray(data.content.varations) ? 'varations' : 'variations';
  if (!Array.isArray(data.content[key])) return data;
  return { ...data, content: { ...data.content, [key]: await apply(serviceID, data.content[key]) } };
}

module.exports = { all, get, apply, applyToCatalog, invalidate };
