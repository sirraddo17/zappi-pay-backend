// Paid OpenAI extras, both OFF until the owner turns them on, each with
// its own monthly budget (Settings → AI Assistant):
//  - speak(): natural voice for Help chat replies (text-to-speech). The
//    phone's own free voice is always the fallback.
//  - adImage(): photo-style background pictures for Ad Studio.
// Uses the same OpenAI key as better voice notes.

const crypto = require('crypto');
const prisma = require('./prisma');
const { getSettings, invalidateSettings } = require('./vtpass');

const TTS_MODEL = 'gpt-4o-mini-tts';
const TTS_USD_PER_CHAR = 15 / 1e6; // ≈ $15 per million characters (estimate)
const TTS_MAX_CHARS = 700;
const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];
// The natural voice is good in English and Pidgin; for Yoruba, Hausa and
// Igbo the phone's own voice is used.
const TTS_LANGS = ['en', 'pcm'];

const IMAGE_MODEL = 'gpt-image-1';
// Approximate OpenAI prices per picture (USD) by quality and shape.
const IMAGE_USD = { low: { square: 0.011, tall: 0.016, wide: 0.016 }, medium: { square: 0.042, tall: 0.063, wide: 0.063 }, high: { square: 0.167, tall: 0.25, wide: 0.25 } };
const SIZES = { square: '1024x1024', tall: '1024x1536', wide: '1536x1024' };

const LAGOS = 60 * 60 * 1000;
const lagosDay = (d = new Date()) => new Date(d.getTime() + LAGOS).toISOString().slice(0, 10);

class ExtraError extends Error {
  constructor(msg, code, status = 400) { super(msg); this.code = code; this.status = status; }
}

const keyFrom = (s) => String(s.openaiApiKey || process.env.OPENAI_API_KEY || '').trim();

async function monthSpend(actorType) {
  const r = await prisma.aiUsage.aggregate({ where: { actorType, createdAt: { gte: require('./ai').startOfLagosMonth() } }, _sum: { costUsd: true }, _count: true });
  return { usd: Number(r?._sum?.costUsd || 0), count: typeof r?._count === 'number' ? r._count : 0 };
}

// --- Natural voice -----------------------------------------------------------

async function speakStatus(customerId) {
  const s = await getSettings();
  if (!s.ttsEnabled || !keyFrom(s)) return { natural: false };
  const budget = Number(s.ttsMonthlyBudgetUsd || 0);
  if (budget > 0 && (await monthSpend('TTS')).usd >= budget) return { natural: false };
  if (customerId) {
    const used = await prisma.aiUsage.count({ where: { actorType: 'TTS', actorId: String(customerId), day: lagosDay() } });
    if (used >= Number(s.ttsDailyLimit || 30)) return { natural: false };
  }
  return { natural: true, languages: TTS_LANGS };
}

// Same reply played again → no second charge (small in-memory cache).
const cache = new Map();
function remember(k, buf) {
  cache.set(k, buf);
  if (cache.size > 60) cache.delete(cache.keys().next().value);
}

function cleanForSpeech(text) {
  return String(text || '')
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#`>]/g, '')
    .replace(/₦\s?([\d,]+(?:\.\d+)?)/g, '$1 naira')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TTS_MAX_CHARS);
}

async function speak(customerId, { text, language = 'en' } = {}) {
  const s = await getSettings();
  if (!TTS_LANGS.includes(language)) throw new ExtraError('Natural voice is for English and Pidgin.', 'TTS_LANG', 409);
  const st = await speakStatus(customerId);
  if (!st.natural) throw new ExtraError('Natural voice is not available right now.', 'TTS_OFF', 409);
  const clean = cleanForSpeech(text);
  if (clean.length < 2) throw new ExtraError('Nothing to read.', 'TTS_EMPTY');
  const voice = VOICES.includes(s.ttsVoice) ? s.ttsVoice : 'coral';
  const key = crypto.createHash('sha1').update(`${voice}|${language}|${clean}`).digest('hex');
  if (cache.has(key)) return cache.get(key);
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${keyFrom(s)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice,
        input: clean,
        response_format: 'mp3',
        instructions: language === 'pcm'
          ? 'Warm, friendly Nigerian customer-support voice speaking Nigerian Pidgin naturally. Clear and calm, normal speed.'
          : 'Warm, friendly Nigerian customer-support voice with a light Nigerian English accent. Clear and calm, normal speed. Say amounts in naira naturally.',
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new ExtraError('Could not reach the voice service.', 'TTS_DOWN', 502);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error('OpenAI speech failed:', res.status, body?.error?.message);
    throw new ExtraError(res.status === 401 ? 'The voice service key is not valid.' : 'The voice service could not read that.', 'TTS_FAILED', 502);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await prisma.aiUsage.create({ data: { actorType: 'TTS', actorId: String(customerId), day: lagosDay(), model: TTS_MODEL, inputTokens: clean.length, outputTokens: 0, costUsd: clean.length * TTS_USD_PER_CHAR } }).catch((e) => console.warn('tts usage log failed:', e.message));
  remember(key, buf);
  return buf;
}

// --- AI ad pictures ------------------------------------------------------------

const IMAGE_RULES = 'Photorealistic advertising photo for a Nigerian mobile payments app. Natural light, warm, modern, everyday Nigerian setting and people (fictional, not famous, not identifiable real persons). Absolutely NO text, letters, numbers, logos, brand names, app screens or watermarks anywhere. Keep the left side or top calm and uncluttered so a headline can be placed over it. Respectful and family-friendly.';
const BLOCK = /\b(logo|brand|mtn|airtel|glo|9mobile|opay|palmpay|moniepoint|celebrity|famous|president|governor|tinubu|davido|wizkid|burna|nude|naked|sexy|gun|weapon|blood)\b/i;

function imagePrice(s, shape) {
  const q = IMAGE_USD[s.adImageQuality] ? s.adImageQuality : 'medium';
  return { quality: q, usd: IMAGE_USD[q][SIZES[shape] ? shape : 'square'] };
}

async function imageStatus() {
  const s = await getSettings();
  const m = await monthSpend('IMAGE');
  const budget = Number(s.adImageMonthlyBudgetUsd || 0);
  return {
    enabled: Boolean(s.adImagesEnabled), keySet: Boolean(keyFrom(s)),
    ready: Boolean(s.adImagesEnabled && keyFrom(s) && (!budget || m.usd < budget)),
    quality: imagePrice(s, 'square').quality,
    prices: { square: imagePrice(s, 'square').usd, tall: imagePrice(s, 'tall').usd, wide: imagePrice(s, 'wide').usd },
    monthUsd: Math.round(m.usd * 1000) / 1000, images: m.count, budgetUsd: budget,
  };
}

async function adImage(adminId, { prompt, shape = 'square' } = {}) {
  const s = await getSettings();
  const st = await imageStatus();
  if (!st.enabled) throw new ExtraError('AI pictures are off. Turn them on in Settings → AI Assistant.', 'IMAGE_OFF', 409);
  if (!st.keySet) throw new ExtraError('Add your OpenAI API key in Settings → AI Assistant first.', 'IMAGE_NO_KEY', 409);
  const what = String(prompt || '').trim().slice(0, 400);
  if (what.length < 4) throw new ExtraError('Describe the picture first.', 'IMAGE_EMPTY');
  if (BLOCK.test(what)) throw new ExtraError('Leave out brand names, logos, real or famous people and anything unsafe — the app adds your own text and logo on top.', 'IMAGE_BLOCKED');
  const sh = SIZES[shape] ? shape : 'square';
  const { quality, usd } = imagePrice(s, sh);
  if (st.budgetUsd && st.monthUsd + usd > st.budgetUsd) throw new ExtraError(`This month’s AI picture budget ($${st.budgetUsd}) is used up. Raise it in Settings → AI Assistant.`, 'IMAGE_BUDGET', 409);
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${keyFrom(s)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt: `${IMAGE_RULES}\nScene: ${what}`, size: SIZES[sh], quality, n: 1, output_format: 'jpeg', output_compression: 85, moderation: 'auto' }),
      signal: AbortSignal.timeout(120000),
    });
  } catch {
    throw new ExtraError('Could not reach the picture service. Try again.', 'IMAGE_DOWN', 502);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('OpenAI image failed:', res.status, body?.error?.message);
    const safety = /safety|moderation|policy/i.test(body?.error?.message || '');
    throw new ExtraError(res.status === 401 ? 'The OpenAI key is not valid.' : safety ? 'OpenAI would not draw that. Try describing it differently.' : 'The picture could not be made. Try again.', 'IMAGE_FAILED', 502);
  }
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw new ExtraError('The picture could not be made. Try again.', 'IMAGE_FAILED', 502);
  await prisma.aiUsage.create({ data: { actorType: 'IMAGE', actorId: String(adminId), day: lagosDay(), model: IMAGE_MODEL, inputTokens: what.length, outputTokens: 0, costUsd: usd } }).catch((e) => console.warn('image usage log failed:', e.message));
  return { image: `data:image/jpeg;base64,${b64}`, costUsd: usd, shape: sh };
}

// --- Settings (owner only; the AI assistant cannot change these) -----------------

async function status() {
  const s = await getSettings();
  const t = await monthSpend('TTS');
  return {
    keySet: Boolean(keyFrom(s)),
    tts: { enabled: Boolean(s.ttsEnabled), voice: s.ttsVoice || 'coral', voices: VOICES, budgetUsd: Number(s.ttsMonthlyBudgetUsd || 0), dailyLimit: s.ttsDailyLimit, monthUsd: Math.round(t.usd * 1000) / 1000, replies: t.count, usdPer1kChars: TTS_USD_PER_CHAR * 1000 },
    images: await imageStatus(),
  };
}

async function updateSettings(b = {}) {
  const s = await getSettings();
  const data = {};
  if (b.ttsEnabled !== undefined) data.ttsEnabled = Boolean(b.ttsEnabled);
  if (b.ttsVoice !== undefined) data.ttsVoice = VOICES.includes(b.ttsVoice) ? b.ttsVoice : 'coral';
  if (b.ttsMonthlyBudgetUsd !== undefined) data.ttsMonthlyBudgetUsd = Math.min(500, Math.max(0, Number(b.ttsMonthlyBudgetUsd) || 0));
  if (b.ttsDailyLimit !== undefined) data.ttsDailyLimit = Math.min(500, Math.max(1, parseInt(b.ttsDailyLimit, 10) || 30));
  if (b.adImagesEnabled !== undefined) data.adImagesEnabled = Boolean(b.adImagesEnabled);
  if (b.adImageQuality !== undefined) data.adImageQuality = IMAGE_USD[b.adImageQuality] ? b.adImageQuality : 'medium';
  if (b.adImageMonthlyBudgetUsd !== undefined) data.adImageMonthlyBudgetUsd = Math.min(500, Math.max(0, Number(b.adImageMonthlyBudgetUsd) || 0));
  if ((data.ttsEnabled || data.adImagesEnabled) && !keyFrom(s)) throw new ExtraError('Paste your OpenAI API key (Voice notes panel) before turning this on.', 'NO_KEY');
  if (Object.keys(data).length) {
    await prisma.settings.update({ where: { id: s.id }, data });
    invalidateSettings?.();
  }
  return status();
}

module.exports = { ExtraError, speak, speakStatus, adImage, imageStatus, status, updateSettings, cleanForSpeech, VOICES, TTS_LANGS };
