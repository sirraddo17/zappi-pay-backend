import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getSafeDeals, createSafeDeal, viewSafeDeal, safeDealAction } from '../../api';
import PinConfirm from '../../components/PinConfirm';
import BottomNav from '../../components/BottomNav';
import { clearAfterLogin } from '../../lib/afterLogin';
import { naira } from '../../components/circles/shared';

const back = (to, label) => <Link to={to} style={{ color: 'var(--purple)', textDecoration: 'none', fontSize: 14 }}>← {label}</Link>;
const STATUS = {
  AWAITING_PAYMENT: ['Waiting for the buyer to pay', 'var(--gold)'],
  PAID: ['Paid — money is held safely', 'var(--purple)'],
  SENT: ['Sent — waiting for the buyer to confirm', 'var(--purple)'],
  COMPLETED: ['✅ Completed — seller paid', 'var(--green-500)'],
  REFUNDED: ['Refunded to the buyer', 'var(--slate-400)'],
  DISPUTED: ['⚠ Problem reported — ZAPPI PAY is checking', 'var(--red-500)'],
  CANCELLED: ['Cancelled', 'var(--slate-400)'],
};
const STEPS = ['Buyer pays — money is held, not sent to the seller', 'Seller sends the item', 'Buyer confirms “I’ve received it” — seller gets paid'];

export default function SafeBuy() {
  const navigate = useNavigate();
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: '', amount: '', description: '' });
  const [err, setErr] = useState('');
  useEffect(() => { getSafeDeals().then((d) => setList(d.deals)).catch((e) => setErr(e.message)); }, []);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <div className="app-shell" style={{ paddingBottom: 90 }}>
      <div className="page-header">{back('/more', 'Back')}<h1>🛡️ SafeBuy</h1><p>Buying or selling on WhatsApp, Instagram or Facebook? The buyer’s money is held until they confirm they got the item. No more “I sent it, they blocked me”.</p></div>
      {err && <p className="error-text" style={{ margin: '0 16px' }}>{err}</p>}
      <div className="card"><b>How it works</b><ol style={{ fontSize: 14, margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>{STEPS.map((s) => <li key={s}>{s}</li>)}</ol></div>
      {!open ? <div style={{ margin: '0 16px 12px' }}><button type="button" className="btn" onClick={() => setOpen(true)}>＋ I’m selling — create a SafeBuy link</button></div> : (
        <form className="card" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { const r = await createSafeDeal(f); navigate(`/safebuy/${r.deal.code}`); } catch (e2) { setErr(e2.message); } }}>
          <b>What are you selling?</b>
          <div className="field" style={{ marginTop: 8 }}><label htmlFor="sT">Item</label><input id="sT" value={f.title} onChange={set('title')} maxLength={80} placeholder="e.g. iPhone 12, 128GB, blue" required /></div>
          <div className="field"><label htmlFor="sA">Price (₦)</label><input id="sA" type="number" min="500" max="2000000" value={f.amount} onChange={set('amount')} required /></div>
          <div className="field"><label htmlFor="sD">Details (condition, delivery)</label><textarea id="sD" rows={3} maxLength={600} value={f.description} onChange={set('description')} style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'inherit' }} /></div>
          <p style={{ fontSize: 12, color: 'var(--slate-400)' }}>A small SafeBuy fee is taken from what you receive. You’ll see it on the next screen.</p>
          <button className="btn" type="submit">Create link</button>
        </form>
      )}
      <div className="card">
        <b>My deals</b>
        {!list ? <p className="empty-state">Loading…</p> : list.length === 0 ? <p style={{ fontSize: 14, color: 'var(--slate-400)' }}>No deals yet. A buyer? Ask the seller to send you a SafeBuy link.</p> : list.map((d) => <Link key={d.code} to={`/safebuy/${d.code}`} style={{ display: 'block', padding: '8px 0', borderTop: '1px solid var(--slate-800)', textDecoration: 'none', color: 'inherit', fontSize: 14 }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><b>{d.title}</b><span>{naira(d.amount)}</span></div><small style={{ color: (STATUS[d.status] || [])[1] }}>{d.role === 'SELLER' ? 'Selling' : 'Buying'} · {(STATUS[d.status] || [d.status])[0]}</small></Link>)}
      </div>
      <BottomNav />
    </div>
  );
}

export function SafeBuyDeal() {
  const { code } = useParams();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [pin, setPin] = useState(null);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState(false);
  const load = () => viewSafeDeal(code).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { clearAfterLogin(); load(); }, [code]);
  if (!d) return <div className="app-shell"><div className="page-header">{back('/safebuy', 'SafeBuy')}</div>{err ? <p className="error-text" style={{ margin: 16 }}>{err}</p> : <p className="empty-state">Loading…</p>}</div>;
  const x = d.deal;
  const [st, col] = STATUS[x.status] || [x.status, 'inherit'];
  const link = `${window.location.origin}/safebuy/${x.code}`;
  const act = (a, body, ok) => { setErr(''); return safeDealAction(code, a, body).then(() => { setMsg(ok); load(); }).catch((e) => setErr(e.message)); };
  const stepDone = { AWAITING_PAYMENT: 0, PAID: 1, SENT: 2, COMPLETED: 3 }[x.status] ?? -1;
  return (
    <div className="app-shell" style={{ paddingBottom: 90 }}>
      <div className="page-header">{back('/safebuy', 'SafeBuy')}<h1>🛡️ {x.title}</h1><p style={{ color: col }}>{st}</p></div>
      {err && <p className="error-text" style={{ margin: '0 16px' }}>{err}</p>}
      {msg && <p style={{ color: 'var(--green-500)', margin: '0 16px', fontSize: 14 }}>{msg}</p>}
      <div className="card">
        <div style={{ fontSize: 28, fontWeight: 800 }}>{naira(x.amount)}</div>
        {x.description && <p style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{x.description}</p>}
        <div style={{ fontSize: 14, padding: '8px 0', borderTop: '1px solid var(--slate-800)' }}>
          Seller: <b>{d.seller.name}</b>{d.seller.username ? ` (@${d.seller.username})` : ''} {d.seller.verified ? <span style={{ color: 'var(--green-500)' }}>✓ verified</span> : <span style={{ color: 'var(--gold)' }}>not verified</span>}
          <br /><small style={{ color: 'var(--slate-400)' }}>On ZAPPI PAY since {new Date(d.seller.since).toLocaleDateString('en-NG', { month: 'short', year: 'numeric' })} · {d.seller.completedDeals} completed SafeBuy deal{d.seller.completedDeals === 1 ? '' : 's'}</small>
          {d.buyer && <><br />Buyer: <b>{d.buyer}</b></>}
        </div>
        {d.role === 'SELLER' && <div style={{ fontSize: 13, color: 'var(--slate-400)' }}>You receive {naira(x.sellerGets)} (SafeBuy fee {naira(x.fee)}).</div>}
        {x.sentNote && <p style={{ fontSize: 14 }}>📦 Seller’s note: {x.sentNote}</p>}
        {x.status === 'SENT' && x.autoReleaseAt && <p style={{ fontSize: 13, color: 'var(--gold)' }}>If the buyer doesn’t confirm or report a problem, the money goes to the seller on {new Date(x.autoReleaseAt).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}.</p>}
        {x.disputeReason && <p style={{ fontSize: 14, color: 'var(--red-500)' }}>Problem reported: {x.disputeReason}</p>}
        {x.resolution && <p style={{ fontSize: 13, color: 'var(--slate-400)' }}>{x.resolution}</p>}
        <ol style={{ fontSize: 13, paddingLeft: 18, margin: '8px 0 0', lineHeight: 1.7 }}>{STEPS.map((s, i) => <li key={s} style={{ color: i < stepDone ? 'var(--green-500)' : 'inherit' }}>{i < stepDone ? '✓ ' : ''}{s}</li>)}</ol>
      </div>

      {d.role === 'VISITOR' && x.status === 'AWAITING_PAYMENT' && (
        <div className="card">
          <p style={{ fontSize: 14, margin: '0 0 8px' }}>When you pay, ZAPPI PAY holds the money. The seller only gets it after you confirm you received the item — or {d.autoReleaseDays} days after they mark it sent if you don’t report a problem.</p>
          <p style={{ fontSize: 12, color: 'var(--slate-400)' }}>Only pay if you’ve agreed the item and delivery with the seller. Check the item as soon as it arrives.</p>
          <button type="button" className="btn" onClick={() => setPin({ a: 'pay', s: `Pay ${naira(x.amount)} into SafeBuy for “${x.title}”`, ok: 'Paid ✓ — the money is held until you confirm.' })}>Pay {naira(x.amount)} safely</button>
        </div>
      )}
      {d.role === 'BUYER' && ['PAID', 'SENT'].includes(x.status) && (
        <div className="card">
          <button type="button" className="btn" onClick={() => setPin({ a: 'received', s: `Release ${naira(x.amount)} to ${d.seller.name} for “${x.title}”`, ok: 'Done ✓ — the seller has been paid. Thank you!' })}>✅ I’ve received it — pay the seller</button>
          <p style={{ fontSize: 12, color: 'var(--slate-400)' }}>Only tap this once you have the item and it’s what you agreed.</p>
          {!problem ? <button type="button" onClick={() => setProblem(true)} style={{ background: 'none', border: 'none', color: 'var(--red-500)', cursor: 'pointer', padding: 0, fontSize: 14 }}>⚠ Report a problem</button> : (
            <div style={{ marginTop: 8 }}>
              <textarea rows={3} maxLength={600} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What went wrong? (not received, wrong item, damaged…)" aria-label="Problem" style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'inherit' }} />
              <button type="button" className="btn btn-secondary" disabled={reason.trim().length < 10} onClick={() => act('dispute', { reason }, 'Reported. The money stays held while ZAPPI PAY checks.').then(() => setProblem(false))}>Send report</button>
            </div>
          )}
          {x.status === 'PAID' && Date.now() - new Date(x.paidAt) > 7 * 86400000 && <button type="button" className="btn btn-secondary" style={{ marginTop: 8 }} onClick={() => window.confirm('Cancel and get your money back?') && act('cancel', {}, 'Refunded ✓')}>Not sent after 7 days — cancel & refund</button>}
        </div>
      )}
      {d.role === 'SELLER' && (
        <div className="card">
          {x.status === 'AWAITING_PAYMENT' && (
            <>
              <b>Send this link to your buyer</b>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                <button type="button" className="btn" style={{ width: 'auto' }} onClick={() => navigator.clipboard?.writeText(link).then(() => setMsg('Link copied ✓'))}>Copy link</button>
                <a className="btn btn-secondary" style={{ width: 'auto', textDecoration: 'none' }} target="_blank" rel="noopener noreferrer" href={`https://wa.me/?text=${encodeURIComponent(`Pay for “${x.title}” (${naira(x.amount)}) with ZAPPI PAY SafeBuy 🛡️ — your money is held until you receive it: ${link}`)}`}>WhatsApp</a>
              </div>
              <button type="button" onClick={() => act('cancel', {}, 'Cancelled')} style={{ background: 'none', border: 'none', color: 'var(--red-500)', cursor: 'pointer', fontSize: 13, marginTop: 10, padding: 0 }}>Cancel deal</button>
            </>
          )}
          {x.status === 'PAID' && (
            <>
              <b>The buyer has paid 🎉 — send the item now</b>
              <div className="field" style={{ marginTop: 8 }}><label htmlFor="sN">Delivery note (rider, waybill number…)</label><input id="sN" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></div>
              <button type="button" className="btn" onClick={() => act('sent', { note }, 'Marked as sent ✓')}>📦 I’ve sent it</button>
              <button type="button" onClick={() => window.confirm('Cancel and refund the buyer?') && act('cancel', {}, 'Buyer refunded')} style={{ background: 'none', border: 'none', color: 'var(--red-500)', cursor: 'pointer', fontSize: 13, marginTop: 10, padding: 0 }}>Can’t deliver — refund the buyer</button>
            </>
          )}
          {x.status === 'SENT' && <p style={{ fontSize: 14, margin: 0 }}>Waiting for the buyer to confirm. You’ll be paid automatically.</p>}
          {x.status === 'DISPUTED' && <p style={{ fontSize: 14, margin: 0 }}>The buyer reported a problem. Reply through Help → Support with any proof (chat screenshots, waybill).</p>}
        </div>
      )}
      <p style={{ fontSize: 12, color: 'var(--slate-400)', margin: '0 16px' }}>SafeBuy holds the money and passes it on. ZAPPI PAY doesn’t sell or inspect items — always agree details with the seller first.</p>
      <PinConfirm open={Boolean(pin)} summary={pin?.s}
        onSubmit={async (auth) => { await safeDealAction(code, pin.a, auth); setMsg(pin.ok); setPin(null); load(); }}
        onError={(e) => setErr(e.message)} onClose={() => setPin(null)} />
      <BottomNav />
    </div>
  );
}
