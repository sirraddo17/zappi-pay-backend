// Where to go after logging in / signing up (e.g. back to a "Pay me"
// link). Only our own short internal paths are allowed. The target page
// clears it (clearAfterLogin) once it has opened.
const KEY = 'zappipay_after_login';
const OK = /^\/((r|gift|shop|circle|spray|p|safebuy)\/[A-Za-z0-9_-]{2,40}|(dues|shared-light)\/join\/[A-Za-z0-9_-]{2,40})$/;
export function setAfterLogin(path) {
  try { if (OK.test(path)) sessionStorage.setItem(KEY, path); } catch { /* private mode */ }
}
export function takeAfterLogin(fallback = '/') {
  try {
    const p = sessionStorage.getItem(KEY);
    return p && OK.test(p) ? p : fallback;
  } catch {
    return fallback;
  }
}
export function clearAfterLogin() {
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
}
