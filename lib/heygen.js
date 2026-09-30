// HeyGen (AI presenter videos) — optional. Off until the owner saves a
// HeyGen API key and turns it on in Settings → AI Assistant. Costs are
// estimated from the video length and capped by a monthly budget.

const prisma = require('./prisma');
const { getSettings } = require('./vtpass');

const BASE = 'https://api.heygen.com';
const DIMENSIONS = { '9:16': { width: 720, height: 1280 }, '1:1': { width: 720, height: 720 }, '16:9': { width: 1280, height: 720 } };
const MAX_CHARS = 1500; // about 90 seconds of speech

class HeygenError extends Error {
  constructor(message, status = 400, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const keyFrom = (s) => String(s.heygenApiKey || process.env.HEYGEN_API_KEY || '').trim();
const round2 = (n) => Math.round(Number(n) * 100) / 100;

async function hg(method, path, body, settings) {
  const key = keyFrom(settings || (await getSettings()));
  if (!key) throw new HeygenError('HeyGen is not set up yet. Add your HeyGen API key in Settings → AI Assistant.', 400, 'HEYGEN_NO_KEY');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(`${BASE}${path}`, { method, signal: ctrl.signal, headers: { Accept: 'application/json', 'X-Api-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      const msg = json.error?.message || json.message || (typeof json.error === 'string' ? json.error : '') || `HeyGen error ${res.status}`;
      throw new HeygenError(res.status === 401 ? 'HeyGen rejected the API key.' : `HeyGen: ${String(msg).slice(0, 200)}`, 502, 'HEYGEN_FAILED');
    }
    return json.data ?? json;
  } catch (error) {
    if (error instanceof HeygenError) throw error;
    throw new HeygenError('Could not reach HeyGen. Try again shortly.', 502, 'HEYGEN_DOWN');
  } finally {
    clearTimeout(t);
  }
}

async function monthSpend() {
  const start = require('./ai').startOfLagosMonth();
  const r = await prisma.aiVideo.aggregate({ where: { createdAt: { gte: start }, status: { not: 'FAILED' } }, _sum: { costUsd: true, estUsd: true } });
  // Finished videos count their real cost; unfinished ones their estimate.
  const done = await prisma.aiVideo.aggregate({ where: { createdAt: { gte: start }, status: 'COMPLETED' }, _sum: { estUsd: true } });
  return round2(Number(r._sum.costUsd || 0) + Number(r._sum.estUsd || 0) - Number(done._sum.estUsd || 0));
}

// ≈150 spoken words a minute.
function estimate(script, settings) {
  const words = String(script).trim().split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(0.25, words / 150);
  return { words, seconds: Math.round(minutes * 60), usd: round2(minutes * Number(settings.heygenPricePerMinUsd || 1)) };
}

async function status() {
  const s = await getSettings();
  const key = keyFrom(s);
  return {
    enabled: Boolean(s.heygenEnabled),
    keySet: Boolean(key),
    keyHint: s.heygenApiKey ? `…${String(s.heygenApiKey).slice(-4)}` : key ? '(server)' : null,
    ready: Boolean(s.heygenEnabled && key),
    monthUsd: await monthSpend(),
    budgetUsd: Number(s.heygenMonthlyBudgetUsd || 0),
    pricePerMinUsd: Number(s.heygenPricePerMinUsd || 1),
    avatarId: s.heygenAvatarId || null,
    voiceId: s.heygenVoiceId || null,
  };
}

async function updateSettings(body) {
  const s = await getSettings();
  const data = {};
  if (body.apiKeyClear) data.heygenApiKey = null;
  else if (body.apiKey !== undefined && String(body.apiKey).trim()) {
    const k = String(body.apiKey).trim();
    if (!/^[A-Za-z0-9_\-=.]{16,200}$/.test(k)) throw new HeygenError('That does not look like a HeyGen API key.');
    data.heygenApiKey = k;
  }
  if (body.budgetUsd !== undefined) data.heygenMonthlyBudgetUsd = Math.min(2000, Math.max(0, Number(body.budgetUsd) || 0));
  if (body.pricePerMinUsd !== undefined) data.heygenPricePerMinUsd = Math.min(20, Math.max(0.1, Number(body.pricePerMinUsd) || 1));
  if (body.avatarId !== undefined) data.heygenAvatarId = String(body.avatarId || '').trim().slice(0, 120) || null;
  if (body.voiceId !== undefined) data.heygenVoiceId = String(body.voiceId || '').trim().slice(0, 120) || null;
  if (body.enabled !== undefined) data.heygenEnabled = Boolean(body.enabled);
  const willKey = data.heygenApiKey !== undefined ? Boolean(data.heygenApiKey || process.env.HEYGEN_API_KEY) : Boolean(keyFrom(s));
  if ((data.heygenEnabled ?? s.heygenEnabled) && !willKey) {
    if (data.heygenEnabled) throw new HeygenError('Save your HeyGen API key first.');
    data.heygenEnabled = false;
  }
  await prisma.settings.update({ where: { id: s.id }, data });
  require('./vtpass').invalidateSettings();
  cache.avatars = null;
  cache.voices = null;
}

const cache = { avatars: null, voices: null, at: 0 };
async function avatars() {
  if (cache.avatars && Date.now() - cache.at < 6 * 3600 * 1000) return cache.avatars;
  const d = await hg('GET', '/v2/avatars');
  const list = [...(d.avatars || []).map((a) => ({ id: a.avatar_id, name: a.avatar_name, gender: a.gender || null, preview: a.preview_image_url || null, type: 'avatar' })),
    ...(d.talking_photos || []).map((p) => ({ id: p.talking_photo_id && `talking_photo:${p.talking_photo_id}`, name: p.talking_photo_name || 'Talking photo', gender: null, preview: p.preview_image_url || null, type: 'talking_photo' }))]
    .filter((a) => a.id).slice(0, 400);
  cache.avatars = list;
  cache.at = Date.now();
  return list;
}
async function voices() {
  if (cache.voices && Date.now() - cache.at < 6 * 3600 * 1000) return cache.voices;
  const d = await hg('GET', '/v2/voices');
  const list = (d.voices || []).map((v) => ({ id: v.voice_id, name: v.name || v.display_name, language: v.language || null, gender: v.gender || null, preview: v.preview_audio || null })).filter((v) => v.id).slice(0, 800);
  cache.voices = list;
  if (!cache.at) cache.at = Date.now();
  return list;
}

// Starts a HeyGen video. Checks the switch, key and monthly budget first.
async function createVideo(adminId, input = {}) {
  const s = await getSettings();
  if (!s.heygenEnabled) throw new HeygenError('HeyGen videos are turned off (Settings → AI Assistant).', 400, 'HEYGEN_OFF');
  if (!keyFrom(s)) throw new HeygenError('HeyGen is not set up yet.', 400, 'HEYGEN_NO_KEY');
  const script = String(input.script || '').replace(/\s+/g, ' ').trim();
  if (script.length < 10) throw new HeygenError('Write what the presenter should say.');
  if (script.length > MAX_CHARS) throw new HeygenError(`Keep the script under ${MAX_CHARS} characters (about 90 seconds).`);
  const avatarId = String(input.avatarId || s.heygenAvatarId || '').trim();
  const voiceId = String(input.voiceId || s.heygenVoiceId || '').trim();
  if (!avatarId || !voiceId) throw new HeygenError('Choose a default presenter and voice in Settings → AI Assistant → HeyGen first.');
  const aspect = DIMENSIONS[input.aspect] ? input.aspect : '9:16';
  const est = estimate(script, s);
  const budget = Number(s.heygenMonthlyBudgetUsd || 0);
  if (budget > 0 && (await monthSpend()) + est.usd > budget) throw new HeygenError(`This would go over your HeyGen budget of $${budget} this month.`, 400, 'HEYGEN_BUDGET');
  const title = String(input.title || script.slice(0, 50)).trim().slice(0, 100);
  // Talking photos are saved as "talking_photo:<id>".
  const isPhoto = avatarId.startsWith('talking_photo:');
  const charId = isPhoto ? avatarId.slice('talking_photo:'.length) : avatarId;

  const row = await prisma.aiVideo.create({ data: { adminId, title, script, avatarId, voiceId, aspect, status: 'PENDING', estUsd: est.usd } });
  try {
    const d = await hg('POST', '/v2/video/generate', {
      title,
      caption: input.caption !== false,
      dimension: DIMENSIONS[aspect],
      video_inputs: [{
        character: isPhoto ? { type: 'talking_photo', talking_photo_id: charId } : { type: 'avatar', avatar_id: charId, avatar_style: 'normal' },
        voice: { type: 'text', input_text: script, voice_id: voiceId, speed: 1.0 },
        background: { type: 'color', value: input.background && /^#[0-9a-f]{6}$/i.test(input.background) ? input.background : '#2a0b66' },
      }],
    }, s);
    if (!d?.video_id) throw new HeygenError('HeyGen did not return a video id.', 502);
    const updated = await prisma.aiVideo.update({ where: { id: row.id }, data: { heygenVideoId: String(d.video_id), status: 'PROCESSING' } });
    schedule(row.id);
    await prisma.auditLog.create({ data: { actorAdminId: adminId, action: 'HEYGEN_VIDEO', details: { id: row.id, est: est.usd } } }).catch(() => {});
    return out(updated);
  } catch (error) {
    await prisma.aiVideo.update({ where: { id: row.id }, data: { status: 'FAILED', error: String(error.message).slice(0, 300) } });
    throw error;
  }
}

async function refresh(id) {
  const v = await prisma.aiVideo.findUnique({ where: { id } });
  if (!v) throw new HeygenError('Video not found.', 404);
  if (!['PROCESSING', 'PENDING'].includes(v.status) || !v.heygenVideoId) return out(v);
  let d;
  try {
    d = await hg('GET', `/v1/video_status.get?video_id=${encodeURIComponent(v.heygenVideoId)}`);
  } catch {
    return out(v);
  }
  const st = String(d.status || '').toLowerCase();
  if (st === 'completed' && d.video_url) {
    const s = await getSettings();
    const secs = Number(d.duration) || estimate(v.script, s).seconds;
    return out(await prisma.aiVideo.update({ where: { id }, data: { status: 'COMPLETED', videoUrl: String(d.video_url), thumbnailUrl: d.thumbnail_url ? String(d.thumbnail_url) : null, duration: secs, costUsd: round2((secs / 60) * Number(s.heygenPricePerMinUsd || 1)), urlExpiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000) } }));
  }
  if (st === 'failed') {
    const why = d.error?.message || d.error_details?.message || d.error || 'HeyGen could not make this video.';
    return out(await prisma.aiVideo.update({ where: { id }, data: { status: 'FAILED', error: String(typeof why === 'string' ? why : JSON.stringify(why)).slice(0, 300) } }));
  }
  return out(v);
}

function schedule(id) {
  let n = 0;
  const tick = () => {
    n += 1;
    refresh(id).then((v) => { if (v.status === 'PROCESSING' && n < 40) setTimeout(tick, 30000).unref?.(); }).catch(() => {});
  };
  setTimeout(tick, 45000).unref?.();
}

async function list() {
  const rows = await prisma.aiVideo.findMany({ orderBy: { createdAt: 'desc' }, take: 30 });
  return rows.map(out);
}

// Copies a finished video into an in-app advert (HeyGen links expire in 7 days).
async function attachToAd(id, adId) {
  const v = await prisma.aiVideo.findUnique({ where: { id } });
  if (!v || v.status !== 'COMPLETED' || !v.videoUrl) throw new HeygenError('The video is not ready yet.');
  const ad = await prisma.appAd.findUnique({ where: { id: String(adId || '') }, select: { id: true } });
  if (!ad) throw new HeygenError('Choose an advert.');
  const res = await fetch(v.videoUrl).catch(() => null);
  if (!res || !res.ok) throw new HeygenError('Could not download the video from HeyGen (the link may have expired).', 502);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > 10 * 1024 * 1024) throw new HeygenError('This video is over 10 MB — too big for an in-app advert. Make it shorter.');
  await prisma.adVideo.upsert({ where: { adId: ad.id }, create: { adId: ad.id, mime: 'video/mp4', size: data.length, data }, update: { mime: 'video/mp4', size: data.length, data } });
  await prisma.appAd.update({ where: { id: ad.id }, data: { updatedAt: new Date() } });
  return { ok: true, size: data.length };
}

function out(v) {
  return { id: v.id, title: v.title, script: v.script, aspect: v.aspect, status: v.status, videoUrl: v.videoUrl, thumbnailUrl: v.thumbnailUrl, duration: v.duration, estUsd: Number(v.estUsd || 0), costUsd: v.costUsd != null ? Number(v.costUsd) : null, error: v.error, urlExpiresAt: v.urlExpiresAt, createdAt: v.createdAt };
}

module.exports = { HeygenError, status, updateSettings, avatars, voices, createVideo, refresh, list, attachToAd, estimate, DIMENSIONS, MAX_CHARS };
