// Draws ZAPPI PAY adverts from a design (headline, subtext, badges,
// button, theme, optional background photo) in three sizes, as a
// picture or a 3-second animated video.

export const FORMATS = {
  square: { w: 1080, h: 1080, label: 'Square post (Instagram, Facebook, X)' },
  story: { w: 1080, h: 1920, label: 'Status / Story (WhatsApp, Instagram, TikTok)' },
  slider: { w: 1200, h: 600, label: 'In-app slider (top or bottom)' },
};

export const THEMES = {
  purple: { stops: ['#a46bff', '#863bff', '#5b1fc4', '#2a0b66'], accent: '#FFB830', ink: '#2a0b66' },
  gold: { stops: ['#fcd34d', '#f59e0b', '#b45309', '#78350f'], accent: '#ffffff', ink: '#78350f' },
  green: { stops: ['#34d399', '#10b981', '#047857', '#064e3b'], accent: '#FFE27A', ink: '#064e3b' },
  blue: { stops: ['#60a5fa', '#2563eb', '#1e40af', '#1e1b4b'], accent: '#FFB830', ink: '#1e1b4b' },
  dark: { stops: ['#334155', '#1e293b', '#0f172a', '#020617'], accent: '#FFB830', ink: '#0f172a' },
  red: { stops: ['#f87171', '#ef4444', '#b91c1c', '#7f1d1d'], accent: '#FFE27A', ink: '#7f1d1d' },
};

const font = (w, px) => `${w} ${px}px Poppins, "Segoe UI", Roboto, Arial, sans-serif`;
const EMOJI_FONT = (px) => `${px}px "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
const clamp = (x) => Math.max(0, Math.min(1, x));
const ease = (x) => 1 - Math.pow(1 - clamp(x), 3);

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawLogo(ctx, x, y, s) {
  const k = s / 300;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  roundRect(ctx, 0, 0, 300, 300, 72);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fill();
  ctx.fillStyle = '#fff';
  roundRect(ctx, 50, 68, 200, 36, 8); ctx.fill();
  ctx.beginPath(); ctx.moveTo(230, 104); ctx.lineTo(70, 184); ctx.lineTo(114, 184); ctx.lineTo(274, 104); ctx.closePath(); ctx.fill();
  roundRect(ctx, 50, 184, 200, 36, 8); ctx.fill();
  ctx.fillStyle = '#FFB830';
  ctx.beginPath(); ctx.moveTo(236, 12); ctx.lineTo(218, 58); ctx.lineTo(232, 58); ctx.lineTo(210, 108); ctx.lineTo(258, 48); ctx.lineTo(242, 48); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// Wraps words into lines no wider than maxW; highlighted words keep a flag.
function layoutWords(ctx, text, highlight, maxW) {
  const hl = new Set(String(highlight || '').toLowerCase().split(/\s+/).filter(Boolean));
  const words = String(text || '').split(/\s+/).filter(Boolean).map((w) => ({ w, hl: hl.has(w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')) || hl.has(w.toLowerCase()) }));
  const lines = [];
  let line = [];
  for (const word of words) {
    const test = [...line, word].map((x) => x.w).join(' ');
    if (line.length && ctx.measureText(test).width > maxW) {
      lines.push(line);
      line = [word];
    } else {
      line.push(word);
    }
  }
  if (line.length) lines.push(line);
  return lines;
}

function fillLines(ctx, lines, x, y, lineH, align, color, accent) {
  lines.forEach((line, i) => {
    const full = line.map((l) => l.w).join(' ');
    let cx = align === 'center' ? x - ctx.measureText(full).width / 2 : x;
    for (const [j, word] of line.entries()) {
      const piece = word.w + (j < line.length - 1 ? ' ' : '');
      ctx.fillStyle = word.hl ? accent : color;
      ctx.textAlign = 'left';
      ctx.fillText(piece, cx, y + i * lineH);
      cx += ctx.measureText(piece).width;
    }
  });
}

function fitHeadline(ctx, text, highlight, maxW, maxLines, start, min) {
  for (let px = start; px >= min; px -= 4) {
    ctx.font = font(700, px);
    const lines = layoutWords(ctx, text, highlight, maxW);
    if (lines.length <= maxLines) return { px, lines };
  }
  ctx.font = font(700, min);
  return { px: min, lines: layoutWords(ctx, text, highlight, maxW) };
}

function background(ctx, W, H, theme, photo, t) {
  const g = ctx.createRadialGradient(W * (0.85 - 0.1 * t), H * 0.1, 40, W * 0.5, H * 0.55, Math.max(W, H));
  theme.stops.forEach((c, i) => g.addColorStop([0, 0.35, 0.7, 1][i], c));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  if (photo) {
    const s = Math.max(W / photo.width, H / photo.height) * (1.04 + 0.04 * t);
    const pw = photo.width * s;
    const ph = photo.height * s;
    ctx.drawImage(photo, (W - pw) / 2, (H - ph) / 2, pw, ph);
    const o = ctx.createLinearGradient(0, 0, 0, H);
    o.addColorStop(0, `${theme.stops[3]}d9`);
    o.addColorStop(0.55, `${theme.stops[2]}99`);
    o.addColorStop(1, `${theme.stops[3]}f2`);
    ctx.fillStyle = o;
    ctx.fillRect(0, 0, W, H);
  }
  const glow = ctx.createRadialGradient(W, H, 10, W, H, Math.max(W, H) * 0.6);
  glow.addColorStop(0, 'rgba(255,184,48,0.28)');
  glow.addColorStop(1, 'rgba(255,184,48,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
}

function pill(ctx, text, x, y, h, bg, color, px, align = 'left') {
  ctx.font = font(700, px);
  const w = ctx.measureText(text).width + h;
  const left = align === 'center' ? x - w / 2 : x;
  roundRect(ctx, left, y, w, h, h / 2);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.fillText(text, left + h / 2, y + h / 2 + px * 0.36);
  return w;
}

// p: animation progress per part (0..1); omit for the finished picture.
export function drawAd(ctx, design, formatKey, photo, p = {}) {
  const { w: W, h: H } = FORMATS[formatKey];
  const theme = THEMES[design.theme] || THEMES.purple;
  const a = (k) => clamp(p[k] ?? 1);
  background(ctx, W, H, theme, photo, a('bg'));
  ctx.textBaseline = 'alphabetic';

  if (formatKey === 'slider') {
    const pad = 56;
    ctx.globalAlpha = a('logo');
    drawLogo(ctx, pad, 44, 64);
    ctx.fillStyle = '#fff';
    ctx.font = font(700, 30);
    ctx.textAlign = 'left';
    ctx.fillText('ZAPPI PAY', pad + 80, 88);
    ctx.globalAlpha = 1;
    const textW = W * 0.62;
    const h = fitHeadline(ctx, design.headline, design.highlight, textW, 2, 72, 44);
    ctx.globalAlpha = ease(a('head'));
    ctx.font = font(700, h.px);
    fillLines(ctx, h.lines, pad, 200 + (1 - ease(a('head'))) * 30, h.px * 1.05, 'left', '#fff', theme.accent);
    ctx.globalAlpha = ease(a('sub'));
    ctx.font = font(500, 30);
    const subY = 200 + h.lines.length * h.px * 1.05 + 10;
    fillLines(ctx, layoutWords(ctx, design.subtext, '', textW), pad, subY, 40, 'left', 'rgba(255,255,255,0.92)', '#fff');
    ctx.globalAlpha = ease(a('cta'));
    if (design.cta) pill(ctx, `${design.cta} →`, pad, H - 116, 68, theme.accent, theme.ink, 30);
    ctx.globalAlpha = ease(a('emoji'));
    if (design.emoji) {
      ctx.font = EMOJI_FONT(220 * (0.7 + 0.3 * ease(a('emoji'))));
      ctx.textAlign = 'center';
      ctx.fillText(design.emoji, W * 0.83, H * 0.66);
    }
    ctx.globalAlpha = 1;
    return;
  }

  const story = formatKey === 'story';
  const pad = 80;
  const top = story ? 220 : 80;
  const bottomSafe = story ? 260 : 70;
  ctx.globalAlpha = a('logo');
  const ls = story ? 110 : 84;
  drawLogo(ctx, pad, top, ls);
  ctx.fillStyle = '#fff';
  ctx.font = font(700, story ? 48 : 38);
  ctx.textAlign = 'left';
  ctx.fillText('ZAPPI', pad + ls + 22, top + ls * 0.64);
  const zw = ctx.measureText('ZAPPI ').width;
  ctx.fillStyle = '#FFB830';
  ctx.fillText('PAY', pad + ls + 22 + zw, top + ls * 0.64);
  ctx.globalAlpha = 1;

  if (design.emoji) {
    ctx.globalAlpha = ease(a('emoji'));
    ctx.font = EMOJI_FONT((story ? 240 : 170) * (0.7 + 0.3 * ease(a('emoji'))));
    ctx.textAlign = 'right';
    ctx.fillText(design.emoji, W - pad + 10, top + (story ? 520 : 330));
    ctx.globalAlpha = 1;
  }

  const hy = top + (story ? 360 : 230);
  const h = fitHeadline(ctx, design.headline, design.highlight, W - pad * 2 - (design.emoji ? 120 : 0), story ? 4 : 3, story ? 132 : 104, 60);
  const lift = (1 - ease(a('head'))) * 40;
  ctx.globalAlpha = ease(a('head'));
  ctx.font = font(700, h.px);
  fillLines(ctx, h.lines, pad, hy + h.px + lift, h.px * 1.04, 'left', '#fff', theme.accent);
  let y = hy + h.px + h.lines.length * h.px * 1.04 + 20;

  ctx.globalAlpha = ease(a('sub'));
  ctx.font = font(500, story ? 50 : 40);
  const sub = layoutWords(ctx, design.subtext, '', W - pad * 2);
  fillLines(ctx, sub, pad, y, story ? 66 : 54, 'left', 'rgba(255,255,255,0.92)', '#fff');
  y += sub.length * (story ? 66 : 54) + (story ? 50 : 34);

  ctx.globalAlpha = ease(a('badges'));
  let bx = pad;
  for (const b of design.badges || []) {
    const bh = story ? 78 : 62;
    ctx.font = font(600, story ? 34 : 28);
    const bw = ctx.measureText(b).width + bh;
    if (bx + bw > W - pad) { bx = pad; y += bh + 16; }
    roundRect(ctx, bx, y, bw, bh, bh / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.fillText(b, bx + bh / 2, y + bh / 2 + (story ? 12 : 10));
    bx += bw + 14;
  }
  ctx.globalAlpha = 1;

  const ctaH = story ? 110 : 88;
  const ctaY = H - bottomSafe - ctaH - (story ? 90 : 70);
  ctx.globalAlpha = ease(a('cta'));
  if (design.cta) pill(ctx, `${design.cta} →`, pad, ctaY, ctaH, theme.accent, theme.ink, story ? 46 : 38);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = font(600, story ? 40 : 32);
  ctx.textAlign = 'left';
  ctx.fillText('www.zappipay.com.ng', pad, H - bottomSafe - (story ? 20 : 10));
  ctx.globalAlpha = 1;
}

export async function loadPhoto(dataUrl) {
  if (!dataUrl) return null;
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  return img;
}

export async function renderAd(design, formatKey, photo, type = 'image/png', quality) {
  const { w, h } = FORMATS[formatKey];
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  drawAd(c.getContext('2d'), design, formatKey, photo);
  if (type === 'dataurl') return c.toDataURL('image/jpeg', quality || 0.86);
  return new Promise((resolve) => c.toBlob(resolve, type, quality));
}

export function videoSupported() {
  return typeof window.MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

// 3-second animation of the advert (MP4 when the browser can, else WebM).
export async function recordAdVideo(design, formatKey, photo) {
  if (!videoSupported()) throw new Error("This browser can't make videos. Download the picture instead.");
  const { w, h } = FORMATS[formatKey];
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(c.captureStream(30), mimeType ? { mimeType, videoBitsPerSecond: 5_000_000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((resolve) => { rec.onstop = resolve; });
  const D = 3000;
  const seg = (t, s, e) => (t - s) / (e - s);
  rec.start(100);
  const start = performance.now();
  await new Promise((resolve) => {
    const step = () => {
      const t = performance.now() - start;
      drawAd(ctx, design, formatKey, photo, { bg: t / D, logo: seg(t, 0, 400), head: seg(t, 250, 850), emoji: seg(t, 600, 1200), sub: seg(t, 900, 1400), badges: seg(t, 1300, 1800), cta: seg(t, 1700, 2200) });
      if (t < D) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  rec.stop();
  await done;
  const type = (mimeType || 'video/webm').split(';')[0];
  return { blob: new Blob(chunks, { type }), ext: type === 'video/mp4' ? 'mp4' : 'webm' };
}
