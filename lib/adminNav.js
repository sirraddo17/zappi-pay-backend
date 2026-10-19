// Map of admin screens for the admin AI assistant, so it can say where
// things are and give a button that opens the exact screen — including a
// Settings menu and the section (tab) inside it.
// KEEP IN SYNC with the frontend: AdminLayout.jsx (NAV) and
// pages/admin/AdminSettings.jsx (TABS + SUBTABS). Settings links look
// like /admin/settings?tab=security&sub=login.

const SCREENS = [
  ['/admin', 'Overview'],
  ['/admin/money', '💰 Money check'],
  ['/admin/go-live', '🚦 Go-live check (partner modes, wallets, test account numbers, safe rewards check, launch blockers)'],
  ['/admin/assistant', '✨ AI Assistant (this chat)'],
  ['/admin/pending-funding', 'Pending Funding (manual funding approvals)'],
  ['/admin/airtime-cash', 'Airtime to Cash requests'],
  ['/admin/bank-transfers', 'Bank Transfers (Send to Bank, held transfers, OTP)'],
  ['/admin/disputes', '↩️ Wrong transfers'],
  ['/admin/unmatched-payments', '💸 Unmatched payments (bank payments to old/removed/deleted account numbers — credit the right customer or record it was sent back)'],
  ['/admin/customers', 'Customers (open one for account tools, BVN/NIN check, funding check, wallet corrections, freeze, money tools: card re-check, chargeback, manual payout)'],
  ['/admin/staff', 'Staff'],
  ['/admin/orders', 'Orders (check now / delivered / failed + refund)'],
  ['/admin/support', 'Support tickets'],
  ['/admin/escalations', '✅ Approvals'],
  ['/admin/partners', '🤝 Partners (auto-pause, away mode, follow-ups)'],
  ['/admin/broadcasts', 'Broadcasts'],
  ['/admin/notices', 'Service Notices'],
  ['/admin/promos', 'Promo Codes'],
  ['/admin/challenges', 'Challenges'],
  ['/admin/contests', '🏆 Referral Contests'],
  ['/admin/ads', '📣 In-app Ads'],
  ['/admin/ad-studio', '🎨 Ad Studio'],
  ['/admin/circles', '🔄 Ajo Circles'],
  ['/admin/features', '🧩 New features (turn features on/off, e.g. Bet Funding)'],
  ['/admin/extra-services', '📩 SMS, Tickets & Bills'],
  ['/admin/feedback', '⭐ Feedback'],
  ['/admin/radar', '🔭 Radar'],
  ['/admin/security', '🛡️ Security (attacks, blocks, warning signs)'],
  ['/admin/settings', 'Settings'],
  ['/admin/audit-log', 'Audit Log'],
];

// [tab, label, [[sub, label], …]]
const SETTINGS = [
  ['maintenance', '🛠️ Maintenance & alerts'],
  ['split', '🎁 Rewards split'],
  ['vtpass', 'VTpass', [['connection', 'Connection'], ['test', 'Self-test'], ['intl', 'International airtime']]],
  ['monnify', 'Wallet funding & payment partners', [['overview', 'Overview (who gives account numbers, who sends Send to Bank, automatic backup)'], ['monnify', 'Monnify'], ['squad', 'Squad (GTBank)'], ['nomba', 'Nomba'], ['flutterwave', 'Flutterwave (card)']]],
  ['markup', 'Markup', [['rates', 'Markup per service'], ['safe', 'Safe pricing check']]],
  ['discount', 'Discounts', [['discounts', 'Discounts'], ['guard', 'Giveaway safety limit']]],
  ['limits', 'Limits', [['amounts', 'Minimum amounts'], ['manual', 'Manual funding accounts'], ['fees', 'Monnify funding fee']]],
  ['airtimeCash', 'Airtime to Cash'],
  ['referral', 'Referrals', [['settings', 'Referral rewards'], ['receipt', 'Invite on receipts'], ['progress', 'Invited friends']]],
  ['cashback', 'Cashback'],
  ['promise', '⚡ Delivery promise'],
  ['shops', '🏪 Agent shops'],
  ['epins', '🖨️ ClubKonnect & Bet Funding (card printing, bet funding supplier)'],
  ['agents', 'Agents'],
  ['loyalty', 'Loyalty Points'],
  ['savings', 'Savings (interest)'],
  ['alerts', 'Alerts & Limits', [['customers', 'Customer alerts'], ['admin', 'Alerts to me'], ['helpers', 'Automatic helpers'], ['limits', 'Daily spending limits'], ['support', 'Support WhatsApp']]],
  ['security', 'Security', [['fraud', 'Fraud check'], ['login', 'Two-step login & backup codes'], ['attack', 'Attack watch'], ['id', 'BVN/NIN check'], ['summary', 'Daily summary email']]],
  ['backups', '💾 Backups (nightly database backups, backup emails, download)'],
  ['ai', 'AI Assistant', [['assistant', 'AI Assistant'], ['voice', 'Voice notes'], ['openai', 'Natural voice & pictures'], ['heygen', 'Presenter videos']]],
  ['password', 'My Password'],
];

const settingsPath = (tab, sub) => `/admin/settings?tab=${tab}${sub ? `&sub=${sub}` : ''}`;

// Every place the assistant may link to.
function all() {
  const out = SCREENS.map(([path, label]) => ({ path, label }));
  for (const [tab, label, subs] of SETTINGS) {
    out.push({ path: settingsPath(tab), label: `Settings → ${label}` });
    for (const [sub, sl] of subs || []) out.push({ path: settingsPath(tab, sub), label: `Settings → ${label.replace(/\s*\(.*\)$/, '')} → ${sl}` });
  }
  return out;
}

const ALLOWED = new Set(all().map((x) => x.path));
const CUSTOMER_PAGE = /^\/admin\/customers\/[A-Za-z0-9_-]{6,40}$/;
const ORDER_PAGE = /^\/admin\/orders\/[A-Za-z0-9_-]{6,40}$/;
const allowed = (path) => ALLOWED.has(path) || CUSTOMER_PAGE.test(path) || ORDER_PAGE.test(path);

// [[go:/path|Label]] markers: keep only real admin screens; a bad one
// becomes plain text so the owner never gets a broken button.
function cleanLinks(text) {
  return String(text || '').replace(/\[\[go:([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, path, label) => {
    const p = path.trim();
    return allowed(p) ? `[[go:${p}|${String(label || '').trim().slice(0, 60) || 'Open'}]]` : String(label || '').trim();
  });
}

// For the assistant's tool: optionally filtered by words.
function find(query) {
  const words = String(query || '').toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const list = all();
  if (!words.length) return list;
  const hits = list.filter((x) => words.some((w) => x.label.toLowerCase().includes(w)));
  return hits.length ? hits : list;
}

module.exports = { SCREENS, SETTINGS, all, allowed, cleanLinks, find, settingsPath };
