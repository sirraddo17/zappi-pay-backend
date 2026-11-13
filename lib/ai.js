const prisma = require('./prisma');
const { getSettings } = require('./vtpass');

// Thin client for the Claude Messages API and Google Gemini, plus a small
// tool-use loop. Every tool the assistant gets is READ-ONLY (or proposes an
// Apply card): it can never move money, change settings or act for anyone.
//
// Providers: each assistant (customers / admin) has an order — "gemini"
// (Gemini first, Claude if Gemini is busy or fails) or "claude" (the other
// way round). The fallback only happens before any tool has run, so a tool
// never runs twice.

const API_URL = 'https://api.anthropic.com/v1/messages';
const LAGOS_MS = 60 * 60 * 1000;

// $ per million tokens [input, output], used only for the spend
// estimate and the monthly budget stop. Unknown models count at the
// most expensive rate so the budget errs on the safe side.
const PRICES = [
  [/gemini.*flash-lite/, [0.1, 0.4]],
  [/gemini.*flash/, [0.3, 2.5]],
  [/gemini.*pro/, [1.25, 10]],
  [/haiku/, [1, 5]],
  [/sonnet/, [2, 10]],
  [/opus/, [4, 20]],
];
const FALLBACK_PRICE = [10, 50];

class AiError extends Error {
  constructor(message, code, status = 503) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function lagosDay(d = new Date()) {
  return new Date(d.getTime() + LAGOS_MS).toISOString().slice(0, 10);
}

function startOfLagosMonth() {
  const d = lagosDay().slice(0, 8);
  return new Date(`${d}01T00:00:00+01:00`);
}

function priceFor(model) {
  const hit = PRICES.find(([re]) => re.test(String(model)));
  return hit ? hit[1] : FALLBACK_PRICE;
}

function costOf(model, inputTokens, outputTokens) {
  const [i, o] = priceFor(model);
  return (inputTokens * i + outputTokens * o) / 1e6;
}

function claudeKeyFrom(settings) {
  return String(settings.aiApiKey || process.env.ANTHROPIC_API_KEY || '').trim();
}
function geminiKeyFrom(settings) {
  return String(settings.geminiApiKey || process.env.GEMINI_API_KEY || '').trim();
}
// Any AI key at all (callers use this to ask "is AI set up?").
function apiKeyFrom(settings) {
  return claudeKeyFrom(settings) || geminiKeyFrom(settings);
}

const GEMINI_DEFAULT = 'gemini-2.5-flash';
// Which providers to try, in order, for an assistant. Default: Gemini first.
function providerOrder(settings, kind) {
  const pref = String((kind === 'CUSTOMER' ? settings.aiCustomerProvider : settings.aiAdminProvider) || 'gemini').toLowerCase();
  const order = pref === 'claude' ? ['claude', 'gemini'] : ['gemini', 'claude'];
  return order.filter((p) => (p === 'claude' ? claudeKeyFrom(settings) : geminiKeyFrom(settings)));
}
function modelFor(provider, settings, kind, claudeModel) {
  if (provider === 'claude') return claudeModel || (kind === 'CUSTOMER' ? settings.aiCustomerModel : settings.aiAdminModel);
  return String((kind === 'CUSTOMER' ? settings.geminiCustomerModel : settings.geminiAdminModel) || GEMINI_DEFAULT);
}

async function monthSpend() {
  const r = await prisma.aiUsage.aggregate({ where: { createdAt: { gte: startOfLagosMonth() }, actorType: { notIn: ['VOICE', 'TTS', 'IMAGE'] } }, _sum: { costUsd: true }, _count: true });
  return { usd: Number(r._sum.costUsd || 0), messages: r._count || 0 };
}

// Checks the switch, key and monthly budget before any call.
async function ensureAvailable(kind) {
  const settings = await getSettings();
  const enabled = kind === 'ADMIN' ? settings.aiAdminEnabled : settings.aiCustomerEnabled;
  if (!enabled) throw new AiError('The AI assistant is turned off.', 'AI_OFF');
  if (!providerOrder(settings, kind).length) throw new AiError('The AI assistant is not set up yet.', 'AI_NO_KEY');
  const budget = Number(settings.aiMonthlyBudgetUsd || 0);
  if (budget > 0) {
    const { usd } = await monthSpend();
    if (usd >= budget) throw new AiError('The AI assistant has reached its monthly limit.', 'AI_BUDGET');
  }
  return settings;
}

async function callClaude({ apiKey, model, system, messages, tools, maxTokens = 800 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, ...(tools?.length ? { tools } : {}) }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new AiError(error.name === 'AbortError' ? 'The AI took too long to answer.' : 'Could not reach the AI service.', 'AI_NETWORK');
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    console.warn('Claude API error:', res.status, msg);
    if (res.status === 401 || res.status === 403) throw new AiError('The AI API key is not valid.', 'AI_BAD_KEY', 502);
    if (/credit balance/i.test(msg)) throw new AiError('The AI account is out of credits.', 'AI_NO_CREDIT', 502);
    if (res.status === 404 || /model/i.test(msg)) throw new AiError(`AI model problem: ${msg}`, 'AI_MODEL', 502);
    if (res.status === 429 || res.status === 529) throw new AiError('The AI is busy right now. Please try again shortly.', 'AI_BUSY');
    throw new AiError(`AI request failed: ${msg}`, 'AI_ERROR', 502);
  }
  return body;
}

// ---- Gemini (generativelanguage.googleapis.com) ------------------------------------
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_SCHEMA_KEYS = new Set(['type', 'description', 'enum', 'properties', 'required', 'items', 'nullable', 'format', 'minimum', 'maximum', 'minItems', 'maxItems']);
// Claude tool schemas → the subset Gemini accepts (e.g. "{}" gets a type).
function geminiSchema(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { type: 'string' };
  const out = {};
  for (const [k, v] of Object.entries(s)) if (GEMINI_SCHEMA_KEYS.has(k)) out[k] = v;
  if (!out.type) out.type = out.properties ? 'object' : out.items ? 'array' : 'string';
  if (out.properties) out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, geminiSchema(v)]));
  if (out.items) out.items = geminiSchema(out.items);
  if (out.type === 'object' && out.properties && !Object.keys(out.properties).length) delete out.properties;
  if (Array.isArray(out.required) && out.properties) out.required = out.required.filter((r) => r in out.properties);
  if (out.enum) out.enum = out.enum.map(String);
  return out;
}
function geminiParts(content) {
  if (typeof content === 'string') return [{ text: content }];
  return (Array.isArray(content) ? content : []).map((b) => {
    if (b.type === 'text') return { text: b.text };
    if (b.type === 'image' && b.source?.type === 'base64') return { inlineData: { mimeType: b.source.media_type, data: b.source.data } };
    return null;
  }).filter(Boolean);
}

async function callGemini({ apiKey, model, system, contents, tools, maxTokens = 800 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  let res;
  try {
    res = await fetch(`${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        ...(tools?.length ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: String(t.description || '').slice(0, 1000), parameters: geminiSchema(t.input_schema || { type: 'object' }) })) }] } : {}),
        generationConfig: { maxOutputTokens: maxTokens },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new AiError(error.name === 'AbortError' ? 'The AI took too long to answer.' : 'Could not reach the AI service.', 'AI_NETWORK');
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    console.warn('Gemini API error:', res.status, msg);
    if (res.status === 400 && /api key/i.test(msg)) throw new AiError('The Gemini API key is not valid.', 'AI_BAD_KEY', 502);
    if (res.status === 401 || res.status === 403) throw new AiError('The Gemini API key is not valid.', 'AI_BAD_KEY', 502);
    if (res.status === 404 || /model/i.test(msg)) throw new AiError(`AI model problem: ${msg}`, 'AI_MODEL', 502);
    if (res.status === 429 || res.status === 503 || res.status === 500) throw new AiError('The AI is busy right now. Please try again shortly.', 'AI_BUSY');
    throw new AiError(`AI request failed: ${msg}`, 'AI_ERROR', 502);
  }
  return body;
}

function clip(value, max = 6000) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…(truncated)` : s;
}

// One provider's tool loop. Returns { text, usage, toolsRan }.
async function loopClaude({ apiKey, model, system, history, tools, handlers, maxSteps, maxTokens, state }) {
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  let text = '';
  for (let step = 0; step <= maxSteps; step += 1) {
    const lastStep = step === maxSteps;
    const res = await callClaude({ apiKey, model, system, messages, tools: lastStep ? [] : tools, maxTokens });
    state.input += res.usage?.input_tokens || 0;
    state.output += res.usage?.output_tokens || 0;
    const content = Array.isArray(res.content) ? res.content : [];
    text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    const calls = content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || calls.length === 0) break;
    messages.push({ role: 'assistant', content });
    const results = [];
    for (const call of calls) {
      state.toolsRan = true;
      results.push({ type: 'tool_result', tool_use_id: call.id, content: clip(await runTool(handlers, call.name, call.input)) });
    }
    messages.push({ role: 'user', content: results });
  }
  return text;
}

async function loopGemini({ apiKey, model, system, history, tools, handlers, maxSteps, maxTokens, state }) {
  const contents = history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: geminiParts(m.content) }));
  let text = '';
  for (let step = 0; step <= maxSteps; step += 1) {
    const lastStep = step === maxSteps;
    const res = await callGemini({ apiKey, model, system, contents, tools: lastStep ? [] : tools, maxTokens });
    state.input += res.usageMetadata?.promptTokenCount || 0;
    state.output += (res.usageMetadata?.candidatesTokenCount || 0) + (res.usageMetadata?.thoughtsTokenCount || 0);
    const cand = res.candidates?.[0];
    const parts = cand?.content?.parts || [];
    text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('\n').trim();
    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length) {
      if (!text && cand?.finishReason && !['STOP', 'MAX_TOKENS'].includes(cand.finishReason)) throw new AiError(`Gemini stopped (${cand.finishReason}).`, 'AI_ERROR', 502);
      break;
    }
    contents.push({ role: 'model', parts });
    const results = [];
    for (const p of calls) {
      state.toolsRan = true;
      const out = await runTool(handlers, p.functionCall.name, p.functionCall.args);
      results.push({ functionResponse: { name: p.functionCall.name, response: { result: clip(out) } } });
    }
    contents.push({ role: 'user', parts: results });
  }
  return text;
}

async function runTool(handlers, name, input) {
  try {
    const fn = handlers[name];
    return fn ? await fn(input || {}) : { error: `Unknown tool ${name}` };
  } catch (error) {
    console.warn(`AI tool ${name} failed:`, error.message);
    return { error: 'That lookup failed.' };
  }
}

// Runs the conversation on the first provider in this assistant's order;
// if it is busy, out of credit or failing BEFORE any tool ran, the next
// provider answers instead. Records token usage per provider/model.
async function runAssistant({ settings, kind, actorId, model, system, history, tools = [], handlers = {}, maxSteps = 5, maxTokens = 800 }) {
  // Internal jobs (translate, polish, briefing) follow the admin order.
  const order = providerOrder(settings, kind === 'CUSTOMER' ? 'CUSTOMER' : 'ADMIN');
  if (!order.length) throw new AiError('The AI assistant is not set up yet.', 'AI_NO_KEY');
  let lastError = null;
  for (const provider of order) {
    const m = modelFor(provider, settings, kind === 'CUSTOMER' ? 'CUSTOMER' : 'ADMIN', provider === 'claude' ? model : null);
    const state = { input: 0, output: 0, toolsRan: false };
    try {
      const args = { model: m, system, history, tools, handlers, maxSteps, maxTokens, state };
      const text = provider === 'claude'
        ? await loopClaude({ ...args, apiKey: claudeKeyFrom(settings) })
        : await loopGemini({ ...args, apiKey: geminiKeyFrom(settings) });
      return { text: text || 'Sorry, I could not come up with an answer. Please try asking another way.', provider, model: m };
    } catch (error) {
      lastError = error;
      // Never retry once a tool has run (it might have prepared a card).
      if (state.toolsRan || !(error instanceof AiError)) throw error;
      console.warn(`AI ${provider} failed (${error.code}); ${order.indexOf(provider) < order.length - 1 ? 'trying the other provider' : 'no other provider'}.`);
    } finally {
      if (state.input || state.output) {
        await prisma.aiUsage.create({
          data: { actorType: kind, actorId: String(actorId), day: lagosDay(), model: m, inputTokens: state.input, outputTokens: state.output, costUsd: costOf(m, state.input, state.output) },
        }).catch((e) => console.warn('AI usage log failed:', e.message));
      }
    }
  }
  throw lastError;
}

// Chat history from the browser: keep the last turns, plain text only,
// alternating roles, starting with the user.
function cleanHistory(raw, { maxTurns = 12, maxChars = 1500 } = {}) {
  const list = (Array.isArray(raw) ? raw : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: require('./idNumber').maskIdsInText(m.content.trim().slice(0, maxChars)) }))
    .slice(-maxTurns);
  const out = [];
  for (const m of list) {
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += `\n${m.content}`;
    else out.push(m);
  }
  while (out.length && out[0].role !== 'user') out.shift();
  if (!out.length || out[out.length - 1].role !== 'user') return null;
  return out;
}

async function testConnection(model, provider) {
  const settings = await getSettings();
  const p = provider === 'gemini' || /^gemini/.test(String(model || '')) ? 'gemini' : 'claude';
  if (p === 'gemini') {
    const apiKey = geminiKeyFrom(settings);
    if (!apiKey) throw new AiError('Paste your Gemini API key first.', 'AI_NO_KEY', 400);
    const m = model || settings.geminiCustomerModel || GEMINI_DEFAULT;
    const res = await callGemini({ apiKey, model: m, system: 'Reply with the single word OK.', contents: [{ role: 'user', parts: [{ text: 'Test' }] }], maxTokens: 20 });
    const u = res.usageMetadata || {};
    await prisma.aiUsage.create({ data: { actorType: 'TEST', actorId: 'admin', day: lagosDay(), model: m, inputTokens: u.promptTokenCount || 0, outputTokens: u.candidatesTokenCount || 0, costUsd: costOf(m, u.promptTokenCount || 0, u.candidatesTokenCount || 0) } }).catch(() => {});
    return { model: m, provider: 'gemini' };
  }
  const apiKey = claudeKeyFrom(settings);
  if (!apiKey) throw new AiError('Paste your Claude API key first.', 'AI_NO_KEY', 400);
  const m = model || settings.aiCustomerModel;
  const res = await callClaude({ apiKey, model: m, system: 'Reply with the single word OK.', messages: [{ role: 'user', content: 'Test' }], maxTokens: 5 });
  await prisma.aiUsage.create({
    data: { actorType: 'TEST', actorId: 'admin', day: lagosDay(), model: m, inputTokens: res.usage?.input_tokens || 0, outputTokens: res.usage?.output_tokens || 0, costUsd: costOf(m, res.usage?.input_tokens || 0, res.usage?.output_tokens || 0) },
  }).catch(() => {});
  return { model: res.model || m, provider: 'claude' };
}

module.exports = { providerOrder, modelFor, geminiSchema, claudeKeyFrom, geminiKeyFrom, GEMINI_DEFAULT, startOfLagosMonth, AiError, ensureAvailable, runAssistant, cleanHistory, testConnection, monthSpend, lagosDay, costOf, apiKeyFrom };
