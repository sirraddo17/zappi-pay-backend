const prisma = require('./prisma');
const { getSettings, vtpassRequest } = require('./vtpass');
const { emailAdmins } = require('./adminAlert');

// Morning email to admins with yesterday's numbers and anything that
// needs attention. Sent at about 7am Nigerian time (when the server is
// awake); if the server was asleep it catches up on the next start.

const LAGOS = 60 * 60 * 1000;
const lagosYmd = (d = new Date()) => new Date(d.getTime() + LAGOS).toISOString().slice(0, 10);
const startOfLagosDay = (ymd) => new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() - LAGOS);
const money = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 0 })}`;
const sum = async (model, where, field = 'amount') => Number((await prisma[model].aggregate({ where, _sum: { [field]: true } }))._sum[field] || 0);

async function buildSummary() {
  const today = lagosYmd();
  const from = new Date(startOfLagosDay(today).getTime() - 24 * LAGOS);
  const to = startOfLagosDay(today);
  const range = { gte: from, lt: to };
  const [orders, failed, pendingOrders, newCustomers, funded, bankOut, bankFees, refunds, cashback, pendingFunding, held, otp, deletions, agentReqs] = await Promise.all([
    prisma.order.findMany({ where: { status: 'SUCCESS', createdAt: range }, select: { amount: true, costAmount: true, cashbackAmount: true } }),
    prisma.order.count({ where: { status: 'FAILED', createdAt: range } }),
    prisma.order.count({ where: { status: 'PENDING' } }),
    prisma.customer.count({ where: { createdAt: range } }),
    sum('walletTransaction', { type: 'FUND', status: 'APPROVED', createdAt: range }),
    sum('bankTransfer', { status: 'SUCCESS', createdAt: range }),
    sum('bankTransfer', { status: 'SUCCESS', createdAt: range }, 'fee'),
    sum('walletTransaction', { type: 'REFUND', status: 'APPROVED', createdAt: range }),
    sum('walletTransaction', { type: 'CASHBACK', status: 'APPROVED', createdAt: range }),
    prisma.walletTransaction.count({ where: { type: 'FUND', status: 'PENDING' } }),
    prisma.bankTransfer.count({ where: { status: 'HELD' } }),
    prisma.bankTransfer.count({ where: { status: 'PENDING_AUTHORIZATION' } }),
    prisma.customer.count({ where: { deletionRequestedAt: { not: null }, deletedAt: null } }),
    prisma.customer.count({ where: { agentRequestedAt: { not: null }, isAgent: false } }),
  ]);
  const sales = orders.reduce((s, o) => s + Number(o.amount), 0);
  const profit = orders.reduce((s, o) => s + Number(o.amount) - Number(o.costAmount ?? o.amount) - Number(o.cashbackAmount || 0), 0) + bankFees;

  let vtpassBalance = null;
  try {
    const b = await vtpassRequest('GET', '/balance');
    vtpassBalance = Number(b?.contents?.balance ?? b?.content?.balance);
  } catch { /* shown as unknown */ }

  const attention = [
    pendingFunding && `${pendingFunding} funding request(s) waiting for approval`,
    held && `${held} bank transfer(s) held for review`,
    otp && `${otp} bank transfer(s) waiting for your Monnify OTP`,
    pendingOrders && `${pendingOrders} purchase(s) still pending with VTpass`,
    deletions && `${deletions} account deletion request(s)`,
    agentReqs && `${agentReqs} agent application(s)`,
    Number.isFinite(vtpassBalance) && vtpassBalance < 20000 && `VTpass wallet is low: ${money(vtpassBalance)}`,
  ].filter(Boolean);

  const dateLabel = new Date(from.getTime() + 12 * LAGOS).toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'long' });
  const rows = [
    ['Sales', `${money(sales)} (${orders.length} orders)`],
    ['Profit', money(profit)],
    ['Failed orders (refunded)', failed],
    ['New customers', newCustomers],
    ['Wallet funding in', money(funded)],
    ['Sent to banks', money(bankOut)],
    ['Refunds', money(refunds)],
    ['Cashback paid', money(cashback)],
    ['VTpass wallet now', Number.isFinite(vtpassBalance) ? money(vtpassBalance) : 'unknown'],
  ];
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#0f172a">
      <div style="background:#7c3aed;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0;font-size:18px;font-weight:bold">ZAPPI PAY · Daily summary</div>
      <div style="border:1px solid #e5e7eb;border-top:none;padding:20px;border-radius:0 0 12px 12px">
        <p style="margin-top:0"><strong>${dateLabel}</strong></p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          ${rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#64748b;border-bottom:1px solid #f1f5f9">${k}</td><td style="padding:6px 0;text-align:right;font-weight:bold;border-bottom:1px solid #f1f5f9">${v}</td></tr>`).join('')}
        </table>
        <h3 style="font-size:15px;margin:18px 0 6px">${attention.length ? 'Needs your attention' : 'Nothing needs your attention 🎉'}</h3>
        ${attention.length ? `<ul style="padding-left:18px;margin:0">${attention.map((a) => `<li>${a}</li>`).join('')}</ul>` : ''}
      </div>
    </div>`;
  const text = `ZappiPay daily summary (${dateLabel})\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${attention.length ? `Needs attention:\n- ${attention.join('\n- ')}` : 'Nothing needs attention.'}`;
  return { subject: `ZappiPay daily summary: ${money(sales)} sales, ${money(profit)} profit`, html, text, today };
}

async function sendDailySummary({ force = false } = {}) {
  const settings = await getSettings();
  if (!force && !settings.dailySummaryEnabled) return { sent: 0, skipped: 'disabled' };
  const s = await buildSummary();
  if (!force) {
    // Claim today's send so a restart can't send it twice.
    const r = await prisma.settings.updateMany({
      where: { id: settings.id, OR: [{ lastDailySummaryDate: null }, { lastDailySummaryDate: { not: s.today } }] },
      data: { lastDailySummaryDate: s.today },
    });
    if (r.count !== 1) return { sent: 0, skipped: 'already sent' };
  }
  return emailAdmins(s.subject, s.html, s.text);
}

let timer = null;
function msUntilNext7am() {
  const now = Date.now();
  const today7 = startOfLagosDay(lagosYmd()).getTime() + 7 * LAGOS;
  return today7 > now ? today7 - now : today7 + 24 * LAGOS - now;
}

function arm() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await sendDailySummary().catch((e) => console.error('daily summary failed:', e.message));
    arm();
  }, msUntilNext7am());
}

function startDailySummary() {
  if (process.env.DISABLE_SCHEDULER === '1') return;
  // Catch up if it's past 7am and today's summary hasn't gone out.
  const hourLagos = new Date(Date.now() + LAGOS).getUTCHours();
  if (hourLagos >= 7) setTimeout(() => sendDailySummary().catch(() => {}), 60 * 1000);
  arm();
}

module.exports = { sendDailySummary, startDailySummary, buildSummary };
