const prisma = require('./prisma');
const { vtpassRequest } = require('./vtpass');

// The daily money check: what customers are owed vs what is in VTpass
// and Monnify. Used by Admin → Money check and the admin assistant.
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const PENDING_TRANSFER = ['PROCESSING', 'HELD', 'PENDING_AUTHORIZATION'];
async function sum(model, where, fields) {
  const a = await prisma[model].aggregate({ where, _sum: Object.fromEntries(fields.map((f) => [f, true])), _count: true });
  return { count: a._count, ...Object.fromEntries(fields.map((f) => [f, r2(a._sum[f])])) };
}

// Test accounts: customers whose wallet money came only from sandbox
// (test) partners or test purchases — they have sandbox funding or a test
// order, and no funding through a live partner. Their balances are test
// money, so the Money check screen shows them apart instead of as a
// shortfall. Display only: owed.total (used by the funds guard) still
// counts every customer.
async function testAccounts(modes) {
  const withMoney = await prisma.customer.findMany({
    where: { deletedAt: null, OR: [{ walletBalance: { not: 0 } }, { cashbackBalance: { not: 0 } }, { savingsBalance: { not: 0 } }] },
    select: { id: true, walletBalance: true, cashbackBalance: true, savingsBalance: true },
  });
  const ids = withMoney.map((c) => c.id);
  if (!ids.length) return { ids: new Set(), count: 0, wallets: 0, cashback: 0, savings: 0, total: 0 };
  const [funds, testOrders] = await Promise.all([
    prisma.walletTransaction.findMany({ where: { customerId: { in: ids }, type: 'FUND', status: 'APPROVED' }, select: { customerId: true, providerRef: true } }),
    prisma.order.findMany({ where: { customerId: { in: ids }, isTest: true }, select: { customerId: true }, distinct: ['customerId'] }),
  ]);
  const providerOf = (ref) => { const p = String(ref || ''); return /^NB-/.test(p) ? 'nomba' : /^SQ-/.test(p) ? 'squad' : p ? 'monnify' : null; };
  const live = new Set();
  const test = new Set(testOrders.map((o) => o.customerId));
  for (const f of funds) {
    const p = providerOf(f.providerRef);
    if (!p) continue; // manual / admin funding: neither
    (modes[p] === 'live' ? live : test).add(f.customerId);
  }
  const list = withMoney.filter((c) => test.has(c.id) && !live.has(c.id));
  const add = (k) => r2(list.reduce((a, c) => a + Number(c[k] || 0), 0));
  const out = { ids: new Set(list.map((c) => c.id)), count: list.length, wallets: add('walletBalance'), cashback: add('cashbackBalance'), savings: add('savingsBalance') };
  out.total = r2(out.wallets + out.cashback + out.savings);
  return out;
}

async function moneyCheck(otherIn = 0) {
  const other = Math.max(0, Number(otherIn) || 0);
    const [wallets, savings, pendingOrders, pendingTransfers, pendingFunding, negative] = await Promise.all([
      sum('customer', { deletedAt: null }, ['walletBalance', 'cashbackBalance']),
      sum('customer', { deletedAt: null }, ['savingsBalance']),
      sum('order', { status: 'PENDING' }, ['amount']),
      sum('bankTransfer', { status: { in: PENDING_TRANSFER } }, ['amount', 'fee']),
      sum('walletTransaction', { type: 'FUND', status: 'PENDING' }, ['amount']),
      prisma.customer.count({ where: { walletBalance: { lt: 0 } } }),
    ]);

    let vtpass = null;
    let vtpassError = null;
    try {
      const b = await vtpassRequest('GET', '/balance');
      const n = Number(b?.contents?.balance ?? b?.content?.balance ?? b?.balance);
      vtpass = Number.isFinite(n) ? n : null;
    } catch (error) {
      vtpassError = error.message;
    }

    let monnify = null;
    let monnifyError = null;
    try {
      const m = require('./monnify');
      const d = require('./disbursement');
      const settings = await d.transferSettings();
      if ((await m.isConfigured()) && settings.walletAccount) {
        const b = await m.api('GET', `/api/v2/disbursements/wallet-balance?accountNumber=${encodeURIComponent(settings.walletAccount)}`);
        monnify = Number(b?.availableBalance ?? 0);
      } else {
        monnifyError = 'Monnify wallet not set up';
      }
    } catch (error) {
      monnifyError = error.message;
    }

    // Squad wallet (GTBank account-number payments collect here, and
    // Squad can send the bank transfers). Only read when Squad is set up.
    let squad = null;
    let squadError = null;
    try {
      const sq = require('./squad');
      if (await sq.isConfigured()) squad = await sq.walletBalance();
    } catch (error) {
      squadError = error.message;
    }

    // Nomba wallet (its account-number payments, and its transfers).
    let nomba = null;
    let nombaError = null;
    try {
      const nb = require('./nomba');
      if (await nb.isConfigured()) nomba = await nb.walletBalance();
    } catch (error) {
      nombaError = error.message;
    }

    // Money you owe: what's in customers' wallets and savings, plus
    // bank transfers already taken from wallets but not yet paid out.
    // Cashback balances too: customers can spend them on purchases.
    // Money on hold for wrong-transfer reports is still owed to someone.
    const held = await require('./disputes').heldTotal().catch(() => 0);
    const owed = r2(wallets.walletBalance + (wallets.cashbackBalance || 0) + savings.savingsBalance + pendingTransfers.amount + held);
    // Partners on sandbox (test) keys hold test money: shown, never counted.
    const settings = await require('./vtpass').getSettings();
    const modes = { vtpass: settings.vtpassMode === 'live' ? 'live' : 'sandbox', ...(await require('./goLive').partnerModes().catch(() => ({ monnify: 'sandbox', squad: 'sandbox', nomba: 'sandbox' }))) };
    const real = (k, v) => (modes[k] === 'live' ? v || 0 : 0);
    const sandbox = Object.fromEntries([['vtpass', vtpass], ['monnify', monnify], ['squad', squad], ['nomba', nomba]].filter(([k, v]) => modes[k] !== 'live' && v !== null && v !== undefined));
    const have = r2(real('vtpass', vtpass) + real('monnify', monnify) + real('squad', squad) + real('nomba', nomba) + other);
    const difference = r2(have - owed);
    const complete = vtpass !== null && (monnify !== null || modes.monnify !== 'live');
    // Every part of "owed", so the rows add up to the total.
    const parts = [
      { key: 'wallets', label: 'Customer wallets', amount: wallets.walletBalance },
      { key: 'cashback', label: 'Unexpired cashback (spendable on purchases)', amount: wallets.cashbackBalance || 0 },
      { key: 'savings', label: 'Customer savings', amount: savings.savingsBalance },
      { key: 'pendingTransfers', label: 'Bank transfers not yet paid out', amount: pendingTransfers.amount },
      { key: 'heldForDisputes', label: 'Held for wrong-transfer reports', amount: held },
    ];
    // The same view with test accounts left out (for the Money check screen).
    const ta = await testAccounts(modes).catch(() => null);
    let realView = null;
    if (ta) {
      const realParts = parts.map((p) => (p.key === 'wallets' ? { ...p, label: 'Customer wallets (real customers only)', amount: r2(p.amount - ta.wallets) } : p.key === 'cashback' ? { ...p, amount: r2(p.amount - ta.cashback) } : p.key === 'savings' ? { ...p, amount: r2(p.amount - ta.savings) } : p));
      const realOwed = r2(owed - ta.total);
      const realDiff = r2(have - realOwed);
      realView = {
        owed: realOwed,
        customers: Math.max(0, wallets.count - ta.count),
        parts: realParts,
        difference: realDiff,
        status: !complete ? 'INCOMPLETE' : realDiff >= 0 ? 'OK' : 'SHORT',
        testAccounts: { count: ta.count, wallets: ta.wallets, cashback: ta.cashback, savings: ta.savings, total: ta.total },
      };
    }

    return {
      at: new Date(),
      owed: {
        total: owed,
        wallets: wallets.walletBalance,
        cashback: wallets.cashbackBalance || 0,
        heldForDisputes: held,
        customers: wallets.count,
        savings: savings.savingsBalance,
        pendingTransfers: pendingTransfers.amount,
        pendingTransferCount: pendingTransfers.count,
        parts,
        partsTotal: r2(parts.reduce((a, p) => a + Number(p.amount || 0), 0)),
      },
      have: { total: have, vtpass, vtpassError, monnify, monnifyError, squad, squadError, nomba, nombaError, other, modes, sandbox, sandboxNote: Object.keys(sandbox).length ? `Not counted: ${Object.keys(sandbox).join(', ')} ${Object.keys(sandbox).length === 1 ? 'is' : 'are'} on SANDBOX (test money).` : null },
      difference,
      real: realView,
      status: !complete ? 'INCOMPLETE' : difference >= 0 ? 'OK' : 'SHORT',
      info: {
        pendingOrders: pendingOrders.amount,
        pendingOrderCount: pendingOrders.count,
        pendingFunding: pendingFunding.amount,
        pendingFundingCount: pendingFunding.count,
        negativeWallets: negative,
      },
    };
}

module.exports = { moneyCheck };
