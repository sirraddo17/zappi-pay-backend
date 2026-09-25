import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getVtpassServices, getVtpassVariations, getPricing, startBulkPurchase, getBulkJob } from '../api';
import PinConfirm from '../components/PinConfirm';
import BottomNav from '../components/BottomNav';

const MAX = 50;
const naira = (n) => `₦${Number(n || 0).toLocaleString()}`;

// Same price formula as the Buy page (display only; the server
// recomputes it for every number).
function priceFor(base, service, pricing) {
  const markup = Number(pricing?.markupPercentByService?.[service] || 0);
  const discountPct = Math.min(100, Math.max(0, Number(pricing?.discountPercentByService?.[service] || 0)));
  const markedUp = Math.round(Number(base || 0) * (1 + markup / 100));
  return Math.max(0, markedUp - Math.round(markedUp * (discountPct / 100)));
}

function parsePhones(text) {
  const out = [];
  const bad = [];
  // One number per line or comma; spaces inside a number are fine
  // ("0803 123 4567"). A line with several numbers split by spaces also works.
  const entries = [];
  for (const chunk of text.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean)) {
    const digits = chunk.replace(/\D/g, '');
    if (/^(0\d{10}|234\d{10})$/.test(digits)) entries.push(chunk);
    else entries.push(...chunk.split(/\s+/));
  }
  for (const p of entries.filter(Boolean)) {
    let n = p.replace(/\D/g, '');
    if (n.startsWith('234') && n.length === 13) n = `0${n.slice(3)}`;
    if (/^0\d{10}$/.test(n)) {
      if (!out.includes(n)) out.push(n);
    } else bad.push(p);
  }
  return { phones: out, bad };
}

const STATUS = {
  waiting: ['Waiting', 'var(--slate-400)'],
  success: ['Sent', 'var(--green-500)'],
  pending: ['Processing', 'var(--orange, #f97316)'],
  failed: ['Failed · refunded', 'var(--red-500)'],
  skipped: ['Not bought', 'var(--slate-400)'],
};

// Send airtime or the same data plan to many numbers at once.
export default function Bulk() {
  const { customer, refreshCustomer } = useAuth();
  const [service, setService] = useState('AIRTIME');
  const [providers, setProviders] = useState([]);
  const [providerId, setProviderId] = useState('');
  const [plans, setPlans] = useState([]);
  const [plan, setPlan] = useState('');
  const [amount, setAmount] = useState('');
  const [text, setText] = useState('');
  const [pricing, setPricing] = useState(null);
  const [error, setError] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [job, setJob] = useState(null);
  const poll = useRef(null);

  useEffect(() => {
    getPricing().then(setPricing).catch(() => {});
    return () => clearInterval(poll.current);
  }, []);

  useEffect(() => {
    setProviders([]);
    setProviderId('');
    setPlans([]);
    setPlan('');
    getVtpassServices(service === 'AIRTIME' ? 'airtime' : 'data')
      .then((d) => setProviders(Array.isArray(d.content) ? d.content : []))
      .catch((e) => setError(e.message));
  }, [service]);

  useEffect(() => {
    setPlans([]);
    setPlan('');
    if (service !== 'DATA' || !providerId) return;
    getVtpassVariations(providerId)
      .then((d) => setPlans(d.content?.varations || d.content?.variations || []))
      .catch((e) => setError(e.message));
  }, [providerId, service]);

  const { phones, bad } = parsePhones(text);
  const selectedPlan = plans.find((p) => p.variation_code === plan);
  const base = service === 'AIRTIME' ? Number(amount || 0) : Number(selectedPlan?.variation_amount || 0);
  const each = priceFor(base, service, pricing);
  const total = each * phones.length;
  const balance = Number(customer?.walletBalance || 0);

  function review(e) {
    e.preventDefault();
    setError('');
    if (!providerId) return setError('Choose a network.');
    if (!base) return setError(service === 'AIRTIME' ? 'Enter an amount.' : 'Choose a data plan.');
    if (bad.length) return setError(`Fix these numbers first: ${bad.slice(0, 5).join(', ')}`);
    if (!phones.length) return setError('Add at least one phone number.');
    if (phones.length > MAX) return setError(`You can send to up to ${MAX} numbers at once.`);
    if (total > balance) return setError(`You need ${naira(total)} but your wallet has ${naira(balance)}. Fund your wallet first.`);
    setConfirmOpen(true);
  }

  async function start(auth) {
    const r = await startBulkPurchase({ service, serviceID: providerId, variationCode: service === 'DATA' ? plan : undefined, amount: service === 'AIRTIME' ? Number(amount) : undefined, phones, ...auth });
    setConfirmOpen(false);
    setJob({ id: r.jobId, total: r.total, done: 0, status: 'running', results: phones.map((phone) => ({ phone, status: 'waiting' })) });
    clearInterval(poll.current);
    poll.current = setInterval(async () => {
      try {
        const j = await getBulkJob(r.jobId);
        setJob(j);
        if (j.status !== 'running') {
          clearInterval(poll.current);
          refreshCustomer?.();
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
  }

  if (job) {
    const ok = job.results.filter((x) => x.status === 'success').length;
    return (
      <div className="app-shell">
        <div className="page-header">
          <h1>Bulk {service === 'AIRTIME' ? 'airtime' : 'data'}</h1>
          <p>{job.status === 'running' ? `Sending… ${job.done} of ${job.total}` : `Done: ${ok} of ${job.total} sent`}</p>
        </div>
        <div className="card" style={{ margin: '0 16px 12px' }}>
          <div style={{ height: 8, background: 'var(--slate-700)', borderRadius: 999, overflow: 'hidden', marginBottom: 12 }}>
            <div style={{ width: `${(job.done / job.total) * 100}%`, height: '100%', background: 'var(--purple)', transition: 'width .3s' }} />
          </div>
          {job.results.map((x) => (
            <div key={x.phone} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 14 }}>
              <span>{x.phone}</span>
              <span style={{ color: STATUS[x.status]?.[1] }}>{STATUS[x.status]?.[0] || x.status}{x.error && x.status === 'failed' ? ` — ${x.error}` : ''}</span>
            </div>
          ))}
          {job.status === 'stopped' && <p className="error-text" style={{ marginBottom: 0 }}>Stopped early (wallet balance or daily limit). Numbers marked "Not bought" were not charged.</p>}
        </div>
        {job.status !== 'running' && (
          <div style={{ display: 'flex', gap: 8, margin: '0 16px 90px' }}>
            <Link to="/orders" className="btn" style={{ textAlign: 'center', textDecoration: 'none' }}>View in Orders</Link>
            <button type="button" className="btn btn-secondary" onClick={() => { setJob(null); setText(''); }}>Send another</button>
          </div>
        )}
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="page-header">
        <Link to="/" style={{ color: 'var(--purple)', textDecoration: 'none', fontSize: 14 }}>&larr; Back</Link>
        <h1>Bulk airtime &amp; data</h1>
        <p>Send to many numbers on one network at once</p>
      </div>
      {error && <p className="error-text" style={{ margin: '0 16px 12px' }}>{error}</p>}
      <form className="card" style={{ margin: '0 16px 90px' }} onSubmit={review}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          {['AIRTIME', 'DATA'].map((s) => (
            <button key={s} type="button" className={service === s ? 'btn' : 'btn btn-secondary'} onClick={() => setService(s)}>
              {s === 'AIRTIME' ? 'Airtime' : 'Data'}
            </button>
          ))}
        </div>
        <div className="field">
          <label htmlFor="bnet">Network (all numbers must be on it)</label>
          <select id="bnet" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">Select…</option>
            {providers.map((p) => <option key={p.serviceID} value={p.serviceID}>{p.name}</option>)}
          </select>
        </div>
        {service === 'AIRTIME' ? (
          <div className="field">
            <label htmlFor="bamt">Amount per number (₦)</label>
            <input id="bamt" type="number" min="50" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
        ) : (
          <div className="field">
            <label htmlFor="bplan">Data plan for every number</label>
            <select id="bplan" value={plan} onChange={(e) => setPlan(e.target.value)} disabled={!providerId}>
              <option value="">{providerId ? 'Select a plan…' : 'Choose a network first'}</option>
              {plans.map((p) => <option key={p.variation_code} value={p.variation_code}>{p.name} — {naira(priceFor(p.variation_amount, 'DATA', pricing))}</option>)}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="bphones">Phone numbers (one per line, or separated by commas)</label>
          <textarea id="bphones" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={'08031234567\n08129876543'} style={{ width: '100%', boxSizing: 'border-box' }} />
          <small style={{ color: bad.length ? 'var(--red-500)' : 'var(--slate-400)' }}>
            {phones.length} number{phones.length === 1 ? '' : 's'}{bad.length ? ` · ${bad.length} not valid: ${bad.slice(0, 3).join(', ')}` : ''} · up to {MAX}
          </small>
        </div>
        {each > 0 && phones.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, margin: '0 0 12px' }}>
            <span>{phones.length} × {naira(each)}</span>
            <span>Total {naira(total)}</span>
          </div>
        )}
        <button className="btn" type="submit">Review &amp; pay</button>
      </form>

      <PinConfirm
        open={confirmOpen}
        summary={`Send ${service === 'AIRTIME' ? naira(each) + ' airtime' : selectedPlan?.name || 'data'} to ${phones.length} numbers. Total ${naira(total)}.`}
        onSubmit={start}
        onError={(err) => setError(err.message || 'Could not start.')}
        onClose={() => setConfirmOpen(false)}
      />
      <BottomNav />
    </div>
  );
}
