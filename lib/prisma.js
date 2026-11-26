const { PrismaClient } = require('@prisma/client');

// A single shared instance across the app, reused on every hot reload in
// dev (Render/Vercel serverless functions don't need this guard, but it's
// harmless there and saves connection churn locally).
const globalForPrisma = globalThis;

// Under npm test (test/setup.js) the real database is never used: any
// test that forgot to fake it fails loudly instead of writing to Neon.
const testGuard = () => new Proxy({}, { get(_, prop) { if (prop === 'then') return undefined; throw new Error(`Tests must not use the real database (prisma.${String(prop)}). Fake lib/prisma in this test.`); } });
// Neon's free database sleeps when quiet and takes a few seconds to wake.
// Prisma gives up after 5s by default, which showed customers "trouble
// connecting" for a moment. Allow 15s to connect, and if the database
// still can't be reached, try the query once more after 2 seconds.
// (Only "couldn't connect" errors are retried — the query never ran.)
const { withWakeTime } = require('./dbUrl');
const RETRY_CODES = new Set(['P1001', 'P2024']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient() {
  const url = withWakeTime(process.env.DATABASE_URL);
  const base = new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
  return base.$extends({
    query: {
      async $allOperations({ args, query }) {
        try {
          return await query(args);
        } catch (error) {
          if (!RETRY_CODES.has(error && error.code)) throw error;
          await sleep(2000);
          return query(args);
        }
      },
    },
  });
}

const prisma = process.env.ZP_TEST === '1' ? testGuard() : globalForPrisma.__prisma || makeClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}

module.exports = prisma;
