// "Verify with BVN" identity providers. Each provider implements:
//   startConsent(bvn, cfg)      → { ref, phoneHint? }  — sends an OTP to the
//                                 phone linked to the BVN (consent step)
//   confirm(ref, otp, cfg)      → { firstName, lastName, middleName?,
//                                   dateOfBirth: 'YYYY-MM-DD', phone? }
// and throws BvnProviderError(code: WRONG_OTP | EXPIRED | NOT_FOUND | DOWN).
// The BVN is passed through only; providers must not store or log it.
//
// Only the TEST provider exists today. To add a real one (Dojah, Prembly,
// Smile ID, Youverify or VerifyMe): create lib/bvnProviders/<key>.js with
// the two functions above using cfg.apiKey / cfg.appId, add it to PROVIDERS
// with implemented: true, and choose it in Admin → Settings → Security →
// BVN auto-fill. Customers only get the feature when the switch is ON and a
// real provider with keys is chosen ("Testers only" can use TEST).

class BvnProviderError extends Error {
  constructor(message, code = 'DOWN') { super(message); this.code = code; }
}

const PROVIDERS = {
  test: { name: 'TEST provider (owner testing only)', implemented: true, load: () => require('./test') },
  // ↓ Placeholders — not implemented yet. Add the file, then set implemented: true.
  dojah: { name: 'Dojah', implemented: false },
  prembly: { name: 'Prembly (IdentityPass)', implemented: false },
  smileid: { name: 'Smile ID', implemented: false },
  youverify: { name: 'Youverify', implemented: false },
  verifyme: { name: 'VerifyMe', implemented: false },
};

const testerIds = (s) => (Array.isArray(s.featureTesters) ? s.featureTesters.map((t) => t.id) : []);

// The provider this customer may use right now, or null (= old flow).
function activeFor(settings, customerId) {
  const mode = String(settings.bvnAutofillMode || 'OFF').toUpperCase();
  if (mode === 'OFF') return null;
  const tester = Boolean(customerId) && testerIds(settings).includes(customerId);
  const key = PROVIDERS[settings.bvnProvider] ? settings.bvnProvider : 'test';
  const p = PROVIDERS[key];
  if (!p.implemented) return null;
  if (key === 'test') return mode === 'TESTERS' && tester ? { key, ...p.load(), cfg: {} } : null;
  if (!settings.bvnProviderKey) return null;
  if (mode === 'ON' || (mode === 'TESTERS' && tester)) return { key, ...p.load(), cfg: { apiKey: settings.bvnProviderKey, appId: settings.bvnProviderAppId || '' } };
  return null;
}

module.exports = { PROVIDERS, activeFor, BvnProviderError };
