const prisma = require('./prisma');
const { notify } = require('./notify');

// Family wallet. A parent invites a family member's ZAPPI PAY account;
// once the member accepts, the parent can send an automatic allowance
// and set controls: a daily spending limit, which services they can
// buy, and whether they can send money out. Either side can end the
// link at any time.

const LAGOS = 60 * 60 * 1000;
const DAY = 24 * LAGOS;
const lagosYmd = (d) => new Date(new Date(d).getTime() + LAGOS).toISOString().slice(0, 10);
const startOfLagosDay = (ymd) => new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() - LAGOS);
const SERVICES = ['AIRTIME', 'DATA', 'ELECTRICITY', 'CABLE', 'EDUCATION', 'INTERNET', 'BETTING', 'INTERNATIONAL', 'INSURANCE'];
const MAX_MEMBERS = 10;
const naira = (n) => `₦${Number(n).toLocaleString('en-NG')}`;

class FamilyError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const first = (c) => String(c?.name || c?.username || 'Someone').split(/\s+/)[0];

function nextAllowance(from, frequency) {
  const d = new Date(from);
  if (frequency === 'WEEKLY') return new Date(d.getTime() + 7 * DAY);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return d;
}

async function activeLinkForChild(childId) {
  return prisma.familyLink.findFirst({ where: { childId, status: 'ACTIVE' } });
}

async function invite(parentId, { identifier, nickname } = {}) {
  const id = String(identifier || '').trim();
  if (!id) throw new FamilyError('Enter their ZAPPI PAY username or phone number.');
  const child = await prisma.customer.findFirst({ where: { OR: [{ phone: id }, { username: id.toLowerCase().replace(/^@/, '') }] } });
  if (!child || child.deletedAt) throw new FamilyError('No ZAPPI PAY account found with that username or phone number.', 404);
  if (child.id === parentId) throw new FamilyError("You can't add yourself.");
  if (await prisma.familyLink.findFirst({ where: { childId: parentId, status: 'ACTIVE' } })) throw new FamilyError('Your account is managed by a family member, so you can’t add others.');
  if (await prisma.familyLink.findFirst({ where: { childId: child.id } })) throw new FamilyError('That account is already linked to a family.');
  if (await prisma.familyLink.findFirst({ where: { parentId: child.id, childId: parentId } })) throw new FamilyError('That person already manages your account.');
  if ((await prisma.familyLink.count({ where: { parentId } })) >= MAX_MEMBERS) throw new FamilyError(`You can add up to ${MAX_MEMBERS} family members.`);
  const parent = await prisma.customer.findUnique({ where: { id: parentId }, select: { name: true, username: true } });
  const link = await prisma.familyLink.create({ data: { parentId, childId: child.id, nickname: String(nickname || '').trim().slice(0, 30) || null } });
  notify(child.id, 'Family Invite', `${parent?.name || 'Someone'} wants to add you to their ZAPPI PAY family so they can send you an allowance and set spending limits. Open Profile → Family to accept or decline.`);
  return link;
}

async function respond(childId, accept) {
  const link = await prisma.familyLink.findFirst({ where: { childId, status: 'PENDING' } });
  if (!link) throw new FamilyError('No family invite waiting.', 404);
  const child = await prisma.customer.findUnique({ where: { id: childId }, select: { name: true } });
  if (!accept) {
    await prisma.familyLink.delete({ where: { id: link.id } });
    notify(link.parentId, 'Family Invite Declined', `${child?.name || 'They'} declined your family invite.`);
    return null;
  }
  const r = await prisma.familyLink.updateMany({ where: { id: link.id, status: 'PENDING' }, data: { status: 'ACTIVE', acceptedAt: new Date() } });
  if (r.count !== 1) throw new FamilyError('This invite has changed. Refresh and try again.', 409);
  notify(link.parentId, 'Family Invite Accepted', `${child?.name || 'They'} joined your ZAPPI PAY family. You can now set an allowance and spending limits.`);
  return prisma.familyLink.findUnique({ where: { id: link.id } });
}

async function leave(childId) {
  const link = await prisma.familyLink.findFirst({ where: { childId } });
  if (!link) throw new FamilyError('You are not in a family.', 404);
  await prisma.familyLink.delete({ where: { id: link.id } });
  const child = await prisma.customer.findUnique({ where: { id: childId }, select: { name: true } });
  if (link.status === 'ACTIVE') notify(link.parentId, 'Family Member Left', `${child?.name || 'A family member'} left your ZAPPI PAY family. Their allowance and limits have stopped.`);
}

async function remove(parentId, linkId) {
  const link = await prisma.familyLink.findFirst({ where: { id: linkId, parentId } });
  if (!link) throw new FamilyError('Family member not found.', 404);
  await prisma.familyLink.delete({ where: { id: link.id } });
  if (link.status === 'ACTIVE') {
    const parent = await prisma.customer.findUnique({ where: { id: parentId }, select: { name: true } });
    notify(link.childId, 'Family Link Ended', `${parent?.name || 'Your family member'} removed the family link. Your account has no limits now and the allowance has stopped.`);
  }
}

async function update(parentId, linkId, b = {}) {
  const link = await prisma.familyLink.findFirst({ where: { id: linkId, parentId } });
  if (!link) throw new FamilyError('Family member not found.', 404);
  if (link.status !== 'ACTIVE') throw new FamilyError('They need to accept your invite first.');
  const data = {};
  if (b.nickname !== undefined) data.nickname = String(b.nickname || '').trim().slice(0, 30) || null;
  if (b.dailyLimit !== undefined) {
    if (b.dailyLimit === null || b.dailyLimit === '' || Number(b.dailyLimit) === 0) data.dailyLimit = null;
    else {
      const n = parseInt(b.dailyLimit, 10);
      if (!(n >= 50 && n <= 10000000)) throw new FamilyError('Daily limit must be at least ₦50.');
      data.dailyLimit = n;
    }
  }
  if (b.allowedServices !== undefined) {
    if (b.allowedServices === null) data.allowedServices = null;
    else {
      if (!Array.isArray(b.allowedServices)) throw new FamilyError('allowedServices must be a list.');
      const list = [...new Set(b.allowedServices.filter((x) => SERVICES.includes(x)))];
      data.allowedServices = list.length === SERVICES.length ? null : list;
    }
  }
  if (b.allowSendMoney !== undefined) data.allowSendMoney = Boolean(b.allowSendMoney);
  if (b.allowanceAmount !== undefined || b.allowanceFrequency !== undefined) {
    const amt = b.allowanceAmount === null || b.allowanceAmount === '' ? null : parseInt(b.allowanceAmount ?? link.allowanceAmount, 10);
    const freq = b.allowanceFrequency ?? link.allowanceFrequency;
    if (!amt) {
      Object.assign(data, { allowanceAmount: null, allowanceFrequency: null, nextAllowanceAt: null });
    } else {
      if (!(amt >= 50 && amt <= 1000000)) throw new FamilyError('Allowance must be between ₦50 and ₦1,000,000.');
      if (!['WEEKLY', 'MONTHLY'].includes(freq)) throw new FamilyError('Choose weekly or monthly.');
      const changed = amt !== link.allowanceAmount || freq !== link.allowanceFrequency;
      Object.assign(data, { allowanceAmount: amt, allowanceFrequency: freq });
      // A new allowance starts now; editing keeps the schedule.
      if (changed && (!link.nextAllowanceAt || freq !== link.allowanceFrequency)) data.nextAllowanceAt = new Date();
    }
  }
  const updated = await prisma.familyLink.update({ where: { id: link.id }, data });
  if (data.nextAllowanceAt) setImmediate(() => runAllowances().catch(() => {}));
  return updated;
}

async function spentToday(customerId, now = new Date()) {
  const a = await prisma.order.aggregate({ where: { customerId, status: { in: ['SUCCESS', 'PENDING'] }, createdAt: { gte: startOfLagosDay(lagosYmd(now)) } }, _sum: { amount: true } });
  return Number(a?._sum?.amount || 0);
}

// Controls on a family member's purchases. Returns an error or null.
async function checkPurchase(customerId, service, amount) {
  const link = await activeLinkForChild(customerId);
  if (!link) return null;
  const allowed = Array.isArray(link.allowedServices) ? link.allowedServices : null;
  if (allowed && !allowed.includes(service)) return 'Your family settings don’t allow this service. Ask your family member to turn it on.';
  if (link.dailyLimit) {
    const spent = await spentToday(customerId);
    if (spent + Number(amount) > link.dailyLimit) {
      const left = Math.max(0, link.dailyLimit - spent);
      return `This goes over your family daily limit of ${naira(link.dailyLimit)} (${naira(left)} left today).`;
    }
  }
  return null;
}

// Sending money out (to a friend or a bank). Sending back to the parent
// is always fine.
async function checkSend(customerId, receiverId = null) {
  const link = await activeLinkForChild(customerId);
  if (!link || link.allowSendMoney) return null;
  if (receiverId && receiverId === link.parentId) return null;
  return 'Your family settings don’t allow sending money. You can still send money back to the family member who manages your account.';
}

async function forParent(parentId) {
  const links = await prisma.familyLink.findMany({ where: { parentId }, take: MAX_MEMBERS });
  return Promise.all(links.map(async (l) => {
    const c = await prisma.customer.findUnique({ where: { id: l.childId }, select: { name: true, username: true, phone: true, walletBalance: true } });
    const base = { id: l.id, status: l.status, nickname: l.nickname, name: c?.name, username: c?.username, dailyLimit: l.dailyLimit, allowedServices: l.allowedServices, allowSendMoney: l.allowSendMoney, allowanceAmount: l.allowanceAmount, allowanceFrequency: l.allowanceFrequency, nextAllowanceAt: l.nextAllowanceAt, lastAllowanceAt: l.lastAllowanceAt, lastAllowanceError: l.lastAllowanceError };
    if (l.status !== 'ACTIVE') return base;
    const recent = await prisma.order.findMany({ where: { customerId: l.childId }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, service: true, amount: true, recipient: true, status: true, createdAt: true } });
    return { ...base, balance: Number(c?.walletBalance || 0), spentToday: await spentToday(l.childId), recent };
  }));
}

async function forChild(childId) {
  const l = await prisma.familyLink.findFirst({ where: { childId } });
  if (!l) return null;
  const p = await prisma.customer.findUnique({ where: { id: l.parentId }, select: { name: true } });
  return { id: l.id, status: l.status, parentName: p?.name || 'Family member', dailyLimit: l.dailyLimit, allowedServices: l.allowedServices, allowSendMoney: l.allowSendMoney, allowanceAmount: l.allowanceAmount, allowanceFrequency: l.allowanceFrequency, nextAllowanceAt: l.nextAllowanceAt, spentToday: l.status === 'ACTIVE' ? await spentToday(childId) : 0 };
}

// Hourly: pay allowances that are due, from the parent's wallet.
async function runAllowances(now = new Date()) {
  if (!(await require('./features').anyOn('family'))) return 0;
  const due = await prisma.familyLink.findMany({ where: { status: 'ACTIVE', nextAllowanceAt: { lte: now } }, take: 200 });
  let paid = 0;
  for (const l of due) {
    if (!l.allowanceAmount || !l.allowanceFrequency) continue;
    // Claim this run so it's paid once, even with two servers.
    const next = nextAllowance(l.nextAllowanceAt < new Date(now.getTime() - 7 * DAY) ? now : l.nextAllowanceAt, l.allowanceFrequency);
    const claim = await prisma.familyLink.updateMany({ where: { id: l.id, status: 'ACTIVE', nextAllowanceAt: l.nextAllowanceAt }, data: { nextAllowanceAt: next } });
    if (claim.count !== 1) continue;
    const amount = l.allowanceAmount;
    const [parent, child] = await Promise.all([
      prisma.customer.findUnique({ where: { id: l.parentId }, select: { name: true, active: true } }),
      prisma.customer.findUnique({ where: { id: l.childId }, select: { name: true, active: true } }),
    ]);
    if (!parent || !child || parent.active === false || child.active === false) continue;
    let ok = false;
    try {
      await prisma.$transaction(async (tx) => {
        const r = await tx.customer.updateMany({ where: { id: l.parentId, walletBalance: { gte: amount } }, data: { walletBalance: { decrement: amount } } });
        if (r.count !== 1) throw new FamilyError('NOT_ENOUGH');
        await tx.customer.update({ where: { id: l.childId }, data: { walletBalance: { increment: amount } } });
        await tx.transfer.create({ data: { senderId: l.parentId, receiverId: l.childId, amount, note: 'Family allowance' } });
        await tx.walletTransaction.create({ data: { customerId: l.parentId, type: 'TRANSFER_OUT', amount, status: 'APPROVED', note: `Allowance to ${child.name}` } });
        await tx.walletTransaction.create({ data: { customerId: l.childId, type: 'TRANSFER_IN', amount, status: 'APPROVED', note: `Allowance from ${parent.name}` } });
      });
      ok = true;
    } catch (e) {
      if (!(e instanceof FamilyError)) console.error('family allowance failed:', e.message);
    }
    if (ok) {
      paid += 1;
      await prisma.familyLink.update({ where: { id: l.id }, data: { lastAllowanceAt: now, lastAllowanceError: null } });
      notify(l.childId, 'Allowance Received', `${first(parent)} sent your ${l.allowanceFrequency.toLowerCase()} allowance of ${naira(amount)}.`);
      notify(l.parentId, 'Allowance Sent', `${naira(amount)} allowance sent to ${child.name}.`);
    } else {
      await prisma.familyLink.update({ where: { id: l.id }, data: { lastAllowanceError: 'Not enough money in your wallet' } });
      notify(l.parentId, 'Allowance Not Sent', `We couldn't send ${child.name}'s ${naira(amount)} allowance — your wallet didn't have enough. Fund your wallet and tap "Send now" under Profile → Family.`);
    }
  }
  return paid;
}

// "Send now": pay this period's allowance straight away.
async function sendNow(parentId, linkId) {
  const link = await prisma.familyLink.findFirst({ where: { id: linkId, parentId, status: 'ACTIVE' } });
  if (!link || !link.allowanceAmount) throw new FamilyError('Set an allowance first.');
  await prisma.familyLink.update({ where: { id: link.id }, data: { nextAllowanceAt: new Date() } });
  const n = await runAllowances();
  const fresh = await prisma.familyLink.findUnique({ where: { id: link.id } });
  if (fresh.lastAllowanceError) throw new FamilyError('Not enough money in your wallet.');
  return n;
}

let timer = null;
function startFamilyTimer() {
  if (timer || process.env.DISABLE_SCHEDULER === '1') return;
  const run = () => runAllowances().catch((e) => console.error('allowances failed:', e.message));
  setTimeout(run, 4 * 60 * 1000);
  timer = setInterval(run, 60 * 60 * 1000);
}

module.exports = { FamilyError, SERVICES, invite, respond, leave, remove, update, checkPurchase, checkSend, forParent, forChild, runAllowances, sendNow, startFamilyTimer, nextAllowance };
