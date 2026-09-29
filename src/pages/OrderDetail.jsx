import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getOrder, submitSupportTicket } from '../api';
import useAutoRefresh from '../lib/useAutoRefresh';
import RateExperience from '../components/RateExperience';
import ImageAttach from '../components/ImageAttach';
import { buyAgainLink } from '../lib/repeat';
import { shareReceipt, downloadReceipt, extractToken } from '../lib/receipt';

const STATUS_COLORS = {
  DELIVERED: 'var(--green-500)',
  SUCCESS: 'var(--green-500)',
  PENDING: 'var(--orange)',
  FAILED: '#ef4444',
};

function fmtMoney(n) {
  return `₦${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
}

function fmtDate(d) {
  return new Date(d).toLocaleString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function OrderDetail() {
  const { id } = useParams();
  const [order, setOrder] = useState(null);
  const [error, setError] = useState('');

  const [reportOpen, setReportOpen] = useState(false);
  const [reportMessage, setReportMessage] = useState('');
  const [reportImages, setReportImages] = useState([]);
  const [reportError, setReportError] = useState('');
  const [reportSuccess, setReportSuccess] = useState('');
  const [submittingReport, setSubmittingReport] = useState(false);

  function load() {
    getOrder(id)
      .then((data) => { setOrder(data.order); setError(''); })
      .catch((err) => { if (!order) setError(err.message || 'Could not load this receipt.'); });
  }

  useEffect(load, [id]);
  useAutoRefresh(load, order?.status === 'PENDING');

  const token = order ? extractToken(order) : null;
  const [copied, setCopied] = useState(false);
  const [sharing, setSharing] = useState(false);

  function receiptData() {
    const rows = [
      ['Service', order.service],
      ['Provider', order.provider],
      ['Recipient', order.recipient],
    ];
    if (order.recipientName) rows.push(['Name', order.recipientName]);
    if (Number(order.discountAmount) > 0) rows.push(['Discount', fmtMoney(order.discountAmount)]);
    rows.push(['Date', fmtDate(order.createdAt)], ['Reference', order.vtpassRequestId || order.id]);
    return {
      title: `${order.service.charAt(0)}${order.service.slice(1).toLowerCase()} receipt`,
      amount: order.amount,
      status: order.status,
      rows,
      highlight: token ? { label: order.service === 'ELECTRICITY' ? 'Token' : 'PIN / Code', value: token } : undefined,
    };
  }

  async function handleDownload() {
    await downloadReceipt(receiptData(), `zappipay-${order.id}.png`);
  }

  async function handleShare() {
    setSharing(true);
    try {
      await shareReceipt(receiptData(), `zappipay-${order.id}.png`);
    } finally {
      setSharing(false);
    }
  }

  async function handleReportSubmit(e) {
    e.preventDefault();
    setReportError('');
    setReportSuccess('');
    setSubmittingReport(true);
    try {
      await submitSupportTicket({ message: reportMessage.trim(), orderId: id, images: reportImages.length ? reportImages : undefined });
      setReportMessage('');
      setReportImages([]);
      setReportOpen(false);
      setReportSuccess('Your report has been submitted. Our team will get back to you.');
    } catch (err) {
      setReportError(err.message || 'Could not submit your report.');
    } finally {
      setSubmittingReport(false);
    }
  }

  if (error) {
    return (
      <div style={{ maxWidth: 420, margin: '0 auto', padding: '24px 16px' }}>
        <p className="error-text">{error}</p>
        <Link to="/orders">Back to Orders</Link>
      </div>
    );
  }

  if (!order) {
    return (
      <div style={{ maxWidth: 420, margin: '0 auto', padding: '24px 16px' }}>
        <p className="empty-state">Loading…</p>
      </div>
    );
  }

  return (
    <div className="receipt" style={{ maxWidth: 420, margin: '0 auto', padding: '24px 16px 90px' }}>
      <Link to="/orders" className="no-print" style={{ display: 'inline-block', marginBottom: 16, color: 'var(--slate-400)', fontSize: 14 }}>
        &larr; Back to Orders
      </Link>

      {reportSuccess && (
        <p className="no-print" style={{ color: 'var(--green-500)', fontSize: 14, margin: '0 0 12px' }}>{reportSuccess}</p>
      )}

      <div className="no-print"><RateExperience order={order} flush /></div>

      <div className="card" style={{ margin: '0 0 16px', textAlign: 'center' }}>
        <h1 style={{ margin: '0 0 4px', fontSize: 18 }}>ZAPPI PAY</h1>
        <p style={{ margin: '0 0 20px', color: 'var(--slate-400)', fontSize: 13 }}>Payment Receipt</p>

        <div style={{ fontSize: 28, fontWeight: 700, margin: '0 0 4px' }}>{fmtMoney(order.amount)}</div>
        <div style={{ color: STATUS_COLORS[order.status] || 'var(--slate-400)', fontWeight: 600, marginBottom: 20 }}>
          {order.status}
        </div>

        {order.status === 'PENDING' && (
          <p style={{ fontSize: 13, color: 'var(--orange, #f97316)', margin: '-8px 0 16px' }}>
            Waiting for the provider to confirm. Please don't buy again — we'll notify you, and refund you automatically if it doesn't go through.
          </p>
        )}

        {token && (
          <div style={{ background: 'rgba(134,59,255,0.12)', border: '1px solid var(--purple)', borderRadius: 12, padding: 14, marginBottom: 18, textAlign: 'left' }}>
            <div style={{ fontSize: 12, color: 'var(--slate-400)', marginBottom: 4 }}>{order.service === 'ELECTRICITY' ? 'Your token' : 'PIN / code'}</div>
            <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: 1, wordBreak: 'break-word' }}>{token}</div>
            <button
              type="button"
              className="btn btn-secondary no-print"
              style={{ width: 'auto', padding: '6px 12px', fontSize: 13, marginTop: 8 }}
              onClick={() => navigator.clipboard?.writeText(token).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        )}

        <div style={{ textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 10, fontSize: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--slate-400)' }}>Service</span>
            <span>{order.service}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--slate-400)' }}>Provider</span>
            <span>{order.provider}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--slate-400)' }}>Recipient</span>
            <span>{order.recipient}</span>
          </div>
          {Number(order.discountAmount) > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--slate-400)' }}>Discount</span>
              <span style={{ color: 'var(--green-500)' }}>−{fmtMoney(order.discountAmount)}</span>
            </div>
          )}
          {order.recipientName && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--slate-400)' }}>Name</span>
              <span>{order.recipientName}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--slate-400)' }}>Date</span>
            <span>{fmtDate(order.createdAt)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--slate-400)' }}>Reference</span>
            <span style={{ fontSize: 12 }}>{order.vtpassRequestId || order.id}</span>
          </div>
        </div>
      </div>

      <div className="no-print" style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className="btn-secondary btn" type="button" onClick={handleDownload}>
          Save image
        </button>
        <button className="btn" type="button" onClick={handleShare} disabled={sharing}>
          {sharing ? 'Preparing…' : 'Share receipt'}
        </button>
      </div>

      {buyAgainLink(order) && (
        <Link
          to={buyAgainLink(order)}
          className="btn no-print"
          style={{ display: 'block', textAlign: 'center', textDecoration: 'none', marginBottom: 8, boxSizing: 'border-box' }}
        >
          Buy again
        </Link>
      )}

      {order.service === 'AIRTIME' && order.status === 'SUCCESS' && (
        <Link
          to={`/airtime-cash?order=${order.id}`}
          className="btn-secondary btn no-print"
          style={{ display: 'block', textAlign: 'center', textDecoration: 'none', marginBottom: 8, boxSizing: 'border-box' }}
        >
          Bought by mistake? Convert to cash
        </Link>
      )}

      {!reportOpen ? (
        <button className="btn-secondary btn no-print" type="button" onClick={() => setReportOpen(true)}>
          Report Issue
        </button>
      ) : (
        <form className="card no-print" style={{ margin: 0 }} onSubmit={handleReportSubmit}>
          <h2 style={{ marginTop: 0, fontSize: 16 }}>Report an Issue</h2>
          {reportError && <p className="error-text" style={{ margin: '0 0 12px' }}>{reportError}</p>}
          <div className="field">
            <label htmlFor="reportMessage">What went wrong?</label>
            <textarea
              id="reportMessage"
              rows={4}
              value={reportMessage}
              onChange={(e) => setReportMessage(e.target.value)}
              required
              style={{ width: '100%', boxSizing: 'border-box' }}
            />
            <ImageAttach value={reportImages} onChange={setReportImages} label="📎 Add a screenshot (e.g. bank alert)" />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" type="submit" disabled={submittingReport}>
              {submittingReport ? 'Submitting…' : 'Submit Report'}
            </button>
            <button className="btn-secondary btn" type="button" onClick={() => setReportOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
