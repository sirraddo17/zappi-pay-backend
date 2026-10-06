import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Navigate, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAdminAuth } from '../context/AdminAuthContext';
import InstallAppButton from './InstallAppButton';
import AdminAlertsToggle from './AdminAlertsToggle';
import { getMonnifyOverview } from '../api';

// Remembered while the admin app is open so every page doesn't re-ask.
let monnifyModeCache = null;

const TABS = [
  { to: '/admin', label: 'Overview', end: true },
  { to: '/admin/money', label: '💰 Money check' },
  { to: '/admin/assistant', label: '✨ AI Assistant' },
  { to: '/admin/pending-funding', label: 'Pending Funding' },
  { to: '/admin/airtime-cash', label: 'Airtime to Cash' },
  { to: '/admin/bank-transfers', label: 'Bank Transfers' },
  { to: '/admin/customers', label: 'Customers' },
  { to: '/admin/staff', label: 'Staff' },
  { to: '/admin/orders', label: 'Orders' },
  { to: '/admin/support', label: 'Support' },
  { to: '/admin/escalations', label: '✅ Approvals' },
  { to: '/admin/broadcasts', label: 'Broadcasts' },
  { to: '/admin/notices', label: 'Service Notices' },
  { to: '/admin/promos', label: 'Promo Codes' },
  { to: '/admin/challenges', label: 'Challenges' },
  { to: '/admin/contests', label: '🏆 Referral Contests' },
  { to: '/admin/ads', label: '📣 In-app Ads' },
  { to: '/admin/ad-studio', label: '🎨 Ad Studio' },
  { to: '/admin/circles', label: '🔄 Ajo Circles' },
  { to: '/admin/features', label: '🧩 New features' },
  { to: '/admin/feedback', label: '⭐ Feedback' },
  { to: '/admin/radar', label: '🔭 Radar' },
  { to: '/admin/security', label: '🛡️ Security' },
  { to: '/admin/settings', label: 'Settings' },
  { to: '/admin/audit-log', label: 'Audit Log' },
];

// What support staff (role SUPPORT) can open.
const SUPPORT_TABS = ['/admin/customers', '/admin/orders', '/admin/bank-transfers', '/admin/support', '/admin/escalations'];

export default function AdminLayout({ children }) {
  const { admin, logout, isOwner } = useAdminAuth();
  const { pathname } = useLocation();
  const tabs = isOwner ? TABS : TABS.filter((t) => SUPPORT_TABS.includes(t.to)).map((t) => (t.to === '/admin/escalations' ? { ...t, label: '✅ My requests' } : t));
  const allowed = isOwner || SUPPORT_TABS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const navigate = useNavigate();
  const mainRef = useRef(null);
  const [monnifyMode, setMonnifyMode] = useState(monnifyModeCache);

  useEffect(() => {
    if (monnifyModeCache !== null || !isOwner) return;
    getMonnifyOverview(true)
      .then((o) => {
        monnifyModeCache = o.mode || '';
        setMonnifyMode(monnifyModeCache);
      })
      .catch(() => {});
  }, []);

  // On phones the admin tables are shown as stacked cards (see
  // index.css); each cell needs its column name as data-label for
  // that. Filled in here for every table on every admin page, and kept
  // up to date as tables load or change.
  useEffect(() => {
    const root = mainRef.current;
    if (!root) return undefined;
    const label = () => {
      root.querySelectorAll('table').forEach((table) => {
        const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
        if (!heads.length) return;
        table.querySelectorAll('tbody tr').forEach((tr) => {
          [...tr.children].forEach((td, i) => {
            const l = heads[i] ?? '';
            if (td.getAttribute('data-label') !== l) td.setAttribute('data-label', l);
          });
        });
      });
    };
    label();
    const obs = new MutationObserver(label);
    obs.observe(root, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  // Keep the active tab visible in the swipeable mobile tab bar.
  useEffect(() => {
    document.querySelector('.admin-sidebar a.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, []);

  function handleLogout() {
    logout();
    navigate('/admin/login');
  }

  if (!isOwner && pathname === '/admin') return <Navigate to="/admin/support" replace />;

  return (
    <div className="admin-shell">
      <div className="admin-sidebar">
        <div className="admin-brand" style={{ padding: '0 20px 16px', fontWeight: 700 }}>ZAPPI PAY</div>
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            {t.label}
          </NavLink>
        ))}
        <div className="admin-account" style={{ padding: '16px 20px 0' }}>
          <div className="admin-name" style={{ color: 'var(--slate-400)', fontSize: 13, marginBottom: 8 }}>{admin?.name}{!isOwner && ' · Support staff'}</div>
          {isOwner && <AdminAlertsToggle />}
          <InstallAppButton admin label="Install admin app" style={{ marginBottom: 8, fontSize: 13 }} />
          <button className="btn-secondary btn" onClick={handleLogout}>Log Out</button>
        </div>
      </div>
      <div className="admin-main" ref={mainRef}>
        {isOwner && monnifyMode === 'sandbox' && (
          <div style={{ background: 'rgba(249,115,22,0.12)', border: '1px solid var(--orange, #f97316)', color: 'var(--orange, #f97316)', borderRadius: 10, padding: '8px 12px', marginBottom: 16, fontSize: 13 }}>
            <strong>Test mode:</strong> Monnify is on Sandbox. Bank-transfer funding and Send to Bank use test money — nothing real moves.{' '}
            <Link to="/admin/settings" style={{ color: 'inherit', textDecoration: 'underline' }}>Settings → Monnify</Link>
          </div>
        )}
        {allowed ? children : (
          <div className="card" style={{ margin: 0, maxWidth: 520 }}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>Not available for support staff</h2>
            <p style={{ color: 'var(--slate-400)' }}>This part of the admin app is for owners. You can help customers from Customers, Orders and Support, and send anything sensitive for approval.</p>
            <NavLink to="/admin/support" className="btn" style={{ display: 'inline-block', width: 'auto', textDecoration: 'none' }}>Go to Support</NavLink>
          </div>
        )}
      </div>
    </div>
  );
}
