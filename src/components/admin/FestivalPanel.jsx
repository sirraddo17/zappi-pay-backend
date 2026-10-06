import { useEffect, useState } from 'react';
import { getFestivals, updateSettings } from '../../api';
import { READY_ADS, CORE_ADS, FEATURE_ADS } from '../../lib/readyAds';

const GROUP = { christian: '✝️', muslim: '🌙', national: '🇳🇬', zappi: '💜' };
const fmt = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

// Ad Studio: festival greetings (worked out for every year) and ready-made
// ads for the newer services. "Open" loads one into the editor below.
export default function FestivalPanel({ onOpen, openId, onAi }) {
  const [data, setData] = useState(null);
  const [all, setAll] = useState(false);
  const [msg, setMsg] = useState('');
  useEffect(() => { getFestivals().then(setData).catch(() => setData({ festivals: [] })); }, []);
  useEffect(() => {
    const m = data?.milestones;
    const f = openId && (data?.festivals?.find((x) => x.id === openId) || m?.celebrated?.find((x) => x.id === openId) || (m?.preview?.id === openId ? m.preview : null));
    if (f) onOpen(f.design);
  }, [openId, data]);

  async function toggle(v) {
    try { await updateSettings({ festivalGreetingsEnabled: v }); setData((d) => ({ ...d, enabled: v })); setMsg(v ? 'On — the app shows the greeting by itself on the day.' : 'Off — no greeting slides or reminders.'); } catch (e) { setMsg(e.message); }
  }
  const list = (data?.festivals || []).slice(0, all ? 40 : 4);
  const btn = { width: 'auto', padding: '5px 12px', fontSize: 13 };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, margin: '0 0 16px' }}>
      <div className="card" style={{ margin: 0 }}>
        <b>🎉 Festival greetings & celebrations</b>
        <p style={{ fontSize: 12, color: 'var(--slate-400)', margin: '4px 0 8px' }}>Ready for Christmas, Easter, New Year, Ramadan, both Eids, Islamic New Year, Eid-el-Maulud, national days, ZAPPI PAY’s launch day & anniversary (17 Nov) and Customer Service Week. You get an alert a few days before; on the day the app shows the greeting slide by itself. Tap Open to download the pictures and copy the caption for social media.</p>
        {data && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginBottom: 8 }}>
            <input type="checkbox" checked={data.enabled !== false} onChange={(e) => toggle(e.target.checked)} style={{ width: 'auto' }} /> Show greetings in the app automatically + remind me
          </label>
        )}
        {msg && <p style={{ fontSize: 12, color: 'var(--green-500)', margin: '0 0 8px' }}>{msg}</p>}
        {onAi && openId && <button type="button" className="btn btn-secondary" style={{ ...btn, marginBottom: 8 }} onClick={onAi}>✨ Let the AI write 3 fresh versions of the open one</button>}
        {!data ? <p className="empty-state">Loading…</p> : list.map((f) => (
          <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderTop: '1px solid var(--slate-800)' }}>
            <span aria-hidden="true">{f.design?.emoji || GROUP[f.group]}</span>
            <div style={{ flex: 1, fontSize: 13 }}>
              <b>{f.name}</b>{f.live && <span style={{ color: 'var(--green-500)' }}> · showing in the app now</span>}
              <div style={{ color: 'var(--slate-400)', fontSize: 12 }}>{fmt(f.date)} · {f.daysAway <= 0 ? 'today' : f.daysAway === 1 ? 'tomorrow' : `in ${f.daysAway} days`}{f.moon ? ' · may move a day (moon sighting)' : ''}</div>
            </div>
            <button type="button" className={openId === f.id ? 'btn' : 'btn btn-secondary'} style={btn} onClick={() => onOpen(f.design, f.id)}>Open</button>
          </div>
        ))}
        {data?.milestones && (
          <div style={{ borderTop: '1px solid var(--slate-800)', marginTop: 8, paddingTop: 8 }}>
            <b style={{ fontSize: 14 }}>🎉 Verified-member milestones</b>
            <div style={{ fontSize: 12, color: 'var(--slate-400)', margin: '2px 0 6px' }}>
              {data.milestones.verified.toLocaleString()} verified members now{data.milestones.next ? ` · next: ${data.milestones.next.toLocaleString()} (${data.milestones.toGo.toLocaleString()} to go)` : ''}. When one is reached, every customer gets a thank-you message, the app shows a slide for 3 days, and you get an alert.
            </div>
            {data.milestones.celebrated.map((m) => (
              <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 13 }}>
                <span style={{ flex: 1 }}>🎉 <b>{m.value.toLocaleString()}</b> — {new Date(m.reachedAt).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })}{m.live && <span style={{ color: 'var(--green-500)' }}> · showing now</span>}</span>
                <button type="button" className={openId === m.id ? 'btn' : 'btn btn-secondary'} style={btn} onClick={() => onOpen(m.design, m.id)}>Open</button>
              </div>
            ))}
            {data.milestones.preview && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 13 }}>
                <span style={{ flex: 1, color: 'var(--slate-400)' }}>Next: {data.milestones.preview.value.toLocaleString()} (get the post ready early)</span>
                <button type="button" className="btn btn-secondary" style={btn} onClick={() => onOpen(data.milestones.preview.design, data.milestones.preview.id)}>Preview</button>
              </div>
            )}
          </div>
        )}
        {data?.festivals?.length > 4 && <button type="button" onClick={() => setAll(!all)} style={{ background: 'none', border: 'none', color: 'var(--purple)', cursor: 'pointer', padding: '6px 0 0', fontSize: 13 }}>{all ? 'Show less' : `Show the whole year (${data.festivals.length})`}</button>}
      </div>
      <div className="card" style={{ margin: 0 }}>
        <b>📣 Ready-made ads — every service</b>
        <p style={{ fontSize: 12, color: 'var(--slate-400)', margin: '4px 0 8px' }}>Open one, then download the pictures, copy the caption, or tap “Use in the app”.</p>
        <div style={{ fontSize: 12, color: 'var(--slate-400)', margin: '6px 0 4px' }}>🆕 New</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {READY_ADS.map((a) => <button key={a.key} type="button" className={openId === a.key ? 'btn' : 'btn btn-secondary'} style={btn} onClick={() => onOpen(a, a.key)}>{a.emoji} {a.name}</button>)}
        </div>
        <div style={{ fontSize: 12, color: 'var(--slate-400)', margin: '10px 0 4px' }}>🧩 New features — post only once switched on in Admin → New features</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {FEATURE_ADS.map((a) => <button key={a.key} type="button" className={openId === a.key ? 'btn' : 'btn btn-secondary'} style={btn} onClick={() => onOpen(a, a.key)}>{a.emoji} {a.name}</button>)}
        </div>
        <div style={{ fontSize: 12, color: 'var(--slate-400)', margin: '10px 0 4px' }}>Everyday services</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {CORE_ADS.map((a) => <button key={a.key} type="button" className={openId === a.key ? 'btn' : 'btn btn-secondary'} style={btn} onClick={() => onOpen(a, a.key)}>{a.emoji} {a.name}</button>)}
        </div>
      </div>
    </div>
  );
}
