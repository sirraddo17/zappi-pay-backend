const prisma = require('./prisma');
const { getSettings } = require('./vtpass');

// Thin client for the Claude Messages API plus a small tool-use loop.
// Every tool the assistant gets is READ-ONLY: it can look things up but
// can never move money, change settings or act for anyone.

const API_URL = 'https://api.anthropic.com/v1/messages';
const LAGOS_MS = 60 * 60 * 1000;

// $ per million tokens [input, output], used only for the spend
// estimate and the monthly budget stop. Unknown models count at the
// most expensive rate so the budget errs on the safe side.
const PRICES = [
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

function apiKeyFrom(settings) {
  return (settings.aiApiKey || process.env.ANTHROPIC_API_KEY || '').trim();
}

async function monthSpend() {
  const r = await prisma.aiUsage.aggregate({ where: { createdAt: { gte: startOfLagosMonth() } }, _sum: { costUsd: true }, _count: true });
  return { usd: Number(r._sum.costUsd || 0), messages: r._count || 0 };
}

// Checks the switch, key and monthly budget before any call.
async function ensureAvailable(kind) {
  const settings = await getSettings();
  const enabled = kind === 'ADMIN' ? settings.aiAdminEnabled : settings.aiCustomerEnabled;
  if (!enabled) throw new AiError('The AI assistant is turned off.', 'AI_OFF');
  if (!apiKeyFrom(settings)) throw new AiError('The AI assistant is not set up yet.', 'AI_NO_KEY');
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

function clip(value, max = 6000) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…(truncated)` : s;
}

// Runs the conversation, letting the model call the given read-only
// tools up to maxSteps times, and records token usage.
async function runAssistant({ settings, kind, actorId, model, system, history, tools = [], handlers = {}, maxSteps = 5, maxTokens = 800 }) {
  const apiKey = apiKeyFrom(settings);
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  let inputTokens = 0;
  let outputTokens = 0;
  let text = '';
  try {
    for (let step = 0; step <= maxSteps; step += 1) {
      const lastStep = step === maxSteps;
      const res = await callClaude({ apiKey, model, system, messages, tools: lastStep ? [] : tools, maxTokens });
      inputTokens += res.usage?.input_tokens || 0;
      outputTokens += res.usage?.output_tokens || 0;
      const content = Array.isArray(res.content) ? res.content : [];
      text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      const calls = content.filter((b) => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || calls.length === 0) break;

      messages.push({ role: 'assistant', content });
      const results = [];
      for (const call of calls) {
        let out;
        try {
          const fn = handlers[call.name];
          out = fn ? await fn(call.input || {}) : { error: `Unknown tool ${call.name}` };
        } catch (error) {
          console.warn(`AI tool ${call.name} failed:`, error.message);
          out = { error: 'That lookup failed.' };
        }
        results.push({ type: 'tool_result', tool_use_id: call.id, content: clip(out) });
      }
      messages.push({ role: 'user', content: results });
    }
  } finally {
    if (inputTokens || outputTokens) {
      await prisma.aiUsage.create({
        data: { actorType: kind, actorId: String(actorId), day: lagosDay(), model, inputTokens, outputTokens, costUsd: costOf(model, inputTokens, outputTokens) },
      }).catch((error) => console.warn('AI usage log failed:', error.message));
    }
  }
  return { text: text || 'Sorry, I could not come up with an answer. Please try asking another way.' };
}

// Chat history from the browser: keep the last turns, plain text only,
// alternating roles, starting with the user.
function cleanHistory(raw, { maxTurns = 12, maxChars = 1500 } = {}) {
  const list = (Array.isArray(raw) ? raw : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, maxChars) }))
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

async function testConnection(model) {
  const settings = await getSettings();
  const apiKey = apiKeyFrom(settings);
  if (!apiKey) throw new AiError('Paste your Claude API key first.', 'AI_NO_KEY', 400);
  const m = model || settings.aiCustomerModel;
  const res = await callClaude({ apiKey, model: m, system: 'Reply with the single word OK.', messages: [{ role: 'user', content: 'Test' }], maxTokens: 5 });
  await prisma.aiUsage.create({
    data: { actorType: 'TEST', actorId: 'admin', day: lagosDay(), model: m, inputTokens: res.usage?.input_tokens || 0, outputTokens: res.usage?.output_tokens || 0, costUsd: costOf(m, res.usage?.input_tokens || 0, res.usage?.output_tokens || 0) },
  }).catch(() => {});
  return { model: res.model || m };
}

module.exports = { AiError, ensureAvailable, runAssistant, cleanHistory, testConnection, monthSpend, lagosDay, costOf, apiKeyFrom };
