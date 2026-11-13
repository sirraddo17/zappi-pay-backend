// Gemini first, Claude as automatic fallback (or the other way round), with
// the same read-only tool loop. Fake HTTP for both providers.
const test = require('node:test');
const assert = require('node:assert/strict');
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
let calls = [];
function fakeFetch(script) {
  global.fetch = async (url, opts) => {
    const who = /googleapis/.test(url) ? 'gemini' : 'claude';
    const body = JSON.parse(opts.body);
    calls.push({ who, url, body });
    return script(who, body, calls.filter((c) => c.who === who).length);
  };
}
const BOTH = { geminiApiKey: 'AIzaTEST', aiApiKey: 'sk-ant-TEST', aiAdminModel: 'claude-sonnet-5', aiCustomerModel: 'claude-haiku-4-5', geminiCustomerModel: 'gemini-2.5-flash', geminiAdminModel: 'gemini-2.5-flash' };
const TOOLS = [{ name: 'get_my_account', description: 'acct', input_schema: { type: 'object', properties: { value: {}, kind: { type: 'string', enum: ['A', 'B'] } }, additionalProperties: false } }];

test('order: Gemini first by default; Claude first when chosen; only providers with a key', () => {
  assert.deepEqual(ai.providerOrder(BOTH, 'CUSTOMER'), ['gemini', 'claude']);
  assert.deepEqual(ai.providerOrder({ ...BOTH, aiAdminProvider: 'claude' }, 'ADMIN'), ['claude', 'gemini']);
  assert.deepEqual(ai.providerOrder({ aiApiKey: 'sk-ant-x' }, 'CUSTOMER'), ['claude'], 'no Gemini key → Claude only');
  assert.deepEqual(ai.providerOrder({}, 'CUSTOMER'), []);
});

test('Gemini schema: unsupported keys dropped, empty schemas get a type', () => {
  const s = ai.geminiSchema(TOOLS[0].input_schema);
  assert.deepEqual(s, { type: 'object', properties: { value: { type: 'string' }, kind: { type: 'string', enum: ['A', 'B'] } } });
});

test('Gemini tool loop: function call → tool → answer; usage logged as Gemini', async () => {
  calls = []; usage.length = 0;
  let ran = 0;
  fakeFetch((who, body, n) => {
    assert.equal(who, 'gemini');
    if (n === 1) return json(200, { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_my_account', args: {} } }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 } });
    assert.ok(body.contents.at(-1).parts[0].functionResponse, 'tool result sent back');
    return json(200, { candidates: [{ content: { parts: [{ text: 'Your balance is ₦500.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 8 } });
  });
  const r = await ai.runAssistant({ settings: BOTH, kind: 'CUSTOMER', actorId: 'c1', model: 'claude-haiku-4-5', system: 'sys', history: [{ role: 'user', content: 'balance?' }], tools: TOOLS, handlers: { get_my_account: async () => { ran += 1; return { balance: 500 }; } } });
  assert.equal(r.text, 'Your balance is ₦500.');
  assert.equal(r.provider, 'gemini');
  assert.equal(ran, 1);
  assert.equal(usage[0].model, 'gemini-2.5-flash');
  assert.equal(usage[0].inputTokens, 250);
  assert.equal(calls[0].body.systemInstruction.parts[0].text, 'sys');
});

test('Gemini busy before any tool → Claude answers automatically', async () => {
  calls = []; usage.length = 0;
  fakeFetch((who) => (who === 'gemini' ? json(429, { error: { message: 'Resource exhausted' } }) : json(200, { content: [{ type: 'text', text: 'Hello from Claude' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 3 } })));
  const r = await ai.runAssistant({ settings: BOTH, kind: 'CUSTOMER', actorId: 'c1', system: 's', history: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.provider, 'claude');
  assert.equal(r.text, 'Hello from Claude');
  assert.deepEqual(calls.map((c) => c.who), ['gemini', 'claude']);
  assert.equal(usage[0].model, 'claude-haiku-4-5');
});

test('no fallback once a tool has run (a tool never runs twice)', async () => {
  calls = [];
  let ran = 0;
  fakeFetch((who, body, n) => (n === 1 ? json(200, { candidates: [{ content: { parts: [{ functionCall: { name: 'get_my_account', args: {} } }] } }] }) : json(503, { error: { message: 'overloaded' } })));
  await assert.rejects(ai.runAssistant({ settings: BOTH, kind: 'CUSTOMER', actorId: 'c1', system: 's', history: [{ role: 'user', content: 'hi' }], tools: TOOLS, handlers: { get_my_account: async () => { ran += 1; return {}; } } }), /busy/);
  assert.equal(ran, 1);
  assert.ok(calls.every((c) => c.who === 'gemini'));
});

test('pictures go to Gemini as inline data', async () => {
  calls = [];
  fakeFetch(() => json(200, { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }));
  await ai.runAssistant({ settings: BOTH, kind: 'ADMIN', actorId: 'a', system: 's', history: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }, { type: 'text', text: 'what is this?' }] }] });
  assert.deepEqual(calls[0].body.contents[0].parts, [{ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }, { text: 'what is this?' }]);
});
