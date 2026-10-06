import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getPayForMes, viewPayForMe, payPayForMe, cancelPayForMe } from '../../api';
import PinConfirm from '../../components/PinConfirm';
import BottomNav from '../../components/BottomNav';
import { clearAfterLogin } from '../../lib/afterLogin';
import { naira } from '../../components/circles/shared';

const STATUS = { OPEN: ['⏳ waiting', 'var(--gold)'], PAYING: ['⏳ paying…', 'var(--gold)'], PAID: ['✅ paid', 'var(--green-500)'], CANCELLED: ['cancelled', 'var(--slate-400)'], EXPIRED: ['expired', 'var(--slate-400)'] };
const back = (to, label) => <Link to={to} style={{ color: 'var(--purple)', textDecoration: 'none', fontSize: 14 }}>← {label}</Link>;

export default function PayForMe() {
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { getPayForMes().then((d) => setList(d.requests)).catch((e) => setErr(e.message)); }, []);
  return (
    <div className="app-shell" style={{ paddingBottom: 90 }}>
      <div className="page-header">{back('/more', 'Back')}<h1>🙏 Pay It For Me</h1><p>Ask family or friends to pay for your airtime, data, light, TV or exam PIN. They pay — it comes straight to you. No “send me money for light” palaver.</p></div>
      {err && <p className="error-text" style={{ margin: '0 16px' }}>{err}</p>}
      <div className="card">
        <b>How to ask</b>
        <ol style={{ fontSize: 14, margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
          <li>Open any service (e.g. <Link to="/buy/electricity" style={{ color: 'var(--purple)' }}>Electricity</Link>) and fill in your meter / number and amount.</li>
          <li>Tap <b>🙏 Ask someone to pay</b> instead of Pay.</li>
          <li>Send the link on WhatsApp. When they pay, you get it instantly.</li>
        </ol>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          {[['airtime', '📱 Airtime'], ['data', '📶 Data'], ['electricity', '💡 Light'], ['cable', '📺 TV']].map(([s, l]) => <Link key={s} to={`/buy/${s}`} className="btn btn-secondary" style={{ width: 'auto', textDecoration: 'none', padding: '6px 12px', fontSize: 13 }}>{l}</Link>)}
        </div>
      </div>
      <div className="card">
        <b>My requests</b>
        {!list ? <p className="empty-state">Loading…</p> : list.length === 0 ? <p style={{ fontSize: 14, color: 'var(--slate-400)' }}>No requests yet.</p> : list.map((r) => {
          const [t, c] = STATUS[r.status] || [r.status, 'inherit'];
          return <Link key={r.token} to={`/p/${r.token}`} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--slate-800)', textDecoration: 'none', color: 'inherit', fontSize: 14 }}><span><b>{r.label}</b><br /><small style={{ color: 'var(--slate-400)' }}>{r.recipient} · {new Date(r.createdAt).toLocaleDateString('en-NG')}</small></span><span style={{ color: c, fontSize: 13 }}>{t}</span></Link>;
        })}
      </div>
      <BottomNav />
    </div>
  );
}

// The shared link: the requester sees status/token; anyone else can pay.
export function PayForMeLink() {
  const { token } = useParams();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [pin, setPin] = useState(false);
  const load = () => viewPayForMe(token).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { clearAfterLogin(); load(); }, [token]);
  if (!d) return <div className="app-shell"><div className="page-header">{back('/', 'Home')}</div>{err ? <p className="error-text" style={{ margin: 16 }}>{err}</p> : <p className="empty-state">Loading…</p>}</div>;
  const r = d.request;
  const [t, c] = STATUS[r.status] || [r.status, 'inherit'];
  const link = `${window.location.origin}/p/${r.token}`;
  return (
    <div className="app-shell" style={{ paddingBottom: 90 }}>
      <div className="page-header">{back(d.isRequester ? '/pay-for-me' : '/', d.isRequester ? 'My requests' : 'Home')}<h1>🙏 {d.isRequester ? 'Your request' : `${r.requester} is asking for help`}</h1></div>
      {err && <p className="error-text" style={{ margin: '0 16px' }}>{err}</p>}
      {msg && <p style={{ color: 'var(--green-500)', margin: '0 16px', fontSize: 14 }}>{msg}</p>}
      <div className="card">
        <div style={{ fontSize: 18, fontWeight: 700 }}>{r.label}</div>
        <div style={{ fontSize: 14, color: 'var(--slate-400)', margin: '4px 0' }}>For: {r.recipient}</div>
        {r.note && <p style={{ fontSize: 14 }}>“{r.note}”</p>}
        {r.price != null && <div style={{ fontSize: 26, fontWeight: 800, margin: '8px 0' }}>{naira(r.price)}</div>}
        <div style={{ color: c, fontSize: 14 }}>{t}{r.paidBy ? ` by ${r.paidBy}` : ''}{r.orderStatus && r.status === 'PAID' && r.orderStatus !== 'SUCCESS' ? ` · delivery ${r.orderStatus.toLowerCase()}` : ''}</div>
        {d.delivered && <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: 'rgba(34,197,94,0.1)', fontSize: 15 }}>Your token: <b style={{ letterSpacing: 1 }}>{d.delivered}</b> <button type="button" onClick={() => navigator.clipboard?.writeText(d.delivered).then(() => setMsg('Token copied ✓'))} style={{ background: 'none', border: 'none', color: 'var(--purple)', cursor: 'pointer' }}>Copy</button></div>}
        {!d.isRequester && r.status === 'OPEN' && (
          <>
            <p style={{ fontSize: 12, color: 'var(--slate-400)' }}>You pay from your ZAPPI PAY wallet and it goes straight to {r.requester}’s {r.service === 'ELECTRICITY' ? 'meter' : r.service === 'CABLE' ? 'decoder' : 'line'}. Nobody receives cash.</p>
            <button type="button" className="btn" onClick={() => setPin(true)}>Pay {r.price != null ? naira(r.price) : ''} for {r.requester}</button>
          </>
        )}
        {!d.isRequester && r.status === 'PAID' && d.orderId && <p style={{ fontSize: 14 }}>Thank you for helping! 💜 <Link to="/orders" style={{ color: 'var(--purple)' }}>See it in Orders →</Link></p>}
        {d.isRequester && r.status === 'OPEN' && (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              <button type="button" className="btn" style={{ width: 'auto' }} onClick={() => navigator.clipboard?.writeText(link).then(() => setMsg('Link copied ✓'))}>Copy link</button>
              <a className="btn btn-secondary" style={{ width: 'auto', textDecoration: 'none' }} target="_blank" rel="noopener noreferrer" href={`https://wa.me/?text=${encodeURIComponent(`Please help me pay for my ${r.label} on ZAPPI PAY 🙏 It goes straight to me: ${link}`)}`}>WhatsApp</a>
            </div>
            <button type="button" onClick={() => window.confirm('Cancel this request?') && cancelPayForMe(token).then(load).catch((e) => setErr(e.message))} style={{ background: 'none', border: 'none', color: 'var(--red-500)', cursor: 'pointer', fontSize: 13, marginTop: 10, padding: 0 }}>Cancel request</button>
          </>
        )}
        <p style={{ fontSize: 12, color: 'var(--slate-400)', marginTop: 10 }}>Links expire after 7 days. If a paid purchase fails, the payer is refunded and the link opens again.</p>
      </div>
      <PinConfirm open={pin} summary={`Pay ${r.price != null ? naira(r.price) : ''} · ${r.label} for ${r.requester}`}
        onSubmit={async (auth) => { const x = await payPayForMe(token, auth); setPin(false); setMsg(x.pending ? 'Paid ✓ — delivery is processing.' : 'Paid ✓ — delivered. Thank you!'); load(); }}
        onError={(e) => setErr(e.message)} onClose={() => setPin(false)} />
      <BottomNav />
    </div>
  );
}
