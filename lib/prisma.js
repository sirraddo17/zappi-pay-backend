const { PrismaClient } = require('@prisma/client');

// A single shared instance across the app, reused on every hot reload in
// dev (Render/Vercel serverless functions don't need this guard, but it's
// harmless there and saves connection churn locally).
const globalForPrisma = globalThis;

// Under npm test (test/setup.js) the real database is never used: any
// test that forgot to fake it fails loudly instead of writing to Neon.
const testGuard = () => new Proxy({}, { get(_, prop) { if (prop === 'then') return undefined; throw new Error(`Tests must not use the real database (prisma.${String(prop)}). Fake lib/prisma in this test.`); } });
const prisma = process.env.ZP_TEST === '1' ? testGuard() : globalForPrisma.__prisma || new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}

module.exports = prisma;
