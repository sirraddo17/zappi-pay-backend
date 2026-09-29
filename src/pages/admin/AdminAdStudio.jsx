import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AdminLayout from '../../components/AdminLayout';
import ImageAttach from '../../components/ImageAttach';
import { adminDesignAd, getAdminAiStatus, createAd } from '../../api';
import { FORMATS, THEMES, renderAd, recordAdVideo, videoSupported, loadPhoto } from '../../lib/adRender';
import { shareFile } from '../../lib/shareCard';

const BLANK = { headline: 'Data finish? No wahala', highlight: 'No wahala', subtext: 'Top up MTN, Airtel, Glo & 9mobile in seconds', cta: 'Buy data', badges: ['Instant', 'Auto refunds'], emoji: '📶', theme: 'purple', caption: 'Data finish? No wahala 😄 Top up any network in seconds with ZAPPI PAY. 👉 www.zappipay.com.ng #ZappiPay #BuyData', link: '/buy/data' };

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function Preview({ design, format, photo }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let alive = true;
    renderAd(design, format, photo, 'dataurl', 0.8).then((u) => alive && setSrc(u));
    return () => { alive = false; };
  }, [JSON.stringify(design), format, photo]);
  const { w, h } = FORMATS[format];
  return src ? <img src={src} alt={`${format} preview`} style={{ width: '100%', aspectRatio: `${w} / ${h}`, borderRadius: 12, display: 'block', background: 'var(--slate-900)' }} />
    : <div style={{ width: '100%', aspectRatio: `${w} / ${h}`, borderRadius: 12, background: 'var(--slate-900)' }} />;
}

// Describe an ad → the AI writes and designs it → download pictures and
// 3-second videos for social media, or put it straight into the app.
export default function AdminAdStudio() {
  const [ai, setAi] = useState(null);
  const [brief, setBrief] = useState('');
  const [designs, setDesigns] = useState([BLANK]);
  const [pick, setPick] = useState(0);
  const [photoData, setPhotoData] = useState([]);
  const [photo, setPhoto] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [video, setVideo] = useState(null);
  const [placement, setPlacement] = useState('HOME');

  useEffect(() => { getAdminAiStatus().then(setAi).catch(() => setAi({ adminEnabled: false })); }, []);
  useEffect(() => { loadPhoto(photoData[0]).then(setPhoto).catch(() => setPhoto(null)); }, [photoData[0]]);

  const d = designs[pick] || BLANK;
  const set = (k, v) => setDesigns((list) => list.map((x, i) => (i === pick ? { ...x, [k]: v } : x)));

  async function designWithAi() {
    setBusy('ai');
    setMsg(null);
    try {
      const r = await adminDesignAd(brief);
      setDesigns(r.designs);
      setPick(0);
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setBusy('');
    }
  }

  async function savePicture(format) {
    const blob = await renderAd(d, format, photo, 'image/png');
    download(blob, `zappipay-ad-${format}.png`);
  }

  async function makeVideo(format) {
    setBusy(`video-${format}`);
    setMsg(null);
    try {
      const { blob, ext } = await recordAdVideo(d, format, photo);
      if (video?.url) URL.revokeObjectURL(video.url);
      setVideo({ url: URL.createObjectURL(blob), blob, name: `zappipay-ad-${format}.${ext}`, format });
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setBusy('');
    }
  }

  async function useInApp() {
    setBusy('inapp');
    setMsg(null);
    try {
      const image = await renderAd(d, 'slider', photo, 'dataurl', 0.85);
      await createAd({ title: d.headline, body: d.subtext, buttonText: d.cta, linkUrl: d.link || '', placement, image, active: true });
      setMsg({ ok: true, text: 'Added to the app ✅ — manage it under In-app Ads.' });
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setBusy('');
    }
  }

  async function copyCaption() {
    await navigator.clipboard?.writeText(d.caption || '').catch(() => {});
    setMsg({ ok: true, text: 'Caption copied — paste it when you post.' });
  }

  const input = { width: '100%', boxSizing: 'border-box' };

  return (
    <AdminLayout>
      <div className="page-header" style={{ padding: 0, marginBottom: 16 }}>
        <h1>🎨 Ad Studio</h1>
        <p>Describe an ad — get ready-to-post pictures, 3-second videos and in-app banners in the ZAPPI PAY style</p>
      </div>

      <div className="card" style={{ margin: '0 0 16px', maxWidth: 860 }}>
        <label htmlFor="brief" style={{ fontWeight: 600 }}>What do you want to advertise?</label>
        <textarea id="brief" rows={3} maxLength={800} value={brief} onChange={(e) => setBrief(e.target.value)} style={{ ...input, fontFamily: 'inherit', marginTop: 6 }}
          placeholder="e.g. We're now on Play Store — tell people to download the app. Or: 5% cashback on data this weekend only." />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          {ai?.adminEnabled ? (
            <button type="button" className="btn" style={{ width: 'auto' }} disabled={busy === 'ai' || !brief.trim()} onClick={designWithAi}>
              {busy === 'ai' ? 'Designing…' : '✨ Design 3 options with AI'}
            </button>
          ) : (
            <span style={{ fontSize: 13, color: 'var(--slate-400)' }}>
              AI designs need the AI assistant on (<Link to="/admin/settings" style={{ color: 'var(--purple)' }}>Settings → AI Assistant</Link>). Meanwhile, edit the design below yourself.
            </span>
          )}
        </div>
        <ImageAttach value={photoData} onChange={setPhotoData} max={1} label="🖼️ Optional: add your own background photo" />
      </div>

      {msg && <p style={{ color: msg.ok ? 'var(--green-500)' : 'var(--red-500)', margin: '0 0 12px' }}>{msg.text}</p>}

      {designs.length > 1 && (
        <div className="admin-actions" style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          {designs.map((x, i) => (
            <button key={i} type="button" className={pick === i ? 'btn' : 'btn btn-secondary'} style={{ width: 'auto', padding: '6px 14px' }} onClick={() => setPick(i)}>Option {i + 1}: {x.headline.slice(0, 22)}</button>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, alignItems: 'start' }}>
        <div className="card" style={{ margin: 0 }}>
          <b>Edit the words</b>
          <div className="field" style={{ marginTop: 8 }}><label htmlFor="hd">Headline</label><input id="hd" maxLength={60} value={d.headline} onChange={(e) => set('headline', e.target.value)} style={input} /></div>
          <div className="field"><label htmlFor="hl">Words to colour gold</label><input id="hl" maxLength={30} value={d.highlight} onChange={(e) => set('highlight', e.target.value)} style={input} /></div>
          <div className="field"><label htmlFor="st">Subtext</label><input id="st" maxLength={120} value={d.subtext} onChange={(e) => set('subtext', e.target.value)} style={input} /></div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div className="field" style={{ flex: 2 }}><label htmlFor="ct">Button</label><input id="ct" maxLength={24} value={d.cta} onChange={(e) => set('cta', e.target.value)} style={input} /></div>
            <div className="field" style={{ flex: 1 }}><label htmlFor="em">Emoji</label><input id="em" maxLength={8} value={d.emoji} onChange={(e) => set('emoji', e.target.value)} style={input} /></div>
          </div>
          <div className="field"><label htmlFor="bd">Tags (comma separated)</label><input id="bd" value={(d.badges || []).join(', ')} onChange={(e) => set('badges', e.target.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 3))} style={input} /></div>
          <div className="field">
            <label>Colour</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {Object.entries(THEMES).map(([k, t]) => (
                <button key={k} type="button" aria-label={k} onClick={() => set('theme', k)} style={{ width: 34, height: 34, borderRadius: '50%', border: d.theme === k ? '3px solid #fff' : '2px solid transparent', background: `linear-gradient(135deg, ${t.stops[1]}, ${t.stops[3]})`, cursor: 'pointer' }} />
              ))}
            </div>
          </div>
          <div className="field"><label htmlFor="lk">In-app button link</label><input id="lk" value={d.link} onChange={(e) => set('link', e.target.value)} placeholder="/buy/data" style={input} /></div>
          <div className="field">
            <label htmlFor="cp">Social media caption</label>
            <textarea id="cp" rows={3} value={d.caption} onChange={(e) => set('caption', e.target.value)} style={{ ...input, fontFamily: 'inherit' }} />
            <button type="button" onClick={copyCaption} style={{ background: 'none', border: 'none', color: 'var(--purple)', cursor: 'pointer', padding: 0, fontSize: 13 }}>Copy caption</button>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 16 }}>
          {['square', 'story', 'slider'].map((f) => (
            <div key={f} className="card" style={{ margin: 0 }}>
              <b style={{ fontSize: 14 }}>{FORMATS[f].label}</b>
              <div style={{ maxWidth: f === 'story' ? 260 : '100%', margin: '8px 0' }}><Preview design={d} format={f} photo={photo} /></div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn" style={{ width: 'auto', padding: '6px 12px' }} onClick={() => savePicture(f)}>⬇ Picture</button>
                {videoSupported() && f !== 'slider' && (
                  <button type="button" className="btn btn-secondary" style={{ width: 'auto', padding: '6px 12px' }} disabled={Boolean(busy)} onClick={() => makeVideo(f)}>
                    {busy === `video-${f}` ? 'Recording 3s…' : '🎬 3-second video'}
                  </button>
                )}
                {f === 'slider' && (
                  <>
                    <select value={placement} onChange={(e) => setPlacement(e.target.value)} style={{ width: 'auto', fontSize: 13 }} aria-label="Where in the app">
                      <option value="HOME">Top slider</option>
                      <option value="BOTTOM">Bottom slider</option>
                      <option value="POPUP">Pop-up</option>
                    </select>
                    <button type="button" className="btn btn-secondary" style={{ width: 'auto', padding: '6px 12px' }} disabled={busy === 'inapp'} onClick={useInApp}>
                      {busy === 'inapp' ? 'Adding…' : '📲 Use in the app'}
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {video && (
        <div role="dialog" aria-label="Video" onClick={(e) => e.target === e.currentTarget && setVideo(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ width: `min(${video.format === 'story' ? 340 : 480}px, 100%)`, background: 'var(--slate-800)', borderRadius: 16, padding: 14 }}>
            <video src={video.url} autoPlay loop muted playsInline style={{ width: '100%', borderRadius: 10, display: 'block' }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button type="button" className="btn" onClick={() => shareFile(video.blob, video.name, d.caption)}>Share</button>
              <button type="button" className="btn btn-secondary" onClick={() => download(video.blob, video.name)}>Download</button>
              <button type="button" className="btn btn-secondary" onClick={() => setVideo(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
