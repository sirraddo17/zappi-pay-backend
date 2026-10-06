import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getDuesGroups, createDuesGroup, previewDues, joinDues, getDuesGroup, payDues, setDuesAutoPay, remindDues, leaveDues } from '../../api';
import PinConfirm from '../../components/PinConfirm';
import BottomNav from '../../components/BottomNav';
import { clearAfterLogin } from '../../lib/afterLogin';
import { naira } from '../../components/circles/shared';

const OFTEN = { WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' };
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const dueText = (g) => (g.frequency === 'WEEKLY' ? `every ${DAYS[g.dueDay - 1]}` : g.frequency === 'MONTHLY' ? `on day ${g.dueDay} of each month` : `every January ${g.dueDay}`);
const back = (to, label) => <Link to={to} style={{ color: 'var(--purple)', textDecoration: 'none', fontSize: 14 }}>← {label}</Link>;

export default function Dues() {
  const navigate = useNavigate();
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', amount: '', frequency: 'MONTHLY', dueDay: '1', description: '' });
  const [err, setErr] = useState('');
  useEffect(() => { getDuesGroups().then((d) => setList(d.groups)).catch((e) => setErr(e.message)); }, []);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <div className="app-shell" style={{ paddingBottom: 90 }}>
      <div className="page-header">{back('/more', 'Back')}<h1>🏘️ Association Dues</h1><p>Estates, churches, mosques, alumni, staff clubs — collect dues with reminders, auto-pay and a paid/unpaid list.</p></div>
      {err && <p className="error-text" style={{ margin: '0 16px' }}>{err}</p>}
      {!open ? <div style={{ margin: '0 16px 12px' }}><button type="button" className="btn" onClick={() => setOpen(true)}>＋ Start collecting dues</button></div> : (
        <form className="card" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { const r = await createDuesGroup(f); navigate(`/dues/${r.group.id}`); } catch (e2) { setErr(e2.message); } }}>
          <b>New dues group</b>
          <div className="field" style={{ marginTop: 8 }}><label htmlFor="dN">Group name</label><input id="dN" value={f.name} onChange={set('name')} maxLength={60} placeholder="e.g. Unity Estate Landlords" required /></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="field"><label htmlFor="dA">Dues (₦)</label><input id="dA" type="number" min="100" value={f.amount} onChange={set('amount')} required /></div>
            <div className="field"><label htmlFor="dF">How often</label><select id="dF" value={f.frequency} onChange={(e) => setF((x) => ({ ...x, frequency: e.target.value, dueDay: '1' }))}><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option><option value="YEARLY">Yearly</option></select></div>
          </div>
          <div className="field"><label htmlFor="dD">Due {f.frequency === 'WEEKLY' ? 'day' : 'date'}</label>
            {f.frequency === 'WEEKLY' ? <select id="dD" value={f.dueDay} onChange={set('dueDay')}>{DAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select> : <input id="dD" type="number" min="1" max="28" value={f.dueDay} onChange={set('dueDay')} />}
          </div>
          <div className="field"><label htmlFor="dX">What the dues are for (members see this)</label><textarea id="dX" rows={2} maxLength={500} value={f.description} onChange={set('description')} style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'inherit' }} /></div>
          <p style={{ fontSize: 12, color: 'var(--slate-400)' }}>You are the treasurer: dues go straight into your wallet. You’ll see who has paid each period.</p>
          <button className="btn" type="submit">Create group</button>
        </form>
      )}
      {list?.length > 0 && (
        <div className="card">
          <b>My groups</b>
          {list.map((g) => <Link key={g.id} to={`/dues/${g.id}`} style={{ display: 'block', padding: '8px 0', borderTop: '1px solid var(--slate-800)', textDecoration: 'none', color: 'inherit' }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><b>{g.name}{g.isOwner ? ' · treasurer' : ''}</b><span style={{ fontSize: 12, color: g.paid ? 'var(--green-500)' : 'var(--gold)' }}>{g.paid ? '✅ paid' : '⏳ due'}</span></div><small style={{ color: 'var(--slate-400)' }}>{naira(g.amount)} {OFTEN[g.frequency]} · {g.period}{g.autoPay ? ' · auto-pay on' : ''}</small></Link>)}
        </div>
      )}
      <BottomNav />
    </div>
  );
}

export function DuesJoin() {
  const { code } = useParams();
  const navigate = useNavigate();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { clearAfterLogin(); previewDues(code).then(setD).catch((e) => setErr(e.message)); }, [code]);
  if (err) return <div className="app-shell"><p className="error-text" style={{ margin: 16 }}>{err}</p></div>;
  if (!d) return <div className="page-loading">Loading…</div>;
  return (
    <div className="app-shell">
      <div className="page-header"><h1>🏘️ {d.group.name}</h1><p>Treasurer: {d.treasurer} · {d.members} members</p></div>
      <div className="card"><div style={{ fontSize: 24, fontWeight: 800 }}>{naira(d.group.amount)} <span style={{ fontSize: 14, fontWeight: 500 }}>{OFTEN[d.group.frequency]}, due {dueText(d.group)}</span></div>{d.group.description && <p style={{ fontSize: 14 }}>{d.group.description}</p>}
        <p style={{ fontSize: 12, color: 'var(--slate-400)' }}>Dues go to the treasurer’s ZAPPI PAY wallet. You choose when to pay (or switch on auto-pay).</p>
        {err && <p className="error-text">{err}</p>}
        <button type="button" className="btn" onClick={() => joinDues(code).then((r) => navigate(`/dues/${r.assocId}`)).catch((e) => setErr(e.message))}>Join group</button>
      </div>
    </div>
  );
}

export function DuesDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [d, setD] = useState(null);
  const [period, setPeriod] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [pin, setPin] = useState(null);
  const load = () => getDuesGroup(id, period).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [id, period]);
  if (!d) return <div className="app-shell"><div className="page-header">{back('/dues', 'Dues')}</div>{err ? <p className="error-text" style={{ margin: 16 }}>{err}</p> : <p className="empty-state">Loading…</p>}</div>;
  const g = d.group;
  const link = `${window.location.origin}/dues/join/${g.code}`;
  const unpaid = d.me.periods.filter((p) => !p.paid);
  function csv() {
    const rows = [['Name', 'Phone', 'Paid', 'Paid on']].concat(d.members.map((m) => [m.name, m.phone, m.paid ? 'Yes' : 'No', m.paidAt ? new Date(m.paidAt).toLocaleDateString('en-NG') : '']));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([rows.map((r) => r.map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' }));
    a.download = `${g.name}-${d.period.key}.csv`.replace(/\s+/g, '-');
    a.click();
  }
  return (
    <div className="app-shell" style={{ paddingBottom: 90 }}>
      <div className="page-header">{back('/dues', 'Dues')}<h1>{g.name}</h1><p>{naira(g.amount)} {OFTEN[g.frequency]}, due {dueText(g)}</p></div>
      {err && <p className="error-text" style={{ margin: '0 16px' }}>{err}</p>}
      {msg && <p style={{ color: 'var(--green-500)', margin: '0 16px', fontSize: 14 }}>{msg}</p>}
      {!d.isOwner && (
        <div className="card">
          <b>My dues</b>
          {unpaid.length === 0 ? <p style={{ color: 'var(--green-500)', fontSize: 14 }}>✅ You’re up to date.</p> : unpaid.map((p) => <div key={p.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderTop: '1px solid var(--slate-800)', fontSize: 14 }}><span>{p.label}</span><button type="button" className="btn" style={{ width: 'auto', padding: '5px 12px', fontSize: 13 }} onClick={() => setPin({ type: 'pay', period: p.key, label: p.label })}>Pay {naira(g.amount)}</button></div>)}
          <label style={{ display: 'flex', gap: 8, fontSize: 14, marginTop: 10 }}><input type="checkbox" checked={d.me.autoPay} onChange={(e) => setPin({ type: 'auto', on: e.target.checked })} style={{ width: 'auto' }} /> Auto-pay on each due date</label>
          <button type="button" onClick={() => window.confirm('Leave this group?') && leaveDues(id).then(() => navigate('/dues'))} style={{ background: 'none', border: 'none', color: 'var(--red-500)', cursor: 'pointer', fontSize: 13, marginTop: 8 }}>Leave group</button>
        </div>
      )}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <b>{d.period.label}</b>
          <select value={d.period.key} onChange={(e) => setPeriod(e.target.value)} aria-label="Period" style={{ width: 'auto', fontSize: 13 }}>{d.periods.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select>
        </div>
        <div style={{ fontSize: 14, margin: '8px 0' }}>{d.summary.paid} of {d.summary.members} paid · {naira(d.summary.collected)} of {naira(d.summary.expected)}</div>
        <div style={{ height: 10, borderRadius: 6, background: 'var(--slate-800)', overflow: 'hidden' }}><div style={{ width: `${Math.round((d.summary.paid / Math.max(1, d.summary.members)) * 100)}%`, height: '100%', background: 'var(--green-500)' }} /></div>
        {d.isOwner && d.members && (
          <>
            {d.members.map((m) => <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '6px 0', borderTop: '1px solid var(--slate-800)' }}><span>{m.name}{m.role === 'OWNER' ? ' (you)' : ''}{m.autoPay ? <small style={{ color: 'var(--slate-400)' }}> · auto-pay</small> : ''}</span><span style={{ color: m.paid ? 'var(--green-500)' : 'var(--gold)' }}>{m.paid ? '✅ paid' : '⏳ not yet'}</span></div>)}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              <button type="button" className="btn btn-secondary" style={{ width: 'auto', padding: '6px 12px', fontSize: 13 }} onClick={() => remindDues(id).then((r) => setMsg(`Reminder sent to ${r.reminded} member${r.reminded === 1 ? '' : 's'} ✓`)).catch((e) => setErr(e.message))}>🔔 Remind unpaid</button>
              <button type="button" className="btn btn-secondary" style={{ width: 'auto', padding: '6px 12px', fontSize: 13 }} onClick={csv}>⬇ Download list (Excel)</button>
              {!d.members.find((m) => m.role === 'OWNER')?.paid && <button type="button" className="btn btn-secondary" style={{ width: 'auto', padding: '6px 12px', fontSize: 13 }} onClick={() => payDues(id, { period: d.period.key }).then(load).catch((e) => setErr(e.message))}>Mark my own dues paid</button>}
            </div>
          </>
        )}
      </div>
      {d.isOwner && (
        <div className="card">
          <b>Invite members</b>
          <p style={{ fontSize: 13, color: 'var(--slate-400)', margin: '4px 0 8px' }}>Share the link in your WhatsApp group. Members need a ZAPPI PAY account.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn" style={{ width: 'auto' }} onClick={() => navigator.clipboard?.writeText(link).then(() => setMsg('Link copied ✓'))}>Copy link</button>
            <a className="btn btn-secondary" style={{ width: 'auto', textDecoration: 'none' }} href={`https://wa.me/?text=${encodeURIComponent(`Pay your “${g.name}” dues (${naira(g.amount)} ${OFTEN[g.frequency]}) on ZAPPI PAY — join here: ${link}`)}`} target="_blank" rel="noopener noreferrer">WhatsApp</a>
          </div>
        </div>
      )}
      <PinConfirm open={Boolean(pin)} summary={pin?.type === 'pay' ? `Pay ${naira(g.amount)} dues to “${g.name}” for ${pin.label}` : `${pin?.on ? 'Turn on' : 'Turn off'} auto-pay for “${g.name}”`}
        onSubmit={async (auth) => { if (pin.type === 'pay') { await payDues(id, { period: pin.period, ...auth }); setMsg('Paid ✓'); } else { await setDuesAutoPay(id, { on: pin.on, ...auth }); setMsg(pin.on ? 'Auto-pay is on ✓' : 'Auto-pay is off'); } setPin(null); load(); }}
        onError={(e) => setErr(e.message)} onClose={() => setPin(null)} />
      <BottomNav />
    </div>
  );
}
