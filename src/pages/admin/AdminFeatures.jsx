import { useEffect, useState } from 'react';
import AdminLayout from '../../components/AdminLayout';
import { getAdminFeatures, switchAdminFeature, saveFeaturesConfig, resolveSafeDeal } from '../../api';

const RISK = { low: ['Low risk', 'var(--green-500)'], medium: ['Needs care', 'var(--gold)'], high: ['Licence may be needed', 'var(--red-500)'] };
const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG')}`;
const btn = { width: 'auto', padding: '5px 12px', fontSize: 13 };

export default function AdminFeatures() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [warn, setWarn] = useState(null);
  const [ok, setOk] = useState(false);
  const load = () => getAdminFeatures().then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  async function flip(f, on, acknowledged) {
    setErr(''); setMsg('');
    try {
      const r = await switchAdminFeature(f.key, { on, acknowledged });
      setD((x) => ({ ...x, features: r.features }));
      setMsg(`${f.name} is now ${on ? 'ON' : 'OFF'}.`);
      setWarn(null);
    } catch (e) { setErr(e.message); }
  }
  function toggle(f) {
    if (f.on) { if (window.confirm(`Turn ${f.name} OFF? Customers won’t be able to start new ones. Anything already running finishes normally.`)) flip(f, false); return; }
    if (f.warning) { setOk(false); setWarn(f); return; }
    flip(f, true, false);
  }
  async function cfg(patch) {
    setErr(''); setMsg('');
    try { await saveFeaturesConfig(patch); setMsg('Saved.'); load(); } catch (e) { setErr(e.message); }
  }
  const num = (label, key, val, w = 110) => <label style={{ display: 'grid', gap: 2, fontSize: 13 }}>{label}<input type="number" defaultValue={val} onBlur={(e) => Number(e.target.value) !== Number(val) && cfg({ [key]: Number(e.target.value) })} style={{ width: w }} /></label>;

  return (
    <AdminLayout>
      <h1 style={{ marginTop: 0 }}>🧩 New features</h1>
      <p style={{ color: 'var(--slate-400)', fontSize: 14, marginTop: -6 }}>Every feature starts OFF. Ones that need care or a licence show a warning you must accept before switching on. Test each one with small amounts first.</p>
      {err && <p className="error-text">{err}</p>}
      {msg && <p style={{ color: 'var(--green-500)', fontSize: 14 }}>{msg}</p>}
      {!d ? <p>Loading…</p> : (
        <>
          <div style={{ display: 'grid', gap: 10 }}>
            {d.features.map((f) => {
              const [rl, rc] = RISK[f.risk] || RISK.low;
              return (
                <div key={f.key} className="card" style={{ margin: 0, border: f.on ? '1px solid var(--green-500)' : undefined }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                    <div><b style={{ fontSize: 16 }}>{f.emoji} {f.name}</b> <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, border: `1px solid ${rc}`, color: rc, whiteSpace: 'nowrap' }}>{f.warning ? '⚠ ' : ''}{rl}</span></div>
                    <button type="button" role="switch" aria-checked={f.on} aria-label={`${f.name} ${f.on ? 'on' : 'off'}`} onClick={() => toggle(f)} style={{ width: 52, height: 28, borderRadius: 999, border: 'none', cursor: 'pointer', background: f.on ? 'var(--green-500)' : 'var(--slate-700, #475569)', position: 'relative', flexShrink: 0 }}>
                      <span style={{ position: 'absolute', top: 3, left: f.on ? 27 : 3, width: 22, height: 22, borderRadius: '50%', background: '#fff', transition: 'left .15s' }} />
                    </button>
                  </div>
                  <p style={{ fontSize: 13, color: 'var(--slate-400)', margin: '6px 0 0' }}>{f.about}</p>
                  <div style={{ fontSize: 12, marginTop: 4, color: f.on ? 'var(--green-500)' : 'var(--slate-400)' }}>{f.on ? 'ON for customers' : 'OFF'}</div>
                </div>
              );
            })}
          </div>

          <div className="card" style={{ margin: '16px 0' }}>
            <b>🛡️ SafeBuy settings</b>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
              {num('Fee (%)', 'safeBuyFeePercent', d.safeBuy.feePercent)}
              {num('Fee cap (₦, 0 = none)', 'safeBuyFeeCap', d.safeBuy.feeCap, 150)}
              {num('Auto-release after (days)', 'safeBuyAutoReleaseDays', d.safeBuy.autoReleaseDays, 150)}
            </div>
            <b style={{ display: 'block', marginTop: 14 }}>Deals holding money ({d.safeBuy.deals.length})</b>
            {d.safeBuy.deals.length === 0 && <p style={{ fontSize: 13, color: 'var(--slate-400)' }}>None right now.</p>}
            {[...d.safeBuy.deals].sort((a, b) => (a.status === 'DISPUTED' ? -1 : 0) - (b.status === 'DISPUTED' ? -1 : 0)).map((x) => (
              <div key={x.code} style={{ padding: '8px 0', borderTop: '1px solid var(--slate-800)', fontSize: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><b>{x.title}</b><span>{naira(x.amount)}</span></div>
                <small style={{ color: x.status === 'DISPUTED' ? 'var(--red-500)' : 'var(--slate-400)' }}>{x.status} · seller {x.seller?.name} ({x.seller?.phone}) · buyer {x.buyer?.name || '—'} ({x.buyer?.phone || '—'})</small>
                {x.sentNote && <div style={{ fontSize: 13 }}>📦 {x.sentNote}</div>}
                {x.disputeReason && <div style={{ fontSize: 13, color: 'var(--red-500)' }}>Problem: {x.disputeReason}</div>}
                {x.status === 'DISPUTED' && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <button type="button" className="btn" style={btn} onClick={() => { const note = window.prompt('Note for both sides (optional):', ''); if (note !== null && window.confirm(`Pay ${naira(x.amount)} (minus fee) to the SELLER?`)) resolveSafeDeal(x.code, { outcome: 'RELEASE', note }).then(() => { setMsg('Released to the seller.'); load(); }).catch((e) => setErr(e.message)); }}>Pay seller</button>
                    <button type="button" className="btn btn-secondary" style={btn} onClick={() => { const note = window.prompt('Note for both sides (optional):', ''); if (note !== null && window.confirm(`Refund ${naira(x.amount)} to the BUYER?`)) resolveSafeDeal(x.code, { outcome: 'REFUND', note }).then(() => { setMsg('Refunded to the buyer.'); load(); }).catch((e) => setErr(e.message)); }}>Refund buyer</button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="card" style={{ margin: '0 0 16px' }}>
            <b>🎁 Daily rewards settings</b>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
              {num('7-day streak reward (₦)', 'dailyStreakReward', d.daily.streakReward, 150)}
              {num('Quiz reward (₦)', 'dailyQuizReward', d.daily.quizReward)}
              {num('Daily budget, all customers (₦)', 'dailyRewardsBudget', d.daily.budget, 180)}
            </div>
            <p style={{ fontSize: 12, color: 'var(--slate-400)', marginBottom: 0 }}>When the day’s budget is used up, check-ins and answers still count but pay nothing until tomorrow.</p>
          </div>
        </>
      )}

      {warn && (
        <div role="dialog" aria-modal="true" aria-label={`Warning: ${warn.name}`} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 1000 }}>
          <div className="card" style={{ maxWidth: 480, width: '100%', margin: 0, border: `2px solid ${(RISK[warn.risk] || RISK.medium)[1]}` }}>
            <h2 style={{ marginTop: 0 }}>⚠ Before you turn on {warn.emoji} {warn.name}</h2>
            <p style={{ fontSize: 14, lineHeight: 1.5 }}>{warn.warning}</p>
            {warn.risk === 'high' && <p style={{ fontSize: 13, color: 'var(--red-500)', fontWeight: 600 }}>Speak to a Nigerian fintech lawyer (and, if needed, a licensed escrow partner) before switching this on for real customers.</p>}
            <label style={{ display: 'flex', gap: 8, fontSize: 14, alignItems: 'flex-start', margin: '12px 0' }}><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} style={{ width: 'auto', marginTop: 3 }} /> I have read this and I understand. I take responsibility for turning it on.</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn" disabled={!ok} onClick={() => flip(warn, true, true)}>Turn on</button>
              <button type="button" className="btn btn-secondary" onClick={() => setWarn(null)}>Keep it off</button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
