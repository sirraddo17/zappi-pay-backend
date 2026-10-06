import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getSprayEvents, createSprayEvent, getSprayLive, startSpraySession, sprayMoney, closeSprayEvent } from '../../api';
import PinConfirm from '../../components/PinConfirm';
import BottomNav from '../../components/BottomNav';
import { useAuth } from '../../context/AuthContext';
import { clearAfterLogin } from '../../lib/afterLogin';
import { naira } from '../../components/circles/shared';
import { qrDataUrl } from '../../lib/shareCard';

function Qr({ link, size, style }) {
  const [src, setSrc] = useState('');
  useEffect(() => { qrDataUrl(link, size).then(setSrc).catch(() => {}); }, [link]);
  return src ? <img alt="Scan to spray" src={src} style={style} /> : <div style={{ ...style, background: '#fff' }} />;
}

const SPRAY_CSS = `
@keyframes zpFly { 0% { transform: translate(-50%, 0) rotate(0deg) scale(.6); opacity: 0 } 15% { opacity: 1 } 100% { transform: translate(calc(-50% + var(--dx)), -85vh) rotate(var(--rot)) scale(1.1); opacity: 0 } }
.zp-note { position: absolute; bottom: 8%; left: 50%; animation: zpFly 2.6s ease-out forwards; pointer-events: none; z-index: 5 }
.zp-note b { display: block; background: linear-gradient(135deg, #1f8b4c, #0b5d2e); color: #fff; border: 2px solid #c8f7d4; border-radius: 6px; padding: 10px 16px; font-size: 20px; box-shadow: 0 6px 20px rgba(0,0,0,.35); white-space: nowrap }
.zp-note span { display: block; text-align: center; color: #fff; font-weight: 700; font-size: 14px; margin-top: 4px; text-shadow: 0 1px 4px #000 }
`;

function useLive(code) {
  const [d, setD] = useState(null);
  const [notes, setNotes] = useState([]);
  const seen = useRef(new Set());
  const first = useRef(true);
  useEffect(() => {
    let stop = false;
    const tick = () => getSprayLive(code).then((x) => {
      if (stop) return;
      setD(x);
      const fresh = x.recent.filter((g) => !seen.current.has(g.id));
      fresh.forEach((g) => seen.current.add(g.id));
      if (first.current) { first.current = false; return; }
      if (fresh.length) {
        setNotes((n) => [...n, ...fresh.slice(0, 8).map((g) => ({ ...g, dx: `${Math.round(Math.random() * 300 - 150)}px`, rot: `${Math.round(Math.random() * 60 - 30)}deg` }))].slice(-24));
      }
    }).catch(() => {});
    tick();
    const t = setInterval(tick, 2500);
    return () => { stop = true; clearInterval(t); };
  }, [code]);
  return { d, notes };
}

function Notes({ notes }) {
  return notes.map((n) => <div key={n.id} className="zp-note" style={{ '--dx': n.dx, '--rot': n.rot }}><b>{naira(n.amount)}</b><span>{n.name}</span></div>);
}

// Big screen for the hall (TV / projector / MC's phone).
export function SprayScreen() {
  const { code } = useParams();
  const { d, notes } = useLive(code);
  const link = `${window.location.origin}/spray/${code}`;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'radial-gradient(circle at 50% 30%, #6d28d9, #1e0b3d 70%)', color: '#fff', overflow: 'hidden', fontFamily: 'Poppins, system-ui, sans-serif' }}>
      <style>{SPRAY_CSS}</style>
      <div style={{ textAlign: 'center', paddingTop: '4vh' }}>
        <div style={{ fontSize: '2.2vh', letterSpacing: 2, opacity: 0.8 }}>💃 OWAMBE SPRAY · ZAPPI PAY</div>
        <div style={{ fontSize: '5vh', fontWeight: 800 }}>{d?.event?.title || '…'}</div>
        <div style={{ fontSize: '11vh', fontWeight: 900, color: '#FFB830', lineHeight: 1.1 }}>{naira(d?.event?.total || 0)}</div>
        <div style={{ fontSize: '2.4vh', opacity: 0.85 }}>{d?.event?.count || 0} sprays {d?.event?.status === 'CLOSED' ? '· ended' : ''}</div>
      </div>
      <div style={{ position: 'absolute', left: '3vw', top: '35vh', width: '28vw', fontSize: '2.2vh' }}>
        <b style={{ fontSize: '2.6vh' }}>🏆 Top sprayers</b>
        {(d?.top || []).slice(0, 7).map((t, i) => <div key={t.name + i} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.6vh 0', borderBottom: '1px solid rgba(255,255,255,.15)' }}><span>{['🥇', '🥈', '🥉'][i] || `${i + 1}.`} {t.name}</span><b>{naira(t.amount)}</b></div>)}
      </div>
      <div style={{ position: 'absolute', right: '3vw', top: '35vh', width: '24vw', textAlign: 'center', background: '#fff', color: '#1e0b3d', borderRadius: 16, padding: '2vh' }}>
        <Qr link={link} size={600} style={{ width: '100%', aspectRatio: '1' }} />
        <b style={{ fontSize: '2.4vh' }}>Scan to spray</b>
        <div style={{ fontSize: '1.6vh', wordBreak: 'break-all' }}>{link.replace(/^https?:\/\//, '')}</div>
      </div>
      <Notes notes={notes} />
    </div>
  );
}

// Guest view (and the host's own phone view).
export function SprayEvent() {
  const { code } = useParams();
  const { customer, refreshCustomer } = useAuth();
  const navigate = useNavigate();
  const { d, notes } = useLive(code);
  const [session, setSession] = useState(null);
  const [budget, setBudget] = useState('5000');
  const [pick, setPick] = useState(500);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [pin, setPin] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { clearAfterLogin(); }, []);

  async function spray() {
    setErr(''); setBusy(true);
    try {
      const r = await sprayMoney(code, { sessionId: session.sessionId, amount: pick, message: msg.trim() || undefined });
      setSession((s) => ({ ...s, left: r.left }));
    } catch (e) {
      if (e.code === 'SESSION' || e.code === 'BUDGET') setSession(null);
      setErr(e.message);
    } finally { setBusy(false); }
  }

  if (!d) return <div className="page-loading">Loading…</div>;
  const ended = d.event.status !== 'OPEN';
  return (
    <div className="app-shell" style={{ paddingBottom: 90, position: 'relative', overflow: 'hidden', minHeight: '100vh' }}>
      <style>{SPRAY_CSS}</style>
      <div className="page-header">
        <Link to="/spray" style={{ color: 'var(--purple)', textDecoration: 'none', fontSize: 14 }}>← Owambe Spray</Link>
        <h1>💃 {d.event.title}</h1>
        <p>Spraying {d.event.celebrant} · {naira(d.event.total)} from {d.event.count} sprays</p>
      </div>
      {ended ? <div className="card">This spray event has ended. Thank you! 🎉</div> : !session ? (
        <div className="card">
          <b>Set your spray budget</b>
          <p style={{ fontSize: 13, color: 'var(--slate-400)', margin: '4px 0 8px' }}>Confirm once with your PIN, then tap to spray as many times as you like until the budget is used. Each spray goes straight to the celebrant.</p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>{[2000, 5000, 10000, 20000, 50000].map((b) => <button key={b} type="button" className={Number(budget) === b ? 'btn' : 'btn btn-secondary'} style={{ width: 'auto', padding: '6px 12px', fontSize: 13 }} onClick={() => setBudget(String(b))}>{naira(b)}</button>)}</div>
          <input type="number" inputMode="numeric" min="100" value={budget} onChange={(e) => setBudget(e.target.value)} aria-label="Spray budget" style={{ width: '100%', boxSizing: 'border-box' }} />
          {err && <p className="error-text">{err}</p>}
          <button type="button" className="btn" style={{ marginTop: 10 }} disabled={!(Number(budget) >= 100)} onClick={() => (customer ? setPin(true) : navigate('/login'))}>Start spraying 💸</button>
        </div>
      ) : (
        <div className="card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 13, color: 'var(--slate-400)' }}>Budget left: <b style={{ color: 'var(--green-500)' }}>{naira(session.left)}</b></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, margin: '12px 0' }}>{d.amounts.map((a) => <button key={a} type="button" className={pick === a ? 'btn' : 'btn btn-secondary'} style={{ padding: '10px 0' }} onClick={() => setPick(a)}>{naira(a)}</button>)}</div>
          <input value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={60} placeholder="Add a message (optional)" aria-label="Message" style={{ width: '100%', boxSizing: 'border-box', marginBottom: 10 }} />
          <button type="button" onClick={spray} disabled={busy || pick > session.left} style={{ width: 160, height: 160, borderRadius: '50%', border: 'none', background: 'radial-gradient(circle at 30% 30%, #34d399, #047857)', color: '#fff', fontSize: 22, fontWeight: 800, boxShadow: '0 10px 30px rgba(16,185,129,.4)', cursor: 'pointer' }}>💸<br />SPRAY<br />{naira(pick)}</button>
          {err && <p className="error-text">{err}</p>}
        </div>
      )}
      <div className="card">
        <b>🏆 Top sprayers</b>
        {d.top.length ? d.top.map((t, i) => <div key={t.name + i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '5px 0', borderTop: '1px solid var(--slate-800)' }}><span>{['🥇', '🥈', '🥉'][i] || `${i + 1}.`} {t.name}</span><b>{naira(t.amount)}</b></div>) : <p className="empty-state">Be the first to spray!</p>}
      </div>
      <Notes notes={notes} />
      <PinConfirm open={pin} summary={`Spray budget ${naira(budget)} for “${d.event.title}”`} onSubmit={async (auth) => { const s = await startSpraySession(code, { budget: Number(budget), ...auth }); setSession(s); setPin(false); refreshCustomer?.(); }} onError={(e) => setErr(e.message)} onClose={() => setPin(false)} />
      <BottomNav />
    </div>
  );
}

// Host: my spray events + create.
export default function Spray() {
  const navigate = useNavigate();
  const [list, setList] = useState(null);
  const [title, setTitle] = useState('');
  const [celebrant, setCelebrant] = useState('');
  const [err, setErr] = useState('');
  const load = () => getSprayEvents().then((d) => setList(d.events)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  return (
    <div className="app-shell" style={{ paddingBottom: 90 }}>
      <div className="page-header">
        <Link to="/more" style={{ color: 'var(--purple)', textDecoration: 'none', fontSize: 14 }}>← Back</Link>
        <h1>💃 Owambe Spray</h1>
        <p>Guests scan your QR and spray money from their phones — it lands in your wallet, live on screen.</p>
      </div>
      <form className="card" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { const r = await createSprayEvent({ title, celebrant }); navigate(`/spray/${r.event.code}/host`); } catch (e2) { setErr(e2.message); } }}>
        <b>Start a spray event</b>
        <div className="field" style={{ marginTop: 8 }}><label htmlFor="sT">Party name</label><input id="sT" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} placeholder="e.g. Tunde & Ada’s wedding" required /></div>
        <div className="field"><label htmlFor="sC">Celebrant (shown to guests)</label><input id="sC" value={celebrant} onChange={(e) => setCelebrant(e.target.value)} maxLength={60} placeholder="e.g. Mr & Mrs Bello" /></div>
        {err && <p className="error-text">{err}</p>}
        <button className="btn" type="submit">Create & get my QR</button>
      </form>
      {list?.length > 0 && (
        <div className="card">
          <b>My events</b>
          {list.map((e) => <Link key={e.code} to={`/spray/${e.code}/host`} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid var(--slate-800)', textDecoration: 'none', color: 'inherit' }}><span>{e.title}<br /><small style={{ color: 'var(--slate-400)' }}>{e.status === 'OPEN' ? '🟢 Live' : 'Ended'} · {e.count} sprays</small></span><b>{naira(e.total)}</b></Link>)}
        </div>
      )}
      <BottomNav />
    </div>
  );
}

// Host control page: QR, link, open the big screen, end the event.
export function SprayHost() {
  const { code } = useParams();
  const { d, notes } = useLive(code);
  const [msg, setMsg] = useState('');
  const link = `${window.location.origin}/spray/${code}`;
  if (!d) return <div className="page-loading">Loading…</div>;
  return (
    <div className="app-shell" style={{ paddingBottom: 90, position: 'relative', overflow: 'hidden' }}>
      <style>{SPRAY_CSS}</style>
      <div className="page-header"><Link to="/spray" style={{ color: 'var(--purple)', textDecoration: 'none', fontSize: 14 }}>← My events</Link><h1>{d.event.title}</h1><p>{d.event.status === 'OPEN' ? '🟢 Live' : 'Ended'} · {d.event.count} sprays</p></div>
      <div className="card" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 13, color: 'var(--slate-400)' }}>Sprayed so far (already in your wallet)</div>
        <div style={{ fontSize: 34, fontWeight: 800, color: 'var(--green-500)' }}>{naira(d.event.total)}</div>
        <Qr link={link} size={480} style={{ width: 200, height: 200, background: '#fff', padding: 8, borderRadius: 12, margin: '10px auto', display: 'block' }} />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          <button type="button" className="btn" style={{ width: 'auto' }} onClick={() => navigator.clipboard?.writeText(link).then(() => setMsg('Link copied ✓'))}>Copy link</button>
          <a className="btn btn-secondary" style={{ width: 'auto', textDecoration: 'none' }} href={`https://wa.me/?text=${encodeURIComponent(`Spray us at “${d.event.title}” on ZAPPI PAY 💃 ${link}`)}`} target="_blank" rel="noopener noreferrer">WhatsApp</a>
          <Link className="btn btn-secondary" style={{ width: 'auto', textDecoration: 'none' }} to={`/spray/${code}/screen`}>📺 Big screen</Link>
        </div>
        {msg && <p style={{ color: 'var(--green-500)', fontSize: 13 }}>{msg}</p>}
        <p style={{ fontSize: 12, color: 'var(--slate-400)' }}>Open “Big screen” on a TV or projector so everyone sees the money fly. Print the QR or put it on the screen.</p>
        {d.event.status === 'OPEN' && <button type="button" onClick={() => window.confirm('End the spray event?') && closeSprayEvent(code).then(() => window.location.reload())} style={{ background: 'none', border: 'none', color: 'var(--red-500)', cursor: 'pointer' }}>End event</button>}
      </div>
      <div className="card"><b>🏆 Top sprayers</b>{d.top.map((t, i) => <div key={t.name + i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '5px 0', borderTop: '1px solid var(--slate-800)' }}><span>{i + 1}. {t.name}</span><b>{naira(t.amount)}</b></div>)}</div>
      <Notes notes={notes} />
      <BottomNav />
    </div>
  );
}
