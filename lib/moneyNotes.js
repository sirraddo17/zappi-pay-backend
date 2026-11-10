// Clear, audit-friendly notes for manual money corrections (credit, debit,
// refund, manual payout). A good note says WHAT, WHY, the EVIDENCE (order /
// ticket / partner reference) and WHO approved — so the wallet history and
// the audit log never look like unexplained money moving. Read-only: this
// only writes text; the admin still makes (or approves) the change.
// Used by the "✨ Suggest note" buttons and the admin AI (suggest_money_note).

const prisma = require('./prisma');

const LAGOS = 60 * 60 * 1000;
const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d = new Date()) => new Date(new Date(d).getTime() + LAGOS).toISOString().slice(0, 10);
const clean = (v, n = 80) => String(v || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// Reasons the admin can pick (what happened).
const REASONS = {
  FAILED_ORDER: { kind: 'CREDIT', label: 'Refund for a failed purchase not refunded automatically', text: 'Refund: failed purchase not auto-refunded' },
  MISSING_FUNDING: { kind: 'CREDIT', label: 'Bank funding confirmed by the partner but not credited', text: 'Funding credit: partner-confirmed deposit not auto-credited' },
  GOODWILL: { kind: 'CREDIT', label: 'Goodwill / apology credit (our mistake)', text: 'Goodwill credit' },
  REWARD_MISSED: { kind: 'CREDIT', label: 'Reward that should have been paid', text: 'Missed reward credit' },
  TEST_REFUND: { kind: 'CREDIT', label: 'Owner test: money back for a test transaction', text: 'Owner test refund' },
  DUPLICATE_CREDIT: { kind: 'DEBIT', label: 'Reverse a duplicate / wrong credit', text: 'Reversal: duplicate or wrong credit' },
  DELIVERED_AFTER_REFUND: { kind: 'DEBIT', label: 'Order was delivered after it was refunded', text: 'Reversal: refund on an order the provider later delivered' },
  TEST_CLEANUP: { kind: 'DEBIT', label: 'Owner test: clear leftover test money', text: 'Owner test balance cleared' },
  CORRECTION: { kind: 'EITHER', label: 'Correction of an earlier admin error', text: 'Correction of an earlier admin adjustment' },
  MANUAL_PAYOUT: { kind: 'DEBIT', label: 'Customer was paid out to their bank by support', text: 'Manual payout to customer bank' },
};

async function suggest({ type, amount, customerId, reason, orderId, ticketId, reference, detail, adminName } = {}) {
  const t = String(type || '').toUpperCase() === 'DEBIT' ? 'DEBIT' : 'CREDIT';
  const r = REASONS[String(reason || '').toUpperCase()] || null;
  const amt = Number(amount) > 0 ? naira(amount) : null;
  const facts = [];
  const checklist = [];
  const warnings = [];

  const customer = customerId ? await prisma.customer.findUnique({ where: { id: String(customerId) }, select: { id: true, name: true, isTestAccount: true } }).catch(() => null) : null;
  if (customer?.isTestAccount) facts.push('test account');

  let order = null;
  if (orderId || (reference && /^\d{12}/.test(String(reference)))) {
    order = await prisma.order.findFirst({ where: orderId ? { id: String(orderId) } : { vtpassRequestId: String(reference) }, select: { id: true, service: true, provider: true, amount: true, status: true, vtpassRequestId: true, customerId: true } }).catch(() => null);
    if (order) {
      facts.push(`order ${order.vtpassRequestId || order.id} (${String(order.service).toLowerCase()} ${order.provider}, ${naira(order.amount)}, ${order.status})`);
      if (customer && order.customerId !== customer.id) warnings.push('That order belongs to a different customer.');
      if (t === 'CREDIT' && order.status === 'SUCCESS') warnings.push('This order is SUCCESS: refund only if the provider confirmed it was NOT delivered (use "Ask the provider" first).');
      if (t === 'CREDIT' && order.status === 'REFUNDED') warnings.push('This order was already refunded automatically — a second refund would pay twice.');
      const already = await prisma.walletTransaction.findFirst({ where: { type: 'REFUND', reference: order.vtpassRequestId || '-' } }).catch(() => null);
      if (t === 'CREDIT' && already) warnings.push(`A refund for this order already exists (${naira(already.amount)}).`);
    }
  }
  if (ticketId) facts.push(`ticket ${String(ticketId).slice(-8)}`);
  if (reference && !order) facts.push(`ref ${clean(reference, 40)}`);
  if (detail) facts.push(clean(detail, 70));

  const head = r ? r.text : t === 'CREDIT' ? 'Manual credit' : 'Manual debit';
  const note = clean([`${head}${amt ? ` ${amt}` : ''}`, facts.join('; '), `approved by ${clean(adminName, 30) || 'owner'} ${day()}`].filter(Boolean).join(' — '), 200);

  if (r && r.kind !== 'EITHER' && r.kind !== t) warnings.push(`"${r.label}" is normally a ${r.kind.toLowerCase()}, not a ${t.toLowerCase()}.`);
  if (!facts.length) checklist.push('Add the evidence: order reference, ticket, or the partner/bank reference (session ID).');
  if (reason === 'MISSING_FUNDING') checklist.push('Prefer "Funding not showing? Check with the bank partners" — it credits with the partner’s own reference so it can never be credited twice. Use a manual credit only if that check can’t find it.');
  if (reason === 'GOODWILL') checklist.push('Keep goodwill credits small and say why in the support reply.');
  if (t === 'DEBIT') checklist.push('Tell the customer before or right after a debit, with the reason.');
  checklist.push('Keep a screenshot of the evidence (receipt, partner dashboard) in the support ticket.');

  return { note, type: t, reasonLabel: r?.label || null, warnings, checklist, reasons: Object.entries(REASONS).map(([k, v]) => ({ key: k, kind: v.kind, label: v.label })) };
}

module.exports = { suggest, REASONS };
