// Business-account (manual) funding requests that nobody has checked yet.
//  • after half the waiting time → one reminder to admins
//  • after the waiting time      → second reminder, and the customer is told
//    "taking longer than usual — support has been alerted"
// Requests are never rejected automatically: the money may really have
// arrived. Only a person approves or rejects.

const prisma = require('./prisma');

const naira = (n) => `₦${Number(n).toLocaleString('en-NG')}`;

async function tick(now = Date.now()) {
  const settings = await require('./vtpass').getSettings();
  const wait = Math.max(5, Number(settings.manualFundingWaitMinutes || 30));
  const firstAt = Math.max(5, Math.round(wait / 2));
  const rows = await prisma.walletTransaction.findMany({
    where: { type: 'FUND', status: 'PENDING', remindedStage: { lt: 2 }, createdAt: { lte: new Date(now - firstAt * 60 * 1000) } },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  if (!rows.length) return { first: 0, late: 0 };
  const first = [];
  const late = [];
  for (const t of rows) {
    const mins = Math.floor((now - new Date(t.createdAt).getTime()) / 60000);
    const stage = mins >= wait ? 2 : 1;
    if (stage <= (t.remindedStage || 0)) continue;
    // Claim the stage so a second server/restart doesn't repeat it.
    const r = await prisma.walletTransaction.updateMany({ where: { id: t.id, status: 'PENDING', remindedStage: t.remindedStage || 0 }, data: { remindedStage: stage } });
    if (r.count !== 1) continue;
    (stage === 2 ? late : first).push({ t, mins });
    if (stage === 2) {
      Promise.resolve(require('./notify').notify(t.customerId, 'Still checking your transfer', `Your ${naira(t.amount)} transfer is taking longer than usual to confirm. Support has been alerted — you'll be notified as soon as it's checked. No need to send it again.`)).catch(() => {});
    }
  }
  const alert = require('./adminAlert').alertAdmins;
  const total = (list) => naira(list.reduce((s, x) => s + Number(x.t.amount), 0));
  if (late.length) {
    await alert('Funding requests overdue', `${late.length} business-account funding request${late.length === 1 ? '' : 's'} (${total(late)}) waiting over ${wait} minutes. The customer${late.length === 1 ? ' has' : 's have'} been told it's taking longer. Check your bank and approve or reject.`, '/admin/pending-funding').catch(() => {});
  }
  if (first.length) {
    await alert('Funding requests waiting', `${first.length} business-account funding request${first.length === 1 ? '' : 's'} (${total(first)}) waiting ${firstAt}+ minutes. Check your bank and approve or reject.`, '/admin/pending-funding').catch(() => {});
  }
  return { first: first.length, late: late.length };
}

function start() {
  if (process.env.DISABLE_SCHEDULER === '1') return;
  require('./quietClock').every('manual funding reminders', 5 * 60 * 1000, () => tick().catch((e) => console.error('manual funding reminders failed:', e.message)), { firstAfter: 60 * 1000 });
}

module.exports = { tick, start };
