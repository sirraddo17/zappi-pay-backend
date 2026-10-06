// Association Dues: an estate, church, mosque, alumni set or staff club
// collects a fixed due every week / month / year. Members join with the
// link, pay from their wallet (or switch on auto-pay), and the treasurer
// sees who has paid each period. Dues go straight to the treasurer's wallet.

const prisma = require('./prisma');
const { notify } = require('./notify');
const F = require('./features');

const FREQ = ['WEEKLY', 'MONTHLY', 'YEARLY'];
const DAY = 24 * 3600 * 1000;
const lagos = (d = new Date()) => new Date(new Date(d).getTime() + 3600 * 1000);
const pad = (n) => String(n).padStart(2, '0');

// The period a date falls in, and that period's due date.
function periodOf(a, date = new Date()) {
  const d = lagos(date);
  const y = d.getUTCFullYear();
  if (a.frequency === 'YEARLY') return { key: String(y), label: String(y), dueAt: new Date(Date.UTC(y, 0, Math.min(28, a.dueDay), 7)) };
  if (a.frequency === 'MONTHLY') {
    const m = d.getUTCMonth();
    return { key: `${y}-${pad(m + 1)}`, label: new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-NG', { month: 'long', year: 'numeric', timeZone: 'UTC' }), dueAt: new Date(Date.UTC(y, m, Math.min(28, a.dueDay), 7)) };
  }
  // WEEKLY: weeks start Monday; dueDay 1 = Monday … 7 = Sunday.
  const monday = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
  const key = `W${monday.toISOString().slice(0, 10)}`;
  return { key, label: `Week of ${monday.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`, dueAt: new Date(monday.getTime() + (Math.min(7, Math.max(1, a.dueDay)) - 1) * DAY + 7 * 3600 * 1000) };
}

// Periods from `from` up to now (newest first), max n.
function periodsSince(a, from, n = 12) {
  const out = [];
  let d = new Date();
  const seen = new Set();
  while (out.length < n) {
    const p = periodOf(a, d);
    if (!seen.has(p.key)) { seen.add(p.key); out.push(p); }
    if (p.dueAt < new Date(from) && out.length > 0) break;
    d = new Date(p.dueAt.getTime() - (a.frequency === 'WEEKLY' ? 7 : a.frequency === 'MONTHLY' ? 28 : 365) * DAY);
  }
  return out;
}

async function create(ownerId, b = {}) {
  await F.requireOn('dues');
  const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (name.length < 3) throw new F.FeatureError('Give the group a name (e.g. “Unity Estate Landlords”).');
  const amount = F.r2(b.amount);
  if (!(amount >= 100 && amount <= 1000000)) throw new F.FeatureError('Dues must be between ₦100 and ₦1,000,000.');
  const frequency = String(b.frequency || '').toUpperCase();
  if (!FREQ.includes(frequency)) throw new F.FeatureError('Choose weekly, monthly or yearly.');
  const max = frequency === 'WEEKLY' ? 7 : 28;
  const dueDay = Math.max(1, Math.min(max, parseInt(b.dueDay, 10) || 1));
  const a = await prisma.association.create({ data: { code: F.newCode(5), name, ownerId, amount, frequency, dueDay, description: String(b.description || '').trim().slice(0, 500) || null, status: 'ACTIVE' } });
  await prisma.associationMember.create({ data: { assocId: a.id, customerId: ownerId, role: 'OWNER', autoPay: false, status: 'ACTIVE' } });
  return a;
}

async function byCode(code) {
  const a = await prisma.association.findUnique({ where: { code: String(code || '') } });
  if (!a) throw new F.FeatureError('This dues link is not valid.', 404);
  return a;
}

async function join(code, customerId) {
  await F.requireOn('dues');
  const a = await byCode(code);
  if (a.status !== 'ACTIVE') throw new F.FeatureError('This group is closed.');
  const m = await prisma.associationMember.findUnique({ where: { assocId_customerId: { assocId: a.id, customerId } } });
  if (m?.status === 'ACTIVE') return { assocId: a.id };
  if (m) await prisma.associationMember.update({ where: { id: m.id }, data: { status: 'ACTIVE' } });
  else await prisma.associationMember.create({ data: { assocId: a.id, customerId, role: 'MEMBER', autoPay: false, status: 'ACTIVE' } });
  const me = await prisma.customer.findUnique({ where: { id: customerId }, select: { name: true } });
  notify(a.ownerId, 'Dues group', `${me?.name} joined “${a.name}”.`, { category: 'UPDATE' });
  return { assocId: a.id };
}

async function pay(assocId, customerId, period) {
  await F.requireOn('dues');
  const a = await prisma.association.findUnique({ where: { id: assocId } });
  if (!a || a.status !== 'ACTIVE') throw new F.FeatureError('Group not found.', 404);
  const m = await prisma.associationMember.findUnique({ where: { assocId_customerId: { assocId, customerId } } });
  if (!m || m.status !== 'ACTIVE') throw new F.FeatureError('Join the group first.', 403);
  const p = period ? periodsSince(a, m.joinedAt, 24).find((x) => x.key === period) : periodOf(a);
  if (!p) throw new F.FeatureError('Choose a period to pay for.');
  if (await prisma.duesPayment.findUnique({ where: { assocId_customerId_period: { assocId, customerId, period: p.key } } })) throw new F.FeatureError(`You’ve already paid for ${p.label}.`);
  await F.checkSpend(customerId);
  const me = await prisma.customer.findUnique({ where: { id: customerId }, select: { name: true } });
  if (a.ownerId === customerId) {
    // The treasurer's own dues: the money is already theirs — just mark it paid.
    try { await prisma.duesPayment.create({ data: { assocId, customerId, period: p.key, amount: a.amount } }); } catch (e) { if (e.code === 'P2002') throw new F.FeatureError(`You’ve already paid for ${p.label}.`); throw e; }
    return { paid: true, period: p.key, label: p.label };
  }
  const ok = await F.move({
    fromId: customerId, toId: a.ownerId, amount: a.amount, outType: 'DUES_OUT', inType: 'DUES_IN',
    outNote: `Dues: ${a.name} — ${p.label}`, inNote: `Dues from ${me?.name}: ${a.name} — ${p.label}`,
    extra: async (tx) => {
      try { await tx.duesPayment.create({ data: { assocId, customerId, period: p.key, amount: a.amount } }); } catch (e) { if (e.code === 'P2002') throw Object.assign(new Error('dup'), { dup: true }); throw e; }
    },
  }).catch((e) => { if (e.dup) return 'dup'; throw e; });
  if (ok === 'dup') throw new F.FeatureError(`You’ve already paid for ${p.label}.`);
  if (!ok) throw new F.FeatureError('Insufficient wallet balance.', 402, 'INSUFFICIENT_BALANCE');
  notify(customerId, 'Dues paid', `You paid ${F.naira(a.amount)} dues to “${a.name}” for ${p.label}. ✅`, { category: 'TRANSACTION' });
  return { paid: true, period: p.key, label: p.label };
}

async function setAutoPay(assocId, customerId, on) {
  const m = await prisma.associationMember.findUnique({ where: { assocId_customerId: { assocId, customerId } } });
  if (!m || m.status !== 'ACTIVE') throw new F.FeatureError('Join the group first.', 403);
  await prisma.associationMember.update({ where: { id: m.id }, data: { autoPay: Boolean(on) } });
  return { autoPay: Boolean(on) };
}

async function leave(assocId, customerId) {
  const a = await prisma.association.findUnique({ where: { id: assocId } });
  if (a?.ownerId === customerId) throw new F.FeatureError('You run this group — close it instead.');
  await prisma.associationMember.updateMany({ where: { assocId, customerId }, data: { status: 'LEFT', autoPay: false } });
  return { left: true };
}

async function detail(assocId, viewerId, { period } = {}) {
  const a = await prisma.association.findUnique({ where: { id: assocId } });
  if (!a) throw new F.FeatureError('Group not found.', 404);
  const members = await prisma.associationMember.findMany({ where: { assocId, status: 'ACTIVE' } });
  const me = members.find((m) => m.customerId === viewerId);
  if (!me) throw new F.FeatureError('You are not in this group.', 403);
  const isOwner = a.ownerId === viewerId;
  const periods = periodsSince(a, a.createdAt, 12);
  const p = periods.find((x) => x.key === period) || periods[0];
  const pays = await prisma.duesPayment.findMany({ where: { assocId, period: p.key } });
  const custs = new Map((await prisma.customer.findMany({ where: { id: { in: members.map((m) => m.customerId) } }, select: { id: true, name: true, phone: true, username: true } })).map((c) => [c.id, c]));
  const myPays = await prisma.duesPayment.findMany({ where: { assocId, customerId: viewerId } });
  const myPeriods = periodsSince(a, me.joinedAt, 12).map((x) => ({ ...x, paid: myPays.some((y) => y.period === x.key) }));
  return {
    group: { id: a.id, code: a.code, name: a.name, amount: Number(a.amount), frequency: a.frequency, dueDay: a.dueDay, description: a.description, status: a.status },
    isOwner,
    me: { autoPay: me.autoPay, periods: myPeriods },
    period: { key: p.key, label: p.label, dueAt: p.dueAt },
    periods: periods.map((x) => ({ key: x.key, label: x.label })),
    // Everyone sees the count; the treasurer sees names.
    summary: { members: members.length, paid: pays.length, collected: F.r2(pays.reduce((t, x) => t + Number(x.amount), 0)), expected: F.r2(members.length * Number(a.amount)) },
    members: isOwner ? members.map((m) => {
      const c = custs.get(m.customerId);
      const pd = pays.find((x) => x.customerId === m.customerId);
      return { id: m.id, name: c?.name, phone: c?.phone, username: c?.username, role: m.role, autoPay: m.autoPay, paid: Boolean(pd), paidAt: pd?.createdAt || null };
    }) : null,
  };
}

async function remindUnpaid(assocId, ownerId) {
  const a = await prisma.association.findUnique({ where: { id: assocId } });
  if (!a || a.ownerId !== ownerId) throw new F.FeatureError('Only the treasurer can do this.', 403);
  const p = periodOf(a);
  const members = await prisma.associationMember.findMany({ where: { assocId, status: 'ACTIVE' } });
  const paid = new Set((await prisma.duesPayment.findMany({ where: { assocId, period: p.key } })).map((x) => x.customerId));
  let n = 0;
  for (const m of members) if (!paid.has(m.customerId) && m.customerId !== ownerId) { n += 1; notify(m.customerId, 'Dues reminder', `Your ${F.naira(a.amount)} dues to “${a.name}” for ${p.label} are due. Pay in the app: More → Association Dues.`, { category: 'TRANSACTION' }); }
  return { reminded: n };
}

async function mine(customerId) {
  const rows = await prisma.associationMember.findMany({ where: { customerId, status: 'ACTIVE' } });
  const groups = await prisma.association.findMany({ where: { id: { in: rows.map((r) => r.assocId) } } });
  const out = [];
  for (const a of groups) {
    const p = periodOf(a);
    const paid = Boolean(await prisma.duesPayment.findUnique({ where: { assocId_customerId_period: { assocId: a.id, customerId, period: p.key } } }));
    out.push({ id: a.id, code: a.code, name: a.name, amount: Number(a.amount), frequency: a.frequency, isOwner: a.ownerId === customerId, period: p.label, paid, autoPay: rows.find((r) => r.assocId === a.id)?.autoPay });
  }
  return out;
}

async function preview(code) {
  const a = await byCode(code);
  const owner = await prisma.customer.findUnique({ where: { id: a.ownerId }, select: { name: true } });
  const count = await prisma.associationMember.count({ where: { assocId: a.id, status: 'ACTIVE' } });
  return { group: { id: a.id, name: a.name, amount: Number(a.amount), frequency: a.frequency, dueDay: a.dueDay, description: a.description, status: a.status }, treasurer: owner?.name, members: count };
}

// Job: on the due day, auto-pay for members who switched it on, and a
// reminder to the rest (once per period); a second reminder 3 days later.
async function tick(now = new Date()) {
  const s = await require('./vtpass').getSettings();
  if (!s.duesEnabled) return;
  const groups = await prisma.association.findMany({ where: { status: 'ACTIVE' } });
  for (const a of groups) {
    const p = periodOf(a, now);
    if (now < p.dueAt) continue;
    const tag = `dues-${a.id}-${p.key}`;
    const first = await prisma.festivalAlert.create({ data: { id: `${tag}-due` } }).then(() => true).catch(() => false);
    const late = now - p.dueAt >= 3 * DAY && (await prisma.festivalAlert.create({ data: { id: `${tag}-late` } }).then(() => true).catch(() => false));
    if (!first && !late) continue;
    const members = await prisma.associationMember.findMany({ where: { assocId: a.id, status: 'ACTIVE' } });
    const paid = new Set((await prisma.duesPayment.findMany({ where: { assocId: a.id, period: p.key } })).map((x) => x.customerId));
    for (const m of members) {
      if (paid.has(m.customerId) || m.customerId === a.ownerId) continue;
      if (m.autoPay) {
        try { await pay(a.id, m.customerId, p.key); continue; } catch (e) { notify(m.customerId, 'Dues auto-pay failed', `We couldn’t auto-pay your ${F.naira(a.amount)} dues to “${a.name}” (${e.message}). Fund your wallet and pay in the app.`, { category: 'TRANSACTION' }); continue; }
      }
      notify(m.customerId, late ? 'Dues overdue' : 'Dues due today', `Your ${F.naira(a.amount)} dues to “${a.name}” for ${p.label} ${late ? 'are overdue' : 'are due today'}. Pay in the app: More → Association Dues.`, { category: 'TRANSACTION' });
    }
  }
}

module.exports = { FREQ, periodOf, periodsSince, create, join, pay, setAutoPay, leave, detail, remindUnpaid, mine, preview, tick };
