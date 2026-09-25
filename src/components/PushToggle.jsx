import { useEffect, useState } from 'react';
import { pushSupported, isIosNotInstalled, currentSubscription, enablePush, disablePush } from '../lib/push';

// "Notifications on this phone" switch (Profile) and a one-time nudge
// on the home screen (variant="nudge").
export default function PushToggle({ variant = 'row' }) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem('zp_push_nudge') === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    currentSubscription().then((s) => setOn(Boolean(s) && Notification.permission === 'granted'));
  }, []);

  const supported = pushSupported();

  async function toggle() {
    setErr('');
    setBusy(true);
    try {
      if (on) {
        await disablePush();
        setOn(false);
      } else {
        await enablePush();
        setOn(true);
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (variant === 'nudge') {
    if (!supported || on || dismissed || Notification.permission === 'denied') return null;
    return (
      <div className="card" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <span style={{ fontSize: 22 }}>🔔</span>
        <div style={{ flex: 1, fontSize: 14 }}>
          <strong>Get instant alerts</strong>
          <div style={{ color: 'var(--slate-400)', fontSize: 12 }}>
            {isIosNotInstalled() ? 'Add ZappiPay to your Home Screen first, then turn on notifications.' : 'Wallet funded, purchases and offers — right on your phone.'}
          </div>
          {err && <div className="error-text" style={{ fontSize: 12, margin: '4px 0 0' }}>{err}</div>}
        </div>
        {!isIosNotInstalled() && (
          <button type="button" className="btn" style={{ width: 'auto', padding: '6px 12px', fontSize: 13 }} disabled={busy} onClick={toggle}>Turn on</button>
        )}
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => {
            setDismissed(true);
            try { localStorage.setItem('zp_push_nudge', '1'); } catch { /* ignore */ }
          }}
          style={{ background: 'none', border: 'none', color: 'var(--slate-400)', cursor: 'pointer', fontSize: 18 }}
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--slate-700)' }}>
      <span>
        <span style={{ display: 'block', fontWeight: 600 }}>Notifications on this device</span>
        <span style={{ display: 'block', color: err ? 'var(--red-500)' : 'var(--slate-400)', fontSize: 13 }}>
          {err || (!supported ? "This browser doesn't support notifications" : isIosNotInstalled() ? 'On iPhone, add ZappiPay to your Home Screen first' : 'Alerts for money in/out, purchases and offers')}
        </span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Notifications on this device"
        onClick={toggle}
        disabled={!supported || busy || isIosNotInstalled()}
        style={{ width: 50, height: 28, borderRadius: 999, border: 'none', background: on ? 'var(--purple)' : 'var(--slate-700)', position: 'relative', cursor: 'pointer', flexShrink: 0, opacity: supported ? 1 : 0.5 }}
      >
        <span style={{ position: 'absolute', top: 3, left: on ? 25 : 3, width: 22, height: 22, borderRadius: '50%', background: '#fff', transition: 'left 0.15s' }} />
      </button>
    </div>
  );
}
