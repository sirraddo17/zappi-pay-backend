const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

// Render's free tier puts the backend to sleep when idle, and the first
// request then takes up to a minute. trackedFetch tells the UI (via
// window events) when a request is slow so it can say "Connecting…"
// instead of looking frozen. wakeServer() is fired on app start so the
// server starts waking while the person is still reading/typing.
let slowCount = 0;
function trackedFetch(url, { quiet, ...options } = {}) {
  let slow = false;
  // quiet: requests that are slow by nature (AI answers) shouldn't
  // show the "Connecting…" banner.
  const timer = quiet ? null : setTimeout(() => {
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
  // Logged out from another device (Security → Where you're logged in).
  if (res.status === 401 && data.code === 'SESSION_ENDED' && localStorage.getItem('zappipay_customer_token')) {
    localStorage.removeItem('zappipay_customer_token');
    try { sessionStorage.setItem('zappipay_idle_customer', 'You were logged out on this device. Please log in again.'); } catch { /* ignore */ }
    if (!window.location.pathname.startsWith('/login')) window.location.replace('/login');
  }
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
  }).then(async (res) => {
    // Admin sessions last 12 hours — when one ends, go back to login.
    if (res.status === 401 && token) {
      const body = await res.clone().json().catch(() => ({}));
      if (body.code === 'ADMIN_SESSION_EXPIRED') {
        localStorage.removeItem('zappipay_admin_token');
        localStorage.removeItem('zappipay_admin');
        if (!window.location.pathname.startsWith('/admin/login')) window.location.assign('/admin/login?expired=1');
      }
    }
    return handleResponse(res);
  });
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
export const checkUsername = (username) => request(`/api/account/username/check?username=${encodeURIComponent(username)}`);
export const setMyUsername = (username) => request('/api/account/username', { method: 'POST', body: JSON.stringify({ username }) });

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
export const purchase = (data) => request('/api/vtpass/purchase', { method: 'POST', quiet: true, body: JSON.stringify(data) });
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
export const getBankTransferConfig = () => request('/api/wallet/bank-transfer/config');
export const getBanks = () => request('/api/banks');
export const lookupBankAccount = (bankCode, accountNumber) =>
  request(`/api/wallet/bank-transfer/lookup?bankCode=${encodeURIComponent(bankCode)}&accountNumber=${encodeURIComponent(accountNumber)}`);
export const sendBankTransfer = (data) => request('/api/wallet/bank-transfer', { method: 'POST', body: JSON.stringify(data) });
export const getBankTransfers = () => request('/api/wallet/bank-transfers');
export const getStatement = (from, to) => request(`/api/wallet/statement?from=${from}&to=${to}`);
export const getAppInfo = () => request('/api/app/info');
export const getAgentInfo = () => request('/api/agent/info');
export const getPushKey = () => request('/api/push/key');
export const subscribePush = (subscription) => request('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription }) });
export const unsubscribePush = (endpoint) => request('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) });
export const startBulkPurchase = (data) => request('/api/vtpass/bulk', { method: 'POST', body: JSON.stringify(data) });
export const getBulkJob = (id) => request(`/api/vtpass/bulk/${id}`);
export const getLoyalty = () => request('/api/loyalty');
export const redeemLoyalty = () => request('/api/loyalty/redeem', { method: 'POST' });
export const requestAgentAccount = (businessName, shopAddress) => request('/api/agent/request', { method: 'POST', body: JSON.stringify({ businessName, shopAddress }) });
export const getMyLimits = () => request('/api/account/limits');
export const updatePreferences = (data) => request('/api/account/preferences', { method: 'PATCH', body: JSON.stringify(data) });
export const requestAccountDeletion = (data) => request('/api/account/delete-request', { method: 'POST', body: JSON.stringify(data) });
export const cancelAccountDeletion = () => request('/api/account/delete-request', { method: 'DELETE' });
export const checkPromo = (code, service, amount, base, provider) =>
  request(`/api/promo/check?code=${encodeURIComponent(code)}&service=${encodeURIComponent(service)}&amount=${encodeURIComponent(amount)}${base ? `&base=${encodeURIComponent(base)}&provider=${encodeURIComponent(provider || '')}` : ''}`);
export const getAdminAnalytics = (days) => adminRequest(`/api/admin/analytics?days=${days}`);

// --- Admin auth ---
export const adminLogin = (data) => adminRequest('/api/admin/login', { method: 'POST', body: JSON.stringify(data) });
export const adminLoginVerify = (data) => adminRequest('/api/admin/login/verify', { method: 'POST', body: JSON.stringify(data) });
export const recheckAdminOrder = (id) => adminRequest(`/api/admin/orders/${id}/recheck`, { method: 'POST' });
export const settleAdminOrder = (id, outcome) => adminRequest(`/api/admin/orders/${id}/settle`, { method: 'POST', body: JSON.stringify({ outcome }) });
export const getVtpassBalance = () => adminRequest('/api/admin/vtpass/balance');
export const releaseBankTransfer = (id) => adminRequest(`/api/admin/bank-transfers/${id}/release`, { method: 'POST' });
export const sendTestDailySummary = () => adminRequest('/api/admin/daily-summary/test', { method: 'POST' });
export const sendPushBroadcast = (data) => adminRequest('/api/admin/push/broadcast', { method: 'POST', body: JSON.stringify(data) });
export const getPushStats = () => adminRequest('/api/admin/push/stats');
export const changeAdminPassword = (data) => adminRequest('/api/admin/password', { method: 'PATCH', body: JSON.stringify(data) });

// --- Admin: settings ---
export const getSettings = () => adminRequest('/api/admin/settings');
export const getAiStatus = () => request('/api/ai/status');
export const aiChat = (messages, images) => request('/api/ai/chat', { method: 'POST', quiet: true, body: JSON.stringify({ messages, images }) });
export const getAdminAiStatus = () => adminRequest('/api/admin/ai/status');
export const adminAiChat = (messages, images) => adminRequest('/api/admin/ai/chat', { method: 'POST', quiet: true, body: JSON.stringify({ messages, images }) });
export const adminAiDraftReply = (ticketId, instructions) => adminRequest('/api/admin/ai/draft-reply', { method: 'POST', quiet: true, body: JSON.stringify({ ticketId, instructions }) });
export const testAiConnection = (model) => adminRequest('/api/admin/ai/test', { method: 'POST', body: JSON.stringify({ model }) });
export const getAiUsage = () => adminRequest('/api/admin/ai/usage');
export const updateSettings = (data) => adminRequest('/api/admin/settings', { method: 'PATCH', body: JSON.stringify(data) });
export const testMonnifyConnection = () => adminRequest('/api/admin/monnify/test', { method: 'POST' });

// --- Admin: customers ---
export const getCustomers = () => adminRequest('/api/admin/customers');
export const getCustomerList = ({ view = 'active', q = '', all = false, page = 0 } = {}) => {
  const qs = new URLSearchParams({ view, page: String(page) });
  if (q) qs.set('q', q);
  if (all) qs.set('all', '1');
  return adminRequest(`/api/admin/customers/list?${qs}`);
};
export const adminSetUsername = (id, username) => adminRequest(`/api/admin/customers/${id}/username`, { method: 'POST', body: JSON.stringify({ username }) });
export const getCustomerDetail = (id) => adminRequest(`/api/admin/customers/${id}`);
export const adminResetCustomerPassword = (id) => adminRequest(`/api/admin/customers/${id}/reset-password`, { method: 'POST' });
export const setCustomerActive = (id, active) =>
  adminRequest(`/api/admin/customers/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) });

// --- Admin: wallet approvals ---
export const getPendingFunding = () => adminRequest('/api/admin/wallet/pending');
export const approveFunding = (id) => adminRequest(`/api/admin/wallet/${id}/approve`, { method: 'POST' });
export const rejectFunding = (id) => adminRequest(`/api/admin/wallet/${id}/reject`, { method: 'POST' });

// --- Admin: orders & audit log ---
// --- New features ---
const post = (url, data) => request(url, { method: 'POST', body: JSON.stringify(data || {}) });
export const getSprayEvents = () => request('/api/spray');
export const createSprayEvent = (d) => post('/api/spray', d);
export const getSprayLive = (code, since) => request(`/api/spray/${encodeURIComponent(code)}/live${since ? `?since=${encodeURIComponent(since)}` : ''}`);
export const startSpraySession = (code, d) => post(`/api/spray/${encodeURIComponent(code)}/session`, d);
export const sprayMoney = (code, d) => request(`/api/spray/${encodeURIComponent(code)}/gift`, { method: 'POST', quiet: true, body: JSON.stringify(d) });
export const closeSprayEvent = (code) => post(`/api/spray/${encodeURIComponent(code)}/close`);
export const getDuesGroups = () => request('/api/dues');
export const createDuesGroup = (d) => post('/api/dues', d);
export const previewDues = (code) => request(`/api/dues/join/${encodeURIComponent(code)}`);
export const joinDues = (code) => post(`/api/dues/join/${encodeURIComponent(code)}`);
export const getDuesGroup = (id, period) => request(`/api/dues/${encodeURIComponent(id)}${period ? `?period=${encodeURIComponent(period)}` : ''}`);
export const payDues = (id, d) => post(`/api/dues/${encodeURIComponent(id)}/pay`, d);
export const setDuesAutoPay = (id, d) => post(`/api/dues/${encodeURIComponent(id)}/autopay`, d);
export const remindDues = (id) => post(`/api/dues/${encodeURIComponent(id)}/remind`);
export const leaveDues = (id) => post(`/api/dues/${encodeURIComponent(id)}/leave`);
export const getPayForMes = () => request('/api/pay-for-me');
export const createPayForMe = (d) => post('/api/pay-for-me', d);
export const viewPayForMe = (t) => request(`/api/pay-for-me/${encodeURIComponent(t)}`);
export const payPayForMe = (t, d) => post(`/api/pay-for-me/${encodeURIComponent(t)}/pay`, d);
export const cancelPayForMe = (t) => post(`/api/pay-for-me/${encodeURIComponent(t)}/cancel`);
export const getLightPots = () => request('/api/shared-light');
export const createLightPot = (d) => post('/api/shared-light', d);
export const previewLightPot = (code) => request(`/api/shared-light/join/${encodeURIComponent(code)}`);
export const joinLightPot = (code) => post(`/api/shared-light/join/${encodeURIComponent(code)}`);
export const getLightPot = (id) => request(`/api/shared-light/${encodeURIComponent(id)}`);
export const payLightPot = (id, d) => post(`/api/shared-light/${encodeURIComponent(id)}/pay`, d);
export const buyLightNow = (id) => post(`/api/shared-light/${encodeURIComponent(id)}/buy`);
export const closeLightPot = (id) => post(`/api/shared-light/${encodeURIComponent(id)}/close`);
export const getSafeDeals = () => request('/api/safebuy');
export const createSafeDeal = (d) => post('/api/safebuy', d);
export const viewSafeDeal = (c) => request(`/api/safebuy/${encodeURIComponent(c)}`);
export const safeDealAction = (c, action, d) => post(`/api/safebuy/${encodeURIComponent(c)}/${action}`, d);
export const getPayroll = () => request('/api/payroll');
export const addPayrollStaff = (d) => post('/api/payroll/staff', d);
export const updatePayrollStaff = (id, d) => request(`/api/payroll/staff/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(d) });
export const runPayroll = (d) => post('/api/payroll/run', d);
export const getDailyRewards = () => request('/api/rewards/daily');
export const dailyCheckin = () => post('/api/rewards/daily/checkin');
export const dailyQuiz = (choice) => post('/api/rewards/daily/quiz', { choice });
export const getAdminFeatures = () => adminRequest('/api/admin/features');
export const switchAdminFeature = (key, d) => adminRequest(`/api/admin/features/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify(d) });
export const saveFeaturesConfig = (d) => adminRequest('/api/admin/features-config', { method: 'PUT', body: JSON.stringify(d) });
export const resolveSafeDeal = (code, d) => adminRequest(`/api/admin/safebuy/${encodeURIComponent(code)}/resolve`, { method: 'POST', body: JSON.stringify(d) });
export const getBankList = () => request('/api/banks');

// --- Ajo Circle ---
export const getCircles = () => request('/api/circles');
export const createCircle = (data) => request('/api/circles', { method: 'POST', body: JSON.stringify(data) });
export const circleAgreementPreview = (data) => request('/api/circles/agreement-preview', { method: 'POST', body: JSON.stringify(data) });
export const previewCircle = (code) => request(`/api/circles/join/${encodeURIComponent(code)}`);
export const joinCircle = (code, data) => request(`/api/circles/join/${encodeURIComponent(code)}`, { method: 'POST', body: JSON.stringify(data) });
export const getCircle = (id) => request(`/api/circles/${encodeURIComponent(id)}`);
export const inviteToCircle = (id, identifier) => request(`/api/circles/${encodeURIComponent(id)}/invite`, { method: 'POST', body: JSON.stringify({ identifier }) });
export const leaveCircle = (id) => request(`/api/circles/${encodeURIComponent(id)}/leave`, { method: 'POST' });
export const orderCircle = (id, data) => request(`/api/circles/${encodeURIComponent(id)}/order`, { method: 'POST', body: JSON.stringify(data) });
export const startCircle = (id, auth) => request(`/api/circles/${encodeURIComponent(id)}/start`, { method: 'POST', body: JSON.stringify(auth || {}) });
export const cancelCircle = (id) => request(`/api/circles/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
export const requestCircleRelease = (id, data) => request(`/api/circles/${encodeURIComponent(id)}/release`, { method: 'POST', body: JSON.stringify(data) });
export const appealCircleBan = (data) => request('/api/circles/appeal', { method: 'POST', body: JSON.stringify(data) });
export const getAdminCircles = () => adminRequest('/api/admin/circles');
export const getAdminCircle = (id) => adminRequest(`/api/admin/circles/${encodeURIComponent(id)}`);
export const reviewCircleRelease = (id, data) => adminRequest(`/api/admin/circles/releases/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(data) });
export const reviewCircleAppeal = (id, data) => adminRequest(`/api/admin/circles/appeals/${encodeURIComponent(id)}`, { method: 'POST', body: JSON.stringify(data) });
export const unbanCircleMember = (customerId) => adminRequest(`/api/admin/circles/unban/${encodeURIComponent(customerId)}`, { method: 'POST' });
export const stopCircle = (id, reason) => adminRequest(`/api/admin/circles/${encodeURIComponent(id)}/stop`, { method: 'POST', body: JSON.stringify({ reason }) });
export const getCashback = () => request('/api/wallet/cashback');
export const startCardPayment = (amount) => request('/api/wallet/card/start', { method: 'POST', body: JSON.stringify({ amount }) });
export const verifyCardPayment = (txRef) => request('/api/wallet/card/verify', { method: 'POST', quiet: true, body: JSON.stringify({ txRef }) });
export const getFundingMethods = () => adminRequest('/api/admin/funding-methods');
export const saveFundingMethods = (data) => adminRequest('/api/admin/funding-methods', { method: 'PUT', body: JSON.stringify(data) });
export const getFestivals = () => adminRequest('/api/admin/festivals');
export const vtpassSelfTest = () => adminRequest('/api/admin/vtpass/selftest');
export const getAdminOrders = (opts = {}) => adminRequest(`/api/admin/orders${opts.status ? `?status=${encodeURIComponent(opts.status)}` : ''}`);
export const getAuditLog = () => adminRequest('/api/admin/audit-log');

// --- Admin: manual wallet adjustments ---
export const adjustWallet = (customerId, data) =>
  adminRequest(`/api/admin/customers/${customerId}/adjust-wallet`, { method: 'POST', body: JSON.stringify(data) });
export const getAdminBankTransfers = (status) => adminRequest(`/api/admin/bank-transfers${status ? `?status=${status}` : ''}`);
export const authorizeBankTransfer = (id, otp) => adminRequest(`/api/admin/bank-transfers/${id}/authorize`, { method: 'POST', body: JSON.stringify({ otp }) });
export const resendBankTransferOtp = (id) => adminRequest(`/api/admin/bank-transfers/${id}/resend-otp`, { method: 'POST' });
export const checkBankTransfer = (id) => adminRequest(`/api/admin/bank-transfers/${id}/check`, { method: 'POST' });
export const cancelBankTransfer = (id) => adminRequest(`/api/admin/bank-transfers/${id}/cancel`, { method: 'POST' });
export const getMonnifyOverview = (light) => adminRequest(`/api/admin/monnify/overview${light ? '?light=1' : ''}`);
export const resetMonnifyAccounts = () => adminRequest('/api/admin/monnify/reset-accounts', { method: 'POST', body: JSON.stringify({ confirm: 'RESET' }) });
export const getAdminPromos = () => adminRequest('/api/admin/promos');
export const createPromo = (data) => adminRequest('/api/admin/promos', { method: 'POST', body: JSON.stringify(data) });
export const updatePromo = (id, data) => adminRequest(`/api/admin/promos/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const getAdminNotices = () => adminRequest('/api/admin/notices');
export const createNotice = (data) => adminRequest('/api/admin/notices', { method: 'POST', body: JSON.stringify(data) });
export const setNoticeActive = (id, active) => adminRequest(`/api/admin/notices/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) });
export const getDeletionRequests = () => adminRequest('/api/admin/deletion-requests');
export const deleteCustomerAccount = (id) => adminRequest(`/api/admin/customers/${id}/delete-account`, { method: 'POST', body: JSON.stringify({ confirm: 'DELETE' }) });
export const getAgentRequests = () => adminRequest('/api/admin/agent-requests');
export const setCustomerAgent = (id, isAgent) => adminRequest(`/api/admin/customers/${id}/agent`, { method: 'POST', body: JSON.stringify({ isAgent }) });

// --- Admin: staff management ---
export const getAdmins = () => adminRequest('/api/admin/admins');
export const createAdmin = (data) => adminRequest('/api/admin/admins', { method: 'POST', body: JSON.stringify(data) });
export const setAdminActive = (id, active) => adminRequest(`/api/admin/admins/${id}/active`, { method: 'PATCH', body: JSON.stringify({ active }) });
export const resetAdminPassword = (id, newPassword) => adminRequest(`/api/admin/admins/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword }) });

// --- Admin alerts, feedback, contests, adverts ---
export const getAdminPushKey = () => adminRequest('/api/admin/push/key');
export const subscribeAdminPush = (subscription) => adminRequest('/api/admin/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription }) });
export const unsubscribeAdminPush = (endpoint) => adminRequest('/api/admin/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) });
export const sendTestAdminAlert = () => adminRequest('/api/admin/alerts/test', { method: 'POST' });
export const testCustomerEmailAlert = (customerId) => adminRequest('/api/admin/email/test-customer-alert', { method: 'POST', body: JSON.stringify({ customerId }) });
export const shouldAskFeedback = () => request('/api/feedback/should-ask');
export const sendFeedback = (data) => request('/api/feedback', { method: 'POST', body: JSON.stringify(data) });
export const markFeedbackShared = (id) => request(`/api/feedback/${id}/shared`, { method: 'POST' });
export const getAdminFeedback = () => adminRequest('/api/admin/feedback');
export const getContest = () => request('/api/contest');
export const getAdminContests = () => adminRequest('/api/admin/contests');
export const getAdminContest = (id) => adminRequest(`/api/admin/contests/${id}`);
export const createContest = (data) => adminRequest('/api/admin/contests', { method: 'POST', body: JSON.stringify(data) });
export const updateContest = (id, data) => adminRequest(`/api/admin/contests/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const contestAction = (id, action, body) => adminRequest(`/api/admin/contests/${id}/${action}`, { method: 'POST', body: JSON.stringify(body || {}) });
export const getAds = () => request('/api/ads');
export const adImageUrl = (ad) => `${API_URL}/api/ads/${ad.id}/image?v=${ad.imageVersion}`;
export const clickAd = (id) => fetch(`${API_URL}/api/ads/${id}/click`, { method: 'POST' }).catch(() => {});
export const getAdminAds = () => adminRequest('/api/admin/ads');
export const createAd = (data) => adminRequest('/api/admin/ads', { method: 'POST', body: JSON.stringify(data) });
export const updateAd = (id, data) => adminRequest(`/api/admin/ads/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const deleteAd = (id) => adminRequest(`/api/admin/ads/${id}`, { method: 'DELETE' });
export const getContestFriends = (contestId, customerId) => adminRequest(`/api/admin/contests/${contestId}/friends/${customerId}`);
export const adminDesignAd = (brief) => adminRequest('/api/admin/ai/design-ad', { method: 'POST', quiet: true, body: JSON.stringify({ brief }) });
// Admin-only picture (needs the login token, so it can't be a plain <img src>).
export async function adminImageUrl(path) {
  const token = localStorage.getItem('zappipay_admin_token');
  const res = await fetch(`${API_URL}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error('Could not load the picture.');
  return URL.createObjectURL(await res.blob());
}

// Security details (date of birth + security question), identity check,
// agent reject, coupons, funding banks.
export const getSecurityDetails = () => request('/api/auth/security-details');
export const saveSecurityDetails = (data) => request('/api/auth/security-details', { method: 'POST', body: JSON.stringify(data) });
export const adminVerifyIdentity = (id, data) => adminRequest(`/api/admin/customers/${id}/verify-identity`, { method: 'POST', body: JSON.stringify(data) });
export const adminClearSecurityDetails = (id) => adminRequest(`/api/admin/customers/${id}/clear-security-details`, { method: 'POST' });
export const rejectAgent = (id, reason) => adminRequest(`/api/admin/customers/${id}/agent-reject`, { method: 'POST', body: JSON.stringify({ reason }) });
export const redeemCoupon = (code) => request('/api/wallet/coupon', { method: 'POST', body: JSON.stringify({ code }) });
export const getFundingBanks = () => adminRequest('/api/admin/funding-banks');
export const estimateEarnings = (data) => adminRequest('/api/admin/earnings/estimate', { method: 'POST', body: JSON.stringify(data) });

// Staff roles & escalations
export const getAdminMe = () => adminRequest('/api/admin/me');
export const getEscalations = (status = 'PENDING') => adminRequest(`/api/admin/escalations?status=${encodeURIComponent(status)}`);
export const createEscalation = (data) => adminRequest('/api/admin/escalations', { method: 'POST', body: JSON.stringify(data) });
export const approveEscalation = (id, note) => adminRequest(`/api/admin/escalations/${id}/approve`, { method: 'POST', body: JSON.stringify({ note }) });
export const rejectEscalation = (id, note) => adminRequest(`/api/admin/escalations/${id}/reject`, { method: 'POST', body: JSON.stringify({ note }) });
export const reportOrderToVtpass = (id, note) => adminRequest(`/api/admin/orders/${id}/vtpass-escalate`, { method: 'POST', body: JSON.stringify({ note }) });
export const checkCustomerFunding = (id, reference) => adminRequest(`/api/admin/customers/${id}/check-funding`, { method: 'POST', body: JSON.stringify({ reference }) });
export const setAdminRole = (id, role) => adminRequest(`/api/admin/admins/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) });
export const getReconciliation = (other) => adminRequest(`/api/admin/reconciliation${other ? `?other=${encodeURIComponent(other)}` : ''}`);
// CSV download for the accountant (orders, transactions, bank-transfers, customers).
export async function downloadExport(kind, from, to) {
  const token = localStorage.getItem('zappipay_admin_token');
  const r = await fetch(`${API_URL}/api/admin/export/${kind}?from=${from}&to=${to}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || 'Could not download the file.');
  }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `zappipay-${kind}-${from}-to-${to}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
export const getChallenges = () => request('/api/challenges');
export const getAdminChallenges = () => adminRequest('/api/admin/challenges');
export const previewChallenge = (data) => adminRequest('/api/admin/challenges/preview', { method: 'POST', body: JSON.stringify(data) });
export const createChallenge = (data) => adminRequest('/api/admin/challenges', { method: 'POST', body: JSON.stringify(data) });
export const updateChallenge = (id, data) => adminRequest(`/api/admin/challenges/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const getServiceStatus = () => fetch(`${API_URL}/api/status`).then((r) => r.json());
export const getSessions = () => request('/api/security/sessions');
export const endSession = (id) => request(`/api/security/sessions/${id}`, { method: 'DELETE' });
export const endOtherSessions = () => request('/api/security/sessions/logout-others', { method: 'POST' });
export const endThisSession = () => request('/api/security/sessions/logout', { method: 'POST' }).catch(() => {});
export const getInsights = () => request('/api/insights');
export const getAudiences = () => adminRequest('/api/admin/audiences');
export const getSavings = () => request('/api/savings');
export const saveToSavings = (amount) => request('/api/savings/deposit', { method: 'POST', body: JSON.stringify({ amount }) });
export const withdrawSavings = (amount) => request('/api/savings/withdraw', { method: 'POST', body: JSON.stringify({ amount }) });
export const getSavingsOverview = () => adminRequest('/api/admin/savings');
export const runSavingsInterest = () => adminRequest('/api/admin/savings/run', { method: 'POST' });
export const customerAccountTool = (id, data) => adminRequest(`/api/admin/customers/${id}/account-tool`, { method: 'POST', body: JSON.stringify(data) });

// Renewal reminders (DStv/GOtv/Startimes expiry, data plan end).
export const getReminders = () => request('/api/reminders');
export const stopReminder = (id) => request(`/api/reminders/${id}`, { method: 'DELETE' });
export const setRemindersOff = (off) => request('/api/reminders/settings', { method: 'PUT', body: JSON.stringify({ off }) });

// Gift cards (airtime / data for someone else).
export const getGift = (token) => request(`/api/gifts/${encodeURIComponent(token)}`);
export const getOrderGift = (id) => request(`/api/orders/${id}/gift`);
export const makeOrderGift = (id, data) => request(`/api/orders/${id}/gift`, { method: 'POST', body: JSON.stringify(data) });

// Delivery promise (owner settings).
export const getDeliveryPromise = () => adminRequest('/api/admin/delivery-promise');
export const saveDeliveryPromise = (data) => adminRequest('/api/admin/delivery-promise', { method: 'PUT', body: JSON.stringify(data) });

// Data deal finder.
export const findDataDeals = (params) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''));
  return request(`/api/deals/data?${q.toString()}`);
};

// Agent shop links.
export const getShop = (username) => request(`/api/shop/${encodeURIComponent(username)}`);
export const getMyShop = () => request('/api/my-shop');
export const saveMyShop = (data) => request('/api/my-shop', { method: 'PUT', body: JSON.stringify(data) });
export const getAdminShops = () => adminRequest('/api/admin/shops');
export const saveAdminShops = (data) => adminRequest('/api/admin/shops', { method: 'PUT', body: JSON.stringify(data) });

// Agent profit book.
export const getProfitBook = ({ from, to }) => request(`/api/agent/book?from=${from}&to=${to}`);
export const getOwing = () => request('/api/agent/book/owing');
export const saveAgentSale = (orderId, data) => request(`/api/agent/book/${orderId}`, { method: 'PUT', body: JSON.stringify(data) });

// Family wallet.
export const getFamily = () => request('/api/family');
export const inviteFamily = (data) => request('/api/family/invite', { method: 'POST', body: JSON.stringify(data) });
export const respondFamily = (accept) => request('/api/family/respond', { method: 'POST', body: JSON.stringify({ accept }) });
export const leaveFamily = () => request('/api/family/leave', { method: 'POST' });
export const updateFamily = (id, data) => request(`/api/family/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const familySendNow = (id) => request(`/api/family/${id}/send-now`, { method: 'POST' });
export const removeFamily = (id) => request(`/api/family/${id}`, { method: 'DELETE' });

// Rewards split (owner).
export const getRewardSplit = () => adminRequest('/api/admin/reward-split');
export const saveRewardSplit = (data) => adminRequest('/api/admin/reward-split', { method: 'PUT', body: JSON.stringify(data) });

// Admin assistant proposals (nothing changes until Apply).
export const applyAiAction = (id) => adminRequest(`/api/admin/ai/actions/${id}/apply`, { method: 'POST' });
export const undoAiAction = (id) => adminRequest(`/api/admin/ai/actions/${id}/undo`, { method: 'POST' });
export const dismissAiAction = (id) => adminRequest(`/api/admin/ai/actions/${id}/dismiss`, { method: 'POST' });

// Ad shown (tap rate), Help Centre answers added in admin, briefing.
export const recordAdView = (id) => request(`/api/ads/${id}/view`, { method: 'POST', quiet: true });
export const getExtraFaqs = () => request('/api/help/faqs', { quiet: true });
export const getAiBriefing = () => adminRequest('/api/admin/ai/briefing');

// Voice notes (better OpenAI voice when the owner turns it on).
export const getVoiceStatus = () => request('/api/voice/status', { quiet: true });
export const transcribeVoice = (data) => request('/api/ai/transcribe', { method: 'POST', quiet: true, body: JSON.stringify(data) });
export const getAdminVoiceStatus = () => adminRequest('/api/admin/voice/status');

// Recharge card printing (ClubKonnect e-PINs)
export const getEpinOptions = () => request('/api/epins/options');
export const getEpinBatches = () => request('/api/epins');
export const getEpinBatch = (id) => request(`/api/epins/${id}`);
export const buyEpins = (data) => request('/api/epins', { method: 'POST', body: JSON.stringify(data) });
export const markEpinsPrinted = (id) => request(`/api/epins/${id}/printed`, { method: 'POST', body: '{}' });
export const markEpinsSold = (id, cardIds, sold = true) => request(`/api/epins/${id}/sold`, { method: 'POST', body: JSON.stringify({ cardIds, sold }) });
export const getAdminEpins = () => adminRequest('/api/admin/epins');
export const updateAdminEpins = (data) => adminRequest('/api/admin/epins/settings', { method: 'PUT', body: JSON.stringify(data) });
export const resolveAdminEpin = (id, action) => adminRequest(`/api/admin/epins/${id}/${action}`, { method: 'POST', body: '{}' });

// Video adverts (optional) + AI video script for social media
export const adVideoUrl = (ad) => `${API_URL}/api/ads/${ad.id}/video?v=${ad.imageVersion || ''}`;
export const getVideoAdSettings = () => adminRequest('/api/admin/ads/video-settings');
export const setVideoAdSettings = (enabled) => adminRequest('/api/admin/ads/video-settings', { method: 'PUT', body: JSON.stringify({ enabled }) });
export const uploadAdVideo = (id, file) => adminRequest(`/api/admin/ads/${id}/video`, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'video/mp4' } });
export const deleteAdVideo = (id) => adminRequest(`/api/admin/ads/${id}/video`, { method: 'DELETE' });
export const writeVideoScript = (data) => adminRequest('/api/admin/ai/video-script', { method: 'POST', body: JSON.stringify(data) });

// HeyGen AI presenter videos (optional)
export const getHeygenStatus = () => adminRequest('/api/admin/heygen/status');
export const updateHeygenSettings = (data) => adminRequest('/api/admin/heygen/settings', { method: 'PUT', body: JSON.stringify(data) });
export const getHeygenAvatars = () => adminRequest('/api/admin/heygen/avatars');
export const getHeygenVoices = () => adminRequest('/api/admin/heygen/voices');
export const getHeygenVideos = () => adminRequest('/api/admin/heygen/videos');
export const makeHeygenVideo = (data) => adminRequest('/api/admin/heygen/videos', { method: 'POST', body: JSON.stringify(data) });
export const refreshHeygenVideo = (id) => adminRequest(`/api/admin/heygen/videos/${id}`);
export const attachHeygenVideo = (id, adId) => adminRequest(`/api/admin/heygen/videos/${id}/attach`, { method: 'POST', body: JSON.stringify({ adId }) });

// Invite on receipts (sender's referral link + QR)
export const getReceiptInvite = () => request('/api/receipt-invite', { quiet: true });
export const getAdminReceiptInvite = () => adminRequest('/api/admin/receipt-invite');
export const setAdminReceiptInvite = (data) => adminRequest('/api/admin/receipt-invite', { method: 'PUT', body: JSON.stringify(data) });

// Self-freeze (lost / stolen phone): needs the account password.
export const freezeMyAccount = (password) => request('/api/security/freeze', { method: 'POST', body: JSON.stringify({ password }) });

// AI helpers & radar
export const planSocialWeek = (data) => adminRequest('/api/admin/ai/week-plan', { method: 'POST', body: JSON.stringify(data) });
export const checkSupportReply = (data) => adminRequest('/api/admin/ai/check-reply', { method: 'POST', body: JSON.stringify(data) });
export const getWinBack = () => adminRequest('/api/admin/insights/winback');
export const simulatePricing = (data) => adminRequest('/api/admin/insights/simulate-pricing', { method: 'POST', body: JSON.stringify(data) });
export const getFeedbackDigest = (days = 30) => adminRequest(`/api/admin/insights/feedback-digest?days=${days}`);
export const getScamReports = () => adminRequest('/api/admin/scam-reports');

// Natural voice (mp3) for a Help chat reply; throws when not available.
export async function speakText(text, language) {
  const token = localStorage.getItem('zappipay_customer_token');
  const res = await fetch(`${API_URL}/api/ai/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ text, language }),
  });
  if (!res.ok || !String(res.headers.get('content-type') || '').includes('audio')) throw new Error('natural voice unavailable');
  return res.blob();
}
export const getOpenAiExtras = () => adminRequest('/api/admin/openai-extras');
export const setOpenAiExtras = (data) => adminRequest('/api/admin/openai-extras', { method: 'PUT', body: JSON.stringify(data) });
export const makeAdImage = (data) => adminRequest('/api/admin/ai/ad-image', { method: 'POST', body: JSON.stringify(data) });
export const getBackupCodes = () => adminRequest('/api/admin/security/backup-codes');
export const makeBackupCodes = (password) => adminRequest('/api/admin/security/backup-codes', { method: 'POST', body: JSON.stringify({ password }) });
export const getSecurityOverview = (hours = 24) => adminRequest(`/api/admin/security/overview?hours=${hours}`);
export const unblockAddress = (id) => adminRequest(`/api/admin/security/blocks/${id}/unblock`, { method: 'POST' });
export const blockAddress = (data) => adminRequest('/api/admin/security/blocks', { method: 'POST', body: JSON.stringify(data) });

// International airtime / data and motor insurance
const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
export const intlCountries = () => request('/api/vtpass/intl/countries');
export const intlTypes = (code) => request(`/api/vtpass/intl/types?${qs({ code })}`);
export const intlOperators = (code, type) => request(`/api/vtpass/intl/operators?${qs({ code, type })}`);
export const intlVariations = (operator, type) => request(`/api/vtpass/intl/variations?${qs({ operator, type })}`);
export const intlQuote = (p) => request(`/api/vtpass/intl/quote?${qs(p)}`, { quiet: true });
export const insurancePlans = () => request('/api/vtpass/insurance/plans');
export const insuranceOptions = (kind, parent) => request(`/api/vtpass/insurance/options/${kind}${parent ? `?${qs({ parent })}` : ''}`);

// Pay me links, split bills, group gifts
export const createPayRequest = (data) => request('/api/pay-requests', { method: 'POST', body: JSON.stringify(data) });
export const getPayRequests = () => request('/api/pay-requests');
export const viewPayRequest = (token) => request(`/api/pay-requests/public/${encodeURIComponent(token)}`);
export const payPayRequest = (token, data) => request(`/api/pay-requests/${encodeURIComponent(token)}/pay`, { method: 'POST', quiet: true, body: JSON.stringify(data) });
export const closePayRequest = (id) => request(`/api/pay-requests/${id}/close`, { method: 'POST' });
export const remindPayRequest = (id) => request(`/api/pay-requests/${id}/remind`, { method: 'POST' });
