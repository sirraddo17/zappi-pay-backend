// ✨ Polish: rough replies corrected / rewritten in an app language. Text only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
let lastCall = null;
let settings = { aiAdminEnabled: true, aiAdminModel: 'm' };
const fakes = {
  vtpass: () => ({ getSettings: async () => settings }),
  ai: () => ({ apiKeyFrom: () => 'k', runAssistant: async (o) => { lastCall = o; return { text: '"Sorry for the delay. Your ₦1,500 refund (ref 202611071504) is back in your wallet."' }; } }),
};
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '');
  if (fakes[rel]) return fakes[rel]();
  return orig.call(this, req, parent, ...rest);
};
const P = require('../lib/polish');

test('polishes into the chosen language, keeps facts, no tools', async () => {
  const r = await P.polish({ text: 'sory ur 1500 refund ref 202611071504 don enter wallet', language: 'pcm' });
  assert.equal(r.language, 'pcm');
  assert.equal(r.text, 'Sorry for the delay. Your ₦1,500 refund (ref 202611071504) is back in your wallet.', 'quotes stripped');
  assert.match(lastCall.system, /Nigerian Pidgin/);
  assert.match(lastCall.system, /Keep EVERY fact exactly/);
  assert.equal(lastCall.maxSteps, 0, 'no tools: it can only rewrite text');
  assert.equal(lastCall.history[0].content, 'sory ur 1500 refund ref 202611071504 don enter wallet');
  assert.equal((await P.polish({ text: 'hi', language: 'xx' })).language, 'en', 'unknown language → English');
});

test('refuses empty / too long / AI off', async () => {
  await assert.rejects(P.polish({ text: ' ' }), /Type something/);
  await assert.rejects(P.polish({ text: 'x'.repeat(2001) }), /too long/);
  settings = { aiAdminEnabled: false };
  await assert.rejects(P.polish({ text: 'hello' }), /assistant is off/);
  settings = { aiAdminEnabled: true, aiAdminModel: 'm' };
});

test('support staff may use it; the chats know how', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'lib/staffAccess.js'), 'utf8'), /admin\\\/ai\\\/polish/);
  const src = fs.readFileSync(path.join(ROOT, 'routes/ai.routes.js'), 'utf8');
  assert.match(src, /router\.post\('\/admin\/ai\/polish'/);
  assert.match(src.slice(src.indexOf('function staffSystemPrompt(')), /Rough English/);
});
