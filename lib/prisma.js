const { PrismaClient } = require('@prisma/client');

// A single shared instance across the app, reused on every hot reload in
// dev (Render/Vercel serverless functions don't need this guard, but it's
// harmless there and saves connection churn locally).
const globalForPrisma = globalThis;

const prisma = globalForPrisma.__prisma || new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}

module.exports = prisma;
