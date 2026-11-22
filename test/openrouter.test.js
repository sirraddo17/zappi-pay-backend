// OpenRouter as a third AI provider: last backup by default, same read-only
// tool loop, real cost from OpenRouter, key never shown.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const usage = [];
const fakes = {
  prisma: () => ({ aiUsage: { create: async ({ data }) => { usage.push(data); return data; }, aggregate: async () => ({ _sum: { costUsd: 0 }, _count: 0 }) } }),
  vtpass: () => ({ getSettings: async () => ({}) }),
};
const orig = Module._load;
Module._load = function load(req, parent, ...rest) {
  const full = req.startsWith('.') ? path.resolve(path.dirname(parent.filename), req) : req;
  const rel = path.relative(path.join(ROOT, 'lib'), full).replace(/\.js$/, '');
  if (fakes[rel]) return fakes[rel]();
  return orig.call(this, req, parent, ...rest);
};
const ai = require('../lib/ai');

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
const ALL = { geminiApiKey: 'AIzaTEST', aiApiKey: 'sk-ant-TEST', openrouterApiKey: 'sk-or-v1-TESTTESTTESTTESTTEST', aiAdminModel: 'claude-sonnet-5', aiCustomerModel: 'claude-haiku-4-5', geminiCustomerModel: 'gemini-2.5-flash' };
const TOOLS = [{ name: 'get_my_account', description: 'acct', input_schema: { type: 'object', properties: {} } }];

test('order: OpenRouter is the last backup; can be chosen first; needs a key', () => {
  assert.deepEqual(ai.providerOrder(ALL, 'CUSTOMER'), ['gemini', 'claude', 'openrouter']);
  assert.deepEqual(ai.providerOrder({ ...ALL, aiAdminProvider: 'claude' }, 'ADMIN'), ['claude', 'gemini', 'openrouter']);
  assert.deepEqual(ai.providerOrder({ ...ALL, aiCustomerProvider: 'openrouter' }, 'CUSTOMER'), ['openrouter', 'gemini', 'claude']);
  assert.deepEqual(ai.providerOrder({ openrouterApiKey: 'sk-or-x' }, 'ADMIN'), ['openrouter']);
  assert.equal(ai.modelFor('openrouter', {}, 'ADMIN'), ai.OPENROUTER_DEFAULT.ADMIN);
  assert.equal(ai.modelFor('openrouter', { openrouterCustomerModel: 'google/gemini-2.5-flash' }, 'CUSTOMER'), 'google/gemini-2.5-flash');
});

test('Gemini busy + Claude out of credit → OpenRouter answers with tools; real cost logged', async () => {
  usage.length = 0;
  const seen = [];
  let ran = 0;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (/googleapis/.test(url)) return json(503, { error: { message: 'overloaded' } });
    if (/anthropic/.test(url)) return json(400, { error: { message: 'Your credit balance is too low' } });
    assert.match(url, /openrouter\.ai\/api\/v1\/chat\/completions/);
    assert.match(opts.headers.authorization, /^Bearer sk-or-/);
    seen.push(body);
    if (seen.length === 1) {
      assert.equal(body.messages[0].role, 'system');
      assert.equal(body.tools[0].function.name, 'get_my_account');
      return json(200, { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_my_account', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0012 } });
    }
    assert.equal(body.messages.at(-1).role, 'tool');
    assert.equal(body.messages.at(-1).tool_call_id, 't1');
    return json(200, { choices: [{ message: { role: 'assistant', content: 'Your balance is ₦500.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 150, completion_tokens: 8, cost: 0.002 } });
  };
  const r = await ai.runAssistant({ settings: ALL, kind: 'CUSTOMER', actorId: 'c1', model: 'claude-haiku-4-5', system: 'sys', history: [{ role: 'user', content: 'balance?' }], tools: TOOLS, handlers: { get_my_account: async () => { ran += 1; return { balance: 500 }; } } });
  assert.equal(r.text, 'Your balance is ₦500.');
  assert.equal(r.provider, 'openrouter');
  assert.equal(ran, 1);
  const u = usage.find((x) => x.model === ai.OPENROUTER_DEFAULT.CUSTOMER);
  assert.ok(Math.abs(u.costUsd - 0.0032) < 1e-9, 'OpenRouter’s own cost');
});

test('images go to OpenRouter as data URLs; bad key is a clear error', async () => {
  assert.deepEqual(ai.openrouterContent([{ type: 'text', text: 'see' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }]), [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }]);
  global.fetch = async () => json(401, { error: { code: 401, message: 'No auth credentials found' } });
  await assert.rejects(ai.runAssistant({ settings: { openrouterApiKey: 'sk-or-bad' }, kind: 'ADMIN', actorId: 'a', system: 's', history: [{ role: 'user', content: 'hi' }] }), /OpenRouter API key is not valid/);
});

test('wiring: key masked in settings, validated, and counted as an AI key', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/admin.routes.js'), 'utf8');
  assert.match(src, /delete out\.openrouterApiKey/);
  assert.match(src, /\^sk-or-/);
  assert.match(src, /\['gemini', 'claude', 'openrouter'\]/);
});

test('"high demand" is busy (falls back), not a model problem', async () => {
  global.fetch = async (url) => (/googleapis/.test(url)
    ? json(503, { error: { message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.' } })
    : json(200, { choices: [{ message: { content: 'Hello from the backup.' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
  await assert.rejects(ai.runAssistant({ settings: { geminiApiKey: 'AIzaX' }, kind: 'ADMIN', actorId: 'a', system: 's', history: [{ role: 'user', content: 'hi' }] }), (e) => e.code === 'AI_BUSY' && /busy/.test(e.message));
  const r = await ai.runAssistant({ settings: { geminiApiKey: 'AIzaX', openrouterApiKey: 'sk-or-x' }, kind: 'CUSTOMER', actorId: 'c', system: 's', history: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.provider, 'openrouter');
});
