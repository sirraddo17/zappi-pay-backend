import { Fragment, useEffect, useState } from 'react';
import AdminLayout from '../../components/AdminLayout';
import { getAdminSupportTickets, resolveSupportTicket, replySupportTicket, getAdminAiStatus, adminAiDraftReply, adminImageUrl } from '../../api';
import useAutoRefresh, { ADMIN_REFRESH } from '../../lib/useAutoRefresh';
import { CATEGORIES, detectCategory, draftReply } from '../../assistant/replyTemplates';

function fmtMoney(n) {
  return `₦${Number(n).toLocaleString()}`;
}

function fmtDate(d) {
  return new Date(d).toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// Reply assistant for one ticket: guesses the complaint type, drafts a
// professional reply from a template filled with this customer's name
// and order details, and lets the admin edit it before sending. Nothing
// goes to the customer until the admin presses Send.
function ReplyPanel({ ticket, onSent, onClose, aiOn }) {
  const [category, setCategory] = useState(() => detectCategory(ticket));
  const [text, setText] = useState(() => draftReply(ticket, detectCategory(ticket)));
  const [edited, setEdited] = useState(false);
  const [resolve, setResolve] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiNote, setAiNote] = useState('');

  // Claude drafts from this customer's real orders, refunds and wallet.
  async function draftWithAi() {
    setAiBusy(true);
    setError('');
    try {
      const res = await adminAiDraftReply(ticket.id, aiNote.trim() || undefined);
      setText(res.draft.slice(0, 2000));
      setEdited(true);
    } catch (err) {
      setError(err.message || 'Could not draft with AI.');
    } finally {
      setAiBusy(false);
    }
  }

  function changeCategory(id) {
    setCategory(id);
    setText(draftReply(ticket, id));
    setEdited(false);
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy — select the text and copy it manually.');
    }
  }

  async function handleSend() {
    setSending(true);
    setError('');
    try {
      await replySupportTicket(ticket.id, { reply: text.trim(), resolve });
      onSent();
    } catch (err) {
      setError(err.message || 'Could not send reply.');
      setSending(false);
    }
  }

  const hasPlaceholder = text.includes('[Add your answer here]');

  return (
    <div style={{ background: 'var(--slate-900)', borderRadius: 10, padding: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <label htmlFor={`cat-${ticket.id}`} style={{ fontSize: 13, color: 'var(--slate-400)' }}>Complaint type</label>
        <select id={`cat-${ticket.id}`} value={category} onChange={(e) => changeCategory(e.target.value)} style={{ width: 'auto', fontSize: 13, padding: '6px 8px' }}>
          {CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
        {edited && (
          <button type="button" className="btn-secondary btn" style={{ width: 'auto', padding: '4px 10px', fontSize: 12 }} onClick={() => changeCategory(category)}>
            Reset draft
          </button>
        )}
      </div>
      {aiOn && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <input
            value={aiNote}
            onChange={(e) => setAiNote(e.target.value)}
            maxLength={300}
            placeholder="Optional note for AI, e.g. “apologise, refund already done”"
            aria-label="Instructions for AI"
            style={{ flex: '1 1 220px', fontSize: 13 }}
          />
          <button type="button" className="btn" style={{ width: 'auto', padding: '6px 12px', fontSize: 13 }} disabled={aiBusy || sending} onClick={draftWithAi}>
            {aiBusy ? 'Drafting…' : '✨ Draft with AI'}
          </button>
        </div>
      )}
      <textarea
        rows={10}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setEdited(true);
        }}
        maxLength={2000}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          fontFamily: 'inherit',
          fontSize: 14,
          lineHeight: 1.45,
          background: 'var(--slate-800)',
          border: '1px solid var(--slate-700)',
          borderRadius: 8,
          color: 'var(--slate-100)',
          padding: 10,
          resize: 'vertical',
        }}
      />
      <p style={{ color: 'var(--slate-400)', fontSize: 12, margin: '4px 0 8px' }}>
        Check the facts (amounts, refund status, dates) against the order and wallet before sending. {text.length}/2000
      </p>
      {hasPlaceholder && <p style={{ color: 'var(--orange)', fontSize: 13, margin: '0 0 8px' }}>Replace “[Add your answer here]” before sending.</p>}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 10, cursor: 'pointer' }}>
        <input type="checkbox" checked={resolve} onChange={(e) => setResolve(e.target.checked)} style={{ width: 'auto' }} />
        Mark ticket as resolved when sending
      </label>
      {error && <p className="error-text" style={{ margin: '0 0 8px' }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" type="button" style={{ width: 'auto', padding: '8px 14px', fontSize: 13 }} disabled={sending || !text.trim() || hasPlaceholder} onClick={handleSend}>
          {sending ? 'Sending…' : 'Send to customer'}
        </button>
        <button className="btn-secondary btn" type="button" style={{ width: 'auto', padding: '8px 14px', fontSize: 13 }} onClick={handleCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button className="btn-secondary btn" type="button" style={{ width: 'auto', padding: '8px 14px', fontSize: 13 }} onClick={onClose} disabled={sending}>
          Close
        </button>
      </div>
    </div>
  );
}

// Picture a customer attached (loaded with the admin login).
function TicketImage({ id }) {
  const [url, setUrl] = useState('');
  const [big, setBig] = useState(false);
  useEffect(() => {
    let u = '';
    adminImageUrl(`/api/admin/support/attachments/${id}`).then((x) => { u = x; setUrl(x); }).catch(() => {});
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [id]);
  if (!url) return <span style={{ display: 'inline-block', width: 56, height: 56, borderRadius: 8, background: 'var(--slate-700)' }} />;
  return (
    <>
      <img src={url} alt="Customer attachment" onClick={() => setBig(true)} style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, cursor: 'zoom-in', border: '1px solid var(--slate-700)' }} />
      {big && (
        <div role="dialog" aria-label="Attachment" onClick={() => setBig(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, cursor: 'zoom-out' }}>
          <img src={url} alt="Customer attachment, full size" style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 10 }} />
        </div>
      )}
    </>
  );
}

export default function AdminSupport() {
  const [tickets, setTickets] = useState(null);
  const [error, setError] = useState('');
  const [resolvingId, setResolvingId] = useState(null);
  const [replyingId, setReplyingId] = useState(null);
  const [filter, setFilter] = useState('OPEN');
  const [aiOn, setAiOn] = useState(false);

  useEffect(() => {
    getAdminAiStatus().then((st) => setAiOn(Boolean(st.adminEnabled))).catch(() => {});
  }, []);

  function load() {
    getAdminSupportTickets()
      .then((data) => setTickets(data.tickets))
      .catch((err) => setError(err.message));
  }

  useEffect(load, []);
  useAutoRefresh(load, true, ADMIN_REFRESH);

  async function handleResolve(id) {
    setResolvingId(id);
    setError('');
    try {
      await resolveSupportTicket(id);
      load();
    } catch (err) {
      setError(err.message || 'Could not resolve this ticket.');
    } finally {
      setResolvingId(null);
    }
  }

  const shown = tickets === null ? null : filter === 'ALL' ? tickets : tickets.filter((t) => t.status === filter);
  const openCount = tickets ? tickets.filter((t) => t.status === 'OPEN').length : 0;

  return (
    <AdminLayout>
      <div className="page-header" style={{ padding: 0, marginBottom: 16 }}>
        <h1>Support</h1>
        <p>Customer complaints — use Draft Reply to get a ready-to-edit professional response</p>
      </div>

      {error && <p className="error-text" style={{ margin: '0 0 12px' }}>{error}</p>}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {[
          ['OPEN', `Open${openCount ? ` (${openCount})` : ''}`],
          ['RESOLVED', 'Resolved'],
          ['ALL', 'All'],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={value === filter ? 'btn' : 'btn-secondary btn'}
            style={{ width: 'auto', padding: '6px 14px', fontSize: 13 }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="card admin-table-wrap" style={{ margin: 0 }}>
        {shown === null ? (
          <p className="empty-state">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="empty-state">No tickets here.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Message</th>
                <th>Order</th>
                <th>Status</th>
                <th>Date</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <Fragment key={t.id}>
                  <tr>
                    <td>
                      {t.customer?.name}
                      <div style={{ color: 'var(--slate-400)', fontSize: 12 }}>{t.customer?.phone}</div>
                    </td>
                    <td style={{ maxWidth: 280 }}>
                      {t.message}
                      {t.attachments?.length > 0 && (
                        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                          {t.attachments.map((a) => <TicketImage key={a.id} id={a.id} />)}
                        </div>
                      )}
                      {t.adminReply && (
                        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--slate-400)' }}>
                          Replied {t.repliedAt ? fmtDate(t.repliedAt) : ''}
                        </div>
                      )}
                    </td>
                    <td>
                      {t.order ? (
                        <>
                          {t.order.service} — {t.order.recipient}
                          <div style={{ color: 'var(--slate-400)', fontSize: 12 }}>{fmtMoney(t.order.amount)} · {t.order.status}</div>
                          <div style={{ color: 'var(--slate-400)', fontSize: 12 }}>Receipt: {fmtDate(t.order.createdAt)}</div>
                        </>
                      ) : (
                        <span style={{ color: 'var(--slate-400)' }}>General</span>
                      )}
                    </td>
                    <td>
                      <span className={`admin-badge ${t.status === 'RESOLVED' ? 'active' : 'inactive'}`}>
                        {t.status === 'RESOLVED' ? 'Solved' : 'Open'}
                      </span>
                    </td>
                    <td style={{ color: 'var(--slate-400)', fontSize: 13 }}>{fmtDate(t.createdAt)}</td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <button
                          className="btn"
                          style={{ width: 'auto', padding: '6px 12px', fontSize: 13 }}
                          onClick={() => setReplyingId(replyingId === t.id ? null : t.id)}
                        >
                          {t.adminReply ? 'Reply again' : 'Draft reply'}
                        </button>
                        {t.status !== 'RESOLVED' && (
                          <button
                            className="btn-secondary btn"
                            style={{ width: 'auto', padding: '6px 12px', fontSize: 13 }}
                            onClick={() => handleResolve(t.id)}
                            disabled={resolvingId === t.id}
                          >
                            {resolvingId === t.id ? 'Saving…' : 'Mark Resolved'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {(replyingId === t.id || t.adminReply) && (
                    <tr>
                      <td colSpan={6} style={{ paddingTop: 0 }}>
                        {replyingId === t.id ? (
                          <ReplyPanel aiOn={aiOn}
                            ticket={t}
                            onClose={() => setReplyingId(null)}
                            onSent={() => {
                              setReplyingId(null);
                              load();
                            }}
                          />
                        ) : (
                          <div style={{ fontSize: 13, color: 'var(--slate-400)', whiteSpace: 'pre-wrap', borderLeft: '3px solid var(--purple)', paddingLeft: 10 }}>
                            <strong style={{ color: 'var(--slate-100)' }}>Your reply:</strong> {t.adminReply}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AdminLayout>
  );
}
