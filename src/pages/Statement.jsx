import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getStatement } from '../api';
import BottomNav from '../components/BottomNav';

function money(n) {
  return `₦${Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function ymd(d) {
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 10);
}

const TYPE_LABEL = {
  FUND: 'Wallet funding',
  REFUND: 'Refund',
  TRANSFER_IN: 'Money received',
  TRANSFER_OUT: 'Money sent',
  DEBIT: 'Purchase',
  AIRTIME_CASH: 'Airtime to cash',
  REFERRAL_BONUS: 'Referral bonus',
  CASHBACK: 'Cashback',
  LOYALTY: 'Points redeemed',
};

// Last 12 months as quick picks, plus a custom range.
function monthOptions() {
  const out = [];
  const now = new Date();
  for (let i = 0; i < 12; i += 1) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = i === 0 ? now : new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
    out.push({ key: ymd(start), label: start.toLocaleDateString('en-NG', { month: 'long', year: 'numeric' }), from: ymd(start), to: ymd(end) });
  }
  return out;
}

// Account statement: pick a period, then "Save as PDF" (browser print).
export default function Statement() {
  const months = useMemo(monthOptions, []);
  const [period, setPeriod] = useState(months[0].key);
  const [from, setFrom] = useState(months[0].from);
  const [to, setTo] = useState(months[0].to);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError('');
    getStatement(from, to)
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [from, to]);

  function pickMonth(key) {
    setPeriod(key);
    const m = months.find((x) => x.key === key);
    if (m) {
      setFrom(m.from);
      setTo(m.to);
    }
  }

  const fmtDay = (d) => new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <div className="app-shell">
      <div className="page-header no-print">
        <Link to="/wallet" style={{ color: 'var(--purple, var(--orange))', textDecoration: 'none', fontSize: 14 }}>&larr; Back to wallet</Link>
        <h1>Account Statement</h1>
        <p>Every credit and debit on your wallet for a period</p>
      </div>

      <div className="card no-print" style={{ margin: '0 16px 16px' }}>
        <div className="field">
          <label htmlFor="period">Period</label>
          <select id="period" value={period} onChange={(e) => pickMonth(e.target.value)}>
            {months.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            <option value="custom">Custom dates…</option>
          </select>
        </div>
        {period === 'custom' && (
          <div style={{ display: 'flex', gap: 8 }}>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="from">From</label>
              <input id="from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="to">To</label>
              <input id="to" type="date" value={to} min={from} max={ymd(new Date())} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
        )}
        <button className="btn" type="button" disabled={!data || loading} onClick={() => window.print()}>
          Download PDF
        </button>
        <p style={{ color: 'var(--slate-400)', fontSize: 12, margin: '8px 0 0' }}>
          Choose “Save as PDF” in the print window that opens.
        </p>
      </div>

      {error && <p className="error-text" style={{ margin: '0 16px 12px' }}>{error}</p>}
      {loading && <p className="empty-state">Loading…</p>}

      {data && !loading && (
        <div className="statement-doc">
          <div className="statement-head">
            <div>
              <div className="statement-brand">ZAPPI PAY</div>
              <div className="statement-sub">Wallet account statement</div>
            </div>
            <div style={{ textAlign: 'right', fontSize: 13 }}>
              <div><strong>{data.customer.name}</strong></div>
              <div>{data.customer.phone}</div>
              {data.customer.email && <div>{data.customer.email}</div>}
            </div>
          </div>

          <div className="statement-period">
            {fmtDay(`${data.from}T12:00:00`)} – {fmtDay(`${data.to}T12:00:00`)}
          </div>

          <div className="statement-summary">
            <div><span>Opening balance</span><strong>{money(data.opening)}</strong></div>
            <div><span>Money in</span><strong className="in">{money(data.totalCredits)}</strong></div>
            <div><span>Money out</span><strong className="out">{money(data.totalDebits)}</strong></div>
            <div><span>Closing balance</span><strong>{money(data.closing)}</strong></div>
          </div>

          {data.transactions.length === 0 ? (
            <p className="empty-state">No transactions in this period.</p>
          ) : (
            <table className="statement-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Details</th>
                  <th className="num">Money in</th>
                  <th className="num">Money out</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {data.transactions.map((t) => (
                  <tr key={t.id}>
                    <td>{new Date(t.date).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}</td>
                    <td>
                      <div>{TYPE_LABEL[t.type] || t.type}</div>
                      {t.note && <div className="muted">{t.note}</div>}
                    </td>
                    <td className="num in">{t.credit ? money(t.credit) : ''}</td>
                    <td className="num out">{t.debit ? money(t.debit) : ''}</td>
                    <td className="num">{money(t.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {data.transactions.length > 0 && (
            <div className="statement-list">
              {data.transactions.map((t) => (
                <div className="statement-item" key={t.id}>
                  <div className="statement-item-main">
                    <div className="statement-item-title">{TYPE_LABEL[t.type] || t.type}</div>
                    {t.note && <div className="muted">{t.note}</div>}
                    <div className="muted">{new Date(t.date).toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
                  </div>
                  <div className="statement-item-nums">
                    <div className={t.credit ? 'in' : 'out'} style={{ fontWeight: 700 }}>
                      {t.credit ? `+${money(t.credit)}` : `−${money(t.debit)}`}
                    </div>
                    <div className="muted">Bal {money(t.balance)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="statement-foot">
            Generated {new Date().toLocaleString('en-NG')} · ZAPPI PAY by Sirraddo Venture · support@zappipay.com.ng
          </div>
        </div>
      )}

      <div className="no-print"><BottomNav /></div>
    </div>
  );
}
