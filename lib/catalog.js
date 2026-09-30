const { vtpassRequest, getSettings } = require('./vtpass');

// VTpass's catalog (networks, data plans, TV bouquets) rarely changes,
// but fetching it live takes 1-2 seconds every time a customer opens a
// Buy page. Keep good answers in memory for an hour, per sandbox/live
// mode. Prices are still checked by VTpass when the purchase is made.
const CATALOG_TTL_MS = 60 * 60 * 1000;
const catalogCache = new Map();

async function cachedCatalog(path, query) {
  const { vtpassMode } = await getSettings();
  const key = `${vtpassMode}|${path}|${JSON.stringify(query || {})}`;
  const hit = catalogCache.get(key);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.data;
  const data = await vtpassRequest('GET', path, { query });
  const content = data?.content;
  const ok = Array.isArray(content) ? content.length > 0 : Boolean(content && (content.varations || content.variations || Object.keys(content).length));
  if (ok) {
    if (catalogCache.size > 200) catalogCache.clear();
    catalogCache.set(key, { at: Date.now(), data });
  }
  return data;
}

module.exports = { cachedCatalog };
