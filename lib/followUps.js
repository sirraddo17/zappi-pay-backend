// Follow-ups: messages for customers affected by an outage or a partner
// problem. The app only DRAFTS them; an owner reads, edits and taps Send.

const prisma = require('./prisma');

const MAX_CUSTOMERS = 500;

async function draft({ kind, title, message, customerIds }) {
  const ids = [...new Set((customerIds || []).filter(Boolean))].slice(0, MAX_CUSTOMERS);
  if (!ids.length) return null;
  // Same subject drafted again within a day → add the customers to it.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const open = await prisma.followUp.findFirst({ where: { kind, title, status: 'DRAFT', createdAt: { gte: since } } });
  if (open) {
    const merged = [...new Set([...(Array.isArray(open.customerIds) ? open.customerIds : []), ...ids])].slice(0, MAX_CUSTOMERS);
    return prisma.followUp.update({ where: { id: open.id }, data: { customerIds: merged, message } });
  }
  return prisma.followUp.create({ data: { kind, title: String(title).slice(0, 120), message: String(message).slice(0, 600), customerIds: ids } });
}

async function list() {
  const rows = await prisma.followUp.findMany({ orderBy: { createdAt: 'desc' }, take: 30 });
  return rows.map((r) => ({ ...r, customers: Array.isArray(r.customerIds) ? r.customerIds.length : 0, customerIds: undefined }));
}

class FollowUpError extends Error {}

async function send(id, { message } = {}) {
  const f = await prisma.followUp.findUnique({ where: { id } });
  if (!f) throw new FollowUpError('Not found.');
  if (f.status !== 'DRAFT') throw new FollowUpError('This one was already sent or dismissed.');
  const text = String(message ?? f.message).trim().slice(0, 600);
  if (text.length < 10) throw new FollowUpError('Write the message first.');
  const claimed = await prisma.followUp.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'SENT', sentAt: new Date(), message: text } });
  if (claimed.count !== 1) throw new FollowUpError('This one was already sent.');
  const { notify } = require('./notify');
  const ids = Array.isArray(f.customerIds) ? f.customerIds : [];
  let sent = 0;
  for (const cid of ids) {
    try { await notify(cid, f.title, text); sent += 1; } catch { /* one bad id shouldn't stop the rest */ }
  }
  return { sent };
}

async function dismiss(id) {
  const r = await prisma.followUp.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'DISMISSED' } });
  if (r.count !== 1) throw new FollowUpError('Not found or already handled.');
  return { ok: true };
}

module.exports = { draft, list, send, dismiss, FollowUpError };
