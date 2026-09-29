import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AdminLayout from '../../components/AdminLayout';
import { getAdminAds, createAd, updateAd, deleteAd, adImageUrl } from '../../api';

const PLACEMENTS = [
  { value: 'HOME', label: 'Home screen — top slider' },
  { value: 'BOTTOM', label: 'Home screen — bottom slider' },
  { value: 'POPUP', label: 'Pop-up (once per customer)' },
  { value: 'BOTH', label: 'Top slider + pop-up' },
];

// Shrinks a picture to at most 1200px wide as a JPEG so it loads fast
// on mobile data (and fits the database).
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, 1200 / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      let q = 0.85;
      let data = c.toDataURL('image/jpeg', q);
      while (data.length > 900 * 1024 && q > 0.4) {
        q -= 0.1;
        data = c.toDataURL('image/jpeg', q);
      }
      resolve(data);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that picture.')); };
    img.src = url;
  });
}

function toLocalInput(d) {
  if (!d) return '';
  const x = new Date(d);
  return new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function AdForm({ initial, onSaved, onCancel }) {
  const [title, setTitle] = useState(initial?.title || '');
  const [body, setBody] = useState(initial?.body || '');
  const [linkUrl, setLinkUrl] = useState(initial?.linkUrl || '');
  const [buttonText, setButtonText] = useState(initial?.buttonText || '');
  const [placement, setPlacement] = useState(initial?.placement || 'HOME');
  const [startsAt, setStartsAt] = useState(toLocalInput(initial?.startsAt));
  const [endsAt, setEndsAt] = useState(toLocalInput(initial?.endsAt));
  const [image, setImage] = useState(undefined); // undefined = unchanged, null = removed
  const [preview, setPreview] = useState(initial?.hasImage ? adImageUrl(initial) : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function pick(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setError('');
    try {
      const data = await compressImage(f);
      setImage(data);
      setPreview(data);
    } catch (err) {
      setError(err.message);
    }
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const data = {
      title, body, linkUrl, buttonText, placement,
      startsAt: startsAt ? new Date(startsAt).toISOString() : null,
      endsAt: endsAt ? new Date(endsAt).toISOString() : null,
      ...(image !== undefined ? { image } : {}),
    };
    try {
      if (initial) await updateAd(initial.id, data);
      else await createAd({ ...data, active: true });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" style={{ margin: '0 0 16px', maxWidth: 560 }} onSubmit={submit}>
      <h2 style={{ marginTop: 0, fontSize: 17 }}>{initial ? 'Edit advert' : 'New advert'}</h2>
      {error && <p className="error-text">{error}</p>}
      <div className="field">
        <label htmlFor="adimg">Picture (best: wide, 2:1, e.g. 1200 × 600)</label>
        {preview && <img src={preview} alt="" style={{ display: 'block', width: '100%', aspectRatio: '2 / 1', objectFit: 'cover', borderRadius: 12, marginBottom: 8 }} />}
        <input id="adimg" type="file" accept="image/jpeg,image/png,image/webp" onChange={pick} />
        {preview && <button type="button" onClick={() => { setImage(null); setPreview(null); }} style={{ background: 'none', border: 'none', color: 'var(--red-500)', cursor: 'pointer', padding: 0, fontSize: 13, marginTop: 4 }}>Remove picture</button>}
        <small style={{ display: 'block', color: 'var(--slate-400)' }}>No picture? The title and text show on a purple card instead. Until you add bottom-slider adverts, the bottom slider shows built-in tips (Refer & Earn, Airtime to Cash, Bulk, QR pay).</small>
      </div>
      <div className="field"><label htmlFor="adt">Title</label><input id="adt" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. ZAPPI PAY is now on Play Store!" /></div>
      <div className="field"><label htmlFor="adb">Text (optional)</label><input id="adb" maxLength={300} value={body} onChange={(e) => setBody(e.target.value)} placeholder="e.g. Download the app for faster access" /></div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: '2 1 240px' }}>
          <label htmlFor="adl">Link when tapped (optional)</label>
          <input id="adl" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="/buy/data  or  https://play.google.com/…" />
        </div>
        <div className="field" style={{ flex: '1 1 140px' }}><label htmlFor="adbt">Button text</label><input id="adbt" maxLength={30} value={buttonText} onChange={(e) => setButtonText(e.target.value)} placeholder="Download now" /></div>
      </div>
      <div className="field">
        <label htmlFor="adp">Show as</label>
        <select id="adp" value={placement} onChange={(e) => setPlacement(e.target.value)}>
          {PLACEMENTS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: '1 1 200px' }}><label htmlFor="ads">Show from (optional)</label><input id="ads" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} /></div>
        <div className="field" style={{ flex: '1 1 200px' }}><label htmlFor="ade">Until (optional)</label><input id="ade" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} /></div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn" type="submit" style={{ width: 'auto' }} disabled={busy || !title.trim()}>{busy ? 'Saving…' : 'Save advert'}</button>
        <button className="btn btn-secondary" type="button" style={{ width: 'auto' }} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export default function AdminAds() {
  const [ads, setAds] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | ad

  function load() {
    getAdminAds().then((d) => setAds(d.ads)).catch((err) => setError(err.message));
  }
  useEffect(load, []);

  async function toggle(ad) {
    await updateAd(ad.id, { active: !ad.active }).catch((err) => setError(err.message));
    load();
  }
  async function remove(ad) {
    if (!window.confirm(`Delete "${ad.title}"?`)) return;
    await deleteAd(ad.id).catch((err) => setError(err.message));
    load();
  }

  const now = Date.now();
  return (
    <AdminLayout>
      <div className="page-header" style={{ padding: 0, marginBottom: 16, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1>In-app Ads</h1>
          <p>Pictures and announcements on the customers' home screen — new services, Play Store launch, promos. No picture yet? Make one in <Link to="/admin/ad-studio" style={{ color: 'var(--purple)' }}>🎨 Ad Studio</Link>.</p>
        </div>
        {!editing && <button className="btn" style={{ width: 'auto' }} onClick={() => setEditing('new')}>+ New advert</button>}
      </div>
      {error && <p className="error-text">{error}</p>}
      {editing && <AdForm initial={editing === 'new' ? null : editing} onSaved={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} />}

      {ads === null ? <p className="empty-state">Loading…</p> : ads.length === 0 ? (!editing && <p className="empty-state">No adverts yet.</p>) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
          {ads.map((ad) => {
            const live = ad.active && (!ad.startsAt || new Date(ad.startsAt).getTime() <= now) && (!ad.endsAt || new Date(ad.endsAt).getTime() > now);
            return (
              <div key={ad.id} className="card" style={{ margin: 0, padding: 0, overflow: 'hidden', opacity: live ? 1 : 0.6 }}>
                {ad.hasImage ? <img src={adImageUrl(ad)} alt="" style={{ display: 'block', width: '100%', aspectRatio: '2 / 1', objectFit: 'cover' }} /> : <div style={{ aspectRatio: '2 / 1', background: 'linear-gradient(135deg, #863bff, #5b1fc4)', padding: 12, color: '#fff', fontWeight: 700 }}>{ad.title}</div>}
                <div style={{ padding: 12 }}>
                  <b>{ad.title}</b>
                  <div style={{ fontSize: 12, color: live ? 'var(--green-500)' : 'var(--slate-400)' }}>
                    {live ? 'Showing now' : !ad.active ? 'Off' : 'Scheduled / ended'} · {PLACEMENTS.find((p) => p.value === ad.placement)?.label} · {ad.clicks} tap{ad.clicks === 1 ? '' : 's'}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                    <button className="btn btn-secondary" style={{ width: 'auto', padding: '4px 10px', fontSize: 12 }} onClick={() => setEditing(ad)}>Edit</button>
                    <button className="btn btn-secondary" style={{ width: 'auto', padding: '4px 10px', fontSize: 12 }} onClick={() => toggle(ad)}>{ad.active ? 'Turn off' : 'Turn on'}</button>
                    <button className="btn btn-secondary" style={{ width: 'auto', padding: '4px 10px', fontSize: 12 }} onClick={() => remove(ad)}>Delete</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </AdminLayout>
  );
}
