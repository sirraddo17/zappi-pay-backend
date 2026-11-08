// Providers the owner hides from the Buy page (e.g. a service VTpass hasn't
// enabled on our account: JAMB, Spectranet). Unlike auto-pause this lasts
// until the owner shows it again on Admin → Partners. Hidden providers are
// left out of the Buy page lists and refused at purchase.
const prisma = require('./prisma');
const { getSettings, invalidateSettings } = require('./vtpass');

// Ones that can be hidden (name shown to the owner).
const CHOICES = {
  jamb: 'JAMB PINs', spectranet: 'Spectranet', 'waec-registration': 'WAEC registration', waec: 'WAEC result checker',
  'smile-direct': 'Smile', showmax: 'Showmax', startimes: 'Startimes', gotv: 'GOtv', dstv: 'DStv',
  'glo-sme-data': 'Glo SME data', 'etisalat-data': '9mobile data', 'swift-4g': 'Swift 4G', ipnx: 'ipNX',
};
const DEFAULT = ['jamb', 'spectranet'];

function list(settings) {
  const v = settings?.hiddenProviders;
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : DEFAULT;
}
const isHidden = (settings, serviceID) => list(settings).includes(String(serviceID || ''));

async function status() {
  const hidden = list(await getSettings());
  return { hidden, choices: Object.entries(CHOICES).map(([id, name]) => ({ id, name, hidden: hidden.includes(id) })) };
}

async function setHidden(serviceID, hide) {
  if (!CHOICES[serviceID]) throw Object.assign(new Error('Unknown service.'), { status: 400 });
  const s = await getSettings();
  const now = new Set(list(s));
  if (hide) now.add(serviceID); else now.delete(serviceID);
  await prisma.settings.update({ where: { id: s.id }, data: { hiddenProviders: [...now] } });
  invalidateSettings();
  return status();
}

module.exports = { list, isHidden, status, setHidden, CHOICES, DEFAULT };
