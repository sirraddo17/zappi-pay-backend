import { useRef, useState } from 'react';
import { compressImage } from '../lib/imageTools';

// "Add screenshot" for support messages: camera or gallery, up to `max`
// pictures, shrunk on the phone before upload. value = data: URIs.
export default function ImageAttach({ value, onChange, max = 3, label = '📎 Add screenshot / photo' }) {
  const input = useRef(null);
  const [error, setError] = useState('');

  async function pick(e) {
    setError('');
    const files = [...(e.target.files || [])].slice(0, max - value.length);
    e.target.value = '';
    try {
      const out = [];
      for (const f of files) out.push(await compressImage(f));
      onChange([...value, ...out].slice(0, max));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div style={{ marginTop: 8 }}>
      {value.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
          {value.map((src, i) => (
            <div key={i} style={{ position: 'relative' }}>
              <img src={src} alt={`Attachment ${i + 1}`} style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--slate-700)' }} />
              <button type="button" aria-label="Remove picture" onClick={() => onChange(value.filter((_, j) => j !== i))} style={{ position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: '50%', border: 'none', background: 'var(--red-500, #ef4444)', color: '#fff', cursor: 'pointer', fontSize: 13, lineHeight: '22px', padding: 0 }}>×</button>
            </div>
          ))}
        </div>
      )}
      {value.length < max && (
        <button type="button" onClick={() => input.current?.click()} style={{ background: 'none', border: '1px dashed var(--slate-600, #475569)', color: 'var(--slate-300, #cbd5e1)', borderRadius: 8, padding: '6px 10px', cursor: 'pointer', fontSize: 13 }}>
          {label}{value.length ? ` (${value.length}/${max})` : ''}
        </button>
      )}
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={pick} />
      {error && <div className="error-text" style={{ fontSize: 12, marginTop: 4 }}>{error}</div>}
    </div>
  );
}
