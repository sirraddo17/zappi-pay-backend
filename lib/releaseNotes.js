// Release notes. When the server starts on a NEW commit (deploy record
// from lib/deployCheck.js), list the commits since the version that ran
// before — from the local git history, no GitHub token needed — and save
// them on the deploy record. The admin AI (get_release_notes) turns them
// into a plain "what changed" note for the owner and, only when customers
// would notice, a broadcast DRAFT through propose_broadcast (the owner taps
// Apply; nothing is ever sent automatically). Read-only.

const path = require('path');
const { execFileSync } = require('child_process');
const prisma = require('./prisma');
const { scrubLine } = require('./serverLogs');

const ROOT = path.resolve(__dirname, '..');
const SHA = /^[0-9a-f]{7,40}$/i;
const MAX = 100;

// Lines that only say who wrote the commit are left out.
const NOISE = /^(co-authored-by|claude-session|signed-off-by|https:\/\/claude\.ai)/i;

function gitLog(from, to, run = (args) => execFileSync('git', args, { cwd: ROOT, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 2 * 1024 * 1024 }).toString()) {
  if (!SHA.test(String(from)) || !SHA.test(String(to))) return null;
  let out;
  try {
    out = run(['log', '--no-merges', `--max-count=${MAX}`, '--date=short', '--format=%h%x1f%ad%x1f%s%x1f%b%x1e', `${from}..${to}`]);
  } catch {
    return null;
  }
  return out.split('\x1e').map((c) => c.trim()).filter(Boolean).map((c) => {
    const [hash, date, subject, body = ''] = c.split('\x1f');
    const details = body.split('\n').map((l) => l.trim()).filter((l) => l && !NOISE.test(l)).slice(0, 6).map((l) => scrubLine(l).slice(0, 200));
    return { hash, date, subject: scrubLine(subject || '').slice(0, 200), details };
  });
}

// Called by deployCheck after the start is recorded.
async function capture({ recordId, commit, run } = {}) {
  if (!recordId || !SHA.test(String(commit || ''))) return null;
  const prev = await prisma.deployRecord.findFirst({ where: { id: { not: recordId } }, orderBy: { startedAt: 'desc' }, select: { commit: true } }).catch(() => null);
  // Same commit restarted (or the very first start): nothing new to note.
  if (!prev || prev.commit === commit || !SHA.test(String(prev.commit))) return null;
  const commits = gitLog(prev.commit, commit, run);
  const data = { sinceCommit: prev.commit, commits: commits === null ? { error: 'The git history between the two versions could not be read on the server.' } : commits };
  await prisma.deployRecord.update({ where: { id: recordId }, data }).catch((e) => console.error('release notes: could not save:', e.message));
  return data;
}

// For the admin AI: back = 0 → the update running now, 1 → the one before…
async function notes({ back = 0 } = {}) {
  const n = Math.min(10, Math.max(0, parseInt(back, 10) || 0));
  const rows = await prisma.deployRecord.findMany({ where: { sinceCommit: { not: null } }, orderBy: { startedAt: 'desc' }, take: n + 1 });
  const r = rows[n];
  if (!r) return { note: n ? 'No earlier update with release notes.' : 'No release notes yet. They are saved when the server starts on a new version (after the next update and restart).' };
  const list = Array.isArray(r.commits) ? r.commits : [];
  return {
    version: r.commit,
    previousVersion: r.sinceCommit,
    startedAt: r.startedAt,
    ...(r.commits && !Array.isArray(r.commits) ? { error: r.commits.error } : {}),
    commits: list,
    count: list.length,
    ...(list.length >= MAX ? { more: `Only the latest ${MAX} commits are listed.` } : {}),
    howToUse: 'Write a short plain note for the owner (group related commits; skip tests, guides and tidy-ups). Only if customers would notice the change, draft a customer message and propose it with propose_broadcast (the owner taps Apply). Never send anything yourself.',
  };
}

module.exports = { capture, notes, gitLog };
