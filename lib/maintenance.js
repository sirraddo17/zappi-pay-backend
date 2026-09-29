// Maintenance mode: the owner can pause all purchases, or only some
// services (e.g. electricity while a disco is down on VTpass), with a
// message customers see. Checked in performPurchase, so app purchases,
// bulk buys and scheduled top-ups all respect it.

const SERVICES = ['AIRTIME', 'DATA', 'ELECTRICITY', 'CABLE', 'EDUCATION', 'INTERNET', 'BETTING'];
const LABEL = { AIRTIME: 'Airtime', DATA: 'Data', ELECTRICITY: 'Electricity', CABLE: 'Cable TV', EDUCATION: 'Exam PINs', INTERNET: 'Internet', BETTING: 'Betting' };

function pausedList(settings) {
  const list = Array.isArray(settings.pausedServices) ? settings.pausedServices : [];
  return list.filter((s) => SERVICES.includes(s));
}

// null when the service can be bought, otherwise the message to show.
function pauseMessage(settings, service) {
  const custom = String(settings.maintenanceMessage || '').trim();
  if (settings.purchasesPaused) return custom || 'Purchases are paused for a short maintenance. Please try again soon — your wallet is safe.';
  if (service && pausedList(settings).includes(service)) return custom || `${LABEL[service] || service} is paused for a short while. Please try again soon — your wallet is safe.`;
  return null;
}

function publicInfo(settings) {
  const services = pausedList(settings);
  if (!settings.purchasesPaused && !services.length) return null;
  return {
    all: Boolean(settings.purchasesPaused),
    services,
    message: pauseMessage(settings, settings.purchasesPaused ? null : services[0]),
  };
}

module.exports = { pauseMessage, publicInfo, pausedList, SERVICES };
