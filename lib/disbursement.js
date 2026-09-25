const crypto = require('crypto');
const prisma = require('./prisma');
const { getSettings } = require('./vtpass');
const { notify } = require('./notify');
const monnify = require('./monnify');
const { checkDailyLimit } = require('./limits');
const { emailAdmins } = require('./adminAlert');

// Send to Bank: wallet → any Nigerian bank account, paid out from the
// business's Monnify wallet. Money safety rules:
//  1. The wallet is debited (amount + fee) in one DB transaction with a
//     "balance is still enough" check BEFORE Monnify is called.
//  2. Only a definite failure refunds. A timeout / network error leaves
//     the transfer PROCESSING until Monnify's status says what happened
//     (it may have gone through), so money is never paid out twice.
//  3. finalize() moves a transfer out of a pending state at most once,
//     so webhook retries, status checks and the admin button can't
//     double-refund.

const PENDING = ['PROCESSING', 'PENDING_AUTHORIZATION'];
const SUCCESS_STATES = ['SUCCESS', 'COMPLETED'];
const FAILED_STATES = ['FAILED', 'REVERSED', 'EXPIRED', 'CANCELLED'];

function money(n) {
  return `₦${Number(n).toLocaleString()}`;
}

function newReference() {
  return `ZPT-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`.toUpperCase();
}

// --- Banks and account name lookup --------------------------------

let banksCache = null;
let banksCachedAt = 0;

async function listBanks() {
  if (banksCache && Date.now() - banksCachedAt < 24 * 60 * 60 * 1000) return banksCache;
  const body = await monnify.api('GET', '/api/v1/banks');
  const banks = (Array.isArray(body) ? body : [])
    .map((b) => ({ code: String(b.code), name: b.name }))
    .filter((b) => b.code && b.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (banks.length) {
    banksCache = banks;
    banksCachedAt = Date.now();
  }
  return banks;
}

async function lookupAccount(bankCode, accountNumber) {
  const body = await monnify.api(
    'GET',
    `/api/v2/disbursements/account/validate?accountNumber=${encodeURIComponent(accountNumber)}&bankCode=${encodeURIComponent(bankCode)}`
  );
  if (!body?.accountName) throw new monnify.MonnifyError('Could not verify that account number.', 400, body);
  return { accountName: body.accountName, accountNumber: body.accountNumber || accountNumber, bankCode };
}

// --- Limits --------------------------------------------------------

async function transferSettings() {
  const s = await getSettings();
  return {
    enabled: Boolean(s.bankTransferEnabled),
    fee: Number(s.bankTransferFee || 0),
    min: Number(s.bankTransferMin || 0),
    max: Number(s.bankTransferMax || 0),
    dailyMax: Number(s.bankTransferDailyMax || 0),
    walletAccount: String(s.monnifyWalletAccount || '').trim(),
  };
}

async function sentToday(customerId) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const agg = await prisma.bankTransfer.aggregate({
    where: { customerId, createdAt: { gte: start }, status: { notIn: ['FAILED', 'REVERSED'] } },
    _sum: { amount: true },
  });
  return Number(agg._sum.amount || 0);
}

// --- Finalizing ----------------------------------------------------

// Moves a pending transfer to its final state exactly once. On failure
// the customer gets amount + fee back.
async function finalize(transfer, providerStatus, reason) {
  const status = SUCCESS_STATES.includes(providerStatus) ? 'SUCCESS' : FAILED_STATES.includes(providerStatus) ? (providerStatus === 'REVERSED' ? 'REVERSED' : 'FAILED') : null;
  if (!status) {
    // Still in progress (or waiting for OTP) — just record what Monnify said.
    const nextStatus = providerStatus === 'PENDING_AUTHORIZATION' ? 'PENDING_AUTHORIZATION' : 'PROCESSING';
    await prisma.bankTransfer.updateMany({ where: { id: transfer.id, status: { in: PENDING } }, data: { status: nextStatus, providerStatus } });
    return { final: false, status: nextStatus };
  }

  const total = Number(transfer.amount) + Number(transfer.fee);
  if (status === 'SUCCESS') {
    const r = await prisma.bankTransfer.updateMany({
      where: { id: transfer.id, status: { in: PENDING } },
      data: { status, providerStatus, completedAt: new Date() },
    });
    if (r.count === 1) {
      notify(transfer.customerId, 'Bank Transfer Successful', `${money(transfer.amount)} was sent to ${transfer.accountName} (${transfer.bankName || transfer.bankCode} ${transfer.accountNumber}).`);
    }
    return { final: true, status };
  }

  // Failed / reversed: claim + refund in one DB transaction.
  let refunded = false;
  await prisma.$transaction(async (tx) => {
    const r = await tx.bankTransfer.updateMany({
      where: { id: transfer.id, status: { in: [...PENDING, 'SUCCESS', 'HELD'] }, refundedAt: null },
      data: { status, providerStatus, failureReason: reason ? String(reason).slice(0, 200) : undefined, refundedAt: new Date(), completedAt: new Date() },
    });
    if (r.count !== 1) return;
    await tx.customer.update({ where: { id: transfer.customerId }, data: { walletBalance: { increment: total } } });
    await tx.walletTransaction.create({
      data: {
        customerId: transfer.customerId,
        type: 'REFUND',
        amount: total,
        status: 'APPROVED',
        reference: transfer.reference,
        note: `Refund: bank transfer to ${transfer.accountName} ${status === 'REVERSED' ? 'was reversed' : 'failed'}`,
      },
    });
    refunded = true;
  });
  if (refunded) {
    notify(transfer.customerId, 'Bank Transfer Failed', `Your transfer of ${money(transfer.amount)} to ${transfer.accountName} did not go through. ${money(total)} has been returned to your wallet.`);
  }
  return { final: true, status };
}

// Asks Monnify for the real status of a transfer and applies it.
async function refreshStatus(transfer) {
  if (transfer.status === 'HELD') return { final: false, status: 'HELD' };
  if (!PENDING.includes(transfer.status) && transfer.status !== 'SUCCESS') return { final: true, status: transfer.status };
  let body;
  try {
    body = await monnify.api('GET', `/api/v2/disbursements/single/summary?reference=${encodeURIComponent(transfer.reference)}`);
  } catch (error) {
    // Monnify has no record of it at all → it was never created, safe to refund.
    if (error.status === 404 || /not found|does not exist|no transaction/i.test(error.message)) {
      return finalize(transfer, 'FAILED', 'Transfer was not created by the bank partner.');
    }
    throw error;
  }
  return finalize(transfer, String(body?.status || '').toUpperCase(), body?.transactionDescription);
}

// Checks any of this customer's transfers that are still processing
// (cheap, runs when they open their transfer list).
async function refreshCustomerPending(customerId) {
  const pending = await prisma.bankTransfer.findMany({
    where: { customerId, status: 'PROCESSING', createdAt: { lt: new Date(Date.now() - 30 * 1000) } },
    take: 5,
  });
  for (const t of pending) {
    try {
      await refreshStatus(t);
    } catch (error) {
      console.error('refreshCustomerPending failed for', t.reference, error.message);
    }
  }
}

// --- Sending -------------------------------------------------------

class TransferError extends Error {
  constructor(message, status = 400, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function sendToBank(customerId, { bankCode, accountNumber, amount, narration }) {
  const cfg = await transferSettings();
  if (!cfg.enabled) throw new TransferError('Sending to banks is not available yet.', 503);
  if (!(await monnify.isConfigured()) || !cfg.walletAccount) throw new TransferError('Sending to banks is not available right now.', 503);

  const amt = Math.round(Number(amount) * 100) / 100;
  if (!(amt > 0)) throw new TransferError('Enter an amount to send.');
  if (cfg.min && amt < cfg.min) throw new TransferError(`The minimum transfer is ${money(cfg.min)}.`);
  if (cfg.max && amt > cfg.max) throw new TransferError(`The maximum per transfer is ${money(cfg.max)}.`);
  if (cfg.dailyMax && (await sentToday(customerId)) + amt > cfg.dailyMax) {
    throw new TransferError(`This would go over your daily bank transfer limit of ${money(cfg.dailyMax)}.`);
  }

  const settingsRow = await getSettings();
  const customerRow = await prisma.customer.findUnique({ where: { id: customerId } });
  const limitError = await checkDailyLimit(customerRow, amt + cfg.fee, settingsRow);
  if (limitError) throw new TransferError(limitError, 403, 'DAILY_LIMIT');

  // Always re-check the account name on the server.
  const acct = await lookupAccount(bankCode, accountNumber);
  const banks = await listBanks().catch(() => []);
  const bankName = banks.find((b) => b.code === String(bankCode))?.name || null;
  const total = amt + cfg.fee;
  const reference = newReference();
  const cleanNarration = String(narration || '').trim().slice(0, 60) || 'ZappiPay transfer';

  // 1. Reserve the money.
  let transfer;
  try {
    transfer = await prisma.$transaction(async (tx) => {
      const r = await tx.customer.updateMany({
        where: { id: customerId, active: true, walletBalance: { gte: total } },
        data: { walletBalance: { decrement: total } },
      });
      if (r.count !== 1) throw new TransferError(`Insufficient wallet balance. You need ${money(total)} (including ${money(cfg.fee)} fee).`, 402, 'INSUFFICIENT_BALANCE');
      const t = await tx.bankTransfer.create({
        data: { customerId, amount: amt, fee: cfg.fee, bankCode: String(bankCode), bankName, accountNumber: acct.accountNumber, accountName: acct.accountName, narration: cleanNarration, reference },
      });
      await tx.walletTransaction.create({
        data: {
          customerId,
          type: 'TRANSFER_OUT',
          amount: total,
          status: 'APPROVED',
          reference,
          note: `Bank transfer to ${acct.accountName} (${bankName || bankCode} ${acct.accountNumber})${cfg.fee ? ` incl. ${money(cfg.fee)} fee` : ''}`,
        },
      });
      return t;
    });
  } catch (error) {
    if (error instanceof TransferError) throw error;
    console.error('sendToBank (reserve) failed:', error);
    throw new TransferError('Could not start the transfer. Your wallet was not charged.', 500);
  }

  // 2. Fraud check: big transfers soon after signup or a security
  // change wait for an admin before any money leaves.
  const reasons = await holdReasons(customerRow, amt, settingsRow);
  if (reasons.length) {
    await prisma.bankTransfer.update({ where: { id: transfer.id }, data: { status: 'HELD', providerStatus: 'HELD', failureReason: reasons.join('; ') } });
    notify(customerId, 'Transfer Under Review', `Your transfer of ${money(amt)} to ${acct.accountName} is being reviewed for your security. It will be sent after a quick check, or refunded.`);
    emailAdmins(
      `ZappiPay: bank transfer held for review (${money(amt)})`,
      `<p>A bank transfer was held for review.</p><p><strong>${money(amt)}</strong> to ${acct.accountName} (${bankName || bankCode} ${acct.accountNumber})<br>Reason: ${reasons.join('; ')}<br>Ref ${reference}</p><p>Open Admin → Bank Transfers → Held to release or refund it.</p>`,
      `Bank transfer held: ${money(amt)} to ${acct.accountName}. Reason: ${reasons.join('; ')}. Ref ${reference}`
    ).catch(() => {});
    return { transfer: await prisma.bankTransfer.findUnique({ where: { id: transfer.id } }), pending: true, held: true };
  }

  return dispatch(transfer, cfg);
}

async function holdReasons(customer, amount, settings) {
  if (!settings.fraudHoldEnabled) return [];
  if (amount < Number(settings.fraudHoldAmount || 0)) return [];
  const since = Date.now() - Number(settings.fraudHoldHours || 24) * 3600 * 1000;
  const out = [];
  if (new Date(customer.createdAt).getTime() > since) out.push('new account');
  if (customer.securityChangedAt && new Date(customer.securityChangedAt).getTime() > since) out.push('recent PIN/password change or new-device login');
  return out;
}

// Sends a reserved transfer to Monnify (new, or released from HELD).
async function dispatch(transfer, cfg) {
  cfg = cfg || (await transferSettings());
  let body;
  try {
    body = await monnify.api('POST', '/api/v2/disbursements/single', {
      amount: Number(transfer.amount),
      reference: transfer.reference,
      narration: transfer.narration || 'ZappiPay transfer',
      destinationBankCode: String(transfer.bankCode),
      destinationAccountNumber: transfer.accountNumber,
      destinationAccountName: transfer.accountName,
      currency: 'NGN',
      sourceAccountNumber: cfg.walletAccount,
      async: true,
    });
  } catch (error) {
    console.error('sendToBank (Monnify) failed:', error.message, JSON.stringify(error.body || {}));
    if (error instanceof monnify.MonnifyError && error.status && error.status < 500) {
      // Monnify clearly refused it (bad details, low wallet, duplicate…) → refund now.
      await finalize(transfer, 'FAILED', error.message);
      throw new TransferError(`The transfer could not be sent: ${error.message} Your wallet has been refunded.`, 502);
    }
    // Unclear (timeout / server error) — keep it PROCESSING; the status
    // check or webhook will settle it and refund if it didn't go through.
    return { transfer: await prisma.bankTransfer.findUnique({ where: { id: transfer.id } }), pending: true };
  }

  await finalize(transfer, String(body?.status || 'PROCESSING').toUpperCase(), body?.transactionDescription);
  const fresh = await prisma.bankTransfer.findUnique({ where: { id: transfer.id } });
  if (fresh.status === 'PENDING_AUTHORIZATION') {
    console.log('Bank transfer waiting for admin OTP:', transfer.reference);
  }
  return { transfer: fresh, pending: fresh.status !== 'SUCCESS' };
}

// Admin releases a held transfer (claim HELD → PROCESSING, then send).
async function releaseHeld(transferId) {
  const r = await prisma.bankTransfer.updateMany({ where: { id: transferId, status: 'HELD' }, data: { status: 'PROCESSING', failureReason: null } });
  if (r.count !== 1) throw new TransferError('This transfer is not on hold.');
  const t = await prisma.bankTransfer.findUnique({ where: { id: transferId } });
  return dispatch(t);
}

// --- Admin OTP (Monnify 2FA) --------------------------------------

async function authorizeWithOtp(transfer, otp) {
  const body = await monnify.api('POST', '/api/v2/disbursements/single/validate-otp', {
    reference: transfer.reference,
    authorizationCode: String(otp).trim(),
  });
  return finalize(transfer, String(body?.status || 'PROCESSING').toUpperCase(), body?.transactionDescription);
}

async function resendOtp(transfer) {
  return monnify.api('POST', '/api/v2/disbursements/single/resend-otp', { reference: transfer.reference });
}

function publicTransfer(t) {
  return {
    id: t.id,
    amount: t.amount,
    fee: t.fee,
    bankName: t.bankName,
    bankCode: t.bankCode,
    accountNumber: t.accountNumber,
    accountName: t.accountName,
    narration: t.narration,
    reference: t.reference,
    // Customers just see "Processing" while it waits for admin OTP.
    status: t.status === 'PENDING_AUTHORIZATION' ? 'PROCESSING' : t.status === 'HELD' ? 'UNDER_REVIEW' : t.status,
    failureReason: t.status === 'FAILED' || t.status === 'REVERSED' ? t.failureReason : null,
    createdAt: t.createdAt,
    completedAt: t.completedAt,
  };
}

module.exports = {
  TransferError,
  listBanks,
  lookupAccount,
  transferSettings,
  sendToBank,
  refreshStatus,
  refreshCustomerPending,
  finalize,
  authorizeWithOtp,
  resendOtp,
  publicTransfer,
  releaseHeld,
  PENDING,
};
