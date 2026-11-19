// Ad Studio → ⚡ Quick video: AI lines, QR tags, visits, sign-ups, results.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { makeDb } = require('./helpers/memdb');

const ROOT = path.resolve(__dirname, '..');
let db = makeDb();
let aiReply = '';
const fakes = {
  prisma: () => new Proxy({}, { get: (_, prop) => db[prop] }),
  ai: () => ({ ensureAvailable: async () => ({ aiAdminModel: 'm' }), runAssistant: async () => ({ text: aiReply }) }),
  features: () => ({ offNote: () => '' }),
};
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '');
  if (fakes[rel]) return fakes[rel]();
  return orig.call(this, req, parent, ...rest);
};
const qv = require('../lib/quickVideo');

const REPLY = JSON.stringify({ opening: { big: 'Data finish this Christmas?', small: 'No wahala at all' }, offer: { title: 'Buy data', highlight: 'Instant', points: ['All networks', 'Cashback every time', 'Auto refunds', 'extra one dropped'] }, message: { title: 'Fund from any bank', text: 'Your own account number' }, ending: { cta: 'Download ZAPPI PAY' }, caption: 'Data in seconds #ZappiPay www.zappipay.com.ng', tag: 'Christmas Data!!' });

test('AI writes 4 scenes; each video gets its own clean QR tag and link', async () => {
  db = makeDb();
  aiReply = `Here: ${REPLY}`;
  const a = await qv.write('admin1', { idea: 'Christmas data', language: 'pcm' });
  assert.equal(a.tag, 'video-christmas-data');
  assert.equal(a.link, 'https://www.zappipay.com.ng/?vt=video-christmas-data');
  assert.equal(a.script.offer.points.length, 3);
  assert.equal(a.language, 'pcm');
  assert.equal(a.editLink, '/admin/ad-studio?tab=quick&tag=video-christmas-data');
  const b = await qv.write('admin1', { idea: 'Christmas data again' });
  assert.equal(b.tag, 'video-christmas-data-2', 'never reuses a tag');
  await assert.rejects(qv.write('admin1', { idea: ' ' }), /Describe the video/);
  const m = await qv.create('admin1', { idea: 'My own lines', script: { opening: { big: 'Hi' } } });
  assert.equal(m.tag, 'video-my-own-lines');
  assert.equal((await qv.get(m.tag)).script.opening.big, 'Hi');
  aiReply = 'not json';
  await assert.rejects(qv.write('admin1', { idea: 'x' }), /try again/);
});

test('visits: only real tags, once per person per day; sign-up keeps only real tags; results count buyers', async () => {
  db = makeDb();
  aiReply = REPLY;
  const { tag } = await qv.write('admin1', { idea: 'Christmas data' });
  assert.equal(await qv.visit(tag, 'ip1'), true);
  assert.equal(await qv.visit(tag, 'ip1'), false, 'same person same day counted once');
  assert.equal(await qv.visit(tag, 'ip2'), true);
  assert.equal(await qv.visit('video-made-up', 'ip3'), false, 'unknown tags are not created');
  assert.equal(await qv.visit('<script>', 'ip3'), false);
  assert.equal(await qv.tagForSignup(tag), tag);
  assert.equal(await qv.tagForSignup('video-made-up'), null);

  await qv.markMade(tag, { opening: { big: 'Edited line' } });
  assert.equal((await qv.get(tag)).script.opening.big, 'Edited line');
  const c1 = await db.customer.create({ data: { name: 'A', phone: '1', signupTag: tag } });
  await db.customer.create({ data: { name: 'B', phone: '2', signupTag: tag } });
  await db.order.create({ data: { customerId: c1.id, service: 'DATA', provider: 'mtn-data', status: 'SUCCESS', amount: '500.00' } });
  await db.order.create({ data: { customerId: c1.id, service: 'DATA', provider: 'mtn-data', status: 'SUCCESS', amount: '300.00', isTest: true } });
  const [r] = await qv.report();
  assert.deepEqual({ visits: r.visits, signups: r.signups, buyers: r.buyers, sales: r.sales }, { visits: 2, signups: 2, buyers: 1, sales: 500 });
});

test('wiring: routes, signup tag, owner-only AI tools, nav link allowed', () => {
  const routes = fs.readFileSync(path.join(ROOT, 'routes/advideo.routes.js'), 'utf8');
  for (const r of ["'/admin/ai/quick-video', requireAdminAuth", "'/admin/video-tags', requireAdminAuth", "'/admin/video-tags/:tag/made', requireAdminAuth", "'/app/video-visit'"]) assert.ok(routes.includes(r), r);
  assert.match(fs.readFileSync(path.join(ROOT, 'routes/auth.routes.js'), 'utf8'), /tagForSignup\(req\.body\.signupTag\)/);
  const ai = fs.readFileSync(path.join(ROOT, 'routes/ai.routes.js'), 'utf8');
  const staff = /const STAFF_TOOL_NAMES = \[([^\]]*)\]/.exec(ai)[1];
  for (const n of ['make_quick_video', 'get_video_results']) { assert.ok(ai.includes(`name: '${n}'`)); assert.ok(!staff.includes(n)); }
  const nav = require('../lib/adminNav');
  assert.ok(nav.allowed('/admin/ad-studio?tab=quick&tag=video-christmas-data'));
  assert.ok(!nav.allowed('/admin/ad-studio?tab=quick&tag=x"><b'));
});
