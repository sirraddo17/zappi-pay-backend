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

    // Money you owe: what's in customers' wallets and savings, plus
    // bank transfers already taken from wallets but not yet paid out.
    // Cashback balances too: customers can spend them on purchases.
    // Money on hold for wrong-transfer reports is still owed to someone.
    const held = await require('./disputes').heldTotal().catch(() => 0);
    const owed = r2(wallets.walletBalance + (wallets.cashbackBalance || 0) + savings.savingsBalance + pendingTransfers.amount + held);
    const have = r2((vtpass || 0) + (monnify || 0) + (squad || 0) + other);
    const difference = r2(have - owed);
    const complete = vtpass !== null && monnify !== null;

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
      },
      have: { total: have, vtpass, vtpassError, monnify, monnifyError, squad, squadError, other },
      difference,
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
