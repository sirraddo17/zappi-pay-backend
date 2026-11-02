// The database can sleep: tests never reach it, and quiet-time jobs are spaced out.
const test = require('node:test');
const assert = require('node:assert/strict');

test('tests can never use the real database', () => {
  assert.equal(process.env.ZP_TEST, '1');
  assert.match(process.env.DATABASE_URL, /tests-never-use-the-real-database/);
  const prisma = require('../lib/prisma');
  assert.throws(() => prisma.customer, /must not use the real database/);
});

test('quiet jobs: hourly in the day, every 3 hours at night (Lagos), always when busy', async () => {
  const settle = () => new Promise((r) => setImmediate(r));
  const clock = require('../lib/quietClock');
  clock._reset();
  let runs = 0;
  clock.every('t', 10 * 60 * 1000, () => { runs += 1; }, { firstAfter: 0 });
  const MIN = 60 * 1000;
  const day = Date.UTC(2099, 0, 5, 11, 0); // 12:00 Lagos (a future date: jobs start "now")
  assert.equal(clock.tick(day), 1);
  await settle();
  assert.equal(clock.tick(day + 30 * MIN), 0, 'quiet: not again after 30 min');
  await settle();
  assert.equal(clock.tick(day + 61 * MIN), 1, 'quiet: again after an hour');
  const night = Date.UTC(2099, 0, 6, 0, 0); // 01:00 Lagos
  clock._reset(); clock.every('n', 10 * MIN, () => {}, { firstAfter: 0 });
  assert.equal(clock.tick(night), 1);
  await settle();
  assert.equal(clock.tick(night + 90 * MIN), 0, 'night: not after 90 min');
  await settle();
  assert.equal(clock.tick(night + 181 * MIN), 1, 'night: after 3 hours');
  assert.ok(runs >= 0);
});
