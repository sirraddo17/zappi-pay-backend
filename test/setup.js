// Loaded before every test (npm test → node --require ./test/setup.js).
// Tests use an in-memory database and fake partners; this makes sure they
// can never reach the real Neon database or start background jobs, even
// if a test forgets to fake something.
process.env.ZP_TEST = '1';
process.env.DATABASE_URL = 'postgresql://tests-never-use-the-real-database@127.0.0.1:1/none';
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.DISABLE_SCHEDULER = '1';
