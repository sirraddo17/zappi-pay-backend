const express = require('express');
const prisma = require('../lib/prisma');
const { requireAdminAuth } = require('../lib/auth');
const { notify } = require('../lib/notify');

// Owner money tools (staff gate keeps support staff out; the AI assistant
// is refused):
//  • card payments: list, re-check one with Flutterwave, record a chargeback
//  • manual payout: record money you sent to a customer's bank yourself
//    (Send to Bank off, or closing an account that still has a balance)
const router = express.Router();
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const naira = (n) => `₦${r2(n).toLocaleString('en-NG')}`;
const noAi = (req, res) => (req.headers['x-admin-assistant'] ? res.status(403).json({ error: 'Only a person can do this.' }) : null);
const audit = (req, action, details) => prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action, details } }).catch(() => {});

// --- Card payments --------------------------------------------------------

router.get('/admin/card-payments', requireAdminAuth, async (req, res) => {
  try {
    const where = {};
    if (req.query.customerId) where.customerId = String(req.query.customerId);
    if (['PENDING', 'PAID', 'FAILED', 'CHARGEBACK'].includes(req.query.status)) where.status = req.query.status;
    const rows = await prisma.cardPayment.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
    const ids = [...new Set(rows.map((r) => r.customerId))];
    const people = ids.length ? await prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, phone: true } }) : [];
    const byId = Object.fromEntries(people.map((c) => [c.id, c]));
    res.json({ payments: rows.map((r) => ({ ...r, amount: Number(r.amount), fee: Number(r.fee), total: Number(r.total), customer: byId[r.customerId] || null })) });
  } catch (error) {
    console.error('GET /admin/card-payments failed:', error);
    res.status(500).json({ error: 'Could not load card payments.' });
  }
});

// "Card charged but wallet not credited": ask Flutterwave again. A payment
// the sweeper gave up on (FAILED after 24h) is checked again too — it's
// only credited if Flutterwave says it was successful, and never twice.
router.post('/admin/card-payments/:txRef/recheck', requireAdminAuth, async (req, res) => {
  if (noAi(req, res)) return;
  try {
    const p = await prisma.cardPayment.findUnique({ where: { txRef: req.params.txRef } });
    if (!p) return res.status(404).json({ error: 'Card payment not found.' });
    if (p.status === 'CHARGEBACK') return res.status(409).json({ error: 'This payment was charged back.' });
    const wasFailed = p.status === 'FAILED';
    if (wasFailed) await prisma.cardPayment.updateMany({ where: { id: p.id, status: 'FAILED' }, data: { status: 'PENDING' } });
    const r = await require('../lib/flutterwave').verifyAndCredit(p.txRef);
    // Still not paid → put a given-up payment back as it was.
    if (!r.credited && !r.already && wasFailed) await prisma.cardPayment.updateMany({ where: { id: p.id, status: 'PENDING' }, data: { status: 'FAILED' } });
    await audit(req, 'CARD_PAYMENT_RECHECKED', { txRef: p.txRef, result: r });
    const status = r.credited ? 'PAID' : r.already ? 'PAID' : r.status || (wasFailed ? 'FAILED' : 'PENDING');
    res.json({ ...r, status, message: r.credited ? `Credited ${naira(r.amount ?? p.amount)} to the wallet.` : r.already ? 'Already credited earlier.' : status === 'FAILED' ? 'Flutterwave says this payment failed — nothing to credit.' : r.reason === 'amount mismatch' ? 'Flutterwave shows a different amount — check the Flutterwave dashboard.' : 'Flutterwave hasn’t confirmed it yet. Try again later.' });
  } catch (error) {
    console.error('POST /admin/card-payments/:txRef/recheck failed:', error);
    res.status(500).json({ error: 'Could not check with Flutterwave.' });
  }
});

// The card owner disputed the payment and the bank took the money back
// (often a stolen card). Takes back what's still in the wallet, freezes
// the account and signs it out everywhere. Any shortfall is shown so you
// can collect it before unfreezing.
router.post('/admin/card-payments/:txRef/chargeback', requireAdminAuth, async (req, res) => {
  if (noAi(req, res)) return;
  try {
    const note = String(req.body?.note || '').trim().slice(0, 200);
    if (note.length < 5) return res.status(400).json({ error: 'Add a short note (e.g. Flutterwave chargeback reference).' });
    const p = await prisma.cardPayment.findUnique({ where: { txRef: req.params.txRef } });
    if (!p) return res.status(404).json({ error: 'Card payment not found.' });
    if (p.status !== 'PAID') return res.status(409).json({ error: p.status === 'CHARGEBACK' ? 'Already recorded as a chargeback.' : 'Only a paid card payment can be charged back.' });
    const credited = Number(p.amount);
    let taken = 0;
    await prisma.$transaction(async (tx) => {
      const r = await tx.cardPayment.updateMany({ where: { id: p.id, status: 'PAID' }, data: { status: 'CHARGEBACK' } });
      if (r.count !== 1) throw Object.assign(new Error('Already recorded as a chargeback.'), { status: 409 });
      const c = await tx.customer.findUnique({ where: { id: p.customerId }, select: { walletBalance: true } });
      taken = r2(Math.max(0, Math.min(credited, Number(c.walletBalance))));
      const short = r2(credited - taken);
      if (taken > 0) {
        await tx.customer.update({ where: { id: p.customerId }, data: { walletBalance: { decrement: taken } } });
        await tx.walletTransaction.create({ data: { customerId: p.customerId, type: 'DEBIT', amount: taken, status: 'APPROVED', reference: `CB-${p.txRef}`, providerRef: `CB-${p.txRef}`, note: `Card payment reversed by the card owner's bank (chargeback)${short > 0 ? ` — ${naira(short)} still owed` : ''}`, reviewedByAdminId: req.admin.adminId, reviewedAt: new Date() } });
      }
      await tx.customer.update({ where: { id: p.customerId }, data: { active: false, frozenAt: new Date(), frozenReason: `Card chargeback ${naira(credited)} (${p.txRef})${short > 0 ? ` — ${naira(short)} not recovered` : ''}. ${note}`.slice(0, 200) } });
    });
    await require('../lib/sessions').revokeAll(p.customerId).catch(() => {});
    const short = r2(credited - taken);
    await audit(req, 'CARD_CHARGEBACK', { txRef: p.txRef, customerId: p.customerId, credited, taken, short, note });
    res.json({ taken, short, message: `Took back ${naira(taken)} and froze the account.${short > 0 ? ` ${naira(short)} was already spent — collect it before unfreezing.` : ''}` });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('POST /admin/card-payments/:txRef/chargeback failed:', error);
    res.status(500).json({ error: 'Could not record the chargeback.' });
  }
});

// --- Manual payout ----------------------------------------------------------

// You sent the customer's money to their bank yourself (from your bank or
// partner dashboard). This takes it off their wallet with a full record.
router.post('/admin/customers/:id/manual-payout', requireAdminAuth, async (req, res) => {
  if (noAi(req, res)) return;
  try {
    const b = req.body || {};
    const amount = r2(b.amount);
    const bankName = String(b.bankName || '').trim().slice(0, 60);
    const accountNumber = String(b.accountNumber || '').replace(/\D/g, '');
    const accountName = String(b.accountName || '').trim().slice(0, 80);
    const reference = String(b.reference || '').trim().slice(0, 80);
    const note = String(b.note || '').trim().slice(0, 200);
    if (!(amount > 0)) return res.status(400).json({ error: 'Enter the amount you sent.' });
    if (!bankName || accountNumber.length !== 10 || !accountName) return res.status(400).json({ error: 'Enter the bank, the 10-digit account number and the account name you sent it to.' });
    if (reference.length < 4) return res.status(400).json({ error: 'Enter the transfer reference / session ID from your bank, so it can be traced.' });
    const c = await prisma.customer.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, walletBalance: true } });
    if (!c) return res.status(404).json({ error: 'Customer not found.' });
    const masked = `••${accountNumber.slice(-4)}`;
    try {
      await prisma.$transaction(async (tx) => {
        const r = await tx.customer.updateMany({ where: { id: c.id, walletBalance: { gte: amount } }, data: { walletBalance: { decrement: amount } } });
        if (r.count !== 1) throw Object.assign(new Error(`The wallet only has ${naira(c.walletBalance)}.`), { status: 400 });
        await tx.walletTransaction.create({ data: { customerId: c.id, type: 'DEBIT', amount, status: 'APPROVED', reference: `MP-${reference}`, providerRef: `MP-${reference}`, note: `Paid out to ${bankName} ${masked} (${accountName}) by ZAPPI PAY support — ref ${reference}${note ? ` · ${note}` : ''}`, reviewedByAdminId: req.admin.adminId, reviewedAt: new Date() } });
      });
    } catch (error) {
      if (error.code === 'P2002') return res.status(409).json({ error: 'That reference was already recorded.' });
      throw error;
    }
    await audit(req, 'MANUAL_PAYOUT', { customerId: c.id, amount, bankName, accountNumber, accountName, reference, note: note || undefined });
    Promise.resolve(notify(c.id, 'Money sent to your bank', `${naira(amount)} from your ZAPPI PAY wallet was sent to ${bankName} ${masked} (${accountName}). Ref: ${reference}.`, { category: 'TRANSACTION' })).catch(() => {});
    res.json({ ok: true, message: `Recorded: ${naira(amount)} paid out to ${bankName} ${masked}.` });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('POST /admin/customers/:id/manual-payout failed:', error);
    res.status(500).json({ error: 'Could not record the payout.' });
  }
});

module.exports = router;
