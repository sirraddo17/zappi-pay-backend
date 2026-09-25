import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getMyLimits, updatePreferences, requestAccountDeletion, cancelAccountDeletion } from '../api';
import PasswordField from './PasswordField';
import PushToggle from './PushToggle';

function money(n) {
  return `₦${Number(n || 0).toLocaleString()}`;
}

// Profile extras: verification level & limits, email alerts, WhatsApp
// support and the "delete my account" request.
export default function AccountExtras() {
  const { customer, refreshCustomer } = useAuth();
  const [limits, setLimits] = useState(null);
  const [emailAlerts, setEmailAlerts] = useState(customer?.emailAlerts !== false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getMyLimits().then(setLimits).catch(() => {});
  }, []);

  useEffect(() => {
    setEmailAlerts(customer?.emailAlerts !== false);
  }, [customer?.emailAlerts]);

  async function toggleAlerts() {
    const next = !emailAlerts;
    setEmailAlerts(next);
    try {
      await updatePreferences({ emailAlerts: next });
      refreshCustomer?.();
    } catch {
      setEmailAlerts(!next);
    }
  }

  async function submitDelete(e) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await requestAccountDeletion({ password, reason });
      setMsg("Request received. Our team will close your account within 7 days. Spend or withdraw any money left in your wallet first.");
      setDeleteOpen(false);
      setPassword('');
      refreshCustomer?.();
    } catch (error) {
      setErr(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function undoDelete() {
    setBusy(true);
    try {
      await cancelAccountDeletion();
      setMsg('Your deletion request was cancelled.');
      refreshCustomer?.();
    } finally {
      setBusy(false);
    }
  }

  const verified = customer?.verified || limits?.verified;
  const row = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--slate-700)' };

  return (
    <div className="card" style={{ margin: '0 0 16px', paddingTop: 4, paddingBottom: 4 }}>
      <div style={row}>
        <span>
          <span style={{ display: 'block', fontWeight: 600 }}>
            Account level{' '}
            <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 999, marginLeft: 4, background: verified ? 'rgba(34,197,94,0.15)' : 'rgba(148,163,184,0.15)', color: verified ? 'var(--green-500)' : 'var(--slate-400)' }}>
              {verified ? '✓ Verified' : 'Not verified'}
            </span>
          </span>
          <span style={{ display: 'block', color: 'var(--slate-400)', fontSize: 13 }}>
            {limits?.enabled
              ? `Daily limit ${money(limits.limit)} · ${money(limits.remaining)} left today`
              : verified ? 'Verified with BVN/NIN' : 'Verify with BVN or NIN to get your own account number'}
          </span>
        </span>
        {!verified && <Link to="/wallet" style={{ color: 'var(--purple)', fontSize: 13, whiteSpace: 'nowrap' }}>Verify ›</Link>}
      </div>

      <div style={row}>
        <span>
          <span style={{ display: 'block', fontWeight: 600 }}>Email alerts</span>
          <span style={{ display: 'block', color: 'var(--slate-400)', fontSize: 13 }}>
            {customer?.email ? `Money in/out and new logins, to ${customer.email}` : 'Add an email above to get alerts'}
          </span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={emailAlerts}
          aria-label="Email alerts"
          onClick={toggleAlerts}
          disabled={!customer?.email}
          style={{ width: 50, height: 28, borderRadius: 999, border: 'none', background: emailAlerts ? 'var(--purple)' : 'var(--slate-700)', position: 'relative', cursor: 'pointer', flexShrink: 0, opacity: customer?.email ? 1 : 0.5 }}
        >
          <span style={{ position: 'absolute', top: 3, left: emailAlerts ? 25 : 3, width: 22, height: 22, borderRadius: '50%', background: '#fff', transition: 'left 0.15s' }} />
        </button>
      </div>

      <PushToggle />

      <div style={{ padding: '12px 0' }}>
        {msg && <p style={{ color: 'var(--green-500)', fontSize: 13, margin: '0 0 8px' }}>{msg}</p>}
        {customer?.deletionRequestedAt ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <span style={{ color: 'var(--orange, #f97316)', fontSize: 13 }}>Account deletion requested. We'll process it soon.</span>
            <button type="button" className="btn btn-secondary" style={{ width: 'auto', padding: '6px 12px', fontSize: 13 }} disabled={busy} onClick={undoDelete}>
              Cancel request
            </button>
          </div>
        ) : !deleteOpen ? (
          <button type="button" onClick={() => setDeleteOpen(true)} style={{ background: 'none', border: 'none', color: 'var(--red-500)', cursor: 'pointer', padding: 0, fontSize: 14 }}>
            Delete my account
          </button>
        ) : (
          <form onSubmit={submitDelete}>
            <p style={{ fontSize: 13, color: 'var(--slate-400)', marginTop: 0 }}>
              This closes your account and removes your personal details. Transaction records are kept for record-keeping rules. Spend or withdraw your wallet balance first.
            </p>
            {err && <p className="error-text" style={{ margin: '0 0 8px' }}>{err}</p>}
            <div className="field">
              <label htmlFor="delReason">Why are you leaving? (optional)</label>
              <input id="delReason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
            </div>
            <div className="field">
              <label htmlFor="delPassword">Your password</label>
              <PasswordField id="delPassword" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" className="btn" style={{ background: 'var(--red-500)' }} disabled={busy || !password}>Request deletion</button>
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteOpen(false)}>Keep my account</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
