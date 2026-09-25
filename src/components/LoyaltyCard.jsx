import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { getLoyalty, redeemLoyalty } from '../api';

// Points balance + redeem, shown on the home screen when loyalty is on.
export default function LoyaltyCard() {
  const { refreshCustomer } = useAuth();
  const [info, setInfo] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    getLoyalty().then(setInfo).catch(() => setInfo(null));
  }
  useEffect(load, []);

  if (!info?.enabled) return null;
  const canRedeem = info.points >= info.minRedeem;

  async function redeem() {
    setBusy(true);
    setMsg('');
    try {
      const r = await redeemLoyalty();
      setMsg(`₦${Number(r.credit).toLocaleString()} added to your wallet.`);
      load();
      refreshCustomer?.();
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
      <div>
        <div style={{ fontSize: 12, color: 'var(--slate-400)' }}>ZappiPay points</div>
        <div style={{ fontSize: 20, fontWeight: 700 }}>
          ⭐ {info.points.toLocaleString()} <span style={{ fontSize: 13, color: 'var(--slate-400)', fontWeight: 400 }}>= ₦{Number(info.worth).toLocaleString()}</span>
        </div>
        <div style={{ fontSize: 12, color: msg ? 'var(--green-500)' : 'var(--slate-400)' }}>
          {msg || (canRedeem ? 'Ready to redeem' : `Earn ${info.pointsPer100} per ₦100 spent · redeem from ${info.minRedeem} points`)}
        </div>
      </div>
      <button type="button" className={canRedeem ? 'btn' : 'btn btn-secondary'} style={{ width: 'auto', padding: '8px 14px' }} disabled={!canRedeem || busy} onClick={redeem}>
        {busy ? '…' : 'Redeem'}
      </button>
    </div>
  );
}
