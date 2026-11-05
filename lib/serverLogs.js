// Server logs for the admin AI (tool get_server_logs). Reads the last lines
// of this app's PM2 log files — READ-ONLY: files are only opened for
// reading, never written, rotated or deleted. Every line is scrubbed of
// secrets and personal data before it leaves this module.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { scrub: scrubIds } = require('./idNumber');

const DEFAULT_LINES = 200;
const MAX_LINES = 1000;
const TAIL_BYTES = 2 * 1024 * 1024; // only the end of a big file is read

function logPaths(env = process.env) {
  const dir = path.join(os.homedir(), '.pm2', 'logs');
  return {
    out: env.pm_out_log_path || path.join(dir, 'zappi-pay-api-out.log'),
    err: env.pm_err_log_path || path.join(dir, 'zappi-pay-api-error.log'),
  };
}

// Last part of a file as lines (missing file → null).
function tailLines(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (start > 0) lines.shift(); // first line may be cut in half
    return lines.filter((l) => l.trim() !== '');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// --- scrubbing ---------------------------------------------------------
const SECRET_WORDS = 'api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|secret|access[_-]?token|refresh[_-]?token|token|password|passwd|pwd|authorization|signature|private[_-]?key|webhook[_-]?secret|x-api-key|pin|otp|bvn|nin|cvv';
const maskPhone = (digits) => {
  const d = digits.replace(/\D/g, '');
  const local = d.startsWith('234') ? `0${d.slice(3)}` : d;
  return `${local.slice(0, 4)}•••••${local.slice(-2)}`;
};
const maskEmail = (user, domain) => {
  const [host, ...rest] = domain.split('.');
  return `${user[0]}•••@${host[0]}•••.${rest.join('.') || 'com'}`;
};

function scrubLine(line) {
  let s = String(line);
  s = s.replace(/(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [hidden]');
  s = s.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[hidden-token]');
  s = s.replace(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]+/g, '[hidden-key]');
  s = s.replace(/\bFLW(?:SECK|PUBK)(?:_TEST)?-[A-Za-z0-9-]+/g, '[hidden-key]');
  s = s.replace(/\bMK_(?:PROD|TEST)_[A-Za-z0-9]+/g, '[hidden-key]');
  s = s.replace(/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s'"]+/gi, '$1://[hidden]');
  s = s.replace(new RegExp(`(["']?\\b(?:${SECRET_WORDS})["']?\\s*[:=]\\s*["']?)([^"'\\s,&}]+)`, 'gi'), '$1[hidden]');
  s = s.replace(/([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g, (m, u, d) => maskEmail(u, d));
  // Nigerian phone numbers → 0816•••••37 (before the 11-digit BVN/NIN mask).
  s = s.replace(/(?<!\d)(?:\+?234|0)[789][01]\d{8}(?!\d)/g, (m) => maskPhone(m));
  // Bank account numbers (10 digits) → ••••••1234.
  s = s.replace(/(?<!\d)\d{10}(?!\d)/g, (m) => `••••••${m.slice(-4)}`);
  // BVN / NIN (any other 11-digit run) — the app's own scrub.
  s = scrubIds(s);
  return s;
}

// --- filters -----------------------------------------------------------
const ERRORISH = /\b(error|failed|fail|exception|unhandled|uncaught|fatal|ECONN\w*|ETIMEDOUT|timeout|refused|crash)\b/i;
// pm2 with timestamps: "2026-11-05T10:12:01: ..." or "2026-11-05 10:12:01 +01:00: ...".
const STAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?/;
function stampOf(line) {
  const m = STAMP.exec(line);
  if (!m) return null;
  const tz = m[3] ? (m[3] === 'Z' ? 'Z' : m[3].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')) : 'Z';
  const t = Date.parse(`${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}${tz}`);
  return Number.isFinite(t) ? t : null;
}

// read({ lines, search, errorsOnly, sinceMinutes }) → { lines, errorLines, ... }
function read({ lines, search, errorsOnly, sinceMinutes } = {}, { paths = logPaths(), now = Date.now() } = {}) {
  const want = Math.min(MAX_LINES, Math.max(1, parseInt(lines, 10) || DEFAULT_LINES));
  const out = tailLines(paths.out);
  const err = tailLines(paths.err);
  if (out === null && err === null) {
    return { lines: [], errorLines: 0, note: `No log files found (looked for ${path.basename(paths.out)} and ${path.basename(paths.err)}). On the server, check: pm2 status.` };
  }
  // Tag each line; lines without a time inherit the one above (stack traces).
  const tag = (list, kind) => {
    let last = null;
    return (list || []).map((text, i) => {
      const t = stampOf(text);
      if (t !== null) last = t;
      return { text, kind, t: t ?? last, i };
    });
  };
  let all = [...tag(out, 'out'), ...tag(err, 'err')];
  const timed = all.some((x) => x.t !== null);
  if (timed) all.sort((a, b) => (a.t ?? 0) - (b.t ?? 0) || (a.kind === b.kind ? a.i - b.i : 0));
  const notes = [];
  const since = Number(sinceMinutes) > 0 ? now - Number(sinceMinutes) * 60 * 1000 : null;
  if (since !== null) {
    if (timed) all = all.filter((x) => x.t !== null && x.t >= since);
    else notes.push('These log lines have no times, so "since" could not be applied (showing the latest lines).');
  }
  const isErr = (x) => x.kind === 'err' || ERRORISH.test(x.text);
  if (errorsOnly) all = all.filter(isErr);
  const q = String(search || '').trim().toLowerCase();
  if (q) all = all.filter((x) => x.text.toLowerCase().includes(q));
  const picked = all.slice(-want);
  return {
    lines: picked.map((x) => `${x.kind === 'err' ? 'ERR ' : ''}${scrubLine(x.text)}`.slice(0, 2000)),
    shown: picked.length,
    errorLines: picked.filter(isErr).length,
    matched: all.length,
    files: { out: out === null ? 'not found' : path.basename(paths.out), err: err === null ? 'not found' : path.basename(paths.err) },
    note: [...notes, 'Read-only. Keys, tokens, passwords, BVN/NIN, emails, phone and account numbers are masked.'].join(' '),
  };
}

module.exports = { read, scrubLine, logPaths, tailLines, DEFAULT_LINES, MAX_LINES };
