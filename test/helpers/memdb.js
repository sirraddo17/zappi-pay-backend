// In-memory stand-in for the Prisma client, for money tests. Behaves like
// Postgres where it matters: decimals are exact (kept as kobo), unique
// constraints throw P2002, and $transaction rolls everything back on error.

const DECIMALS = new Set(['amount', 'walletBalance', 'cashbackBalance', 'savingsBalance', 'costAmount', 'cashbackUsed', 'discountAmount', 'promoDiscount', 'cashbackAmount', 'balance', 'shopCommission', 'fee']);
const UNIQUE = {
  cashbackEntry: [['orderId', 'type'], ['reference']],
  walletTransaction: [['providerRef']],
  order: [['vtpassRequestId']],
  customer: [['phone']],
  rewardPool: [['key']],
};

const k = (v) => {
  if (v === null || v === undefined) return v;
  const s = String(v);
  const neg = s.startsWith('-');
  const [w, f = ''] = s.replace('-', '').split('.');
  const kob = Number(w || 0) * 100 + Number((f + '00').slice(0, 2));
  return neg ? -kob : kob;
};
const dec = (kob) => (kob === null || kob === undefined ? kob : `${kob < 0 ? '-' : ''}${Math.floor(Math.abs(kob) / 100)}.${String(Math.abs(kob) % 100).padStart(2, '0')}`);

let seq = 0;
const id = () => `id${(seq += 1).toString().padStart(5, '0')}`;

function cmp(field, a, cond) {
  const num = DECIMALS.has(field);
  const val = (x) => (x instanceof Date ? x.getTime() : num && x !== null && x !== undefined ? k(x) : x);
  if (cond === null) return a === null || a === undefined;
  if (typeof cond !== 'object' || cond instanceof Date) return val(a) === val(cond);
  for (const [op, c] of Object.entries(cond)) {
    const A = val(a);
    const C = Array.isArray(c) ? c.map(val) : val(c);
    if (op === 'equals' && A !== C) return false;
    if (op === 'gte' && !(A !== null && A !== undefined && A >= C)) return false;
    if (op === 'gt' && !(A !== null && A !== undefined && A > C)) return false;
    if (op === 'lte' && !(A !== null && A !== undefined && A <= C)) return false;
    if (op === 'lt' && !(A !== null && A !== undefined && A < C)) return false;
    if (op === 'in' && !C.includes(A)) return false;
    if (op === 'notIn' && C.includes(A)) return false;
    if (op === 'not') { if (c === null ? A === null || A === undefined : A === C) return false; }
    if (op === 'startsWith' && !String(a || '').startsWith(c)) return false;
  }
  return true;
}

function matches(row, where = {}) {
  for (const [f, cond] of Object.entries(where || {})) {
    if (f === 'OR') { if (!cond.some((w) => matches(row, w))) return false; continue; }
    if (f === 'AND') { if (!cond.every((w) => matches(row, w))) return false; continue; }
    if (f === 'NOT') { if (matches(row, cond)) return false; continue; }
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && Object.keys(cond).length && Object.keys(cond).every((x) => /^[a-z]+_[a-z]+$/i.test(x) === false && !['equals', 'gte', 'gt', 'lte', 'lt', 'in', 'notIn', 'not', 'startsWith'].includes(x))) {
      // compound unique like customerId_day: { customerId, day }
      if (!matches(row, cond)) return false;
      continue;
    }
    if (!cmp(f, row[f], cond)) return false;
  }
  return true;
}

function apply(row, data) {
  for (const [f, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !(v instanceof Date) && ('increment' in v || 'decrement' in v)) {
      const by = v.increment ?? -v.decrement;
      if (DECIMALS.has(f)) row[f] = dec(k(row[f] ?? 0) + (v.increment !== undefined ? k(v.increment) : -k(v.decrement)));
      else row[f] = Number(row[f] || 0) + Number(by);
    } else if (v !== undefined) {
      row[f] = DECIMALS.has(f) && v !== null ? dec(k(v)) : v;
    }
  }
  return row;
}

function makeDb() {
  const tables = {};
  const t = (name) => (tables[name] = tables[name] || []);
  const checkUnique = (name, row, self) => {
    for (const cols of UNIQUE[name] || []) {
      if (cols.some((c) => row[c] === null || row[c] === undefined)) continue;
      if (t(name).some((r) => r !== self && cols.every((c) => r[c] === row[c]))) throw Object.assign(new Error(`Unique constraint failed on ${name}(${cols})`), { code: 'P2002' });
    }
  };
  const pick = (row, select) => {
    if (!row) return row;
    const copy = JSON.parse(JSON.stringify(row), (key, v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v) : v));
    if (!select) return copy;
    return Object.fromEntries(Object.keys(select).filter((x) => select[x]).map((x) => [x, copy[x]]));
  };
  const model = (name) => ({
    async create({ data, select }) {
      const row = apply({ id: id(), createdAt: new Date(Date.now() + seq), ...defaults(name) }, data);
      checkUnique(name, row);
      t(name).push(row);
      return pick(row, select);
    },
    async findUnique({ where, select }) { return pick(t(name).find((r) => matches(r, where)), select); },
    async findFirst({ where, select, orderBy } = {}) { return pick(sort(t(name).filter((r) => matches(r, where)), orderBy)[0], select); },
    async findMany({ where, select, orderBy, take } = {}) { return sort(t(name).filter((r) => matches(r, where)), orderBy).slice(0, take || 1e9).map((r) => pick(r, select)); },
    async update({ where, data, select }) {
      const row = t(name).find((r) => matches(r, where));
      if (!row) throw Object.assign(new Error(`${name} not found`), { code: 'P2025' });
      const before = { ...row };
      apply(row, data);
      try { checkUnique(name, row, row); } catch (e) { Object.assign(row, before); throw e; }
      return pick(row, select);
    },
    async updateMany({ where, data }) {
      const rows = t(name).filter((r) => matches(r, where));
      rows.forEach((r) => apply(r, data));
      return { count: rows.length };
    },
    async upsert({ where, create, update }) {
      const row = t(name).find((r) => matches(r, where));
      if (row) return this.update({ where, data: update });
      return this.create({ data: create });
    },
    async count({ where } = {}) { return t(name).filter((r) => matches(r, where)).length; },
    async aggregate({ where, _sum, _count } = {}) {
      const rows = t(name).filter((r) => matches(r, where));
      const out = {};
      if (_sum) out._sum = Object.fromEntries(Object.keys(_sum).map((f) => [f, rows.length ? (DECIMALS.has(f) ? dec(rows.reduce((a, r) => a + k(r[f] || 0), 0)) : rows.reduce((a, r) => a + Number(r[f] || 0), 0)) : null]));
      if (_count) out._count = rows.length;
      return out;
    },
    async deleteMany({ where } = {}) { const keep = t(name).filter((r) => !matches(r, where)); const n = t(name).length - keep.length; tables[name] = keep; return { count: n }; },
  });
  const sort = (rows, orderBy) => {
    if (!orderBy) return rows;
    const [[f, dir]] = Object.entries(Array.isArray(orderBy) ? orderBy[0] : orderBy);
    return [...rows].sort((a, b) => ((a[f] > b[f] ? 1 : a[f] < b[f] ? -1 : 0) * (dir === 'desc' ? -1 : 1)));
  };
  const defaults = (name) => ({
    customer: { walletBalance: '0.00', cashbackBalance: '0.00', savingsBalance: '0.00', loyaltyPoints: 0, active: true, deletedAt: null },
    order: { status: 'PENDING', isTest: false, cashbackUsed: null, discountAmount: null, promoDiscount: null, cashbackAmount: null, pointsEarned: null },
    cashbackEntry: { type: null, orderId: null, reference: null, expiresAt: null },
    walletTransaction: { providerRef: null },
  }[name] || {});
  const db = new Proxy({}, {
    get(_, prop) {
      if (prop === '$transaction') {
        return async (arg) => {
          if (Array.isArray(arg)) return Promise.all(arg);
          const snap = JSON.stringify(tables);
          try {
            return await arg(db);
          } catch (e) {
            const back = JSON.parse(snap, (key, v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v) : v));
            for (const key of Object.keys(tables)) delete tables[key];
            Object.assign(tables, back);
            throw e;
          }
        };
      }
      if (prop === '$queryRawUnsafe') return async () => [];
      if (prop === '_tables') return tables;
      return model(prop);
    },
  });
  return db;
}

module.exports = { makeDb, k, dec };
