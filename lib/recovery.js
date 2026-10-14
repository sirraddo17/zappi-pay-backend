// "It's working again" notices. When a customer's purchase, bank transfer
// or send fails because of us or a partner (provider down, network, bank,
// system error — not a wrong number, meter or account), we remember it.
// As soon as the same service succeeds again for anyone, each affected
// customer gets one polite notice: it's fixed, please try again, sorry.
//
// Rules: only failures from the last 48 hours; at most one notice per
// customer per service per 24 hours; nobody is told if they already
// succeeded with that service themselves since.

const prisma = require('./prisma');
const { notify } = require('./notify');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const WITHIN = 48 * HOUR;
const COOLDOWN = 24 * HOUR;
const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

// Failures the customer can fix themselves — no "it's back" notice for these.
// A known VTpass code decides it (lib/vtpassCodes.js); otherwise the text.
const CUSTOMER_TEXT = /invalid (meter|smart ?card|account|number|phone|customer|iuc|profile)|wrong|incorrect|not found|unknown (meter|smartcard|account|number)|below (the )?minimum|above (the )?maximum|exceeds|duplicate|not eligible|insufficient|name (does not|doesn['’]t) match|blocked by the customer/i;

function customerCaused({ code, reason } = {}) {
  const c = String(code ?? '');
  if (/^\d{3}$/.test(c)) {
    const known = require('./vtpassCodes').CODES[c];
    if (known && known[1] === 'customer') return true;
    if (known && known[1] === 'account') return false; // e.g. 027, 087 — never the customer
  }
  return CUSTOMER_TEXT.test(String(reason || ''));
}

async function enabled() {
  try { const s = await require('./vtpass').getSettings(); return s.recoveryNoticesEnabled !== false; } catch { return true; }
}

// Remember a failure caused by a service/partner/system problem.
async function failed({ customerId, key, label, amount, retryLink, code, reason }) {
  try {
    if (!customerId || !key) return;
    if (customerCaused({ code, reason })) return;
    if (!(await enabled())) return;
    const open = await prisma.recoveryNotice.findFirst({ where: { customerId, key, notifiedAt: null, resolvedAt: null } });
    // A repeat failure refreshes the time; keep earlier details it doesn't carry.
    const data = {
      label: String(label || open?.label || key).slice(0, 80),
      amount: amount != null ? Number(amount) : open?.amount ?? null,
      retryLink: retryLink || open?.retryLink || null,
      reason: reason ? String(reason).slice(0, 200) : open?.reason || null,
      failedAt: new Date(),
    };
    if (open) await prisma.recoveryNotice.update({ where: { id: open.id }, data });
    else await prisma.recoveryNotice.create({ data: { customerId, key, ...data } });
  } catch (error) {
    console.error('recovery.failed:', error.message);
  }
}

// The service just worked (for `customerId`, if given). Tell everyone
// still waiting on it.
async function worked(key, { customerId } = {}) {
  try {
    if (!key) return 0;
    const now = Date.now();
    if (customerId) await prisma.recoveryNotice.updateMany({ where: { customerId, key, notifiedAt: null, resolvedAt: null }, data: { resolvedAt: new Date() } });
    if (!(await enabled())) return 0;
    const waiting = await prisma.recoveryNotice.findMany({ where: { key, notifiedAt: null, resolvedAt: null, failedAt: { gte: new Date(now - WITHIN), lte: new Date(now - MIN) } }, take: 500 });
    let sent = 0;
    for (const r of waiting) {
      const claim = await prisma.recoveryNotice.updateMany({ where: { id: r.id, notifiedAt: null, resolvedAt: null }, data: { notifiedAt: new Date() } });
      if (claim.count !== 1) continue;
      const recent = await prisma.recoveryNotice.findFirst({ where: { customerId: r.customerId, key, id: { not: r.id }, notifiedAt: { gte: new Date(now - COOLDOWN) } } });
      if (recent) continue; // already told today
      const what = key === 'bank-transfer' ? 'bank transfer' : key === 'send-money' ? 'transfer' : 'purchase';
      notify(r.customerId, `${r.label} is working again ✅`,
        `Good news! ${r.label} is fully restored and working well again. Earlier your ${what}${r.amount ? ` of ${naira(r.amount)}` : ''} couldn’t go through because of a problem on our side${key === 'bank-transfer' ? ' or the bank’s' : ''} — your money was returned to your wallet. You can try again now. We’re very sorry for the inconvenience, and thank you for your patience 🙏`,
        { category: 'TRANSACTION', link: r.retryLink || undefined });
      sent += 1;
    }
    // Clear out old ones nobody needs any more.
    await prisma.recoveryNotice.updateMany({ where: { notifiedAt: null, resolvedAt: null, failedAt: { lt: new Date(now - WITHIN) } }, data: { resolvedAt: new Date() } }).catch(() => {});
    return sent;
  } catch (error) {
    console.error('recovery.worked:', error.message);
    return 0;
  }
}

// What a purchase is called and where to retry it.
const SLUG = { AIRTIME: 'airtime', DATA: 'data', ELECTRICITY: 'electricity', CABLE: 'cable', EDUCATION: 'education', INTERNET: 'internet', BETTING: 'betting' };
function orderInfo(order) {
  const name = require('./partnerHealth').nameOf(order.provider);
  const slug = SLUG[order.service];
  const retryLink = order.service === 'INTERNATIONAL' ? '/international' : order.service === 'INSURANCE' ? '/insurance' : slug ? `/buy/${slug}` : '/';
  return { key: order.provider || order.service, label: name, retryLink };
}
function payloadCode(payload) {
  return payload?.code ?? payload?.content?.code ?? null;
}
function payloadReason(payload) {
  return payload?.response_description || payload?.content?.error || payload?.content?.errors || payload?.message || '';
}

module.exports = { failed, worked, customerCaused, orderInfo, payloadCode, payloadReason };
