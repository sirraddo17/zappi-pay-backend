const prisma = require('./prisma');
const { getSettings } = require('./vtpass');

// Better voice notes: OpenAI transcription (gpt-4o-mini-transcribe),
// switched on by the owner in Settings → AI Assistant. The phone's own
// speech recognition is always there as the free fallback, so when this
// is off, over budget or failing, customers can still talk to the app.

const MODEL = 'gpt-4o-mini-transcribe';
const USD_PER_MINUTE = 0.003;
const MAX_SECONDS = 90;
const MAX_BYTES = 3 * 1024 * 1024;
const LAGOS = 60 * 60 * 1000;
const lagosDay = (d = new Date()) => new Date(d.getTime() + LAGOS).toISOString().slice(0, 10);
const PROMPT = 'Nigerian customer talking to ZAPPI PAY, a payments app. May speak Nigerian English, Pidgin, Yoruba, Hausa or Igbo. Words: ZAPPI PAY, airtime, data, MTN, Airtel, Glo, 9mobile, DStv, GOtv, Startimes, NEPA, token, meter, WAEC, JAMB, Bet9ja, naira, Opay, Palmpay, Moniepoint, GTBank, FCMB, Access, Zenith, UBA.';
const ISO = { en: 'en', pcm: 'en', yo: 'yo', ha: 'ha', ig: 'ig' };

class VoiceError extends Error {
  constructor(msg, code, status = 400) { super(msg); this.code = code; this.status = status; }
}

const keyFrom = (s) => String(s.openaiApiKey || process.env.OPENAI_API_KEY || '').trim();

async function monthSpend() {
  const r = await prisma.aiUsage.aggregate({ where: { actorType: 'VOICE', createdAt: { gte: require('./ai').startOfLagosMonth() } }, _sum: { costUsd: true }, _count: true });
  return { usd: Number(r?._sum?.costUsd || 0), notes: typeof r?._count === 'number' ? r._count : 0 };
}

async function status(customerId) {
  const s = await getSettings();
  if (!s.voiceAiEnabled || !keyFrom(s)) return { enhanced: false };
  const budget = Number(s.voiceMonthlyBudgetUsd || 0);
  if (budget > 0 && (await monthSpend()).usd >= budget) return { enhanced: false };
  if (customerId) {
    const used = await prisma.aiUsage.count({ where: { actorType: 'VOICE', actorId: customerId, day: lagosDay() } });
    if (used >= Number(s.voiceDailyLimit || 20)) return { enhanced: false };
  }
  return { enhanced: true, maxSeconds: MAX_SECONDS };
}

async function transcribe(customerId, { audio, seconds, language } = {}) {
  const s = await getSettings();
  const st = await status(customerId);
  if (!st.enhanced) throw new VoiceError('Better voice is not available right now.', 'VOICE_OFF', 409);
  const m = /^data:(audio\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=]+)$/i.exec(String(audio || ''));
  if (!m) throw new VoiceError('Send the recording as audio.', 'BAD_AUDIO');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_BYTES) throw new VoiceError('That recording is too long. Keep it under a minute and a half.', 'TOO_LONG');
  const mime = m[1].toLowerCase();
  const ext = mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac') ? 'mp4' : mime.includes('mpeg') || mime.includes('mp3') ? 'mp3' : mime.includes('wav') ? 'wav' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), `voice.${ext}`);
  form.append('model', MODEL);
  form.append('prompt', PROMPT);
  const lang = ISO[language];
  if (lang && lang !== 'en') form.append('language', lang);
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${keyFrom(s)}` }, body: form, signal: AbortSignal.timeout(30000) });
  } catch {
    throw new VoiceError('Could not reach the voice service.', 'VOICE_DOWN', 502);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('OpenAI transcription failed:', res.status, body?.error?.message);
    throw new VoiceError(res.status === 401 ? 'The voice service key is not valid.' : 'The voice service could not understand that recording.', 'VOICE_FAILED', 502);
  }
  const secs = Math.min(MAX_SECONDS, Math.max(1, Math.round(Number(seconds) || buf.length / 16000)));
  await prisma.aiUsage.create({ data: { actorType: 'VOICE', actorId: String(customerId), day: lagosDay(), model: MODEL, inputTokens: secs, outputTokens: 0, costUsd: (secs / 60) * USD_PER_MINUTE } }).catch((e) => console.warn('voice usage log failed:', e.message));
  return { text: String(body.text || '').trim().slice(0, 800) };
}

module.exports = { VoiceError, status, transcribe, monthSpend, keyFrom, MODEL, USD_PER_MINUTE };
