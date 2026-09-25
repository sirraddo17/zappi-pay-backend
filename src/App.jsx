import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AdminAuthProvider, useAdminAuth } from './context/AdminAuthContext';

import Login from './pages/Login';
import Signup from './pages/Signup';
import Dashboard from './pages/Dashboard';
import Buy from './pages/Buy';
import Wallet from './pages/Wallet';
import Statement from './pages/Statement';
import Bulk from './pages/Bulk';
import Orders from './pages/Orders';
import OrderDetail from './pages/OrderDetail';
import Notifications from './pages/Notifications';
import Legal from './pages/Legal';
import DeleteAccountInfo from './pages/DeleteAccountInfo';
import Transfer from './pages/Transfer';
import Profile from './pages/Profile';
import AirtimeCash from './pages/AirtimeCash';
import HelpAssistant from './components/HelpAssistant';
import ServerWaking from './components/ServerWaking';
import ChangePassword from './pages/ChangePassword';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Landing from './pages/Landing';
import Security from './pages/Security';
import Refer from './pages/Refer';
import Saved from './pages/Saved';
import { getQuickLogin } from './lib/quickLogin';

import AdminLogin from './pages/admin/AdminLogin';
import AdminDashboard from './pages/admin/AdminDashboard';
import AdminSettings from './pages/admin/AdminSettings';
import AdminCustomers from './pages/admin/AdminCustomers';
import AdminCustomerDetail from './pages/admin/AdminCustomerDetail';
import AdminPendingFunding from './pages/admin/AdminPendingFunding';
import AdminOrders from './pages/admin/AdminOrders';
import AdminSupport from './pages/admin/AdminSupport';
import AdminAuditLog from './pages/admin/AdminAuditLog';
import AdminStaff from './pages/admin/AdminStaff';
import AdminBroadcasts from './pages/admin/AdminBroadcasts';
import AdminAirtimeCash from './pages/admin/AdminAirtimeCash';
import AdminBankTransfers from './pages/admin/AdminBankTransfers';
import AdminPromos from './pages/admin/AdminPromos';
import AdminNotices from './pages/admin/AdminNotices';

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
          <Route path="/admin/notices" element={<RequireAdmin><AdminNotices /></RequireAdmin>} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <HelpAssistant />
        <ServerWaking />
      </AdminAuthProvider>
    </AuthProvider>
  );
}
