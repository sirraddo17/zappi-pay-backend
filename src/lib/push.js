import { getPushKey, subscribePush, unsubscribePush } from '../api';

// Phone/desktop notifications. iPhone needs iOS 16.4+ and the app
// added to the Home Screen first.

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function isIosNotInstalled() {
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone;
  return ios && !standalone;
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function registration() {
  const reg = await navigator.serviceWorker.ready;
  return reg;
}

export async function currentSubscription() {
  if (!pushSupported()) return null;
  try {
    return await (await registration()).pushManager.getSubscription();
  } catch {
    return null;
  }
}

export async function enablePush() {
  if (!pushSupported()) throw new Error("This browser can't show notifications.");
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked. Allow them for ZappiPay in your browser or phone settings.');
  const { publicKey } = await getPushKey();
  if (!publicKey) throw new Error('Notifications are not available right now.');
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  await subscribePush(sub.toJSON());
  return true;
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await unsubscribePush(sub.endpoint).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}
