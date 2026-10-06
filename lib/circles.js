// Ajo Circle — rotating group contributions (ajo / esusu / adashe).
//
// How it works:
//  - A creator sets the amount, how often (daily / weekly / monthly), the
//    number of members and the start day. Members join with the invite
//    link (or are invited by username) and must accept the agreement with
//    their PIN. The creator sets the payout order (or shuffles it).
//  - Each payment day a "round" opens: every member owes the amount; the
//    member with the next payout number is that round's recipient.
//  - Money is taken from wallets automatically (partly if the balance is
//    short), retried, and taken the moment money comes in. It sits in the
//    round's pot — visible to all, spendable by nobody.
//  - When every member has paid, the pot is paid to the recipient (minus
//    the optional payout fee: 80% creator, 20% ZAPPI PAY). Rounds are paid
//    strictly in order.
//  - Late after the grace hours: late fee (into the pot) + a strike.
//    Strikes before getting paid → payout number moves to the end.
//    Owing after getting paid → wallet spending is blocked until settled.
//    Repeated strikes → banned from new circles (admin can lift on appeal).

const crypto = require('crypto');
const prisma = require('./prisma');
const { getSettings } = require('./vtpass');
const { notify } = require('./notify');
const agreement = require('./circleAgreement');

const APP_SHARE = 20; // % of the payout fee kept by ZAPPI PAY
const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY'];
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const HOUR = 3600 * 1000;

class CircleError extends Error {
  constructor(msg, status = 400, code) { super(msg); this.status = status; this.code = code; }
}

// Payment day n (1-based): start + (n-1) periods.
function dueAtFor(circle, n) {
  const d = new Date(circle.startAt);
  if (circle.frequency === 'DAILY') d.setUTCDate(d.getUTCDate() + (n - 1));
  else if (circle.frequency === 'WEEKLY') d.setUTCDate(d.getUTCDate() + 7 * (n - 1));
  else d.setUTCMonth(d.getUTCMonth() + (n - 1));
  return d;
}

// 8:00 am Lagos time on a YYYY-MM-DD day.
function startOfDay(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 7));
}

function feeSplit(circle) {
  const fee = r2(circle.payoutFee || 0);
  const app = r2((fee * APP_SHARE) / 100);
  return { fee, app, creator: r2(fee - app) };
}

async function event(circleId, kind, message) {
  await prisma.circleEvent.create({ data: { circleId, kind, message } }).catch(() => {});
}

// On for everyone, or "Testers only" and this customer is a tester
// (Admin → New features).
async function settingsOn(customerId) {
  const s = await getSettings();
  if (!require('./features').isOnFor(s, 'circles', customerId)) throw new CircleError('Ajo Circle is not available yet.', 503, 'OFF');
  return s;
}
const anyOn = (s) => Boolean(s.circlesEnabled || s.featureTestMode?.circles);

const byPosition = (a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || new Date(a.joinedAt) - new Date(b.joinedAt);
async function members(circleId, joinedOnly = true) {
  const list = await prisma.circleMember.findMany({ where: { circleId, ...(joinedOnly ? { status: 'JOINED' } : { status: { in: ['JOINED', 'INVITED'] } }) }, orderBy: [{ position: 'asc' }, { joinedAt: 'asc' }] });
  return list.sort(byPosition);
}

async function notifyMembers(circleId, title, message, exceptCustomerId) {
  for (const m of await members(circleId)) if (m.customerId !== exceptCustomerId) notify(m.customerId, title, message, { category: 'TRANSACTION' });
}

// --- Creating and joining ---------------------------------------------

async function create(creatorId, b = {}) {
  const s = await settingsOn(creatorId);
  const creator = await prisma.customer.findUnique({ where: { id: creatorId } });
  if (!creator?.active) throw new CircleError('Account not found.', 404);
  if (creator.circleBannedAt) throw new CircleError('You can’t start a circle right now because of missed circle payments. You can appeal from the Ajo Circle page.', 403, 'BANNED');
  if (!creator.pinHash) throw new CircleError('Create your transaction PIN first (Profile → Security).', 403, 'PIN_NOT_SET');
  const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 50);
  if (name.length < 3) throw new CircleError('Give the circle a name (at least 3 letters).');
  const amount = r2(b.amount);
  if (!(amount >= 100)) throw new CircleError('The contribution must be at least ₦100.');
  if (amount > Number(s.circleMaxAmount || 500000)) throw new CircleError(`The contribution can’t be more than ${naira(s.circleMaxAmount)}.`);
  const frequency = String(b.frequency || '').toUpperCase();
  if (!FREQUENCIES.includes(frequency)) throw new CircleError('Choose daily, weekly or monthly.');
  const size = parseInt(b.size, 10);
  const maxM = Number(s.circleMaxMembers || 30);
  if (!(size >= 2 && size <= maxM)) throw new CircleError(`A circle needs between 2 and ${maxM} members.`);
  const startAt = startOfDay(b.startDate);
  if (!startAt || startAt.getTime() < Date.now() + 20 * HOUR) throw new CircleError('Pick a start day from tomorrow onwards, so everyone has time to fund their wallet.');
  if (startAt.getTime() > Date.now() + 90 * 24 * HOUR) throw new CircleError('Pick a start day within the next 3 months.');
  const pot = amount * size;
  const payoutFee = b.payoutFeeOn ? r2(b.payoutFee) : 0;
  if (payoutFee < 0 || payoutFee > pot * 0.05) throw new CircleError(`The payout fee can’t be more than 5% of the pot (${naira(pot * 0.05)}).`);
  const penaltyFee = r2(b.penaltyFee || 0);
  if (penaltyFee < 0 || penaltyFee > amount * 0.1) throw new CircleError(`The late fee can’t be more than 10% of the contribution (${naira(amount * 0.1)}).`);
  const graceHours = Math.max(1, Math.min(72, parseInt(b.graceHours, 10) || 24));
  const strikesToLast = Math.max(1, Math.min(5, parseInt(b.strikesToLast, 10) || 2));
  const extraRules = String(b.extraRules || '').trim().slice(0, 1500) || null;
  if (!b.agree) throw new CircleError('Tick that you accept the agreement for your own circle.', 400, 'AGREE');

  const circle = await prisma.circle.create({
    data: { code: crypto.randomBytes(6).toString('base64url'), name, creatorId, amount, frequency, size, startAt, payoutFee, penaltyFee, graceHours, strikesToLast, extraRules, agreementVersion: agreement.VERSION },
  });
  await prisma.circleMember.create({ data: { circleId: circle.id, customerId: creatorId, position: 1, status: 'JOINED', agreedAt: new Date(), agreementVersion: agreement.VERSION } });
  await event(circle.id, 'CREATED', `${creator.name} created the circle: ${naira(amount)} ${frequency.toLowerCase()}, ${size} members.`);
  return circle;
}

async function byCode(code) {
  const c = await prisma.circle.findUnique({ where: { code: String(code || '') } });
  if (!c) throw new CircleError('This circle link is not valid.', 404);
  return c;
}

// Preview for the join page (before joining).
async function preview(code, customerId) {
  const c = await byCode(code);
  const ms = await members(c.id);
  const creator = await prisma.customer.findUnique({ where: { id: c.creatorId }, select: { name: true, username: true } });
  const mine = await prisma.circleMember.findUnique({ where: { circleId_customerId: { circleId: c.id, customerId } } });
  return { circle: publicCircle(c), creator: creator?.name, creatorUsername: creator?.username, joined: ms.length, spotsLeft: Math.max(0, c.size - ms.length), myStatus: mine?.status || null, agreement: agreement.terms(c, { appShare: APP_SHARE }), agreementVersion: agreement.VERSION };
}

async function join(code, customerId, { agree } = {}) {
  await settingsOn(customerId);
  const c = await byCode(code);
  if (c.status !== 'FORMING') throw new CircleError('This circle has already started or closed.');
  const me = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!me?.active) throw new CircleError('Account not found.', 404);
  if (me.circleBannedAt) throw new CircleError('You can’t join new circles right now because of missed circle payments. You can appeal from the Ajo Circle page.', 403, 'BANNED');
  if (!agree) throw new CircleError('You must read and accept the agreement to join.', 400, 'AGREE');
  const existing = await prisma.circleMember.findUnique({ where: { circleId_customerId: { circleId: c.id, customerId } } });
  if (existing?.status === 'JOINED') return { joined: true, circleId: c.id };
  const count = await prisma.circleMember.count({ where: { circleId: c.id, status: 'JOINED' } });
  if (count >= c.size) throw new CircleError('This circle is full.');
  const position = count + 1;
  const data = { status: 'JOINED', agreedAt: new Date(), agreementVersion: agreement.VERSION, position };
  if (existing) await prisma.circleMember.update({ where: { id: existing.id }, data });
  else await prisma.circleMember.create({ data: { circleId: c.id, customerId, ...data } });
  await event(c.id, 'JOINED', `${me.name} joined and accepted the agreement (payout number ${position}).`);
  notify(c.creatorId, 'Ajo Circle', `${me.name} joined “${c.name}” (${count + 1} of ${c.size}).`, { category: 'UPDATE' });
  return { joined: true, circleId: c.id };
}

async function invite(circleId, creatorId, identifier) {
  const c = await own(circleId, creatorId);
  if (c.status !== 'FORMING') throw new CircleError('You can only invite people before the circle starts.');
  const t = String(identifier || '').trim().replace(/^@/, '');
  const who = await prisma.customer.findFirst({ where: { active: true, OR: [{ username: t.toLowerCase() }, { phone: t }] }, select: { id: true, name: true, circleBannedAt: true } });
  if (!who) throw new CircleError('No ZAPPI PAY user with that username or phone number.', 404);
  if (who.id === creatorId) throw new CircleError('You are already in the circle.');
  const existing = await prisma.circleMember.findUnique({ where: { circleId_customerId: { circleId, customerId: who.id } } });
  if (existing?.status === 'JOINED') throw new CircleError(`${who.name} is already a member.`);
  if (!existing) await prisma.circleMember.create({ data: { circleId, customerId: who.id, status: 'INVITED' } });
  notify(who.id, 'Ajo Circle invite', `You’ve been invited to join “${c.name}” — ${naira(c.amount)} ${c.frequency.toLowerCase()}, ${c.size} members. Open Ajo Circle to read the rules and join.`, { category: 'UPDATE' });
  return { invited: who.name };
}

async function leave(circleId, customerId) {
  const c = await prisma.circle.findUnique({ where: { id: circleId } });
  if (!c) throw new CircleError('Circle not found.', 404);
  if (c.status !== 'FORMING') throw new CircleError('Members can’t leave after the circle has started — see the agreement.');
  if (c.creatorId === customerId) throw new CircleError('You created this circle. Cancel it instead.');
  const m = await prisma.circleMember.findUnique({ where: { circleId_customerId: { circleId, customerId } } });
  if (!m || m.status === 'LEFT') return { left: true };
  await prisma.circleMember.update({ where: { id: m.id }, data: { status: 'LEFT', position: null } });
  await renumber(circleId);
  const me = await prisma.customer.findUnique({ where: { id: customerId }, select: { name: true } });
  await event(circleId, 'LEFT', `${me?.name || 'A member'} left before the start.`);
  return { left: true };
}

async function own(circleId, creatorId) {
  const c = await prisma.circle.findUnique({ where: { id: circleId } });
  if (!c) throw new CircleError('Circle not found.', 404);
  if (c.creatorId !== creatorId) throw new CircleError('Only the circle’s creator can do this.', 403);
  return c;
}

async function renumber(circleId) {
  const ms = await members(circleId);
  for (const [i, m] of ms.entries()) if (m.position !== i + 1) await prisma.circleMember.update({ where: { id: m.id }, data: { position: i + 1 } });
}

// Creator sets the payout order before the start (list of member ids), or shuffles.
async function reorder(circleId, creatorId, { order, shuffle } = {}) {
  const c = await own(circleId, creatorId);
  if (c.status !== 'FORMING') throw new CircleError('The payout order is fixed once the circle starts.');
  const ms = await members(circleId);
  let list = ms.map((m) => m.id);
  if (shuffle) {
    for (let i = list.length - 1; i > 0; i -= 1) { const j = crypto.randomInt(i + 1); [list[i], list[j]] = [list[j], list[i]]; }
  } else {
    const want = Array.isArray(order) ? order.map(String) : [];
    if (want.length !== list.length || !want.every((id) => list.includes(id))) throw new CircleError('Send every member once.');
    list = want;
  }
  for (const [i, id] of list.entries()) await prisma.circleMember.update({ where: { id }, data: { position: i + 1 } });
  await event(circleId, 'ORDER', shuffle ? 'The creator shuffled the payout order.' : 'The creator set the payout order.');
  return { ok: true };
}

async function start(circleId, creatorId) {
  await settingsOn(creatorId);
  const c = await own(circleId, creatorId);
  if (c.status !== 'FORMING') throw new CircleError('This circle has already started.');
  const ms = await members(circleId);
  if (ms.length !== c.size) throw new CircleError(`All ${c.size} members must join first (${ms.length} so far).`);
  if (ms.some((m) => !m.agreedAt)) throw new CircleError('Every member must accept the agreement first.');
  let startAt = new Date(c.startAt);
  if (startAt.getTime() < Date.now() + 12 * HOUR) {
    // Start day too close / passed: move it to tomorrow 8 am so everyone gets notice.
    const t = new Date(Date.now() + 24 * HOUR);
    startAt = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 7));
  }
  await renumber(circleId);
  const r = await prisma.circle.updateMany({ where: { id: circleId, status: 'FORMING' }, data: { status: 'ACTIVE', startAt, startedAt: new Date() } });
  if (r.count !== 1) throw new CircleError('This circle has already started.');
  await event(circleId, 'STARTED', `The circle started. First payment day: ${startAt.toDateString()}.`);
  await notifyMembers(circleId, 'Ajo Circle started', `“${c.name}” has started. ${naira(c.amount)} will be taken from your wallet on ${startAt.toDateString()} and every ${c.frequency === 'DAILY' ? 'day' : c.frequency === 'WEEKLY' ? 'week' : 'month'} after. Keep your wallet funded.`);
  return { started: true, startAt };
}

// Creator cancels before start; an admin can stop a running circle
// (unpaid pots go back to the members who paid them).
async function cancel(circleId, { creatorId, adminId, reason } = {}) {
  const c = await prisma.circle.findUnique({ where: { id: circleId } });
  if (!c) throw new CircleError('Circle not found.', 404);
  if (!adminId && c.creatorId !== creatorId) throw new CircleError('Only the circle’s creator can do this.', 403);
  if (!adminId && c.status !== 'FORMING') throw new CircleError('A running circle can only be stopped by ZAPPI PAY support.');
  if (['COMPLETED', 'CANCELLED'].includes(c.status)) return { cancelled: true };
  const r = await prisma.circle.updateMany({ where: { id: circleId, status: c.status }, data: { status: 'CANCELLED', completedAt: new Date() } });
  if (r.count !== 1) throw new CircleError('Please try again.');
  let refunded = 0;
  const open = await prisma.circleRound.findMany({ where: { circleId, status: 'COLLECTING' } });
  for (const round of open) {
    const dues = await prisma.circleDue.findMany({ where: { roundId: round.id } });
    const inPot = r2(Number(round.collected) - Number(round.released));
    const paidIn = dues.reduce((s, d) => s + Number(d.paid), 0);
    // Give back what's still in the pot, in proportion to what each paid.
    for (const d of dues) {
      const back = paidIn > 0 ? Math.floor((Number(d.paid) / paidIn) * inPot * 100) / 100 : 0;
      if (back > 0) {
        await prisma.$transaction([
          prisma.customer.update({ where: { id: d.customerId }, data: { walletBalance: { increment: back } } }),
          prisma.walletTransaction.create({ data: { customerId: d.customerId, type: 'CIRCLE_IN', amount: back, status: 'APPROVED', note: `Returned: “${c.name}” was stopped` } }),
        ]);
        refunded += back;
      }
    }
    await prisma.circleDue.updateMany({ where: { roundId: round.id, status: 'DUE' }, data: { status: 'CANCELLED' } });
    await prisma.circleRound.update({ where: { id: round.id }, data: { status: 'PAID', paidAt: new Date(), released: round.collected } });
  }
  await event(circleId, 'CANCELLED', adminId ? `Stopped by ZAPPI PAY${reason ? `: ${reason}` : ''}. ${naira(refunded)} held in pots was returned to the members who paid it.` : 'The creator cancelled the circle before it started.');
  await notifyMembers(circleId, 'Ajo Circle stopped', `“${c.name}” was ${adminId ? 'stopped by ZAPPI PAY' : 'cancelled by its creator'}.${refunded > 0 ? ' Money held in its pot has been returned to the members who paid it.' : ''}`);
  return { cancelled: true, refunded };
}

// --- Collecting ----------------------------------------------------------

// Takes what it can (up to what's owed) from the member's wallet.
async function collectDue(dueId) {
  const due = await prisma.circleDue.findUnique({ where: { id: dueId } });
  if (!due || due.status !== 'DUE') return 0;
  const need = r2(Number(due.amount) + Number(due.penalty) - Number(due.paid));
  if (!(need > 0)) {
    await prisma.circleDue.update({ where: { id: due.id }, data: { status: 'PAID' } });
    return 0;
  }
  const cust = await prisma.customer.findUnique({ where: { id: due.customerId }, select: { walletBalance: true } });
  const take = Math.floor(Math.min(Number(cust?.walletBalance || 0), need) * 100) / 100;
  await prisma.circleDue.update({ where: { id: due.id }, data: { lastTryAt: new Date() } }).catch(() => {});
  if (!(take > 0)) return 0;
  const circle = await prisma.circle.findUnique({ where: { id: due.circleId } });
  const round = await prisma.circleRound.findUnique({ where: { id: due.roundId } });
  try {
    await prisma.$transaction(async (tx) => {
      const d = await tx.circleDue.updateMany({ where: { id: due.id, status: 'DUE', paid: due.paid }, data: { paid: { increment: take }, ...(take >= need ? { status: 'PAID' } : {}) } });
      if (d.count !== 1) throw Object.assign(new Error('changed'), { retry: true });
      const w = await tx.customer.updateMany({ where: { id: due.customerId, walletBalance: { gte: take } }, data: { walletBalance: { decrement: take } } });
      if (w.count !== 1) throw Object.assign(new Error('balance'), { retry: true });
      await tx.circleRound.update({ where: { id: due.roundId }, data: { collected: { increment: take } } });
      await tx.walletTransaction.create({ data: { customerId: due.customerId, type: 'CIRCLE_OUT', amount: take, status: 'APPROVED', note: `Ajo Circle “${circle.name}” — payment ${round.number}${take < need ? ' (part)' : ''}` } });
    });
  } catch (e) {
    if (e.retry) return 0;
    throw e;
  }
  const left = r2(need - take);
  notify(due.customerId, 'Ajo Circle payment', left > 0
    ? `${naira(take)} was taken for “${circle.name}” (payment ${round.number}). You still owe ${naira(left)} — it will be taken as soon as money comes into your wallet.`
    : `${naira(take)} was taken for “${circle.name}” (payment ${round.number}). You’re fully paid for this one ✅`, { category: 'TRANSACTION' });
  return take;
}

// Any money that comes in goes to overdue circle payments first.
async function onDeposit(customerId) {
  try {
    const s = await getSettings();
    if (!anyOn(s)) return 0;
    const dues = await prisma.circleDue.findMany({ where: { customerId, status: 'DUE', dueAt: { lte: new Date() } }, orderBy: { dueAt: 'asc' } });
    let total = 0;
    const circles = new Set();
    for (const d of dues) { total += await collectDue(d.id); circles.add(d.circleId); }
    for (const id of circles) await tryPayouts(id);
    return total;
  } catch (e) {
    console.error('circles.onDeposit failed:', e.message);
    return 0;
  }
}

// --- Rounds and payouts ----------------------------------------------------

async function openRound(circle, n) {
  const ms = await members(circle.id);
  const taken = (await prisma.circleRound.findMany({ where: { circleId: circle.id, status: 'COLLECTING' }, select: { recipientMemberId: true } })).map((r) => r.recipientMemberId);
  const recipient = ms.find((m) => !m.received && !taken.includes(m.id));
  const dueAt = dueAtFor(circle, n);
  let round;
  try {
    round = await prisma.circleRound.create({ data: { circleId: circle.id, number: n, recipientMemberId: recipient?.id || null, dueAt, expected: r2(Number(circle.amount) * ms.length) } });
  } catch (e) {
    if (e.code === 'P2002') return null; // another server opened it
    throw e;
  }
  for (const m of ms) await prisma.circleDue.create({ data: { circleId: circle.id, roundId: round.id, memberId: m.id, customerId: m.customerId, amount: circle.amount, dueAt } });
  const rc = recipient ? await prisma.customer.findUnique({ where: { id: recipient.customerId }, select: { name: true } }) : null;
  await event(circle.id, 'ROUND', `Payment ${n} of ${circle.size} is due today. This payout goes to ${rc?.name || 'the next member'}.`);
  const dues = await prisma.circleDue.findMany({ where: { roundId: round.id } });
  for (const d of dues) await collectDue(d.id);
  // First try failed: tell them once.
  for (const d of await prisma.circleDue.findMany({ where: { roundId: round.id, status: 'DUE' } })) {
    await prisma.circleDue.update({ where: { id: d.id }, data: { failNoticeAt: new Date() } });
    notify(d.customerId, 'Ajo Circle payment', `We couldn’t take your full ${naira(circle.amount)} for “${circle.name}” today. Fund your wallet — it’s taken automatically as soon as money comes in.${Number(circle.penaltyFee) > 0 ? ` After ${circle.graceHours} hours a ${naira(circle.penaltyFee)} late fee applies.` : ''}`, { category: 'TRANSACTION' });
  }
  return round;
}

async function payOut(round, circle, { early = false, releaseId } = {}) {
  const fees = feeSplit(circle);
  const takeFee = round.feeTaken ? 0 : fees.fee;
  const out = r2(Number(round.collected) - Number(round.released) - takeFee);
  if (!(out > 0)) return 0;
  const member = await prisma.circleMember.findUnique({ where: { id: round.recipientMemberId } });
  if (!member) return 0;
  let done = false;
  await prisma.$transaction(async (tx) => {
    const r = await tx.circleRound.updateMany({ where: { id: round.id, status: 'COLLECTING', released: round.released }, data: { released: { increment: out + takeFee }, ...(takeFee > 0 ? { feeTaken: true, feeCreator: fees.creator, feeApp: fees.app } : {}), ...(early ? {} : { status: 'PAID', paidAt: new Date() }) } });
    if (r.count !== 1) return;
    done = true;
    await tx.customer.update({ where: { id: member.customerId }, data: { walletBalance: { increment: out } } });
    await tx.walletTransaction.create({ data: { customerId: member.customerId, type: 'CIRCLE_IN', amount: out, status: 'APPROVED', note: `Ajo Circle “${circle.name}” — payout ${round.number}${early ? ' (early, part)' : ''}` } });
    if (takeFee > 0 && fees.creator > 0) {
      await tx.customer.update({ where: { id: circle.creatorId }, data: { walletBalance: { increment: fees.creator } } });
      await tx.walletTransaction.create({ data: { customerId: circle.creatorId, type: 'CIRCLE_IN', amount: fees.creator, status: 'APPROVED', note: `Ajo Circle “${circle.name}” — payout fee (your ${100 - APP_SHARE}%)` } });
    }
    if (!early) await tx.circleMember.update({ where: { id: member.id }, data: { received: true, receivedAt: new Date() } });
    if (releaseId) await tx.circleRelease.update({ where: { id: releaseId }, data: { amount: out } });
  });
  if (!done) return 0;
  const who = await prisma.customer.findUnique({ where: { id: member.customerId }, select: { name: true } });
  notify(member.customerId, 'Ajo Circle payout', `${naira(out)} from “${circle.name}” has been added to your wallet${early ? ' (early part — the rest follows when everyone has paid)' : ''}. 🎉`, { category: 'TRANSACTION' });
  await event(circle.id, early ? 'RELEASE' : 'PAYOUT', `${naira(out)} paid to ${who?.name} for payout ${round.number}${early ? ' (early part, approved by ZAPPI PAY)' : ''}${takeFee > 0 ? ` · payout fee ${naira(takeFee)}` : ''}.`);
  if (!early) await notifyMembers(circle.id, 'Ajo Circle', `Payout ${round.number} of “${circle.name}” was paid to ${who?.name}.`, member.customerId);
  return out;
}

// Pays rounds strictly in order, as soon as everyone has paid.
async function tryPayouts(circleId) {
  for (;;) {
    const circle = await prisma.circle.findUnique({ where: { id: circleId } });
    if (!circle || circle.status !== 'ACTIVE') return;
    const round = await prisma.circleRound.findFirst({ where: { circleId, status: 'COLLECTING' }, orderBy: { number: 'asc' } });
    if (!round) break;
    const owing = await prisma.circleDue.count({ where: { roundId: round.id, status: 'DUE' } });
    if (owing > 0) break;
    const paid = await payOut(round, circle);
    const fresh = await prisma.circleRound.findUnique({ where: { id: round.id } });
    if (fresh.status !== 'PAID') {
      // Nothing left to pay (e.g. all released early) — close it.
      if (!(paid > 0)) {
        await prisma.circleRound.update({ where: { id: round.id }, data: { status: 'PAID', paidAt: new Date() } });
        if (round.recipientMemberId) await prisma.circleMember.update({ where: { id: round.recipientMemberId }, data: { received: true, receivedAt: new Date() } });
      } else break;
    }
  }
  const circle = await prisma.circle.findUnique({ where: { id: circleId } });
  if (circle?.status === 'ACTIVE') {
    const paidRounds = await prisma.circleRound.count({ where: { circleId, status: 'PAID' } });
    if (paidRounds >= circle.size) {
      await prisma.circle.update({ where: { id: circleId }, data: { status: 'COMPLETED', completedAt: new Date() } });
      await event(circleId, 'COMPLETED', 'Every member has received their payout. The circle is complete 🎉');
      await notifyMembers(circleId, 'Ajo Circle complete', `“${circle.name}” is complete — every member has been paid. Thank you for saving together! 🎉`);
    }
  }
}

// --- Late payments ----------------------------------------------------------

async function moveToLast(member, circle) {
  const ms = await members(circle.id);
  const order = ms.filter((m) => m.id !== member.id).map((m) => m.id).concat(member.id);
  for (const [i, id] of order.entries()) await prisma.circleMember.update({ where: { id }, data: { position: i + 1, ...(id === member.id ? { movedToLast: true } : {}) } });
  // If they were the recipient of a round still collecting, give it to the next in line.
  const rounds = await prisma.circleRound.findMany({ where: { circleId: circle.id, status: 'COLLECTING' } });
  for (const r of rounds.filter((x) => x.recipientMemberId === member.id)) {
    const fresh = await members(circle.id);
    const taken = rounds.map((x) => x.recipientMemberId);
    const next = fresh.find((m) => !m.received && m.id !== member.id && !taken.includes(m.id));
    if (next) await prisma.circleRound.update({ where: { id: r.id }, data: { recipientMemberId: next.id } });
  }
}

async function penalize(due, circle, settings) {
  const r = await prisma.circleDue.updateMany({ where: { id: due.id, status: 'DUE', penalizedAt: null }, data: { penalizedAt: new Date(), penalty: circle.penaltyFee } });
  if (r.count !== 1) return;
  const member = await prisma.circleMember.update({ where: { id: due.memberId }, data: { strikes: { increment: 1 } } });
  const who = await prisma.customer.findUnique({ where: { id: due.customerId }, select: { name: true } });
  const pen = Number(circle.penaltyFee);
  let note = '';
  if (!member.received && member.strikes >= circle.strikesToLast && !member.movedToLast) {
    await moveToLast(member, circle);
    note = ' Your payout number has moved to the end of the list, as the agreement says.';
    await event(circle.id, 'MOVED', `${who?.name} reached ${member.strikes} missed payments, so their payout number moved to the end.`);
  } else if (!member.received && !member.movedToLast) {
    const left = circle.strikesToLast - member.strikes;
    note = ` ${left} more missed payment${left === 1 ? '' : 's'} and your payout number moves to the end.`;
  }
  const banAt = Math.max(1, Number(settings.circleBanStrikes || 3));
  if (member.received || member.strikes >= banAt) {
    await prisma.customer.update({ where: { id: due.customerId }, data: { circleBannedAt: new Date(), circleBanReason: member.received ? `Missed a payment in “${circle.name}” after receiving a payout` : `${member.strikes} missed payments in “${circle.name}”` } });
    note += ' You can’t join new circles until ZAPPI PAY reviews an appeal.';
  }
  notify(due.customerId, 'Ajo Circle late payment', `Your payment for “${circle.name}” is late.${pen > 0 ? ` A ${naira(pen)} late fee has been added.` : ''}${note} Fund your wallet — it’s taken automatically.`, { category: 'TRANSACTION' });
  await event(circle.id, 'LATE', `${who?.name}’s payment is late (strike ${member.strikes})${pen > 0 ? ` — late fee ${naira(pen)} added to the pot` : ''}.`);
}

// --- The job (every 2 minutes) ---------------------------------------------

async function tick(now = new Date()) {
  const settings = await getSettings();
  if (!anyOn(settings)) return;
  const active = await prisma.circle.findMany({ where: { status: 'ACTIVE' } });
  for (const circle of active) {
    try {
      const opened = await prisma.circleRound.count({ where: { circleId: circle.id } });
      const n = opened + 1;
      if (n <= circle.size) {
        const dueAt = dueAtFor(circle, n);
        if (now >= dueAt) await openRound(circle, n);
        else {
          // Reminders: 3 days before (weekly/monthly), and a low-balance warning the day before.
          if (circle.frequency !== 'DAILY' && circle.remindedRound < n && now.getTime() >= dueAt.getTime() - 3 * 24 * HOUR) {
            await prisma.circle.update({ where: { id: circle.id }, data: { remindedRound: n } });
            await notifyMembers(circle.id, 'Ajo Circle reminder', `${naira(circle.amount)} will be taken for “${circle.name}” on ${dueAt.toDateString()}. Keep your wallet funded.`);
          }
          const warnBefore = circle.frequency === 'DAILY' ? 12 * HOUR : 24 * HOUR;
          if (circle.warnedRound < n && now.getTime() >= dueAt.getTime() - warnBefore) {
            await prisma.circle.update({ where: { id: circle.id }, data: { warnedRound: n } });
            for (const m of await members(circle.id)) {
              const c = await prisma.customer.findUnique({ where: { id: m.customerId }, select: { walletBalance: true } });
              if (Number(c?.walletBalance || 0) < Number(circle.amount)) notify(m.customerId, 'Ajo Circle: low balance', `⚠ Your wallet has less than ${naira(circle.amount)} for “${circle.name}”, due ${circle.frequency === 'DAILY' ? 'tomorrow morning' : 'tomorrow'}. Fund it now to avoid a late fee.`, { category: 'TRANSACTION' });
            }
          }
        }
      }
      // Late payments.
      for (const d of await prisma.circleDue.findMany({ where: { circleId: circle.id, status: 'DUE', penalizedAt: null, dueAt: { lte: new Date(now.getTime() - circle.graceHours * HOUR) } } })) await penalize(d, circle, settings);
      // Tell everyone once when a payout is held up, and by whom.
      for (const round of await prisma.circleRound.findMany({ where: { circleId: circle.id, status: 'COLLECTING', delayNotifiedAt: null, dueAt: { lte: new Date(now.getTime() - circle.graceHours * HOUR) } } })) {
        const late = await prisma.circleDue.findMany({ where: { roundId: round.id, status: 'DUE' } });
        if (!late.length) continue;
        await prisma.circleRound.update({ where: { id: round.id }, data: { delayNotifiedAt: now } });
        const names = (await prisma.customer.findMany({ where: { id: { in: late.map((d) => d.customerId) } }, select: { name: true } })).map((c) => c.name);
        await notifyMembers(circle.id, 'Ajo Circle payout delayed', `Payout ${round.number} of “${circle.name}” is waiting for: ${names.join(', ')}. It’s paid out automatically the moment they pay.`);
      }
      await tryPayouts(circle.id);
    } catch (e) {
      console.error('circle tick failed:', circle.id, e.message);
    }
  }
  // Retry overdue payments: whenever there's money, and tell the member every 6 hours.
  const overdue = await prisma.circleDue.findMany({ where: { status: 'DUE', dueAt: { lte: now } }, take: 500 });
  const ids = [...new Set(overdue.map((d) => d.customerId))];
  const balances = new Map((await prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, walletBalance: true } })).map((c) => [c.id, Number(c.walletBalance)]));
  const touched = new Set();
  for (const d of overdue) {
    if ((balances.get(d.customerId) || 0) > 0) {
      const took = await collectDue(d.id);
      if (took > 0) { balances.set(d.customerId, (balances.get(d.customerId) || 0) - took); touched.add(d.circleId); }
    } else if (!d.lastTryAt || now - new Date(d.lastTryAt) >= HOUR) {
      await prisma.circleDue.update({ where: { id: d.id }, data: { lastTryAt: now } });
      if (!d.failNoticeAt || now - new Date(d.failNoticeAt) >= 6 * HOUR) {
        await prisma.circleDue.update({ where: { id: d.id }, data: { failNoticeAt: now } });
        const owed = r2(Number(d.amount) + Number(d.penalty) - Number(d.paid));
        notify(d.customerId, 'Ajo Circle payment', `You still owe ${naira(owed)} to your Ajo Circle. We try every hour and take it the moment money comes into your wallet.`, { category: 'TRANSACTION' });
      }
    }
  }
  for (const id of touched) await tryPayouts(id);
}

let timer = null;
function startJob() {
  if (process.env.DISABLE_SCHEDULER === '1' || timer) return;
  timer = setInterval(() => tick().catch((e) => console.error('circles tick failed:', e.message)), 2 * 60 * 1000);
  timer.unref?.();
}

// --- Spending lock -----------------------------------------------------------

// Owing to a circle after already being paid out = no spending until settled.
async function owingLock(customerId) {
  const s = await getSettings().catch(() => ({}));
  if (!anyOn(s)) return null;
  const dues = await prisma.circleDue.findMany({ where: { customerId, status: 'DUE', dueAt: { lte: new Date() } } });
  if (!dues.length) return null;
  const memberIds = dues.map((d) => d.memberId);
  const paidOut = await prisma.circleMember.findMany({ where: { id: { in: memberIds }, received: true }, select: { id: true } });
  if (!paidOut.length) return null;
  const owed = r2(dues.filter((d) => paidOut.some((m) => m.id === d.memberId)).reduce((t, d) => t + Number(d.amount) + Number(d.penalty) - Number(d.paid), 0));
  return `You owe ${naira(owed)} to an Ajo Circle you have already been paid from. Fund your wallet to settle it first — it’s taken automatically — then you can use your wallet again.`;
}

// --- Early release & appeals ------------------------------------------------

async function requestRelease(circleId, customerId, { reason, agree } = {}) {
  const circle = await prisma.circle.findUnique({ where: { id: circleId } });
  if (!circle || circle.status !== 'ACTIVE') throw new CircleError('This circle isn’t running.');
  const round = await prisma.circleRound.findFirst({ where: { circleId, status: 'COLLECTING' }, orderBy: { number: 'asc' } });
  const me = await prisma.circleMember.findUnique({ where: { circleId_customerId: { circleId, customerId } } });
  if (!round || !me || round.recipientMemberId !== me.id) throw new CircleError('Only the member due for the current payout can ask for an early release.');
  const owing = await prisma.circleDue.count({ where: { roundId: round.id, status: 'DUE' } });
  if (!owing) throw new CircleError('Everyone has paid — your payout is on its way.');
  if (!agree) throw new CircleError('Tick that you agree to receive the rest later.', 400, 'AGREE');
  const fee = round.feeTaken ? 0 : feeSplit(circle).fee;
  const available = r2(Number(round.collected) - Number(round.released) - fee);
  if (!(available > 0)) throw new CircleError('There’s nothing in the pot to release yet.');
  const pending = await prisma.circleRelease.findFirst({ where: { roundId: round.id, status: 'PENDING' } });
  if (pending) throw new CircleError('You already asked — ZAPPI PAY is reviewing it.');
  const rel = await prisma.circleRelease.create({ data: { circleId, roundId: round.id, memberId: me.id, customerId, amount: available, reason: String(reason || '').trim().slice(0, 300) || null, agreedAt: new Date() } });
  const who = await prisma.customer.findUnique({ where: { id: customerId }, select: { name: true } });
  await event(circleId, 'RELEASE_ASKED', `${who?.name} asked to receive the ${naira(available)} collected so far for payout ${round.number}, and agreed the rest follows when everyone pays. Waiting for ZAPPI PAY.`);
  require('./adminAlert').alertAdmins('Ajo Circle early release request', `${who?.name} asked for ${naira(available)} early from “${circle.name}” (payout ${round.number}).`, '/admin/circles').catch?.(() => {});
  return rel;
}

async function reviewRelease(id, adminId, { approve, note } = {}) {
  const rel = await prisma.circleRelease.findUnique({ where: { id } });
  if (!rel || rel.status !== 'PENDING') throw new CircleError('This request was already handled.');
  const r = await prisma.circleRelease.updateMany({ where: { id, status: 'PENDING' }, data: { status: approve ? 'APPROVED' : 'REJECTED', reviewedAt: new Date(), reviewedBy: adminId, note: String(note || '').slice(0, 300) || null } });
  if (r.count !== 1) throw new CircleError('This request was already handled.');
  const circle = await prisma.circle.findUnique({ where: { id: rel.circleId } });
  if (!approve) {
    notify(rel.customerId, 'Ajo Circle', `Your early release request for “${circle.name}” was not approved${note ? `: ${note}` : ''}. Your payout is paid as soon as everyone has paid.`, { category: 'UPDATE' });
    await event(rel.circleId, 'RELEASE_REJECTED', 'ZAPPI PAY did not approve the early release request.');
    return { status: 'REJECTED' };
  }
  const round = await prisma.circleRound.findUnique({ where: { id: rel.roundId } });
  const paid = round.status === 'COLLECTING' ? await payOut(round, circle, { early: true, releaseId: rel.id }) : 0;
  await tryPayouts(circle.id);
  return { status: 'APPROVED', paid };
}

async function appeal(customerId, message) {
  const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { circleBannedAt: true } });
  if (!c?.circleBannedAt) throw new CircleError('You’re not blocked from circles.');
  const text = String(message || '').trim();
  if (text.length < 15) throw new CircleError('Tell us what happened and how you’ll keep up with payments (at least 15 letters).');
  if (await prisma.circleAppeal.findFirst({ where: { customerId, status: 'PENDING' } })) throw new CircleError('Your appeal is already being reviewed.');
  if (await owingLock(customerId)) throw new CircleError('Settle what you owe to your circle first, then appeal.');
  const a = await prisma.circleAppeal.create({ data: { customerId, message: text.slice(0, 1000) } });
  require('./adminAlert').alertAdmins('Ajo Circle appeal', 'A customer appealed their Ajo Circle block.', '/admin/circles').catch?.(() => {});
  return a;
}

async function reviewAppeal(id, adminId, { approve, note } = {}) {
  const a = await prisma.circleAppeal.findUnique({ where: { id } });
  if (!a || a.status !== 'PENDING') throw new CircleError('This appeal was already handled.');
  await prisma.circleAppeal.update({ where: { id }, data: { status: approve ? 'APPROVED' : 'REJECTED', reviewedAt: new Date(), reviewedBy: adminId, note: String(note || '').slice(0, 300) || null } });
  if (approve) await prisma.customer.update({ where: { id: a.customerId }, data: { circleBannedAt: null, circleBanReason: null } });
  notify(a.customerId, 'Ajo Circle appeal', approve ? 'Your appeal was approved — you can join Ajo Circles again. You’ll accept the agreement again when you join.' : `Your appeal was not approved${note ? `: ${note}` : ''}.`, { category: 'ACCOUNT' });
  return { status: approve ? 'APPROVED' : 'REJECTED' };
}

// --- Views -------------------------------------------------------------------

function publicCircle(c) {
  const fees = feeSplit(c);
  return { id: c.id, code: c.code, name: c.name, amount: Number(c.amount), frequency: c.frequency, size: c.size, status: c.status, startAt: c.startAt, pot: r2(Number(c.amount) * c.size), payoutFee: fees.fee, feeCreator: fees.creator, feeApp: fees.app, appShare: APP_SHARE, penaltyFee: Number(c.penaltyFee), graceHours: c.graceHours, strikesToLast: c.strikesToLast, extraRules: c.extraRules, createdAt: c.createdAt, startedAt: c.startedAt, completedAt: c.completedAt };
}

async function detail(circleId, viewerId, { admin = false } = {}) {
  const c = await prisma.circle.findUnique({ where: { id: circleId } });
  if (!c) throw new CircleError('Circle not found.', 404);
  const all = (await prisma.circleMember.findMany({ where: { circleId, status: { in: ['JOINED', 'INVITED'] } }, orderBy: [{ position: 'asc' }, { joinedAt: 'asc' }] })).sort(byPosition);
  const me = all.find((m) => m.customerId === viewerId && m.status === 'JOINED');
  if (!admin && !me && c.creatorId !== viewerId) throw new CircleError('You are not a member of this circle.', 403);
  const custs = new Map((await prisma.customer.findMany({ where: { id: { in: all.map((m) => m.customerId) } }, select: { id: true, name: true, username: true, walletBalance: true } })).map((x) => [x.id, x]));
  const rounds = (await prisma.circleRound.findMany({ where: { circleId }, orderBy: { number: 'asc' } })).sort((a, b) => a.number - b.number);
  const current = rounds.find((r) => r.status === 'COLLECTING') || null;
  const dues = current ? await prisma.circleDue.findMany({ where: { roundId: current.id } }) : [];
  const owedBy = new Map();
  for (const d of await prisma.circleDue.findMany({ where: { circleId, status: 'DUE' } })) owedBy.set(d.memberId, r2((owedBy.get(d.memberId) || 0) + Number(d.amount) + Number(d.penalty) - Number(d.paid)));
  const next = c.status === 'ACTIVE' && rounds.length < c.size ? dueAtFor(c, rounds.length + 1) : null;
  const events = await prisma.circleEvent.findMany({ where: { circleId }, orderBy: { createdAt: 'desc' }, take: 60 });
  const releases = await prisma.circleRelease.findMany({ where: { circleId }, orderBy: { createdAt: 'desc' }, take: 10 });
  const nameOf = (memberId) => custs.get(all.find((m) => m.id === memberId)?.customerId)?.name || '—';
  return {
    circle: publicCircle(c),
    isCreator: c.creatorId === viewerId,
    me: me ? { id: me.id, position: me.position, strikes: me.strikes, received: me.received, movedToLast: me.movedToLast, owed: owedBy.get(me.id) || 0, agreedAt: me.agreedAt } : null,
    members: all.map((m) => {
      const u = custs.get(m.customerId);
      const d = dues.find((x) => x.memberId === m.id);
      return {
        id: m.id,
        name: u?.name,
        username: u?.username,
        status: m.status,
        position: m.position,
        received: m.received,
        strikes: m.strikes,
        movedToLast: m.movedToLast,
        owed: owedBy.get(m.id) || 0,
        thisRound: d ? { paid: Number(d.paid), due: r2(Number(d.amount) + Number(d.penalty)), status: d.status, late: Boolean(d.penalizedAt) } : null,
        // Consented warning sign: balance below the next payment (amount not shown).
        lowBalance: m.status === 'JOINED' && c.status === 'ACTIVE' && Number(u?.walletBalance || 0) < Number(c.amount),
        isCreator: m.customerId === c.creatorId,
      };
    }),
    current: current ? {
      number: current.number,
      recipient: nameOf(current.recipientMemberId),
      recipientIsMe: me ? current.recipientMemberId === me.id : false,
      dueAt: current.dueAt,
      expected: Number(current.expected),
      collected: Number(current.collected),
      inPot: r2(Number(current.collected) - Number(current.released)),
      released: Number(current.released),
      waitingFor: dues.filter((d) => d.status === 'DUE').map((d) => ({ name: nameOf(d.memberId), owes: r2(Number(d.amount) + Number(d.penalty) - Number(d.paid)), late: Boolean(d.penalizedAt) })),
    } : null,
    nextDueAt: next,
    rounds: rounds.map((r) => ({ number: r.number, recipient: nameOf(r.recipientMemberId), dueAt: r.dueAt, status: r.status, collected: Number(r.collected), paidAt: r.paidAt })),
    releases: releases.map((r) => ({ id: r.id, amount: Number(r.amount), status: r.status, createdAt: r.createdAt, note: r.note })),
    events: events.map((e) => ({ kind: e.kind, message: e.message, at: e.createdAt })),
    agreement: agreement.terms(c, { appShare: APP_SHARE }),
  };
}

async function mine(customerId) {
  const rows = await prisma.circleMember.findMany({ where: { customerId, status: { in: ['JOINED', 'INVITED'] } } });
  const circles = await prisma.circle.findMany({ where: { id: { in: rows.map((r) => r.circleId) } }, orderBy: { createdAt: 'desc' } });
  const me = await prisma.customer.findUnique({ where: { id: customerId }, select: { circleBannedAt: true, circleBanReason: true } });
  const appealRow = me?.circleBannedAt ? await prisma.circleAppeal.findFirst({ where: { customerId }, orderBy: { createdAt: 'desc' } }) : null;
  const out = [];
  for (const c of circles) {
    const m = rows.find((r) => r.circleId === c.id);
    const owed = m.status === 'JOINED' ? r2((await prisma.circleDue.findMany({ where: { memberId: m.id, status: 'DUE' } })).reduce((t, d) => t + Number(d.amount) + Number(d.penalty) - Number(d.paid), 0)) : 0;
    const joined = await prisma.circleMember.count({ where: { circleId: c.id, status: 'JOINED' } });
    out.push({ ...publicCircle(c), myStatus: m.status, position: m.position, received: m.received, owed, joined, isCreator: c.creatorId === customerId });
  }
  return { circles: out, banned: me?.circleBannedAt ? { at: me.circleBannedAt, reason: me.circleBanReason, appeal: appealRow ? { status: appealRow.status, note: appealRow.note } : null } : null };
}

async function adminList() {
  const circles = await prisma.circle.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  const out = [];
  for (const c of circles) {
    const [joined, owing, pots, fees] = await Promise.all([
      prisma.circleMember.count({ where: { circleId: c.id, status: 'JOINED' } }),
      prisma.circleDue.count({ where: { circleId: c.id, status: 'DUE', dueAt: { lte: new Date() } } }),
      prisma.circleRound.findMany({ where: { circleId: c.id }, select: { status: true, collected: true, released: true, feeApp: true } }),
      null,
    ]);
    void fees;
    const creator = await prisma.customer.findUnique({ where: { id: c.creatorId }, select: { name: true } });
    out.push({ ...publicCircle(c), creator: creator?.name, joined, owing, inPots: r2(pots.filter((p) => p.status === 'COLLECTING').reduce((t, p) => t + Number(p.collected) - Number(p.released), 0)), paidRounds: pots.filter((p) => p.status === 'PAID').length, appFees: r2(pots.reduce((t, p) => t + Number(p.feeApp), 0)) });
  }
  const releases = await prisma.circleRelease.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } });
  const appeals = await prisma.circleAppeal.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } });
  const banned = await prisma.customer.findMany({ where: { circleBannedAt: { not: null } }, select: { id: true, name: true, phone: true, circleBannedAt: true, circleBanReason: true }, take: 100 });
  const names = new Map((await prisma.customer.findMany({ where: { id: { in: [...releases, ...appeals].map((x) => x.customerId) } }, select: { id: true, name: true, phone: true } })).map((x) => [x.id, x]));
  const cname = new Map(circles.map((c) => [c.id, c.name]));
  return {
    circles: out,
    releases: releases.map((r) => ({ id: r.id, circleId: r.circleId, circle: cname.get(r.circleId), customer: names.get(r.customerId)?.name, phone: names.get(r.customerId)?.phone, amount: Number(r.amount), reason: r.reason, createdAt: r.createdAt })),
    appeals: appeals.map((a) => ({ id: a.id, customer: names.get(a.customerId)?.name, phone: names.get(a.customerId)?.phone, message: a.message, createdAt: a.createdAt })),
    banned,
    totals: { running: out.filter((c) => c.status === 'ACTIVE').length, forming: out.filter((c) => c.status === 'FORMING').length, inPots: r2(out.reduce((t, c) => t + c.inPots, 0)), appFees: r2(out.reduce((t, c) => t + c.appFees, 0)) },
  };
}

module.exports = { APP_SHARE, CircleError, dueAtFor, feeSplit, create, preview, join, invite, leave, reorder, start, cancel, collectDue, onDeposit, tryPayouts, tick, startJob, owingLock, requestRelease, reviewRelease, appeal, reviewAppeal, detail, mine, adminList, publicCircle };
