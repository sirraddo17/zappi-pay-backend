import { lazy as reactLazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AdminAuthProvider, useAdminAuth } from './context/AdminAuthContext';

import Login from './pages/Login';
import Signup from './pages/Signup';
import Dashboard from './pages/Dashboard';
import Buy from './pages/Buy';
import Wallet from './pages/Wallet';
import Orders from './pages/Orders';
import HelpAssistant from './components/HelpAssistant';
import ServerWaking from './components/ServerWaking';
import Landing from './pages/Landing';
import { getQuickLogin } from './lib/quickLogin';

// Screens used less often load only when opened, so the app starts faster.
// If a screen's file is missing because a newer version was published
// while the app was open, reload once to pick up the new version.
function lazy(load) {
  return reactLazy(() =>
    load().catch((error) => {
      const key = 'zappipay_chunk_reload';
      let reloaded = false;
      try { reloaded = sessionStorage.getItem(key) === '1'; sessionStorage.setItem(key, '1'); } catch { /* ignore */ }
      if (!reloaded) {
        window.location.reload();
        return new Promise(() => {});
      }
      throw error;
    }).then((mod) => {
      try { sessionStorage.removeItem('zappipay_chunk_reload'); } catch { /* ignore */ }
      return mod;
    })
  );
}

const Statement = lazy(() => import('./pages/Statement'));
const Bulk = lazy(() => import('./pages/Bulk'));
const OrderDetail = lazy(() => import('./pages/OrderDetail'));
const Notifications = lazy(() => import('./pages/Notifications'));
const Legal = lazy(() => import('./pages/Legal'));
const DeleteAccountInfo = lazy(() => import('./pages/DeleteAccountInfo'));
const Transfer = lazy(() => import('./pages/Transfer'));
const PayLink = lazy(() => import('./pages/PayLink'));
const Profile = lazy(() => import('./pages/Profile'));
const AirtimeCash = lazy(() => import('./pages/AirtimeCash'));
const ChangePassword = lazy(() => import('./pages/ChangePassword'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const Security = lazy(() => import('./pages/Security'));
const Refer = lazy(() => import('./pages/Refer'));
const Saved = lazy(() => import('./pages/Saved'));
const AdminLogin = lazy(() => import('./pages/admin/AdminLogin'));
const AdminDashboard = lazy(() => import('./pages/admin/AdminDashboard'));
const AdminSettings = lazy(() => import('./pages/admin/AdminSettings'));
const AdminCustomers = lazy(() => import('./pages/admin/AdminCustomers'));
const AdminCustomerDetail = lazy(() => import('./pages/admin/AdminCustomerDetail'));
const AdminPendingFunding = lazy(() => import('./pages/admin/AdminPendingFunding'));
const AdminOrders = lazy(() => import('./pages/admin/AdminOrders'));
const AdminSupport = lazy(() => import('./pages/admin/AdminSupport'));
const AdminAuditLog = lazy(() => import('./pages/admin/AdminAuditLog'));
const AdminStaff = lazy(() => import('./pages/admin/AdminStaff'));
const AdminBroadcasts = lazy(() => import('./pages/admin/AdminBroadcasts'));
const AdminAirtimeCash = lazy(() => import('./pages/admin/AdminAirtimeCash'));
const AdminBankTransfers = lazy(() => import('./pages/admin/AdminBankTransfers'));
const AdminPromos = lazy(() => import('./pages/admin/AdminPromos'));
const AdminAssistant = lazy(() => import('./pages/admin/AdminAssistant'));
const AdminNotices = lazy(() => import('./pages/admin/AdminNotices'));
const AdminContests = lazy(() => import('./pages/admin/AdminContests'));
const AdminAds = lazy(() => import('./pages/admin/AdminAds'));
const AdminAdStudio = lazy(() => import('./pages/admin/AdminAdStudio'));
const AdminFeedback = lazy(() => import('./pages/admin/AdminFeedback'));


function RequireCustomer({ children }) {
  const { customer, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="page-loading">Loading…</div>;
  if (!customer) return <Navigate to="/login" replace />;
  // After support issues a temporary password, nothing else in the
  // app is reachable until the customer sets their own.
  if (customer.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  return children;
}

// zappipay.com.ng/ — the dashboard for logged-in customers, the PIN
// screen for returning customers with quick login, and the public
// landing page for everyone else.
function Home() {
  const { customer, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="page-loading">Loading…</div>;
  if (customer) return <RequireCustomer><Dashboard /></RequireCustomer>;
  if (getQuickLogin()) return <Navigate to="/login" replace />;
  return <Landing key={location.search} />;
}

function RequireAdmin({ children }) {
  const { admin } = useAdminAuth();
  if (!admin) return <Navigate to="/admin/login" replace />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <AdminAuthProvider>
        <Suspense fallback={<div className="page-loading">Loading…</div>}>
        <Routes>
          {/* Customer */}
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/change-password" element={<RequireCustomer><ChangePassword /></RequireCustomer>} />
          <Route path="/" element={<Home />} />
          <Route path="/welcome" element={<Landing />} />
          <Route path="/security" element={<RequireCustomer><Security /></RequireCustomer>} />
          <Route path="/refer" element={<RequireCustomer><Refer /></RequireCustomer>} />
          <Route path="/saved" element={<RequireCustomer><Saved /></RequireCustomer>} />
          <Route path="/buy/:service" element={<RequireCustomer><Buy /></RequireCustomer>} />
          <Route path="/wallet" element={<RequireCustomer><Wallet /></RequireCustomer>} />
          <Route path="/statement" element={<RequireCustomer><Statement /></RequireCustomer>} />
          <Route path="/bulk" element={<RequireCustomer><Bulk /></RequireCustomer>} />
          <Route path="/orders" element={<RequireCustomer><Orders /></RequireCustomer>} />
          <Route path="/orders/:id" element={<RequireCustomer><OrderDetail /></RequireCustomer>} />
          <Route path="/notifications" element={<RequireCustomer><Notifications /></RequireCustomer>} />
          <Route path="/legal/:doc" element={<Legal />} />
          <Route path="/delete-account" element={<DeleteAccountInfo />} />
          <Route path="/transfer" element={<RequireCustomer><Transfer /></RequireCustomer>} />
          <Route path="/pay/:username" element={<PayLink />} />
          <Route path="/profile" element={<RequireCustomer><Profile /></RequireCustomer>} />
          <Route path="/airtime-cash" element={<RequireCustomer><AirtimeCash /></RequireCustomer>} />

          {/* Admin */}
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route path="/admin" element={<RequireAdmin><AdminDashboard /></RequireAdmin>} />
          <Route path="/admin/settings" element={<RequireAdmin><AdminSettings /></RequireAdmin>} />
          <Route path="/admin/customers" element={<RequireAdmin><AdminCustomers /></RequireAdmin>} />
          <Route path="/admin/customers/:id" element={<RequireAdmin><AdminCustomerDetail /></RequireAdmin>} />
          <Route path="/admin/pending-funding" element={<RequireAdmin><AdminPendingFunding /></RequireAdmin>} />
          <Route path="/admin/orders" element={<RequireAdmin><AdminOrders /></RequireAdmin>} />
          <Route path="/admin/support" element={<RequireAdmin><AdminSupport /></RequireAdmin>} />
          <Route path="/admin/audit-log" element={<RequireAdmin><AdminAuditLog /></RequireAdmin>} />
          <Route path="/admin/staff" element={<RequireAdmin><AdminStaff /></RequireAdmin>} />
          <Route path="/admin/broadcasts" element={<RequireAdmin><AdminBroadcasts /></RequireAdmin>} />
          <Route path="/admin/airtime-cash" element={<RequireAdmin><AdminAirtimeCash /></RequireAdmin>} />
          <Route path="/admin/bank-transfers" element={<RequireAdmin><AdminBankTransfers /></RequireAdmin>} />
          <Route path="/admin/promos" element={<RequireAdmin><AdminPromos /></RequireAdmin>} />
          <Route path="/admin/assistant" element={<RequireAdmin><AdminAssistant /></RequireAdmin>} />
          <Route path="/admin/contests" element={<RequireAdmin><AdminContests /></RequireAdmin>} />
          <Route path="/admin/ads" element={<RequireAdmin><AdminAds /></RequireAdmin>} />
          <Route path="/admin/ad-studio" element={<RequireAdmin><AdminAdStudio /></RequireAdmin>} />
          <Route path="/admin/feedback" element={<RequireAdmin><AdminFeedback /></RequireAdmin>} />
          <Route path="/admin/notices" element={<RequireAdmin><AdminNotices /></RequireAdmin>} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
        <HelpAssistant />
        <ServerWaking />
      </AdminAuthProvider>
    </AuthProvider>
  );
}
