import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getPayroll, addPayrollStaff, updatePayrollStaff, runPayroll, getBankList } from '../../api';
import PinConfirm from '../../components/PinConfirm';
import BottomNav from '../../components/BottomNav';
import { naira } from '../../components/circles/shared';

export default function Payroll() {
  const [d, setD] = useState(null);
  const [banks, setBanks] = useState([]);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ payTo: 'WALLET', name: '', identifier: '', bankCode: '', accountNumber: '', amount: '' });
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState('');
  const [pin, setPin] = useState(false);
  const [result, setResult] = useState(null);
  const [edit, setEdit] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => getPayroll().then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  useEffect(() => { if (open && f.payTo === 'BANK' && !banks.length) getBankList().then((x) => setBanks(x.banks || [])).catch(() => {}); }, [open, f.payTo]);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function add(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    try { await addPayrollStaff(f); setF({ payTo: f.payTo, name: '', identifier: '', bankCode: f.bankCode, accountNumber: '', amount: '' }); setOpen(false); setMsg('Staff added ✓'); load(); } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }
  return (
    <div className="app-shell" style={{ paddingBottom: 90 }}>
      <div className="page-header"><Link to="/more" style={{ color: 'var(--purple)', textDecoration: 'none', fontSize: 14 }}>← Back</Link><h1>💼 Payroll</h1><p>Pay your shop staff, workers or helpers in one tap — to their ZAPPI PAY wallet (free, instant) or any bank account.</p></div>
      {err && <p className="error-text" style={{ margin: '0 16px' }}>{err}</p>}
      {msg && <p style={{ color: 'var(--green-500)', margin: '0 16px', fontSize: 14 }}>{msg}</p>}
      {!d ? <p className="empty-state">Loading…</p> : (
        <>
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><b>Staff ({d.staff.length})</b><span style={{ fontWeight: 700 }}>{naira(d.total)}</span></div>
            {d.staff.length === 0 && <p style={{ fontSize: 14, color: 'var(--slate-400)' }}>Add the people you pay every month.</p>}
            {d.staff.map((s) => (
              <div key={s.id} style={{ padding: '8px 0', borderTop: '1px solid var(--slate-800)', fontSize: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span><b>{s.name}</b><br /><small style={{ color: 'var(--slate-400)' }}>{s.payTo === 'WALLET' ? `ZAPPI PAY @${s.identifier}` : `${s.accountName} · ${s.accountNumber}`}</small></span>
                  {edit?.id === s.id ? (
                    <span style={{ display: 'flex', gap: 4 }}><input type="number" min="100" value={edit.amount} onChange={(e) => setEdit({ ...edit, amount: e.target.value })} aria-label="Salary" style={{ width: 100 }} /><button type="button" className="btn" style={{ width: 'auto', padding: '4px 10px' }} onClick={() => updatePayrollStaff(s.id, { amount: Number(edit.amount) }).then(() => { setEdit(null); load(); }).catch((e) => setErr(e.message))}>Save</button></span>
                  ) : <span style={{ textAlign: 'right' }}>{naira(s.amount)}<br /><button type="button" onClick={() => setEdit({ id: s.id, amount: s.amount })} style={{ background: 'none', border: 'none', color: 'var(--purple)', cursor: 'pointer', padding: 0, fontSize: 12 }}>Edit</button> · <button type="button" onClick={() => window.confirm(`Remove ${s.name}?`) && updatePayrollStaff(s.id, { remove: true }).then(load)} style={{ background: 'none', border: 'none', color: 'var(--red-500)', cursor: 'pointer', padding: 0, fontSize: 12 }}>Remove</button></span>}
                </div>
              </div>
            ))}
            {!open ? <button type="button" className="btn btn-secondary" style={{ marginTop: 8 }} onClick={() => setOpen(true)}>＋ Add staff</button> : (
              <form onSubmit={add} style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--slate-800)' }}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  {[['WALLET', 'ZAPPI PAY wallet'], ['BANK', 'Bank account']].map(([k, l]) => <button key={k} type="button" className={f.payTo === k ? 'btn' : 'btn btn-secondary'} style={{ flex: 1, padding: '6px' }} onClick={() => setF((x) => ({ ...x, payTo: k }))}>{l}</button>)}
                </div>
                {f.payTo === 'WALLET' ? (
                  <div className="field"><label htmlFor="pI">Their ZAPPI PAY username or phone</label><input id="pI" value={f.identifier} onChange={set('identifier')} required /></div>
                ) : (
                  <>
                    <div className="field"><label htmlFor="pB">Bank</label><select id="pB" value={f.bankCode} onChange={set('bankCode')} required><option value="">Choose bank…</option>{banks.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}</select></div>
                    <div className="field"><label htmlFor="pA">Account number</label><input id="pA" inputMode="numeric" maxLength={10} value={f.accountNumber} onChange={set('accountNumber')} required /></div>
                  </>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div className="field"><label htmlFor="pN">Name (optional)</label><input id="pN" value={f.name} onChange={set('name')} maxLength={60} /></div>
                  <div className="field"><label htmlFor="pS">Salary (₦)</label><input id="pS" type="number" min="100" value={f.amount} onChange={set('amount')} required /></div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}><button className="btn" type="submit" disabled={busy}>{busy ? 'Checking…' : 'Add'}</button><button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button></div>
              </form>
            )}
          </div>
          {d.staff.length > 0 && (
            <div className="card">
              <b>Pay everyone</b>
              <div className="field" style={{ marginTop: 8 }}><label htmlFor="pL">Label (optional)</label><input id="pL" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder={`Salary ${new Date().toLocaleDateString('en-NG', { month: 'long', year: 'numeric' })}`} /></div>
              <p style={{ fontSize: 12, color: 'var(--slate-400)' }}>Wallet staff are paid instantly and free. Bank staff use Send to Bank (normal transfer fee each). Everyone gets a payslip message.</p>
              <button type="button" className="btn" onClick={() => setPin(true)}>Pay {d.staff.length} staff · {naira(d.total)}</button>
            </div>
          )}
          {result && <div className="card"><b>Result: {result.paid} paid{result.failed ? `, ${result.failed} failed` : ''}</b>{result.items.map((i, n) => <div key={n} style={{ fontSize: 14, padding: '4px 0', color: i.ok ? 'inherit' : 'var(--red-500)' }}>{i.ok ? '✅' : '❌'} {i.name} · {naira(i.amount)}{i.error ? ` — ${i.error}` : ''}</div>)}</div>}
          {d.runs.length > 0 && <div className="card"><b>Past payrolls</b>{d.runs.map((r) => <details key={r.id} style={{ padding: '6px 0', borderTop: '1px solid var(--slate-800)', fontSize: 14 }}><summary style={{ cursor: 'pointer' }}>{r.label} · {naira(r.total)} · {r.paid} paid{r.failed ? `, ${r.failed} failed` : ''} <small style={{ color: 'var(--slate-400)' }}>{new Date(r.createdAt).toLocaleDateString('en-NG')}</small></summary>{(r.items || []).map((i, n) => <div key={n} style={{ fontSize: 13, color: i.ok ? 'var(--slate-400)' : 'var(--red-500)' }}>{i.ok ? '✅' : '❌'} {i.name} · {naira(i.amount)} · {i.to}</div>)}</details>)}</div>}
        </>
      )}
      <PinConfirm open={pin} summary={`Pay ${d?.staff.length} staff a total of ${naira(d?.total || 0)}${d?.staff.some((s) => s.payTo === 'BANK') ? ' (plus bank fees)' : ''}`}
        onSubmit={async (auth) => { const r = await runPayroll({ label, ...auth }); setPin(false); setResult(r); setMsg(''); load(); }}
        onError={(e) => setErr(e.message)} onClose={() => setPin(false)} />
      <BottomNav />
    </div>
  );
}
