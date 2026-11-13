// Map of admin screens for the admin AI assistant, so it can say where
// things are and give a button that opens the exact screen — including a
// Settings menu and the section (tab) inside it.
// KEEP IN SYNC with the frontend: AdminLayout.jsx (NAV) and
// pages/admin/AdminSettings.jsx (TABS + SUBTABS). Settings links look
// like /admin/settings?tab=security&sub=login.

const SCREENS = [
  ['/admin', 'Overview'],
  ['/admin/money', '💰 Money check (🧾 Compliance summary card: pick a month, download the CSV, change the large-funding thresholds; in demo mode sandbox balances, Short by and Difference are hidden; "Bank transfers (guard): Not paused" means the guard is not blocking payouts — Send to Bank itself is off for customers)'],
  ['/admin/ledger', '📒 Ledger & refunds (every wallet credit/debit, read-only; Real / Test / All filter, test lines tagged; types for switched-off features (Ajo Circle, transfers, disputes, Airtime to Cash) hidden; refunds automatic and manual with reason, cash + cashback back = what the order took)'],
  ['/admin/subscriptions', '🧾 Subscriptions (every plan the app runs on: domain, VPS server, fixed IP, Neon database, Vercel, AI credits, email — cost, billing period, next renewal date, reminders 14/7/3/1/0 days before; owner only)'],
  ['/admin/my-access', '🔒 Access & roles (what support staff can and cannot do)'],
  ['/admin/go-live', '🚦 Go-live check (partner modes, wallets, test account numbers, reset BVN checks made before Monnify went live (typed RESET-KYC, owner only), safe rewards check, launch blockers)'],
  ['/admin/database', '🗄️ Server & Database (server memory, swap, disk, load; Neon: health, speed, size, biggest tables, connections, compute hours, storage, plan limits, bill estimate)'],
  ['/admin/assistant', '✨ AI Assistant (this chat; owner only, read-only: VTpass plan codes removed/added and what still uses them, server logs with secrets masked, which code is running and the self-check after a restart; 📄 attach a Nomba/Squad/Monnify/VTpass statement (CSV or Excel) to match it against our records; release notes after an update; proposes money actions as Apply cards: check funding from a receipt, credit an unmatched payment, release/cancel a held transfer, re-check or settle a stuck order, switch a plan; payout runway, daily Monnify check, weekly report; finds the cause of errors and proposes code fixes as GitHub pull requests with automatic tests, then gives the server commands; failing purchases, support quality, slipping customers)'],
  ['/admin/support-guide', '📘 Support guide (how support handles each customer problem, who can do what, ready replies)'],
  ['/admin/pending-funding', 'Pending Funding (manual funding approvals)'],
  ['/admin/airtime-cash', 'Airtime to Cash requests'],
  ['/admin/bank-transfers', 'Bank Transfers (Send to Bank, held transfers, OTP)'],
  ['/admin/disputes', '↩️ Wrong transfers'],
  ['/admin/unmatched-payments', '💸 Unmatched payments (bank payments to old/removed/deleted account numbers — credit the right customer or record it was sent back)'],
  ['/admin/customers', 'Customers (open one for account tools, BVN/NIN check, funding check, wallet corrections, freeze, money tools: card re-check, chargeback, manual payout; support tools: scheduled top-ups, log a complaint as a ticket, fix name, daily limit, give a missing reward)'],
  ['/admin/staff', 'Staff'],
  ['/admin/orders', 'Orders (details: token, PINs, provider reply; ask the provider; check now / delivered / failed + refund; Real / Test / All orders; mark orders before a date as test)'],
  ['/admin/support', 'Support tickets'],
  ['/admin/escalations', '✅ Approvals'],
  ['/admin/partners', '🤝 Partners (🙈 hide/show a service on the Buy page, e.g. JAMB and Spectranet until VTpass enables them; partner desk: VTpass, Monnify, Nomba, Squad (GTBank), FCMB, GTBank, ClubKonnect, Flutterwave; tasks with due dates and notes; auto-pause, away mode, follow-ups)'],
  ['/admin/broadcasts', 'Broadcasts'],
  ['/admin/notices', 'Service Notices'],
  ['/admin/promos', 'Promo Codes'],
  ['/admin/challenges', 'Challenges'],
  ['/admin/contests', '🏆 Referral Contests'],
  ['/admin/ads', '📣 In-app Ads (tabs: Showing now / Scheduled / Off or ended / All)'],
  ['/admin/ad-studio', '🎨 Ad Studio (tabs: Design an ad / Festivals & dates / Week plan / Story video / Scripts & AI presenter)'],
  ['/admin/circles', '🔄 Ajo Circles'],
  ['/admin/features', '🧩 New features (turn features on/off, e.g. Bet Funding, Airtime to Cash, Car insurance). Menu items for switched-off features are hidden: Airtime to Cash, Bank Transfers (Send to Bank off), Wrong transfers (Send money and Send to Bank off), Pending Funding (manual funding off), Unmatched payments (bank funding off)'],
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
  ['split', '🎁 Rewards split (monthly rewards cap, cashback used and still held, % of earnings given back)'],
  ['vtpass', 'VTpass', [['connection', 'Connection'], ['test', 'Self-test'], ['intl', 'International airtime']]],
  ['monnify', 'Wallet funding & payment partners', [['overview', 'Overview (who gives account numbers, who sends Send to Bank, automatic backup; your partner accounts — the 🔒 Monnify payout wallet is an internal number, never send money to it; top up Monnify via Balances → Fund Balance)'], ['monnify', 'Monnify — keys and mode, account numbers on/off, Send to Bank and the 🔒 payout wallet number (internal, never send money to it), your Monnify accounts'], ['squad', 'Squad (GTBank) — keys, account numbers on/off, settlement account, funding fee with “free from ₦”'], ['nomba', 'Nomba — keys, account numbers on/off, funding fee with “free from ₦”'], ['flutterwave', 'Flutterwave (card)']]],
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
  ['security', 'Security', [['fraud', 'Fraud check'], ['login', 'Two-step login & backup codes'], ['attack', 'Attack watch'], ['id', 'BVN/NIN check (₦10 per BVN, ₦60 per NIN at Monnify; 5 paid checks a day per customer)'], ['summary', 'Daily summary email']]],
  ['backups', '💾 Backups (nightly database backups, backup emails, download)'],
  ['ai', 'AI Assistant', [['assistant', 'AI Assistant — Gemini key and models, Gemini-first / Claude-first for customers and for admin, Claude key and models, assistants on/off, daily limit, monthly budget, morning briefing'], ['voice', 'Voice notes'], ['openai', 'Natural voice & pictures (OpenAI key)'], ['heygen', 'Presenter videos (HeyGen)']]],
  ['password', 'My Password'],
];

// Cards inside a page: the button scrolls there and highlights it.
// KEEP IN SYNC with the id="…" on those cards in the frontend.
const SECTIONS = [
  ['/admin/money#funds-guard', '💰 Money check → 🛡️ Customer-funds guard (free in Monnify, yours to move out, guard on/off)'],
  ['/admin/money#owed', '💰 Money check → What you owe customers (real customers, test accounts not counted)'],
  ['/admin/money#held', '💰 Money check → Money you hold (VTpass, Monnify, Squad/Nomba when in use)'],
  ['/admin/money#compliance', '💰 Money check → 🧾 Compliance summary (SCUML/NFIU: month, CSV download, large-funding thresholds)'],
  ['/admin/money#exports', '💰 Money check → 📥 Download for your accountant (purchases, wallet transactions, send to bank, customers CSV)'],
  ['/admin/partners#hidden-services', '🤝 Partners → 🙈 Hidden on the Buy page (hide/show JAMB, Spectranet and other services)'],
  ['/admin/partners#auto-pause', '🤝 Partners → 🚦 Auto-pause a failing provider (on/off, reopen now)'],
  ['/admin/partners#away-mode', '🤝 Partners → 🌙 Away mode (automatic support replies at night)'],
  ['/admin/go-live#reset-kyc', '🚦 Go-live → 🔁 Reset BVN checks made before Monnify went live (typed RESET-KYC)'],
  ['/admin/go-live#test-numbers', '🚦 Go-live → 🧹 Remove test account numbers'],
  ['/admin/ledger?tab=refunds', '📒 Ledger → Refunds tab'],
];
// On one customer's page: /admin/customers/ID#adjust-wallet (credit/debit with ✨ Suggest note) or #test-account (Test account switch).
const CUSTOMER_SECTIONS = ['adjust-wallet', 'test-account'];

const settingsPath = (tab, sub) => `/admin/settings?tab=${tab}${sub ? `&sub=${sub}` : ''}`;

// Every place the assistant may link to.
function all() {
  const out = [...SCREENS, ...SECTIONS].map(([path, label]) => ({ path, label }));
  for (const [tab, label, subs] of SETTINGS) {
    out.push({ path: settingsPath(tab), label: `Settings → ${label}` });
    for (const [sub, sl] of subs || []) out.push({ path: settingsPath(tab, sub), label: `Settings → ${label.replace(/\s*\(.*\)$/, '')} → ${sl}` });
  }
  return out;
}

const ALLOWED = new Set(all().map((x) => x.path));
const CUSTOMER_PAGE = new RegExp(`^\\/admin\\/customers\\/[A-Za-z0-9_-]{6,40}(#(${CUSTOMER_SECTIONS.join('|')}))?$`);
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

module.exports = { SECTIONS, CUSTOMER_SECTIONS, SCREENS, SETTINGS, all, allowed, cleanLinks, find, settingsPath };
