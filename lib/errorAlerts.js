const prisma = require('./prisma');

// Emails owners when something is going wrong, so you hear it before
// customers complain:
//   • the server crashes (uncaught error)
//   • many requests fail with a server error (10+ in 10 minutes)
//   • VTpass keeps failing purchases (5+ in 15 minutes)
// Each kind of alert is sent at most once an hour. Owners can switch
// them off in Settings → Maintenance & alerts.

const HOUR = 60 * 60 * 1000;
const lastSent = new Map();
const windows = { http: [], vtpass: [] };

async function enabled() {
  try {
    const s = await prisma.settings.findFirst({ select: { errorAlertsEnabled: true } });
    return s?.errorAlertsEnabled !== false;
  } catch {
    return true;
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function send(kind, subject, lines) {
  const now = Date.now();
  if (now - (lastSent.get(kind) || 0) < HOUR) return false;
  lastSent.set(kind, now);
  if (!(await enabled())) return false;
  const text = `${subject}\n\n${lines.join('\n')}\n\nTime: ${new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}\nYou'll get at most one of these per hour. Turn them off in Admin → Settings → Maintenance & alerts.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><div style="background:#ef4444;color:#fff;padding:14px 18px;border-radius:10px 10px 0 0;font-weight:bold">ZAPPI PAY · ${esc(subject)}</div><div style="border:1px solid #e5e7eb;border-top:none;padding:18px;border-radius:0 0 10px 10px">${lines.map((l) => `<p style="margin:0 0 8px">${esc(l)}</p>`).join('')}<p style="color:#64748b;font-size:12px;margin-top:14px">At most one of these per hour. Turn them off in Admin → Settings → Maintenance &amp; alerts.</p></div></div>`;
  try {
    await require('./adminAlert').emailAdmins(`⚠️ ZappiPay: ${subject}`, html, text);
    require('./push').pushToAdmins(`ZP Admin: ${subject}`, lines[0] || subject, '/admin').catch(() => {});
  } catch (error) {
    console.error('error alert email failed:', error.message);
  }
  return true;
}

function note(list, windowMs, now = Date.now()) {
  list.push(now);
  while (list.length && list[0] < now - windowMs) list.shift();
  return list.length;
}

// Express middleware: counts responses with a 5xx status.
const recentPaths = [];
function watchResponses(req, res, next) {
  res.on('finish', () => {
    if (res.statusCode < 500 || res.statusCode === 503) return; // 503 = maintenance, on purpose
    recentPaths.push(`${req.method} ${req.originalUrl.split('?')[0]} → ${res.statusCode}`);
    if (recentPaths.length > 20) recentPaths.shift();
    const n = note(windows.http, 10 * 60 * 1000);
    if (n >= 10) send('http', `${n} server errors in 10 minutes`, ['Customers or admins are getting "something went wrong" errors.', 'Latest:', ...recentPaths.slice(-6), 'Check the Render logs for details.']).catch(() => {});
  });
  next();
}

// Called when a purchase ends as FAILED.
function vtpassFailure(order) {
  const n = note(windows.vtpass, 15 * 60 * 1000);
  if (n >= 5) {
    send('vtpass', `${n} failed purchases in 15 minutes`, [
      'VTpass is failing purchases (customers were refunded automatically).',
      `Latest: ${order?.service || ''} ${order?.provider || ''} ₦${Number(order?.amount || 0).toLocaleString()}`,
      'Check your VTpass balance and the VTpass status. If a service is down, pause it in Settings → Maintenance so customers see a message instead.',
    ]).catch(() => {});
  }
}

let installed = false;
function installCrashHandlers() {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
    send('rejection', 'Server error (unhandled)', [String(reason?.stack || reason).slice(0, 600)]).catch(() => {});
  });
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    // Try to email, then exit so Render restarts the server cleanly.
    const done = () => process.exit(1);
    setTimeout(done, 4000).unref();
    send('crash', 'Server crashed and is restarting', [String(error?.stack || error).slice(0, 600)]).finally(done);
  });
}

module.exports = { watchResponses, vtpassFailure, installCrashHandlers, _send: send, _reset: () => { lastSent.clear(); windows.http.length = 0; windows.vtpass.length = 0; } };
