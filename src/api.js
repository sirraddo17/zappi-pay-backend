const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

// Render's free tier puts the backend to sleep when idle, and the first
// request then takes up to a minute. trackedFetch tells the UI (via
// window events) when a request is slow so it can say "Connecting…"
// instead of looking frozen. wakeServer() is fired on app start so the
// server starts waking while the person is still reading/typing.
let slowCount = 0;
function trackedFetch(url, options) {
  let slow = false;
  const timer = setTimeout(() => {
    slow = true;
    slowCount += 1;
    window.dispatchEvent(new CustomEvent('zp-server-slow', { detail: slowCount }));
  }, 3000);
  const done = () => {
    clearTimeout(timer);
    if (slow) {
      slowCount -= 1;
      window.dispatchEvent(new CustomEvent('zp-server-slow', { detail: slowCount }));
    }
  };
  return fetch(url, options).then(
    (res) => {
      done();
      // A 502/503/504 that isn't our own JSON error means the server
      // itself is down (host outage, suspended service), not a normal
      // app error — tell the UI so it can explain calmly.
      const isJson = (res.headers.get('content-type') || '').includes('json');
      if ([502, 503, 504].includes(res.status) && !isJson) {
        window.dispatchEvent(new CustomEvent('zp-server-down'));
        throw new Error('ZappiPay is temporarily unavailable. Your money is safe — please try again in a few minutes.');
      }
      window.dispatchEvent(new CustomEvent('zp-server-up'));
      return res;
    },
    (err) => {
      done();
      window.dispatchEvent(new CustomEvent('zp-server-down'));
      throw new Error(navigator.onLine === false
        ? 'You appear to be offline. Check your internet connection and try again.'
        : 'Could not reach ZappiPay. Please check your connection and try again.');
    }
  );
}

export function wakeServer() {
  fetch(`${API_URL}/api/health`, { cache: 'no-store' }).catch(() => {});
}

async function handleResponse(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Customer and admin sessions are kept under separate localStorage keys
// so a staff member can be logged into the admin panel and a customer
// account in the same browser without one logging the other out.
export class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function handleCustomerResponse(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, data.code, res.status);
  return data;
}

function deviceToken() {
  try {
    return JSON.parse(localStorage.getItem('zappipay_quick_login') || 'null')?.deviceToken || null;
  } catch {
    return null;
  }
}

export function request(path, options = {}) {
  const token = localStorage.getItem('zappipay_customer_token');
  const device = deviceToken();
  return trackedFetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(device ? { 'X-Device-Token': device } : {}),
      ...options.headers,
    },
  }).then(handleCustomerResponse);
}

export function adminRequest(path, options = {}) {
  const token = localStorage.getItem('zappipay_admin_token');
  return trackedFetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  }).then(handleResponse);
}

// --- Customer auth ---
export const signup = (data) => request('/api/auth/signup', { method: 'POST', body: JSON.stringify(data) });
export const login = (data) => request('/api/auth/login', { method: 'POST', body: JSON.stringify(data) });
export const getMe = () => request('/api/auth/me');
export const updateMe = (data) => request('/api/auth/me', { method: 'PATCH', body: JSON.stringify(data) });
export const changePassword = (data) => request('/api/auth/password', { method: 'PATCH', body: JSON.stringify(data) });
export const forgotPassword = (data) => request('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify(data) });
export const resetPassword = (data) => request('/api/auth/reset-password', { method: 'POST', body: JSON.stringify(data) });

// --- Security: PIN, quick login, fingerprint / Face ID ---
export const getSecurityStatus = () => request('/api/security/status');
export const setPin = (data) => request('/api/security/pin', { method: 'POST', body: JSON.stringify(data) });
export const trustThisDevice = (data) => request('/api/security/devices', { method: 'POST', body: JSON.stringify(data) });
export const untrustThisDevice = () => request('/api/security/devices/current', { method: 'DELETE' });
export const untrustOtherDevices = () => request('/api/security/devices', { method: 'DELETE' });
export const biometricRegisterOptions = (compat = false) => request('/api/security/webauthn/register-options', { method: 'POST', body: JSON.stringify({ compat }) });
export const biometricRegisterVerify = (response) => request('/api/security/webauthn/register-verify', { method: 'POST', body: JSON.stringify({ response }) });
export const removeBiometric = () => request('/api/security/webauthn', { method: 'DELETE' });
export const biometricTxOptions = () => request('/api/security/webauthn/tx-options', { method: 'POST' });
export const quickLoginPin = (data) => request('/api/auth/quick/pin', { method: 'POST', body: JSON.stringify(data) });
export const quickLoginBiometricOptions = (data) => request('/api/auth/quick/biometric-options', { method: 'POST', body: JSON.stringify(data) });
export const quickLoginBiometric = (data) => request('/api/auth/quick/biometric', { method: 'POST', body: JSON.stringify(data) });

// --- Saved beneficiaries & scheduled top-ups ---
export const getBeneficiaries = (service) => request(`/api/beneficiaries${service ? `?service=${encodeURIComponent(service)}` : ''}`);
export const saveBeneficiary = (data) => request('/api/beneficiaries', { method: 'POST', body: JSON.stringify(data) });
export const renameBeneficiary = (id, nickname) => request(`/api/beneficiaries/${id}`, { method: 'PATCH', body: JSON.stringify({ nickname }) });
export const deleteBeneficiary = (id) => request(`/api/beneficiaries/${id}`, { method: 'DELETE' });
export const getSchedules = () => request('/api/schedules');
export const updateSchedule = (id, data) => request(`/api/schedules/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteSchedule = (id) => request(`/api/schedules/${id}`, { method: 'DELETE' });

// --- Referrals ---
export const getReferralInfo = (code) => request(`/api/referrals/info${code ? `?code=${encodeURIComponent(code)}` : ''}`);
export const getMyReferrals = () => request('/api/referrals');

// --- Wallet ---
export const getWalletBalance = () => request('/api/wallet/balance');
export const getWalletTransactions = () => request('/api/wallet/transactions');
export const submitFundRequest = (data) => request('/api/wallet/fund-request', { method: 'POST', body: JSON.stringify(data) });
export const getBankAccount = () => request('/api/wallet/bank-account');
export const createBankAccount = (data) => request('/api/wallet/bank-account', { method: 'POST', body: JSON.stringify(data) });
export const checkBankPayments = () => request('/api/wallet/bank-account/check', { method: 'POST' });

// --- VTpass ---
export const getVtpassCategories = () => request('/api/vtpass/categories');
export const getVtpassServices = (identifier) => request(`/api/vtpass/services?identifier=${encodeURIComponent(identifier)}`);
export const getVtpassVariations = (serviceID) => request(`/api/vtpass/variations?serviceID=${encodeURIComponent(serviceID)}`);
export const verifyBillersCode = (serviceID, billersCode, type) =>
  request(`/api/vtpass/verify?serviceID=${encodeURIComponent(serviceID)}&billersCode=${encodeURIComponent(billersCode)}${type ? `&type=${type}` : ''}`);
export const getPricing = () => request('/api/pricing');
export const purchase = (data) => request('/api/vtpass/purchase', { method: 'POST', body: JSON.stringify(data) });
export const getOrders = () => request('/api/orders');
export const getOrder = (id) => request(`/api/orders/${id}`);

// --- Support ---
export const getSupportTickets = () => request('/api/support/tickets');
export const submitSupportTicket = (data) => request('/api/support/tickets', { method: 'POST', body: JSON.stringify(data) });
export const getAdminSupportTickets = () => adminRequest('/api/admin/support/tickets');
export const resolveSupportTicket = (id) => adminRequest(`/api/admin/support/tickets/${id}/resolve`, { method: 'PATCH' });
export const replySupportTicket = (id, data) => adminRequest(`/api/admin/support/tickets/${id}/reply`, { method: 'POST', body: JSON.stringify(data) });

// --- Notifications ---
export const getNotifications = () => request('/api/notifications');
export const markNotificationRead = (id) => request(`/api/notifications/${id}/read`, { method: 'PATCH' });
export const markAllNotificationsRead = () => request('/api/notifications/read-all', { method: 'PATCH' });

// --- Broadcasts ---
export const getActiveBroadcasts = () => request('/api/broadcasts/active');
export const getAdminBroadcasts = () => adminRequest('/api/admin/broadcasts');
export const createBroadcast = (data) => adminRequest('/api/admin/broadcasts', { method: 'POST', body: JSON.stringify(data) });
export const endBroadcast = (id) => adminRequest(`/api/admin/broadcasts/${id}/end`, { method: 'PATCH' });

// --- Airtime to Cash ---
export const getAirtimeCashConfig = () => request('/api/airtime-cash/config');
export const getMyAirtimeCashRequests = () => request('/api/airtime-cash/requests');
export const submitAirtimeCashRequest = (data) => request('/api/airtime-cash/requests', { method: 'POST', body: JSON.stringify(data) });
export const getAdminAirtimeCash = (status) => adminRequest(`/api/admin/airtime-cash?status=${encodeURIComponent(status)}`);
export const approveAirtimeCash = (id, data) => adminRequest(`/api/admin/airtime-cash/${id}/approve`, { method: 'POST', body: JSON.stringify(data || {}) });
export const rejectAirtimeCash = (id, reason) => adminRequest(`/api/admin/airtime-cash/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });

// --- Transfers ---
export const lookupRecipient = (identifier) => request(`/api/wallet/lookup?identifier=${encodeURIComponent(identifier)}`);
export const sendTransfer = (data) => request('/api/wallet/transfer', { method: 'POST', body: JSON.stringify(data) });

// --- Admin auth ---
export const adminLogin = (data) => adminRequest('/api/admin/login', { method: 'POST', body: JSON.stringify(data) });
export const changeAdminPassword = (data) => adminRequest('/api/admin/password', { method: 'PATCH', body: JSON.stringify(data) });

// --- Admin: settings ---
export const getSettings = () => adminRequest('/api/admin/settings');
export const updateSettings = (data) => adminRequest('/api/admin/settings', { method: 'PATCH', body: JSON.stringify(data) });

// --- Admin: customers ---
export const getCustomers = () => adminRequest('/api/admin/customers');
export const getCustomerDetail = (id) => adminRequest(`/api/admin/customers/${id}`);
export const adminResetCustomerPassword = (id) => adminRequest(`/api/admin/customers/${id}/reset-password`, { method: 'POST' });
export const setCustomerActive = (id, active) =>
  adminRequest(`/api/admin/customers/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) });

// --- Admin: wallet approvals ---
export const getPendingFunding = () => adminRequest('/api/admin/wallet/pending');
export const approveFunding = (id) => adminRequest(`/api/admin/wallet/${id}/approve`, { method: 'POST' });
export const rejectFunding = (id) => adminRequest(`/api/admin/wallet/${id}/reject`, { method: 'POST' });

// --- Admin: orders & audit log ---
export const getAdminOrders = () => adminRequest('/api/admin/orders');
export const getAuditLog = () => adminRequest('/api/admin/audit-log');

// --- Admin: manual wallet adjustments ---
export const adjustWallet = (customerId, data) =>
  adminRequest(`/api/admin/customers/${customerId}/adjust-wallet`, { method: 'POST', body: JSON.stringify(data) });

// --- Admin: staff management ---
export const getAdmins = () => adminRequest('/api/admin/admins');
export const createAdmin = (data) => adminRequest('/api/admin/admins', { method: 'POST', body: JSON.stringify(data) });
export const setAdminActive = (id, active) => adminRequest(`/api/admin/admins/${id}/active`, { method: 'PATCH', body: JSON.stringify({ active }) });
export const resetAdminPassword = (id, newPassword) => adminRequest(`/api/admin/admins/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword }) });
