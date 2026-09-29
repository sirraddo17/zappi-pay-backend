import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { submitSupportTicket, getOrders, getAiStatus, aiChat } from '../api';
import { matchMessage, topicById, QUICK_TOPICS, WHATSAPP_NUMBER, SUPPORT_EMAIL } from '../assistant/knowledge';
import { useAppInfo } from './ServiceNotices';
import ImageAttach from './ImageAttach';

// Floating "Help" chat for logged-in customers. Quick topics are
// rule-based (assistant/knowledge.js). When the AI assistant is on in
// Admin → Settings, typed questions go to it (it can look up the
// customer's own orders and wallet, read-only); if it is off, busy or
// over the daily limit, the rule-based answers are used instead.
// Hidden on admin, auth and legal pages.
const HIDDEN_PREFIXES = ['/admin', '/login', '/signup', '/legal', '/forgot-password', '/reset-password', '/change-password'];

function botText(text, extra = {}) {
  return { from: 'bot', text, ...extra };
}

export default function HelpAssistant() {
  const appInfo = useAppInfo();
  const { customer } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [misses, setMisses] = useState(0);
  const [ticketMode, setTicketMode] = useState(false);
  const [ticketText, setTicketText] = useState('');
  const [ticketImages, setTicketImages] = useState([]);
  const [ticketOrderId, setTicketOrderId] = useState('');
  const [orders, setOrders] = useState([]);
  const [sending, setSending] = useState(false);
  const [ticketError, setTicketError] = useState('');
  const endRef = useRef(null);
  const [ai, setAi] = useState(null); // { enabled, remaining }
  const [thinking, setThinking] = useState(false);

  const hidden = !customer || HIDDEN_PREFIXES.some((p) => location.pathname.startsWith(p));

  useEffect(() => {
    if (open && ai === null) getAiStatus().then(setAi).catch(() => setAi({ enabled: false }));
  }, [open]);

  useEffect(() => {
    if (open && messages.length === 0) {
      const first = customer?.name?.split(' ')[0];
      setMessages([
        botText(`Hi${first ? ` ${first}` : ''}! I'm the ZappiPay helper. Ask me anything about the app, or pick a topic below.`, { quick: true }),
      ]);
    }
  }, [open]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, ticketMode]);

  if (hidden) return null;

  function lastUserText() {
    const u = [...messages].reverse().find((m) => m.from === 'user');
    return u?.text || '';
  }

  function openTicket(prefill) {
    setTicketMode(true);
    setTicketError('');
    setTicketText(prefill ?? lastUserText());
    if (orders.length === 0) {
      getOrders()
        .then((data) => setOrders((data.orders || []).slice(0, 15)))
        .catch(() => {});
    }
  }

  function respond(userText) {
    const result = matchMessage(userText);
    if (result.type === 'topic') {
      setMisses(0);
      const t = result.topic;
      const reply = botText(t.answer, { actions: t.actions, offerHuman: t.escalate || result.wantsHuman });
      return [reply];
    }
    if (result.type === 'human') {
      setMisses(0);
      return [botText('Sure — I can pass this to our support team. Tell them what happened below and they will reply in your notifications.', { offerHuman: true })];
    }
    if (result.type === 'greeting') {
      return [botText('Hello! What can I help you with today?', { quick: true })];
    }
    const nextMisses = misses + 1;
    setMisses(nextMisses);
    if (nextMisses >= 2) {
      return [botText("I'm still not sure I understand. The best next step is to message our support team — a real person will reply.", { offerHuman: true })];
    }
    return [botText("Sorry, I didn't quite get that. Try describing it differently, or pick one of these topics:", { quick: true })];
  }

  async function send(text) {
    const clean = text.trim();
    if (!clean || thinking) return;
    setInput('');
    if (!ai?.enabled) {
      setMessages((prev) => [...prev, { from: 'user', text: clean }, ...respond(clean)]);
      return;
    }
    const next = [...messages, { from: 'user', text: clean }];
    setMessages(next);
    setThinking(true);
    // Only real conversation text goes to the AI (not the greeting).
    const history = next
      .filter((m, i) => i > 0 && m.text)
      .map((m) => ({ role: m.from === 'user' ? 'user' : 'assistant', content: m.text }));
    try {
      const res = await aiChat(history);
      setAi((a) => ({ ...a, remaining: res.remaining }));
      setMessages((prev) => [...prev, botText(res.reply, { actions: res.actions, offerHuman: res.offerHuman, ai: true })]);
    } catch (err) {
      // Fall back to the built-in answers so the customer still gets help.
      if (err.code === 'AI_LIMIT' || err.code === 'AI_OFF' || err.code === 'AI_NO_KEY' || err.code === 'AI_BUDGET') setAi({ enabled: false });
      const note = err.code === 'AI_LIMIT' ? botText(err.message) : null;
      setMessages((prev) => [...prev, ...(note ? [note] : []), ...respond(clean)]);
    } finally {
      setThinking(false);
    }
  }

  function pickTopic(id) {
    const t = topicById(id);
    if (!t) return;
    setMessages((prev) => [
      ...prev,
      { from: 'user', text: t.title },
      botText(t.answer, { actions: t.actions, offerHuman: t.escalate }),
    ]);
  }

  async function submitTicket(e) {
    e.preventDefault();
    if (!ticketText.trim()) {
      setTicketError('Please describe the problem.');
      return;
    }
    setSending(true);
    setTicketError('');
    try {
      await submitSupportTicket({ message: ticketText.trim(), orderId: ticketOrderId || undefined, images: ticketImages.length ? ticketImages : undefined });
      setTicketImages([]);
      setTicketMode(false);
      setTicketText('');
      setTicketOrderId('');
      setMessages((prev) => [
        ...prev,
        botText("Done — your message is with our support team. You'll get their reply in your notifications, and you can see it under Profile → Support."),
      ]);
    } catch (err) {
      setTicketError(err.message || 'Could not send. Please try again.');
    } finally {
      setSending(false);
    }
  }

  const bubbleStyle = {
    position: 'fixed',
    right: 'max(16px, calc(50% - 240px + 16px))',
    bottom: 84,
    width: 52,
    height: 52,
    borderRadius: '50%',
    background: 'var(--purple)',
    color: '#fff',
    border: '2px solid var(--gold)',
    fontSize: 22,
    fontWeight: 700,
    cursor: 'pointer',
    boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
    zIndex: 50,
  };

  if (!open) {
    return (
      <button type="button" aria-label="Open help" style={bubbleStyle} onClick={() => setOpen(true)}>
        ?
      </button>
    );
  }

  const chip = { width: 'auto', padding: '6px 10px', fontSize: 12, borderRadius: 999 };

  return (
    <div
      role="dialog"
      aria-label="ZappiPay help"
      style={{
        position: 'fixed',
        right: 'max(8px, calc(50% - 240px + 8px))',
        bottom: 76,
        width: 'min(360px, calc(100vw - 16px))',
        height: 'min(520px, calc(100vh - 120px))',
        background: 'var(--slate-800)',
        border: '1px solid var(--slate-700)',
        borderRadius: 16,
        display: 'flex',
        flexDirection: 'column',
        zIndex: 60,
        boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
        overflow: 'hidden',
      }}
    >
      <div style={{ background: 'var(--purple)', color: '#fff', padding: '12px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontWeight: 700 }}>ZappiPay Help</div>
          <div style={{ fontSize: 12, opacity: 0.85 }}>{ai?.enabled ? 'AI assistant · checks your own orders' : 'Instant answers'} · real people when you need them</div>
        </div>
        <button type="button" aria-label="Close help" onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 22, cursor: 'pointer' }}>
          ×
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.from === 'user' ? 'flex-end' : 'flex-start', maxWidth: '88%' }}>
            <div
              style={{
                background: m.from === 'user' ? 'var(--purple)' : 'var(--slate-900)',
                color: m.from === 'user' ? '#fff' : 'var(--slate-100)',
                padding: '8px 12px',
                borderRadius: 12,
                fontSize: 14,
                lineHeight: 1.4,
                whiteSpace: 'pre-wrap',
              }}
            >
              {m.text}
            </div>
            {m.ai && <div style={{ fontSize: 10, color: 'var(--slate-500, #64748b)', marginTop: 2 }}>AI answer · check Orders for exact details</div>}
            {(m.actions?.length > 0 || m.offerHuman || m.quick) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {m.actions?.map((a) => (
                  <Link key={a.to + a.label} to={a.to} className="btn" style={{ ...chip, textDecoration: 'none' }} onClick={() => setOpen(false)}>
                    {a.label}
                  </Link>
                ))}
                {m.quick &&
                  QUICK_TOPICS.map((id) => (
                    <button key={id} type="button" className="btn-secondary btn" style={chip} onClick={() => pickTopic(id)}>
                      {topicById(id)?.title}
                    </button>
                  ))}
                {m.offerHuman && (
                  <button type="button" className="btn-secondary btn" style={chip} onClick={() => openTicket()}>
                    Talk to support
                  </button>
                )}
              </div>
            )}
          </div>
        ))}

        {thinking && (
          <div style={{ alignSelf: 'flex-start', background: 'var(--slate-900)', color: 'var(--slate-400)', padding: '8px 12px', borderRadius: 12, fontSize: 14 }}>
            Checking…
          </div>
        )}

        {ticketMode && (
          <form onSubmit={submitTicket} style={{ background: 'var(--slate-900)', borderRadius: 12, padding: 10 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>Message support</div>
            <textarea
              rows={3}
              value={ticketText}
              onChange={(e) => setTicketText(e.target.value)}
              placeholder="What happened? Include amounts, numbers or references."
              style={{
                width: '100%',
                boxSizing: 'border-box',
                fontFamily: 'inherit',
                fontSize: 14,
                background: 'var(--slate-800)',
                border: '1px solid var(--slate-700)',
                borderRadius: 8,
                color: 'var(--slate-100)',
                padding: 8,
                resize: 'vertical',
              }}
            />
            <ImageAttach value={ticketImages} onChange={setTicketImages} />
            {orders.length > 0 && (
              <select value={ticketOrderId} onChange={(e) => setTicketOrderId(e.target.value)} style={{ marginTop: 6, fontSize: 13 }}>
                <option value="">Not about a specific order</option>
                {orders.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.service} · {o.recipient} · ₦{Number(o.amount).toLocaleString()} · {o.status}
                  </option>
                ))}
              </select>
            )}
            {ticketError && <p className="error-text" style={{ margin: '6px 0 0', fontSize: 13 }}>{ticketError}</p>}
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button className="btn" type="submit" disabled={sending} style={{ ...chip, padding: '8px 12px' }}>
                {sending ? 'Sending…' : 'Send to support'}
              </button>
              <button className="btn-secondary btn" type="button" onClick={() => setTicketMode(false)} style={{ ...chip, padding: '8px 12px' }}>
                Cancel
              </button>
              <a
                href={`https://wa.me/${appInfo?.supportWhatsapp || WHATSAPP_NUMBER}?text=${encodeURIComponent(ticketText || 'Hello ZappiPay, I need help with')}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary btn"
                style={{ ...chip, padding: '8px 12px', textDecoration: 'none' }}
              >
                WhatsApp
              </a>
              <a
                href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('ZappiPay support')}&body=${encodeURIComponent(ticketText)}`}
                className="btn-secondary btn"
                style={{ ...chip, padding: '8px 12px', textDecoration: 'none' }}
              >
                Email
              </a>
            </div>
          </form>
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        style={{ display: 'flex', gap: 6, padding: 10, borderTop: '1px solid var(--slate-700)' }}
      >
        <input value={input} onChange={(e) => setInput(e.target.value)} maxLength={800} placeholder={ai?.enabled ? 'Ask anything about your account…' : 'Type your question…'} aria-label="Your question" style={{ fontSize: 14 }} />
        <button className="btn" type="submit" style={{ width: 'auto', padding: '8px 14px' }} disabled={!input.trim() || thinking}>
          Send
        </button>
      </form>
    </div>
  );
}
