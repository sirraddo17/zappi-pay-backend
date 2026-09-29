const express = require('express');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { requireAdminAuth, hashPassword } = require('../lib/auth');
const { notify } = require('../lib/notify');
const { getSettings } = require('../lib/vtpass');
const { roleOf } = require('../lib/staffAccess');

// Support staff escalations: sensitive actions a SUPPORT staff member
// asks an OWNER to approve. The customer is told it's with a senior
// admin and when to expect an answer. Approving runs the action.
const router = express.Router();

const TYPES = {
  PASSWORD_RESET: 'Reset password',
  ORDER_REFUND: 'Refund a failed purchase',
  WALLET_CREDIT: 'Credit wallet',
  WALLET_DEBIT: 'Debit wallet',
  SECURITY_RESET: 'Reset date of birth & security question',
  REACTIVATE: 'Reactivate account',
  FUNDING_MISSING: 'Bank funding not credited',
  TRANSFER_ISSUE: 'Send-to-bank problem',
  OTHER: 'Other',
};
const naira = (n) => `₦${Number(n || 0).toLocaleString()}`;

async function me(req) {
  const a = await prisma.adminUser.findUnique({ where: { id: req.admin.adminId }, select: { id: true, name: true, email: true, role: true } });
  return a ? { ...a, role: a.role || 'OWNER' } : null;
}
async function audit(req, action, details) {
  await prisma.auditLog.create({ data: { actorAdminId: req.admin.adminId, action, details } }).catch(() => {});
}
function newRef() {
  return `ESC-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}
function hoursText(h) {
  return h % 24 === 0 ? `${h / 24} day${h === 24 ? '' : 's'}` : `${h} hours`;
}

router.get('/admin/me', requireAdminAuth, async (req, res) => {
  const a = await me(req).catch(() => null);
  if (!a) return res.status(404).json({ error: 'Admin not found.' });
  res.json({ admin: a });
});

// --- Create --------------------------------------------------------

router.post('/admin/escalations', requireAdminAuth, async (req, res) => {
  try {
    const staff = await me(req);
    const b = req.body || {};
    const type = String(b.type || '');
    if (!TYPES[type]) return res.status(400).json({ error: 'Choose what needs approval.' });
    const reason = String(b.reason || '').trim().slice(0, 500);
    if (reason.length < 10) return res.status(400).json({ error: 'Explain what happened and what you checked (at least a sentence).' });
    const customer = await prisma.customer.findUnique({ where: { id: String(b.customerId || '') }, select: { id: true, name: true, active: true, walletBalance: true } });
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });

    let amount = null;
    let order = null;
    const checks = {
      identityVerified: Boolean(b.identityVerified),
      debitConfirmed: Boolean(b.debitConfirmed),
      staffNote: String(b.checkNote || '').trim().slice(0, 300) || null,
    };
    // Latest identity check result the app itself recorded (last 2h).
    const idCheck = await prisma.auditLog.findFirst({
      where: { action: 'IDENTITY_CHECK', createdAt: { gte: new Date(Date.now() - 2 * 3600 * 1000) }, details: { path: ['customerId'], equals: customer.id } },
      orderBy: { createdAt: 'desc' },
    }).catch(() => null);
    if (idCheck) checks.appIdentityCheck = { dob: idCheck.details.dob || null, answer: idCheck.details.answer || null, at: idCheck.createdAt };

    if (['PASSWORD_RESET', 'SECURITY_RESET', 'REACTIVATE'].includes(type) && !checks.identityVerified) {
      return res.status(400).json({ error: 'Confirm you checked it’s really the customer (date of birth / security question) first.' });
    }
    if (type === 'REACTIVATE' && customer.active) return res.status(400).json({ error: 'This account is already active.' });

    if (type === 'WALLET_CREDIT' || type === 'WALLET_DEBIT') {
      amount = Math.round(Number(b.amount) * 100) / 100;
      if (!(amount > 0) || amount > 1000000) return res.status(400).json({ error: 'Enter the amount.' });
    }
    if (type === 'ORDER_REFUND' || (type === 'WALLET_CREDIT' && b.orderId)) {
      order = await prisma.order.findUnique({ where: { id: String(b.orderId || '') } });
      if (!order || order.customerId !== customer.id) return res.status(400).json({ error: 'Pick the purchase this is about.' });
    }
    if (type === 'ORDER_REFUND') {
      if (!checks.debitConfirmed) return res.status(400).json({ error: 'Confirm the customer was debited and the service was not delivered.' });
      // Ask VTpass first — most "not delivered" orders settle here on their own.
      if (order.status === 'PENDING') {
        const r = await require('../lib/purchase').recheckOrder(order.id).catch(() => null);
        const fresh = await prisma.order.findUnique({ where: { id: order.id } });
        if (fresh.status !== 'PENDING') {
          return res.json({ resolved: true, status: fresh.status, message: fresh.status === 'SUCCESS' ? 'VTpass says this was delivered, so no refund is due. Ask the customer to check again, or report it to VTpass.' : 'VTpass confirmed it failed — the customer has been refunded automatically.' });
        }
        checks.vtpassStatus = r?.status || 'PENDING';
      } else if (order.status === 'SUCCESS') {
        return res.status(400).json({ error: 'VTpass marked this purchase as delivered. Report it to VTpass first; if they confirm it wasn’t delivered, request a wallet credit.' });
      } else {
        return res.status(400).json({ error: `This purchase is already ${order.status.toLowerCase()} — nothing to refund.` });
      }
      amount = Number(order.amount);
    }

    let transfer = null;
    if (type === 'FUNDING_MISSING') {
      amount = Math.round(Number(b.amount) * 100) / 100;
      if (!(amount > 0) || amount > 1000000) return res.status(400).json({ error: 'Enter the amount the customer sent.' });
      checks.bankReference = String(b.bankReference || '').trim().slice(0, 80) || null;
      // Ask Monnify first — most "not credited" payments land here on their own.
      const full = await prisma.customer.findUnique({ where: { id: customer.id } });
      if (full.bankAccountRef && (await require('../lib/monnify').isConfigured())) {
        const r = await require('../lib/monnify').syncCustomerPayments(full).catch(() => null);
        if (r?.credited > 0) return res.json({ resolved: true, message: `Found it — ${naira(r.amount)} was just added to the customer's wallet. No approval needed.` });
        checks.monnifySync = 'No uncredited payment found at Monnify';
      }
    }
    if (type === 'TRANSFER_ISSUE') {
      transfer = await prisma.bankTransfer.findUnique({ where: { id: String(b.transferId || '') } });
      if (!transfer || transfer.customerId !== customer.id) return res.status(400).json({ error: 'Pick the transfer this is about.' });
      if (['PROCESSING', 'PENDING_AUTHORIZATION', 'SUCCESS'].includes(transfer.status)) {
        const r = await require('../lib/disbursement').refreshStatus(transfer).catch(() => null);
        const fresh = await prisma.bankTransfer.findUnique({ where: { id: transfer.id } });
        if (['FAILED', 'REVERSED', 'CANCELLED'].includes(fresh.status)) {
          return res.json({ resolved: true, message: 'Monnify confirmed the transfer failed — the customer has been refunded automatically.' });
        }
        checks.monnifyStatus = r?.status || fresh.status;
        transfer = fresh;
      }
      amount = Number(transfer.amount);
    }

    const dup = await prisma.escalation.findFirst({ where: { customerId: customer.id, type, status: { in: ['PENDING', 'PROCESSING'] }, ...(order ? { orderId: order.id } : {}), ...(transfer ? { transferId: transfer.id } : {}) } });
    if (dup) return res.status(409).json({ error: `There's already a pending request for this (${dup.ref}).` });

    const settings = await getSettings();
    const hours = Math.min(168, Math.max(1, Number(settings.escalationHours || 24)));
    const esc = await prisma.escalation.create({
      data: {
        ref: newRef(), type, customerId: customer.id, orderId: order?.id || null, transferId: transfer?.id || null, amount, reason, checks,
        createdById: staff.id, createdByName: staff.name, dueAt: new Date(Date.now() + hours * 3600 * 1000),
      },
    });
    await audit(req, 'ESCALATION_CREATED', { ref: esc.ref, type, customerId: customer.id, amount });
    notify(customer.id, 'Request Escalated', `Your request (${esc.ref}) has been passed to a senior admin for approval. You'll get an update within ${hoursText(hours)}.`);
    require('../lib/adminAlert').alertAdmins('Approval needed', `${staff.name} asks: ${TYPES[type]}${amount ? ` ${naira(amount)}` : ''} for ${customer.name} (${esc.ref}).`, '/admin/escalations');
    res.status(201).json({ escalation: esc });
  } catch (error) {
    if (error.code === 'P2002') return res.status(409).json({ error: 'Please try again.' });
    console.error('POST /admin/escalations failed:', error);
    res.status(500).json({ error: 'Could not send the request.' });
  }
});

// --- List ------------------------------------------------------------

router.get('/admin/escalations', requireAdminAuth, async (req, res) => {
  try {
    const role = await roleOf(req.admin.adminId);
    const status = String(req.query.status || 'PENDING');
    const where = {
      ...(status === 'ALL' ? {} : status === 'PENDING' ? { status: { in: ['PENDING', 'PROCESSING'] } } : { status }),
      ...(role === 'SUPPORT' ? { createdById: req.admin.adminId } : {}),
    };
    const rows = await prisma.escalation.findMany({ where, orderBy: { createdAt: status === 'PENDING' ? 'asc' : 'desc' }, take: 200 });
    const customers = await prisma.customer.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.customerId))] } }, select: { id: true, name: true, phone: true, walletBalance: true } });
    const orders = await prisma.order.findMany({ where: { id: { in: rows.map((r) => r.orderId).filter(Boolean) } }, select: { id: true, service: true, recipient: true, amount: true, status: true, createdAt: true, vtpassRequestId: true } });
    const transfers = await prisma.bankTransfer.findMany({ where: { id: { in: rows.map((r) => r.transferId).filter(Boolean) } }, select: { id: true, amount: true, fee: true, bankName: true, accountNumber: true, accountName: true, status: true, reference: true, createdAt: true } });
    const tMap = Object.fromEntries(transfers.map((t) => [t.id, t]));
    const cMap = Object.fromEntries(customers.map((c) => [c.id, c]));
    const oMap = Object.fromEntries(orders.map((o) => [o.id, o]));
    const pendingCount = await prisma.escalation.count({ where: { status: { in: ['PENDING', 'PROCESSING'] }, ...(role === 'SUPPORT' ? { createdById: req.admin.adminId } : {}) } });
    res.json({ role, types: TYPES, pendingCount, escalations: rows.map((r) => ({ ...r, customer: cMap[r.customerId] || null, order: r.orderId ? oMap[r.orderId] || null : null, transfer: r.transferId ? tMap[r.transferId] || null : null })) });
  } catch (error) {
    console.error('GET /admin/escalations failed:', error);
    res.status(500).json({ error: 'Could not load requests.' });
  }
});

// --- Approve / reject (OWNER only — staffGate blocks SUPPORT) --------

const TEMP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function tempPassword() {
  let out = '';
  for (const b of crypto.randomBytes(8)) out += TEMP_ALPHABET[b % TEMP_ALPHABET.length];
  return `ZP-${out}`;
}

async function execute(esc, req) {
  const note = `Approved request ${esc.ref}: ${esc.reason}`.slice(0, 250);
  switch (esc.type) {
    case 'PASSWORD_RESET': {
      const temporaryPassword = tempPassword();
      const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);
      await prisma.customer.update({ where: { id: esc.customerId }, data: { passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true, tempPasswordExpiresAt: expiresAt } });
      notify(esc.customerId, 'Password Reset Approved', 'Your password reset was approved. Support will send you a temporary password — log in with it and choose a new one.');
      return { summary: 'Temporary password issued', secret: { temporaryPassword, expiresAt } };
    }
    case 'ORDER_REFUND': {
      const r = await require('../lib/purchase').forceSettle(esc.orderId, 'FAILED');
      if (r.status !== 'FAILED' && r.status !== 'REFUNDED') throw new Error(`The purchase is now ${String(r.status).toLowerCase()}, so it wasn't refunded.`);
      return { summary: `Purchase marked failed and ${naira(esc.amount)} refunded` };
    }
    case 'WALLET_CREDIT':
    case 'WALLET_DEBIT': {
      const credit = esc.type === 'WALLET_CREDIT';
      const amt = Number(esc.amount);
      await prisma.$transaction(async (tx) => {
        if (!credit) {
          const r = await tx.customer.updateMany({ where: { id: esc.customerId, walletBalance: { gte: amt } }, data: { walletBalance: { decrement: amt } } });
          if (r.count !== 1) throw new Error('The customer no longer has enough balance for this debit.');
        } else {
          await tx.customer.update({ where: { id: esc.customerId }, data: { walletBalance: { increment: amt } } });
        }
        await tx.walletTransaction.create({ data: { customerId: esc.customerId, type: credit ? 'FUND' : 'DEBIT', amount: amt, status: 'APPROVED', note, reviewedByAdminId: req.admin.adminId, reviewedAt: new Date() } });
      });
      notify(esc.customerId, credit ? 'Wallet Credited' : 'Wallet Debited', `${naira(amt)} was ${credit ? 'added to' : 'taken from'} your wallet (request ${esc.ref}).`);
      return { summary: `${naira(amt)} ${credit ? 'credited' : 'debited'}` };
    }
    case 'FUNDING_MISSING': {
      // The owner confirmed the money arrived (Monnify dashboard / bank).
      const amt = Number(esc.amount);
      await prisma.$transaction([
        prisma.customer.update({ where: { id: esc.customerId }, data: { walletBalance: { increment: amt } } }),
        prisma.walletTransaction.create({ data: { customerId: esc.customerId, type: 'FUND', amount: amt, status: 'APPROVED', note: `Bank funding credited after review (${esc.ref})`, reviewedByAdminId: req.admin.adminId, reviewedAt: new Date() } }),
      ]);
      notify(esc.customerId, 'Wallet Funded', `${naira(amt)} from your bank transfer has been added to your wallet (request ${esc.ref}).`);
      return { summary: `${naira(amt)} credited` };
    }
    case 'TRANSFER_ISSUE': {
      const t = await prisma.bankTransfer.findUnique({ where: { id: esc.transferId } });
      let status = t?.status;
      if (t && ['PROCESSING', 'PENDING_AUTHORIZATION', 'SUCCESS'].includes(t.status)) status = (await require('../lib/disbursement').refreshStatus(t).catch(() => ({ status: t.status }))).status;
      notify(esc.customerId, 'Transfer Update', `We've reviewed your bank transfer (request ${esc.ref}). ${['FAILED', 'REVERSED', 'CANCELLED'].includes(status) ? 'It did not go through, and the money is back in your wallet.' : 'We are following up with our payment partner and will update you.'}`);
      return { summary: `Reviewed — transfer status ${String(status || 'unknown').toLowerCase()}` };
    }
    case 'SECURITY_RESET':
      await prisma.customer.update({ where: { id: esc.customerId }, data: { dateOfBirth: null, securityQuestion: null, securityAnswerHash: null } });
      notify(esc.customerId, 'Security Details Reset', 'Your date of birth and security question were reset. Please set them again in Profile → Security details.');
      return { summary: 'Security details cleared' };
    case 'REACTIVATE':
      await prisma.customer.update({ where: { id: esc.customerId }, data: { active: true } });
      notify(esc.customerId, 'Account Reactivated', 'Your ZAPPI PAY account is active again.');
      return { summary: 'Account reactivated' };
    default:
      notify(esc.customerId, 'Request Approved', `Your request (${esc.ref}) was approved. Support will follow up with you.`);
      return { summary: 'Approved — follow up manually' };
  }
}

router.post('/admin/escalations/:id/approve', requireAdminAuth, async (req, res) => {
  const id = req.params.id;
  try {
    const owner = await me(req);
    // Claim it so two admins can't approve the same request twice.
    const claim = await prisma.escalation.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'PROCESSING', reviewedById: owner.id, reviewedByName: owner.name } });
    if (claim.count !== 1) return res.status(409).json({ error: 'This request was already handled.' });
    const esc = await prisma.escalation.findUnique({ where: { id } });
    let out;
    try {
      out = await execute(esc, req);
    } catch (error) {
      await prisma.escalation.update({ where: { id }, data: { status: 'PENDING', reviewedById: null, reviewedByName: null } });
      return res.status(400).json({ error: error.message || 'Could not carry out this request.' });
    }
    const reviewNote = String(req.body?.note || '').trim().slice(0, 300) || null;
    const done = await prisma.escalation.update({ where: { id }, data: { status: 'APPROVED', reviewNote, result: out.summary, reviewedAt: new Date() } });
    await audit(req, 'ESCALATION_APPROVED', { ref: esc.ref, type: esc.type, customerId: esc.customerId, amount: esc.amount ? Number(esc.amount) : undefined, result: out.summary });
    res.json({ escalation: done, ...(out.secret || {}) });
  } catch (error) {
    console.error('POST /admin/escalations/:id/approve failed:', error);
    await prisma.escalation.updateMany({ where: { id, status: 'PROCESSING' }, data: { status: 'PENDING' } }).catch(() => {});
    res.status(500).json({ error: 'Could not approve this request.' });
  }
});

router.post('/admin/escalations/:id/reject', requireAdminAuth, async (req, res) => {
  try {
    const owner = await me(req);
    const reviewNote = String(req.body?.note || '').trim().slice(0, 300);
    if (reviewNote.length < 3) return res.status(400).json({ error: 'Say why (the staff member sees this).' });
    const r = await prisma.escalation.updateMany({ where: { id: req.params.id, status: 'PENDING' }, data: { status: 'REJECTED', reviewNote, reviewedById: owner.id, reviewedByName: owner.name, reviewedAt: new Date() } });
    if (r.count !== 1) return res.status(409).json({ error: 'This request was already handled.' });
    const esc = await prisma.escalation.findUnique({ where: { id: req.params.id } });
    await audit(req, 'ESCALATION_REJECTED', { ref: esc.ref, type: esc.type, customerId: esc.customerId, note: reviewNote });
    notify(esc.customerId, 'Request Update', `Your request (${esc.ref}) could not be approved. Support will contact you with the next steps.`);
    res.json({ escalation: esc });
  } catch (error) {
    console.error('POST /admin/escalations/:id/reject failed:', error);
    res.status(500).json({ error: 'Could not reject this request.' });
  }
});

// --- Missing bank funding: ask Monnify for this customer's payments ------
// Safe for support staff: only credits payments Monnify itself confirms
// were paid into this customer's account, and never the same one twice.
router.post('/admin/customers/:id/check-funding', requireAdminAuth, async (req, res) => {
  try {
    const monnify = require('../lib/monnify');
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });
    if (!customer.bankAccountRef) return res.json({ credited: 0, message: 'This customer has no personal account number yet, so bank funding can’t reach their wallet. For manual funding, the owner approves it under Pending Funding.' });
    if (!(await monnify.isConfigured())) return res.status(503).json({ error: 'Monnify isn’t connected.' });
    const reference = String(req.body?.reference || '').trim();
    let credited = 0;
    let amount = 0;
    let note = '';
    if (reference) {
      const r = await monnify.creditFromTransaction(reference).catch((e) => ({ credited: false, reason: e.message }));
      if (r.credited && r.customerId !== customer.id) note = ' (it belonged to a different customer’s account and was credited to them)';
      if (r.credited && r.customerId === customer.id) { credited += 1; amount += r.amount; }
      if (!r.credited) note = r.reason === 'already credited' ? ' That reference was already credited earlier — check their wallet history.' : ` Monnify didn’t confirm that reference (${r.reason || 'not found'}).`;
    }
    const s = await monnify.syncCustomerPayments(customer);
    credited += s.credited;
    amount += s.amount;
    await audit(req, 'FUNDING_CHECKED', { customerId: customer.id, reference: reference || undefined, credited, amount });
    res.json({
      credited,
      amount,
      message: credited > 0
        ? `Found ${credited} payment${credited === 1 ? '' : 's'} — ${naira(amount)} added to the wallet. The customer was notified.${note}`
        : `Monnify shows no uncredited payment into this customer’s account.${note} If they have a debit alert, ask for the bank's session ID and send it for approval.`,
    });
  } catch (error) {
    console.error('POST /admin/customers/:id/check-funding failed:', error);
    res.status(500).json({ error: 'Could not check with Monnify.' });
  }
});

// --- Report a purchase to VTpass support (email) -----------------------

router.post('/admin/orders/:id/vtpass-escalate', requireAdminAuth, async (req, res) => {
  try {
    const staff = await me(req);
    let order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { customer: { select: { id: true, name: true } } } });
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    // Ask VTpass's own status API first.
    if (order.status === 'PENDING') {
      await require('../lib/purchase').recheckOrder(order.id).catch(() => null);
      order = await prisma.order.findUnique({ where: { id: order.id }, include: { customer: { select: { id: true, name: true } } } });
      if (order.status === 'FAILED' || order.status === 'REFUNDED') {
        return res.json({ resolved: true, message: 'VTpass confirmed it failed — the customer was refunded automatically. No need to email VTpass.' });
      }
    }
    if (order.vtpassEscalatedAt && Date.now() - new Date(order.vtpassEscalatedAt).getTime() < 12 * 3600 * 1000) {
      return res.status(429).json({ error: `Already reported to VTpass on ${new Date(order.vtpassEscalatedAt).toLocaleString('en-NG')}. Wait for their reply (up to 12 hours) before sending again.` });
    }
    const note = String(req.body?.note || '').trim().slice(0, 600);
    if (note.length < 5) return res.status(400).json({ error: 'Describe the problem for VTpass (e.g. "customer says token not received").' });
    const settings = await getSettings();
    const to = String(settings.vtpassSupportEmail || 'support@vtpass.com').trim();
    const t = order.responsePayload?.content?.transactions || {};
    const rows = [
      ['Request ID', order.vtpassRequestId],
      ['VTpass transaction ID', t.transactionId || '—'],
      ['Service', `${order.service} (${order.provider})`],
      ['Recipient / meter / smartcard', order.recipient],
      ['Face value', naira(order.costAmount ?? order.amount)],
      ['Date', new Date(order.createdAt).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })],
      ['Status on our side', order.status],
      ['VTpass status', t.status || order.vtpassStatus || '—'],
      ['Environment', settings.vtpassMode === 'live' ? 'Live' : 'Sandbox'],
    ];
    const text = `Hello VTpass Support,\n\nPlease help us check this transaction.\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nIssue: ${note}\n\nThank you,\nZAPPI PAY (Sirraddo Venture) support`;
    const html = `<p>Hello VTpass Support,</p><p>Please help us check this transaction.</p><table cellpadding="4">${rows.map(([k, v]) => `<tr><td><b>${k}</b></td><td>${String(v).replace(/</g, '&lt;')}</td></tr>`).join('')}</table><p><b>Issue:</b> ${note.replace(/</g, '&lt;')}</p><p>Thank you,<br>ZAPPI PAY (Sirraddo Venture) support</p>`;
    const sent = await require('../lib/email').sendEmail({ to, subject: `Transaction issue — request ID ${order.vtpassRequestId}`, html, text });
    if (!sent?.sent && sent?.reason === 'not_configured') return res.status(503).json({ error: 'Email isn’t set up (Resend), so the report couldn’t be sent. Contact VTpass on 07080631810 or support@vtpass.com with the request ID.' });
    if (sent && sent.sent === false) return res.status(502).json({ error: 'The email could not be sent. Try again, or contact VTpass directly.' });
    await prisma.order.update({ where: { id: order.id }, data: { vtpassEscalatedAt: new Date() } });
    await audit(req, 'VTPASS_ESCALATED', { orderId: order.id, requestId: order.vtpassRequestId, by: staff.name, note });
    notify(order.customerId, 'Issue Reported to Provider', `We've reported your ${order.service.toLowerCase()} purchase for ${order.recipient} to our service provider. This is usually resolved within 24–48 hours — we'll update you.`);
    res.json({ sent: true, to, message: `Reported to VTpass (${to}). The customer was told to expect an update within 24–48 hours.` });
  } catch (error) {
    console.error('POST /admin/orders/:id/vtpass-escalate failed:', error);
    res.status(500).json({ error: 'Could not report this to VTpass.' });
  }
});

module.exports = router;
module.exports.TYPES = TYPES;
