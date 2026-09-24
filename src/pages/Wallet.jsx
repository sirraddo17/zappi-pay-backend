import { useEffect, useState } from 'react';
import { getWalletBalance, getWalletTransactions, submitFundRequest, getBankAccount, createBankAccount, checkBankPayments } from '../api';
import BottomNav from '../components/BottomNav';

function fmtMoney(n) {
  return `₦${Number(n).toLocaleString()}`;
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-secondary"
      style={{ width: 'auto', padding: '6px 12px', fontSize: 13 }}
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

// Personal account number(s): money sent here is added to the wallet
// automatically. First time, the customer verifies with BVN or NIN.
function BankFunding({ info, onCreated, onCredited }) {
  const [idType, setIdType] = useState('BVN');
  const [idNumber, setIdNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const feeText = info.feePercent > 0
    ? `A ${info.feePercent}% fee${info.feeCap > 0 ? ` (max ₦${Number(info.feeCap).toLocaleString()})` : ''} applies to each transfer.`
    : 'No fee.';

  async function create(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await createBankAccount({ idType, idNumber });
      setIdNumber('');
      onCreated(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    setError('');
    setMessage('');
    setBusy(true);
    try {
      const res = await checkBankPayments();
      if (res.credited > 0) {
        setMessage(`₦${Number(res.amount).toLocaleString()} added to your wallet.`);
        onCredited();
      } else {
        setMessage('No new payment yet. Transfers usually arrive within a minute or two — you\'ll get a notification when it lands.');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!info.accounts) {
    return (
      <form className="card" onSubmit={create}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Get your personal account number</h2>
        <p style={{ color: 'var(--slate-400)', fontSize: 13, marginTop: -8 }}>
          Any bank transfer to it goes straight into your wallet — no need to wait for approval. It's a one-time setup; banks require your BVN or NIN for this.
        </p>
        {error && <p className="error-text" style={{ margin: '0 0 10px' }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          {['BVN', 'NIN'].map((t) => (
            <button key={t} type="button" className={idType === t ? 'btn' : 'btn btn-secondary'} onClick={() => setIdType(t)}>
              {t}
            </button>
          ))}
        </div>
        <div className="field">
          <label htmlFor="idNumber">Your {idType} (11 digits)</label>
          <input
            id="idNumber"
            inputMode="numeric"
            autoComplete="off"
            maxLength={11}
            value={idNumber}
            onChange={(e) => setIdNumber(e.target.value.replace(/\D/g, ''))}
            required
          />
        </div>
        <p style={{ color: 'var(--slate-400)', fontSize: 12 }}>
          Your {idType} is sent securely to our licensed payment partner only to create your account. ZappiPay does not store it.
        </p>
        <button className="btn" type="submit" disabled={busy || idNumber.length !== 11}>
          {busy ? 'Creating…' : 'Get My Account Number'}
        </button>
      </form>
    );
  }

  return (
    <div className="card">
      <h2 style={{ marginTop: 0, fontSize: 16 }}>Fund by bank transfer</h2>
      <p style={{ color: 'var(--slate-400)', fontSize: 13, marginTop: -8 }}>
        Transfer any amount from any bank app to your account below. It's added to your wallet automatically. {feeText}
      </p>
      {info.accounts.map((a) => (
        <div key={a.accountNumber} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderTop: '1px solid var(--slate-800, rgba(255,255,255,0.08))' }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--slate-400)' }}>{a.bankName}</div>
            <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: 1 }}>{a.accountNumber}</div>
            <div style={{ fontSize: 12, color: 'var(--slate-400)' }}>{a.accountName}</div>
          </div>
          <CopyButton text={a.accountNumber} />
        </div>
      ))}
      {error && <p className="error-text" style={{ margin: '8px 0' }}>{error}</p>}
      {message && <p style={{ color: 'var(--green-500)', fontSize: 14, margin: '8px 0' }}>{message}</p>}
      <button className="btn btn-secondary" type="button" style={{ marginTop: 8 }} disabled={busy} onClick={check}>
        {busy ? 'Checking…' : 'I\'ve sent money — check now'}
      </button>
    </div>
  );
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function Wallet() {
  const [balance, setBalance] = useState(0);
  const [transactions, setTransactions] = useState(null);
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [bankInfo, setBankInfo] = useState(null);

  function load() {
    Promise.all([getWalletBalance(), getWalletTransactions()])
      .then(([b, t]) => {
        setBalance(b.walletBalance);
        setTransactions(t.transactions);
      })
      .catch((err) => setError(err.message));
  }

  useEffect(load, []);
  useEffect(() => {
    getBankAccount().then(setBankInfo).catch(() => setBankInfo(null));
  }, []);

  const autoFunding = Boolean(bankInfo?.available);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSuccessMessage('');
    setSubmitting(true);
    try {
      await submitFundRequest({ amount: Number(amount), reference: reference.trim() || undefined, note: note.trim() || undefined });
      setAmount('');
      setReference('');
      setNote('');
      setSuccessMessage('Funding request submitted. It will reflect once approved.');
      load();
    } catch (err) {
      setError(err.message || 'Could not submit funding request.');
    } finally {
      setSubmitting(false);
    }
  }

  const manualForm = (
      <form onSubmit={handleSubmit} style={autoFunding ? { marginTop: 12 } : undefined}>
          <h2 style={{ marginTop: 0, fontSize: 16 }}>{autoFunding ? 'Manual funding' : 'Fund Wallet'}</h2>
          <p style={{ color: 'var(--slate-400)', fontSize: 13, marginTop: -8 }}>
            Send a bank transfer, then submit the details below for approval.
          </p>
          <div className="field">
            <label htmlFor="amount">Amount (₦)</label>
            <input id="amount" type="number" min="100" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="reference">Transfer reference (optional)</label>
            <input id="reference" type="text" value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="note">Note (optional)</label>
            <input id="note" type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. sent from GTBank" />
          </div>
          <button className="btn" type="submit" disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit Funding Request'}
          </button>
        </form>
  );

  return (
    <div className="app-shell">
      <div className="page-header">
        <h1>Wallet</h1>
        <p>Fund your wallet and track your transactions</p>
      </div>

      <div className="card stat-card">
        <div className="label">Wallet Balance</div>
        <div className="value">{fmtMoney(balance)}</div>
      </div>

      {error && <p className="error-text">{error}</p>}
      {successMessage && <p style={{ color: 'var(--green-500)', fontSize: 14, margin: '0 16px 12px' }}>{successMessage}</p>}

      {autoFunding && (
        <BankFunding
          info={bankInfo}
          onCreated={(res) => setBankInfo((prev) => ({ ...prev, accounts: res.accounts, kycType: res.kycType }))}
          onCredited={load}
        />
      )}

      {autoFunding ? (
        <details className="card">
          <summary style={{ cursor: 'pointer', fontSize: 14 }}>Other way: send to our business account for manual approval</summary>
          {manualForm}
        </details>
      ) : (
        <div className="card">{manualForm}</div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Transaction History</h2>
        {transactions === null ? (
          <p className="empty-state">Loading…</p>
        ) : transactions.length === 0 ? (
          <p className="empty-state">No transactions yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((t) => (
                <tr key={t.id}>
                  <td>{fmtDate(t.createdAt)}</td>
                  <td>{String(t.type).replace(/_/g, ' ')}</td>
                  <td>{fmtMoney(t.amount)}</td>
                  <td>{t.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <BottomNav />
    </div>
  );
}
