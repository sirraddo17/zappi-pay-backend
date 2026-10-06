// Payroll for small businesses: keep a staff list (ZAPPI PAY wallet or
// bank account + amount) and pay everyone in one tap. Wallet staff are
// paid instantly; bank staff go through Send to Bank (normal fees/limits).

const prisma = require('./prisma');
const { notify } = require('./notify');
const F = require('./features');

async function list(ownerId) {
  const staff = await prisma.payrollStaff.findMany({ where: { ownerId, active: true } });
  const runs = (await prisma.payrollRun.findMany({ where: { ownerId } })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 12);
  return {
    staff: staff.map((x) => ({ id: x.id, name: x.name, payTo: x.payTo, identifier: x.identifier, bankCode: x.bankCode, accountNumber: x.accountNumber, accountName: x.accountName, amount: Number(x.amount) })),
    total: F.r2(staff.reduce((t, x) => t + Number(x.amount), 0)),
    runs: runs.map((r) => ({ id: r.id, label: r.label, total: Number(r.total), paid: r.paid, failed: r.failed, items: r.items, createdAt: r.createdAt })),
  };
}

async function addStaff(ownerId, b = {}) {
  await F.requireOn('payroll');
  const count = await prisma.payrollStaff.count({ where: { ownerId, active: true } });
  if (count >= 100) throw new F.FeatureError('You can have up to 100 staff.');
  const amount = F.r2(b.amount);
  if (!(amount >= 100 && amount <= 5000000)) throw new F.FeatureError('Enter a salary between ₦100 and ₦5,000,000.');
  const payTo = b.payTo === 'BANK' ? 'BANK' : 'WALLET';
  if (payTo === 'WALLET') {
    const t = String(b.identifier || '').trim().replace(/^@/, '');
    const c = await prisma.customer.findFirst({ where: { active: true, OR: [{ username: t.toLowerCase() }, { phone: t }] }, select: { id: true, name: true } });
    if (!c) throw new F.FeatureError('No ZAPPI PAY user with that username or phone.');
    if (c.id === ownerId) throw new F.FeatureError('You can’t add yourself.');
    return prisma.payrollStaff.create({ data: { ownerId, name: String(b.name || c.name).slice(0, 60), payTo, identifier: t, amount, active: true } });
  }
  const accountNumber = String(b.accountNumber || '').replace(/\D/g, '');
  if (!b.bankCode || accountNumber.length !== 10) throw new F.FeatureError('Choose the bank and enter the 10-digit account number.');
  const acct = await require('./disbursement').lookupAccount(b.bankCode, accountNumber).catch((e) => { throw new F.FeatureError(`We couldn’t find that account (${e.message}).`); });
  return prisma.payrollStaff.create({ data: { ownerId, name: String(b.name || acct.accountName).slice(0, 60), payTo, bankCode: String(b.bankCode), accountNumber, accountName: acct.accountName, amount, active: true } });
}

async function updateStaff(ownerId, id, b = {}) {
  const x = await prisma.payrollStaff.findUnique({ where: { id } });
  if (!x || x.ownerId !== ownerId) throw new F.FeatureError('Not found.', 404);
  const data = {};
  if (b.amount !== undefined) { const a = F.r2(b.amount); if (!(a >= 100)) throw new F.FeatureError('Enter a salary of at least ₦100.'); data.amount = a; }
  if (b.remove) data.active = false;
  await prisma.payrollStaff.update({ where: { id }, data });
  return { ok: true };
}

async function run(ownerId, label) {
  await F.requireOn('payroll');
  await F.checkSpend(ownerId);
  const staff = await prisma.payrollStaff.findMany({ where: { ownerId, active: true } });
  if (!staff.length) throw new F.FeatureError('Add your staff first.');
  const total = F.r2(staff.reduce((t, x) => t + Number(x.amount), 0));
  const owner = await prisma.customer.findUnique({ where: { id: ownerId }, select: { name: true, walletBalance: true } });
  if (Number(owner.walletBalance) < total) throw new F.FeatureError(`You need ${F.naira(total)} in your wallet (plus bank transfer fees) to pay everyone.`, 402, 'INSUFFICIENT_BALANCE');
  const name = String(label || '').trim().slice(0, 40) || `Salary ${new Date().toLocaleDateString('en-NG', { month: 'long', year: 'numeric' })}`;
  const items = [];
  for (const x of staff) {
    try {
      if (x.payTo === 'WALLET') {
        const to = await prisma.customer.findFirst({ where: { active: true, OR: [{ username: String(x.identifier).toLowerCase() }, { phone: x.identifier }] }, select: { id: true } });
        if (!to) throw new Error('user not found');
        const ok = await F.move({ fromId: ownerId, toId: to.id, amount: x.amount, outType: 'PAYROLL_OUT', inType: 'PAYROLL_IN', outNote: `${name}: ${x.name}`, inNote: `${name} from ${owner.name}` });
        if (!ok) throw new Error('wallet balance too low');
        notify(to.id, 'Salary received 💼', `${owner.name} paid you ${F.naira(x.amount)} (${name}).`, { category: 'TRANSACTION' });
      } else {
        await require('./disbursement').sendToBank(ownerId, { bankCode: x.bankCode, accountNumber: x.accountNumber, amount: Number(x.amount), narration: `${name} ${owner.name}`.slice(0, 60) });
      }
      items.push({ name: x.name, amount: Number(x.amount), to: x.payTo === 'WALLET' ? `@${x.identifier}` : `${x.accountName} ${x.accountNumber}`, ok: true });
    } catch (e) {
      items.push({ name: x.name, amount: Number(x.amount), to: x.payTo === 'WALLET' ? `@${x.identifier}` : `${x.accountName} ${x.accountNumber}`, ok: false, error: String(e.message).slice(0, 120) });
    }
  }
  const paid = items.filter((i) => i.ok).length;
  const r = await prisma.payrollRun.create({ data: { ownerId, label: name, total: F.r2(items.filter((i) => i.ok).reduce((t, i) => t + i.amount, 0)), paid, failed: items.length - paid, items } });
  notify(ownerId, 'Payroll done', `${name}: ${paid} of ${items.length} staff paid${items.length - paid ? ` — ${items.length - paid} failed, see Payroll` : ''}.`, { category: 'TRANSACTION' });
  return { id: r.id, paid, failed: items.length - paid, items };
}

module.exports = { list, addStaff, updateStaff, run };
