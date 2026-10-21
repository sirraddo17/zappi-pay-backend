// Read-only access to the app's code for the admin AI (owner only):
// list folders, search, and read files, so it can explain how something
// works or where an error comes from.
//  • backend  — read from this server's own copy of the code
//  • frontend — read from GitHub (needs GITHUB_TOKEN in the server
//    settings if the repo is private)
// Never readable: .env files, keys/certificates, backups, node_modules,
// .git, build output. Anything that looks like a secret is masked.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPOS = {
  backend: process.env.GITHUB_REPO_BACKEND || 'sirraddo17/zappi-pay-backend',
  frontend: process.env.GITHUB_REPO_FRONTEND || 'sirraddo17/zappi-pay-frontend',
};
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const TEXT = /\.(js|jsx|ts|tsx|mjs|cjs|json|md|txt|prisma|css|html|yml|yaml|sh|example|svg)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'uploads', 'backups', '.vercel', '.next', 'tmp']);
const MAX_LINES = 400;

class CodeError extends Error {}

function clean(p) {
  const rel = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '').trim();
  if (rel.split('/').includes('..')) throw new CodeError('That path isn’t allowed.');
  return rel;
}

function blocked(rel) {
  const parts = rel.split('/');
  const name = parts[parts.length - 1] || '';
  if (parts.some((x) => SKIP_DIRS.has(x))) return 'build/library folders aren’t readable';
  if (/^\.env/i.test(name) && !/\.example$/i.test(name)) return 'server settings (.env) are never readable';
  if (/\.(pem|key|p12|pfx|crt|zpbak|sqlite|db)$/i.test(name) || /^id_(rsa|ed25519)/.test(name)) return 'keys, certificates and backups are never readable';
  return null;
}

// Mask anything that looks like a secret, even in code.
function redact(text) {
  return String(text)
    .replace(/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/g, '$1_$2_•••')
    .replace(/\bnapi_[A-Za-z0-9]{10,}/g, 'napi_•••')
    .replace(/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s'"`]+/gi, '$1://•••')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{24,}=*/g, '$1 •••')
    .replace(/((?:secret|password|passwd|api[_-]?key|token|private[_-]?key)["']?\s*[:=]\s*["'`])([^"'`\s]{8,})(["'`])/gi, '$1•••$3');
}

// ---- backend (local copy) ----------------------------------------------------

function localPath(rel) {
  const full = path.resolve(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) throw new CodeError('That path isn’t allowed.');
  return full;
}

function walk(dir, out = [], depth = 0) {
  if (depth > 6 || out.length > 3000) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.isDirectory()) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    if (e.isDirectory()) walk(full, out, depth + 1);
    else if (TEXT.test(e.name) && !blocked(rel)) out.push(rel);
  }
  return out;
}

// ---- GitHub ------------------------------------------------------------------

const token = () => String(process.env.GITHUB_TOKEN || '').trim();

async function gh(url, opts = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'zappipay-admin', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) };
  if (token()) headers.Authorization = `Bearer ${token()}`;
  const res = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, { ...opts, headers, signal: AbortSignal.timeout(20000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint = res.status === 404 || res.status === 401 ? (token() ? ' — check the GitHub token can see this repo.' : ' — the repo may be private: add GITHUB_TOKEN to the server settings (.env).') : '';
    throw new CodeError(`GitHub answered ${res.status}${json.message ? `: ${json.message}` : ''}${hint}`);
  }
  return json;
}

let treeCache = {};
async function ghFiles(repo) {
  const c = treeCache[repo];
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c.files;
  const t = await gh(`/repos/${REPOS[repo]}/git/trees/${BRANCH}?recursive=1`);
  const files = (t.tree || []).filter((x) => x.type === 'blob' && TEXT.test(x.path) && !blocked(x.path)).map((x) => ({ path: x.path, size: x.size }));
  treeCache[repo] = { at: Date.now(), files };
  return files;
}

async function ghRead(repo, rel) {
  const j = await gh(`/repos/${REPOS[repo]}/contents/${encodeURI(rel)}?ref=${BRANCH}`);
  if (Array.isArray(j)) throw new CodeError('That is a folder — use list.');
  return { text: Buffer.from(j.content || '', 'base64').toString('utf8'), sha: j.sha };
}

// ---- public ------------------------------------------------------------------

const repoOf = (r) => (String(r || 'backend').toLowerCase().startsWith('f') ? 'frontend' : 'backend');

async function list({ repo, path: p } = {}) {
  const r = repoOf(repo);
  const rel = clean(p);
  const files = r === 'backend' ? walk(ROOT) : (await ghFiles(r)).map((f) => f.path);
  const under = files.filter((f) => !rel || f === rel || f.startsWith(rel.replace(/\/$/, '') + '/'));
  const depth = rel ? rel.replace(/\/$/, '').split('/').length : 0;
  const entries = [...new Set(under.map((f) => f.split('/').slice(0, depth + 1).join('/') + (f.split('/').length > depth + 1 ? '/' : '')))];
  return { repo: r, path: rel || '/', entries: entries.slice(0, 300), more: entries.length > 300 };
}

async function search({ repo, query } = {}) {
  const r = repoOf(repo);
  const q = String(query || '').trim();
  if (q.length < 3) throw new CodeError('Search for at least 3 characters.');
  const needle = q.toLowerCase();
  const hits = [];
  if (r === 'backend') {
    for (const rel of walk(ROOT)) {
      const text = fs.readFileSync(localPath(rel), 'utf8');
      if (!text.toLowerCase().includes(needle)) continue;
      text.split('\n').forEach((line, i) => { if (hits.length < 40 && line.toLowerCase().includes(needle)) hits.push({ path: rel, line: i + 1, text: redact(line.trim().slice(0, 200)) }); });
      if (hits.length >= 40) break;
    }
  } else {
    // Only source folders, read from GitHub (cached tree; up to 120 files).
    const files = (await ghFiles(r)).filter((f) => /^(src|public)\//.test(f.path) && f.size < 200000).slice(0, 120);
    for (const f of files) {
      const { text } = await ghRead(r, f.path).catch(() => ({ text: '' }));
      if (!text.toLowerCase().includes(needle)) continue;
      text.split('\n').forEach((line, i) => { if (hits.length < 40 && line.toLowerCase().includes(needle)) hits.push({ path: f.path, line: i + 1, text: redact(line.trim().slice(0, 200)) }); });
      if (hits.length >= 40) break;
    }
  }
  return { repo: r, query: q, hits, more: hits.length >= 40 };
}

async function read({ repo, path: p, from, to } = {}) {
  const r = repoOf(repo);
  const rel = clean(p);
  if (!rel) throw new CodeError('Which file?');
  const why = blocked(rel);
  if (why) throw new CodeError(`Can’t read that: ${why}.`);
  if (!TEXT.test(rel)) throw new CodeError('Only code and text files can be read.');
  let text;
  if (r === 'backend') {
    const full = localPath(rel);
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) throw new CodeError('No such file — use search or list to find it.');
    text = fs.readFileSync(full, 'utf8');
  } else {
    text = (await ghRead(r, rel)).text;
  }
  const lines = text.split('\n');
  const start = Math.max(1, parseInt(from, 10) || 1);
  const end = Math.min(lines.length, parseInt(to, 10) || start + MAX_LINES - 1, start + MAX_LINES - 1);
  const body = lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join('\n');
  return { repo: r, path: rel, totalLines: lines.length, from: start, to: end, more: end < lines.length, code: redact(body), note: end < lines.length ? `Read on with from=${end + 1}.` : undefined };
}

module.exports = { list, search, read, redact, blocked, clean, CodeError, REPOS, BRANCH, gh, ghRead, token };
