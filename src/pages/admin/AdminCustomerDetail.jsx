import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import AdminLayout from '../../components/AdminLayout';
import { getCustomerDetail, adjustWallet, adminResetCustomerPassword } from '../../api';

function fmtMoney(n) {
  return `₦${Number(n).toLocaleString()}`;
}

function fmtDate(d) {
  return new Date(d).toLocaleString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const STATUS_COLORS = {
  SUCCESS: 'var(--green-500)',
  APPROVED: 'var(--green-500)',
  PENDING: 'var(--slate-400)',
  FAILED: 'var(--red-500)',
  REJECTED: 'var(--red-500)',
  REFUNDED: 'var(--orange)',
};

export default function AdminCustomerDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const [adjustType, setAdjustType] = useState('CREDIT');
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustNote, setAdjustNote] = useState('');
  const [adjustSubmitting, setAdjustSubmitting] = useState(false);
  const [adjustError, setAdjustError] = useState('');

  const [resetConfirming, setResetConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetResult, setResetResult] = useState(null);
  const [resetError, setResetError] = useState('');
  const [copied, setCopied] = useState(false);

  function load() {
    getCustomerDetail(id)
      .then(setData)
      .catch((err) => setError(err.message));
  }

  useEffect(load, [id]);

  async function handleAdjustSubmit(e) {
    e.preventDefault();
    setAdjustError('');
    setAdjustSubmitting(true);
    try {
      await adjustWallet(id, { type: adjustType, amount: Number(adjustAmount), note: adjustNote.trim() || undefined });
      setAdjustAmount('');
      setAdjustNote('');
      load();
    } catch (err) {
      setAdjustError(err.message || 'Could not adjust wallet.');
    } finally {
      setAdjustSubmitting(false);
    }
  }

  async function handleResetPassword() {
    setResetting(true);
    setResetError('');
    try {
      const result = await adminResetCustomerPassword(id);
      setResetResult(result);
      setResetConfirming(false);
      load();
    } catch (err) {
      setResetError(err.message || 'Could not reset password.');
    } finally {
      setResetting(false);
    }
  }

  async function copyTemp() {
    try {
      await navigator.clipboard.writeText(resetResult.temporaryPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setResetError('Could not copy — select the password and copy it manually.');
    }
  }

  if (error) {
    return (
      <AdminLayout>
        <p className="error-text" style={{ margin: 0 }}>{error}</p>
      </AdminLayout>
    );
  }

  if (!data) {
    return (
      <AdminLayout>
        <p className="empty-state">Loading…</p>
      </AdminLayout>
    );
  }

  const { customer, orders, walletTransactions } = data;

  return (
    <AdminLayout>
      <Link to="/admin/customers" style={{ color: 'var(--orange)', fontSize: 13 }}>← Back to Customers</Link>

      <div className="page-header" style={{ padding: 0, margin: '12px 0 16px' }}>
        <h1>{customer.name}</h1>
        <p>{customer.phone}{customer.email ? ` · ${customer.email}` : ''} · {customer.active ? 'Active' : 'Deactivated'} · Joined {fmtDate(customer.createdAt)}</p>
        <p style={{ marginTop: 4 }}>
          {customer.username ? `@${customer.username} · ` : ''}PIN {customer.hasPin ? 'set' : 'not set'}
          {' · '}Referred {customer.referralCount || 0} customer{customer.referralCount === 1 ? '' : 's'}
          {customer.referredBy && (
            <>
              {' · '}Invited by{' '}
              <Link to={`/admin/customers/${customer.referredBy.id}`} style={{ color: 'var(--purple)' }}>
                {customer.referredBy.name}
              </Link>
              {customer.referralBonusPaidAt ? ` (bonus ₦${Number(customer.referralBonusAmount || 0).toLocaleString()} paid)` : ' (bonus not paid yet)'}
            </>
          )}
        </p>
        <p style={{ marginTop: 4 }}>
          {Array.isArray(customer.bankAccounts) && customer.bankAccounts.length > 0
            ? `Funding account${customer.bankAccounts.length > 1 ? 's' : ''}: ${customer.bankAccounts.map((a) => `${a.bankName} ${a.accountNumber}`).join(', ')} · verified with ${customer.kycType || 'ID'}`
            : 'No funding account number yet'}
        </p>
      </div>

      <div className="card stat-card" style={{ margin: '0 0 16px', maxWidth: 260 }}>
        <div className="label">Wallet Balance</div>
        <div className="value">{fmtMoney(customer.walletBalance)}</div>
      </div>

      <div className="card" style={{ margin: '0 0 16px', maxWidth: 400 }}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Reset Password</h2>
        <p style={{ color: 'var(--slate-400)', fontSize: 13, margin: '0 0 12px' }}>
          For customers who forgot their password. This creates a temporary password (valid 24 hours) and the customer must choose a new
          one as soon as they log in. Confirm it's really the account owner first — e.g. they're messaging from the registered number{' '}
          {customer.phone}.
        </p>
        {customer.mustChangePassword && !resetResult && (
          <p style={{ color: 'var(--orange)', fontSize: 13, margin: '0 0 12px' }}>
            A temporary password is active
            {customer.tempPasswordExpiresAt ? ` until ${fmtDate(customer.tempPasswordExpiresAt)}` : ''} — the customer hasn't set a new
            password yet.
          </p>
        )}
        {resetError && <p className="error-text" style={{ margin: '0 0 12px' }}>{resetError}</p>}

        {resetResult ? (
          <div>
            <p style={{ fontSize: 13, margin: '0 0 6px' }}>Give this temporary password to the customer. It won't be shown again:</p>
            <div
              style={{
                fontFamily: 'monospace',
                fontSize: 20,
                fontWeight: 700,
                letterSpacing: 1,
                background: 'var(--slate-900)',
                borderRadius: 8,
                padding: '10px 12px',
                marginBottom: 8,
                userSelect: 'all',
              }}
            >
              {resetResult.temporaryPassword}
            </div>
            <p style={{ color: 'var(--slate-400)', fontSize: 12, margin: '0 0 10px' }}>Expires {fmtDate(resetResult.expiresAt)}.</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn" type="button" style={{ width: 'auto', padding: '8px 14px', fontSize: 13 }} onClick={copyTemp}>
                {copied ? 'Copied' : 'Copy'}
              </button>
              <a
                className="btn-secondary btn"
                style={{ width: 'auto', padding: '8px 14px', fontSize: 13, textDecoration: 'none' }}
                target="_blank"
                rel="noopener noreferrer"
                href={`https://wa.me/${'234' + String(customer.phone).replace(/^0/, '')}?text=${encodeURIComponent(
                  `Hello ${customer.name.split(' ')[0]}, your ZappiPay temporary password is: ${resetResult.temporaryPassword}\n\nLog in with your phone number or username and this password — you'll be asked to create a new password straight away. It expires in 24 hours. Never share your password with anyone.`
                )}`}
              >
                Send via WhatsApp
              </a>
              <button className="btn-secondary btn" type="button" style={{ width: 'auto', padding: '8px 14px', fontSize: 13 }} onClick={() => setResetResult(null)}>
                Done
              </button>
            </div>
          </div>
        ) : !resetConfirming ? (
          <button className="btn-secondary btn" type="button" onClick={() => setResetConfirming(true)}>
            Reset Password
          </button>
        ) : (
          <div>
            <p style={{ fontSize: 14, margin: '0 0 10px' }}>
              Reset {customer.name}'s password? Their current password will stop working immediately.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" type="button" disabled={resetting} onClick={handleResetPassword}>
                {resetting ? 'Resetting…' : 'Yes, reset'}
              </button>
              <button className="btn-secondary btn" type="button" disabled={resetting} onClick={() => setResetConfirming(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <form className="card" style={{ margin: '0 0 16px', maxWidth: 400 }} onSubmit={handleAdjustSubmit}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Adjust Wallet</h2>
        {adjustError && <p className="error-text" style={{ margin: '0 0 12px' }}>{adjustError}</p>}
        <div className="field">
          <label htmlFor="adjustType">Type</label>
          <select id="adjustType" value={adjustType} onChange={(e) => setAdjustType(e.target.value)}>
            <option value="CREDIT">Credit (add funds)</option>
            <option value="DEBIT">Debit (remove funds)</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="adjustAmount">Amount (₦)</label>
          <input id="adjustAmount" type="number" min="1" value={adjustAmount} onChange={(e) => setAdjustAmount(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="adjustNote">Reason (optional)</label>
          <input id="adjustNote" type="text" value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)} />
        </div>
        <button className="btn" type="submit" disabled={adjustSubmitting}>
          {adjustSubmitting ? 'Saving…' : 'Apply Adjustment'}
        </button>
      </form>

      <div className="card admin-table-wrap" style={{ margin: '0 0 16px' }}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Orders</h2>
        {orders.length === 0 ? (
          <p className="empty-state">No orders yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th>Recipient</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>{o.service}</td>
                  <td>{o.recipient}</td>
                  <td>{fmtMoney(o.amount)}</td>
                  <td style={{ color: STATUS_COLORS[o.status] || 'var(--slate-400)' }}>{o.status}</td>
                  <td>{fmtDate(o.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card admin-table-wrap" style={{ margin: 0 }}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Wallet History</h2>
        {walletTransactions.length === 0 ? (
          <p className="empty-state">No transactions yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Note</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {walletTransactions.map((t) => (
                <tr key={t.id}>
                  <td>{t.type}</td>
                  <td>{fmtMoney(t.amount)}</td>
                  <td style={{ color: STATUS_COLORS[t.status] || 'var(--slate-400)' }}>{t.status}</td>
                  <td style={{ fontSize: 12, color: 'var(--slate-400)' }}>{t.note || '—'}</td>
                  <td>{fmtDate(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AdminLayout>
  );
}
