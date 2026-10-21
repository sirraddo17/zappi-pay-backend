// Code changes from the admin AI as GitHub pull requests — NEVER live by
// itself. The AI proposes a change (an Apply card listing each file);
// when the owner taps Apply the server opens a pull request on GitHub on
// a new branch. Nothing reaches customers until the owner reviews it on
// GitHub and merges it (and, for the backend, updates the VPS).
// Off unless CODE_PR_ENABLED=on and GITHUB_TOKEN (fine-grained token for
// the two repos: Contents + Pull requests read/write) are in the server
// settings (.env).

const vm = require('vm');
const code = require('./codeAccess');

const MAX_FILES = 6;
const MAX_BYTES = 120 * 1024;
const NEVER = [/^\.github\//, /(^|\/)\.env/i, /(^|\/)package-lock\.json$/, /(^|\/)node_modules\//, /\.(pem|key|zpbak)$/i, /^ops\//];
const CAREFUL = [
  [/(^|\/)package\.json$/, 'changes the app’s libraries — the server needs `npm ci` after merging'],
  [/^prisma\/schema\.prisma$/, 'changes the database — run `npx prisma db push` before updating the server'],
  [/(wallet|purchase|disburse|payout|monnify|squad|nomba|flutterwave|fundsGuard|fundingFees|refund|ledger|transfer|webhook|auth|staffAccess|security)/i, 'touches money, login or security code — review every line'],
  [/^server\.js$/, 'changes how the server starts'],
];

class PrError extends Error {}

const enabled = () => String(process.env.CODE_PR_ENABLED || '').toLowerCase() === 'on' && Boolean(code.token());

function status() {
  return {
    enabled: enabled(),
    tokenSet: Boolean(code.token()),
    switchOn: String(process.env.CODE_PR_ENABLED || '').toLowerCase() === 'on',
    repos: code.REPOS,
    howTo: enabled() ? null : 'GitHub → Settings → Developer settings → Fine-grained tokens → Generate: only the two zappi-pay repos; permissions Contents: Read and write, Pull requests: Read and write. Put it in the server settings (.env) as GITHUB_TOKEN=… and add CODE_PR_ENABLED=on, then pm2 restart zappi-pay-api --update-env.',
  };
}

function lineChanges(before, after) {
  const count = (t) => t.split('\n').reduce((m, l) => m.set(l, (m.get(l) || 0) + 1), new Map());
  const a = count(before);
  const b = count(after);
  let removed = 0;
  let added = 0;
  for (const [l, n] of a) removed += Math.max(0, n - (b.get(l) || 0));
  for (const [l, n] of b) added += Math.max(0, n - (a.get(l) || 0));
  return { added, removed };
}

function syntaxCheck(rel, text) {
  if (/\.json$/i.test(rel)) { JSON.parse(text); return 'valid JSON'; }
  if (/\.(js|cjs)$/i.test(rel) && !/^src\//.test(rel)) {
    // eslint-disable-next-line no-new
    new vm.Script(`(function (exports, require, module, __filename, __dirname) {\n${text}\n})`, { filename: rel });
    return 'syntax OK';
  }
  return null; // JSX/frontend: checked by the Vercel preview build
}

// Build the change: read each file from GitHub, apply exact find/replace
// edits (each "find" must appear exactly once), check syntax.
async function prepare({ repo, files } = {}) {
  const r = String(repo || '').toLowerCase().startsWith('f') ? 'frontend' : 'backend';
  if (!Array.isArray(files) || !files.length) throw new PrError('No files to change.');
  if (files.length > MAX_FILES) throw new PrError(`At most ${MAX_FILES} files in one change — split it.`);
  const out = [];
  const warns = [];
  for (const f of files) {
    const rel = code.clean(f.path);
    if (!rel) throw new PrError('A file has no path.');
    if (NEVER.some((re) => re.test(rel)) || code.blocked(rel)) throw new PrError(`${rel} can’t be changed by the assistant.`);
    let before = '';
    let sha;
    try {
      ({ text: before, sha } = await code.ghRead(r, rel));
    } catch (e) {
      if (!/404/.test(e.message)) throw e;
    }
    let after;
    if (typeof f.content === 'string') {
      if (sha) throw new PrError(`${rel} already exists — change it with edits (find/replace), not a whole new file.`);
      after = f.content;
    } else {
      if (!sha) throw new PrError(`${rel} doesn’t exist on GitHub — check the path with list/search.`);
      after = before;
      for (const [i, e] of (f.edits || []).entries()) {
        const find = String(e.find ?? '');
        if (!find) throw new PrError(`${rel}: edit ${i + 1} has nothing to find.`);
        const at = after.indexOf(find);
        if (at < 0) throw new PrError(`${rel}: edit ${i + 1} — the text to replace wasn’t found. Read the file again and copy it exactly.`);
        if (after.indexOf(find, at + 1) >= 0) throw new PrError(`${rel}: edit ${i + 1} — that text appears more than once; include more surrounding lines.`);
        after = after.slice(0, at) + String(e.replace ?? '') + after.slice(at + find.length);
      }
      if (after === before) throw new PrError(`${rel}: nothing changed.`);
    }
    if (Buffer.byteLength(after) > MAX_BYTES) throw new PrError(`${rel} is too big for one change.`);
    let check = null;
    try { check = syntaxCheck(rel, after); } catch (e) { throw new PrError(`${rel} would not run: ${String(e.message).slice(0, 160)}`); }
    for (const [re, why] of CAREFUL) if (re.test(rel)) warns.push(`${rel} ${why}.`);
    out.push({ path: rel, sha: sha || null, content: after, ...lineChanges(before, after), isNew: !sha, check });
  }
  return { repo: r, files: out, warnings: warns };
}

const slug = (s) => String(s || 'change').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'change';

// Called when the owner taps Apply: branch → commits → pull request.
async function open({ repo, title, body, files } = {}) {
  if (!enabled()) throw new PrError('Code pull requests are switched off (CODE_PR_ENABLED / GITHUB_TOKEN).');
  const r = String(repo || '').toLowerCase().startsWith('f') ? 'frontend' : 'backend';
  const full = code.REPOS[r];
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) throw new PrError('Nothing to change.');
  for (const f of files) if (NEVER.some((re) => re.test(f.path)) || code.blocked(f.path)) throw new PrError(`${f.path} can’t be changed.`);
  const base = await code.gh(`/repos/${full}/git/ref/heads/${code.BRANCH}`);
  const branch = `ai/${slug(title)}-${Date.now().toString(36)}`;
  await code.gh(`/repos/${full}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.object.sha }) });
  for (const f of files) {
    try {
      await code.gh(`/repos/${full}/contents/${encodeURI(f.path)}`, { method: 'PUT', body: JSON.stringify({ message: `${String(title).slice(0, 60)}: ${f.path}`, content: Buffer.from(String(f.content), 'utf8').toString('base64'), branch, ...(f.sha ? { sha: f.sha } : {}) }) });
    } catch (e) {
      if (/409|does not match/.test(e.message)) throw new PrError(`${f.path} changed on GitHub since this was prepared — ask the assistant again.`);
      throw e;
    }
  }
  const pr = await code.gh(`/repos/${full}/pulls`, {
    method: 'POST',
    body: JSON.stringify({
      title: `[AI] ${String(title).slice(0, 90)}`,
      head: branch,
      base: code.BRANCH,
      body: `${String(body || '').slice(0, 6000)}\n\n---\nPrepared by the ZAPPI PAY admin assistant and opened when the owner tapped Apply. **Not tested.** Review **Files changed** line by line before merging.${r === 'frontend' ? ' Vercel builds a preview of this branch — open it and try the change first.' : ' After merging, update the server (git pull … pm2 restart).'}`,
      draft: false,
    }),
  });
  return { url: pr.html_url, number: pr.number, branch, repo: full };
}

module.exports = { status, prepare, open, enabled, PrError, lineChanges };
