import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getVtpassServices, getLightPots, createLightPot, previewLightPot, joinLightPot, getLightPot, payLightPot, buyLightNow, closeLightPot } from '../../api';
import PinConfirm from '../../components/PinConfirm';
import BottomNav from '../../components/BottomNav';
import { clearAfterLogin } from '../../lib/afterLogin';
import { naira } from '../../components/circles/shared';

const back = (to, label) => <Link to={to} style={{ color: 'var(--purple)', textDecoration: 'none', fontSize: 14 }}>← {label}</Link>;
const bar = (a, b) => <div style={{ height: 12, borderRadius: 6, background: 'var(--slate-800)', overflow: 'hidden', margin: '8px 0' }}><div style={{ width: `${Math.min(100, Math.round((a / Math.max(1, b)) * 100))}%`, height: '100%', background: 'var(--gold)' }} /></div>;

export default function SharedLight() {
  const navigate = useNavigate();
  const [list, setList] = useState(null);
  const [discos, setDiscos] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ name: '', serviceID: '', meterNumber: '', meterType: 'prepaid', target: '' });
  const [err, setErr] = useState('');
  useEffect(() => { getLightPots().then((d) => setList(d.pots)).catch((e) => setErr(e.message)); }, []);
  useEffect(() => { if (open && !discos.length) getVtpassServices('electricity-bill').then((d) => setDiscos(Array.isArray(d.content) ? d.content : [])).catch(() => {}); }, [open]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <div className="app-shell" style={{ paddingBottom: 90 }}>
      <div className="page-header">{back('/more', 'Back')}<h1>💡 Shared Light</h1><p>Housemates, flatmates or shop neighbours put money into one pot. When it’s full, the token is bought automatically for your shared meter.</p></div>
      {err && <p className="error-text" style={{ margin: '0 16px' }}>{err}</p>}
      {!open ? <div style={{ margin: '0 16px 12px' }}><button type="button" className="btn" onClick={() => setOpen(true)}>＋ Start a light pot</button></div> : (
        <form className="card" onSubmit={async (e) => { e.preventDefault(); setErr(''); setBusy(true); try { const r = await createLightPot(f); navigate(`/shared-light/${r.pot.id}`); } catch (e2) { setErr(e2.message); } finally { setBusy(false); } }}>
          <b>New light pot</b>
          <div className="field" style={{ marginTop: 8 }}><label htmlFor="lN">Name</label><input id="lN" value={f.name} onChange={set('name')} maxLength={50} placeholder="e.g. Flat 3 light" required /></div>
          <div className="field"><label htmlFor="lD">Electricity company</label><select id="lD" value={f.serviceID} onChange={set('serviceID')} required><option value="">Choose…</option>{discos.map((d) => <option key={d.serviceID} value={d.serviceID}>{d.name}</option>)}</select></div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
            <div className="field"><label htmlFor="lM">Meter number</label><input id="lM" inputMode="numeric" value={f.meterNumber} onChange={set('meterNumber')} required /></div>
            <div className="field"><label htmlFor="lT">Type</label><select id="lT" value={f.meterType} onChange={set('meterType')}><option value="prepaid">Prepaid</option><option value="postpaid">Postpaid</option></select></div>
          </div>
          <div className="field"><label htmlFor="lA">Token amount each time (₦)</label><input id="lA" type="number" min="1000" max="200000" value={f.target} onChange={set('target')} placeholder="e.g. 10000" required /></div>
          <p style={{ fontSize: 12, color: 'var(--slate-400)' }}>We check the meter name first. Money in the pot can only buy light for this meter — or goes back to whoever paid it if you close the pot.</p>
          <button className="btn" type="submit" disabled={busy}>{busy ? 'Checking meter…' : 'Create pot'}</button>
        </form>
      )}
      {list?.length > 0 && (
        <div className="card">
          <b>My pots</b>
          {list.map((p) => <Link key={p.id} to={`/shared-light/${p.id}`} style={{ display: 'block', padding: '8px 0', borderTop: '1px solid var(--slate-800)', textDecoration: 'none', color: 'inherit' }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><b>{p.name}{p.isOwner ? ' · owner' : ''}</b><small>{p.status === 'ACTIVE' ? `${naira(p.collected)} / ${naira(p.target)}` : 'closed'}</small></div>{p.status === 'ACTIVE' && bar(p.collected, p.target)}</Link>)}
        </div>
      )}
      <BottomNav />
    </div>
  );
}

export function SharedLightJoin() {
  const { code } = useParams();
  const navigate = useNavigate();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { clearAfterLogin(); previewLightPot(code).then(setD).catch((e) => setErr(e.message)); }, [code]);
  if (err) return <div className="app-shell"><p className="error-text" style={{ margin: 16 }}>{err}</p></div>;
  if (!d) return <div className="page-loading">Loading…</div>;
  return (
    <div className="app-shell">
      <div className="page-header"><h1>💡 {d.pot.name}</h1><p>Started by {d.owner} · {d.members} in the pot</p></div>
      <div className="card">
        <div style={{ fontSize: 14 }}>Meter: <b>{d.pot.meterNumber}</b>{d.pot.meterName ? ` (${d.pot.meterName})` : ''}</div>
        <div style={{ fontSize: 14, margin: '4px 0 10px' }}>Token: {naira(d.pot.target)} each time the pot fills</div>
        {err && <p className="error-text">{err}</p>}
        {d.pot.status === 'ACTIVE' ? <button type="button" className="btn" onClick={() => joinLightPot(code).then((r) => navigate(`/shared-light/${r.potId}`)).catch((e) => setErr(e.message))}>Join the pot</button> : <p>This pot is closed.</p>}
      </div>
    </div>
  );
}

export function SharedLightDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [d, setD] = useState(null);
  const [amt, setAmt] = useState('');
  const [pin, setPin] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => getLightPot(id).then((x) => { setD(x); setAmt((a) => a || String(Math.ceil(x.pot.suggestedShare))); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [id]);
  if (!d) return <div className="app-shell"><div className="page-header">{back('/shared-light', 'Shared Light')}</div>{err ? <p className="error-text" style={{ margin: 16 }}>{err}</p> : <p className="empty-state">Loading…</p>}</div>;
  const p = d.pot;
  const link = `${window.location.origin}/shared-light/join/${p.code}`;
  const left = Math.max(0, p.target - p.collected);
  return (
    <div className="app-shell" style={{ paddingBottom: 90 }}>
      <div className="page-header">{back('/shared-light', 'Shared Light')}<h1>💡 {p.name}</h1><p>Meter {p.meterNumber}{p.meterName ? ` · ${p.meterName}` : ''} · {p.meterType}</p></div>
      {err && <p className="error-text" style={{ margin: '0 16px' }}>{err}</p>}
      {msg && <p style={{ color: 'var(--green-500)', margin: '0 16px', fontSize: 14 }}>{msg}</p>}
      {d.lastToken && <div className="card" style={{ borderColor: 'var(--green-500)' }}><small>Latest token</small><div style={{ fontSize: 20, fontWeight: 800, letterSpacing: 1 }}>{d.lastToken}</div><button type="button" onClick={() => navigator.clipboard?.writeText(d.lastToken).then(() => setMsg('Token copied ✓'))} style={{ background: 'none', border: 'none', color: 'var(--purple)', cursor: 'pointer', padding: 0 }}>Copy token</button></div>}
      <div className="card">
        <b>Round {p.cycle}</b>
        <div style={{ fontSize: 22, fontWeight: 800, marginTop: 6 }}>{naira(p.collected)} <span style={{ fontSize: 14, fontWeight: 500 }}>of {naira(p.target)}</span></div>
        {bar(p.collected, p.target)}
        {p.status === 'ACTIVE' ? (
          <>
            <p style={{ fontSize: 13, color: 'var(--slate-400)' }}>{naira(left)} to go. Fair share: about {naira(p.suggestedShare)} each. The token is bought the moment the pot is full.</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="number" min="100" value={amt} onChange={(e) => setAmt(e.target.value)} aria-label="Amount" style={{ flex: 1 }} />
              <button type="button" className="btn" style={{ width: 'auto' }} disabled={!(Number(amt) >= 100)} onClick={() => setPin(true)}>Put in</button>
            </div>
          </>
        ) : <p>This pot is closed.</p>}
        {d.members.map((m, i) => <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '6px 0', borderTop: '1px solid var(--slate-800)' }}><span>{m.name}{m.isOwner ? ' (owner)' : ''}</span><span style={{ color: m.done ? 'var(--green-500)' : 'var(--slate-400)' }}>{m.paid > 0 ? naira(m.paid) : '—'}{m.done ? ' ✅' : ''}</span></div>)}
      </div>
      {p.status === 'ACTIVE' && (
        <div className="card">
          <b>Invite housemates</b>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <button type="button" className="btn" style={{ width: 'auto' }} onClick={() => navigator.clipboard?.writeText(link).then(() => setMsg('Link copied ✓'))}>Copy link</button>
            <a className="btn btn-secondary" style={{ width: 'auto', textDecoration: 'none' }} target="_blank" rel="noopener noreferrer" href={`https://wa.me/?text=${encodeURIComponent(`Let’s pay our light together 💡 Join “${p.name}” on ZAPPI PAY — the token buys itself when the pot is full: ${link}`)}`}>WhatsApp</a>
          </div>
          {d.isOwner && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
              {p.collected >= 1000 && p.collected < p.target && <button type="button" className="btn btn-secondary" style={{ width: 'auto', fontSize: 13 }} onClick={() => window.confirm(`Buy a ${naira(p.collected)} token now with what’s in the pot?`) && buyLightNow(id).then((r) => { if (r?.bought) setMsg('Token bought ✓'); else setErr(r?.error ? `The purchase failed (${r.error}) — the money is back in the pot.` : 'The purchase failed — the money is back in the pot.'); load(); }).catch((e) => setErr(e.message))}>⚡ Buy now with {naira(p.collected)}</button>}
              <button type="button" style={{ background: 'none', border: 'none', color: 'var(--red-500)', cursor: 'pointer', fontSize: 13 }} onClick={() => window.confirm('Close the pot? Money in it goes back to the people who paid.') && closeLightPot(id).then(() => navigate('/shared-light')).catch((e) => setErr(e.message))}>Close pot</button>
            </div>
          )}
        </div>
      )}
      {d.history.length > 0 && <div className="card"><b>Past tokens</b>{d.history.map((h, i) => <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '6px 0', borderTop: '1px solid var(--slate-800)' }}><span>Round {h.cycle} · {new Date(h.at).toLocaleDateString('en-NG')}</span><span>{naira(h.amount)} · {String(h.status).toLowerCase()}</span></div>)}</div>}
      <PinConfirm open={pin} summary={`Put ${naira(Number(amt) || 0)} into “${p.name}”`}
        onSubmit={async (auth) => { const r = await payLightPot(id, { amount: Number(amt), ...auth }); setPin(false); setMsg(r.bought?.bought ? 'Added ✓ — the pot was full, so the token has been bought! ⚡' : 'Added ✓'); setAmt(''); load(); }}
        onError={(e) => setErr(e.message)} onClose={() => setPin(false)} />
      <BottomNav />
    </div>
  );
}
