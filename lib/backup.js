// Database backups: a full copy of every table, password-protected,
// emailed every night to up to 3 addresses (Admin → Settings → Backups)
// and downloadable on demand by the owner.
//
// File format (.zpbak): "ZPBK1" | salt(16) | iv(12) | tag(16) | data
// where data = AES-256-GCM( gzip( JSON ) ) and the key comes from the
// BACKUP_PASSWORD environment variable (scrypt). The password is never
// stored in the database, so a stolen backup or a stolen database
// can't open the other. ops/restore-backup.js reads the file back.

const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
// Loaded when used, so the file can also be read by the restore script.
const prismaClient = () => require('./prisma');

const MAGIC = Buffer.from('ZPBK1');
const MAX_EMAIL_BYTES = 30 * 1024 * 1024; // Resend allows ~40 MB per email
const PAGE = 2000;
const DAY = 24 * 3600 * 1000;
const LAGOS = 3600 * 1000;

// --- Reading the model list from prisma/schema.prisma -----------------
// (Prisma's runtime metadata changes between versions; the schema file
// doesn't.) Returns [{ name, delegate, fields: [{ name, type, scalar,
// list, relation: { model, from: [...] } | null }] }].
function parseSchema(text) {
  const src = text || fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
  const blocks = [...src.matchAll(/^(model|enum)\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
  const modelNames = new Set(blocks.filter((b) => b[1] === 'model').map((b) => b[2]));
  return blocks.filter((b) => b[1] === 'model').map(([, , name, body]) => {
    const fields = [];
    for (const raw of body.split('\n')) {
      const line = raw.replace(/\/\/.*$/, '').trim();
      if (!line || line.startsWith('@@')) continue;
      const m = /^(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/.exec(line);
      if (!m) continue;
      const [, fname, type, list, , rest] = m;
      const isModel = modelNames.has(type);
      const rel = isModel ? /@relation\([^)]*fields:\s*\[([^\]]*)\]/.exec(rest) : null;
      fields.push({
        name: fname,
        type,
        list: Boolean(list),
        scalar: !isModel,
        relation: isModel ? { model: type, from: rel ? rel[1].split(',').map((x) => x.trim()).filter(Boolean) : [] } : null,
      });
    }
    return { name, delegate: name.charAt(0).toLowerCase() + name.slice(1), fields };
  });
}

// --- Making the file -----------------------------------------------------

function keyFor(password, salt) {
  return crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
}
function passwordOk() {
  return String(process.env.BACKUP_PASSWORD || '').length >= 12;
}

function encrypt(json, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(password, salt), iv);
  const data = Buffer.concat([cipher.update(zlib.gzipSync(Buffer.from(json, 'utf8'))), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), data]);
}

function decrypt(buf, password) {
  if (!Buffer.isBuffer(buf) || buf.length < 49 || !buf.subarray(0, 5).equals(MAGIC)) throw new Error('This is not a ZAPPI PAY backup file.');
  const salt = buf.subarray(5, 21);
  const iv = buf.subarray(21, 33);
  const tag = buf.subarray(33, 49);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(password, salt), iv);
  decipher.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([decipher.update(buf.subarray(49)), decipher.final()]);
  } catch {
    throw new Error('Wrong backup password (or the file is damaged).');
  }
  return JSON.parse(zlib.gunzipSync(plain).toString('utf8'));
}

// Bytes columns become base64 text; everything else (dates, decimals)
// JSON-serialises on its own and is converted back on restore.
function plainRow(row, bytesFields) {
  if (!bytesFields.length) return row;
  const out = { ...row };
  for (const f of bytesFields) if (out[f] != null) out[f] = Buffer.from(out[f]).toString('base64');
  return out;
}

async function dump(db = prismaClient(), schemaText) {
  const models = parseSchema(schemaText);
  const data = {};
  const counts = {};
  for (const m of models) {
    const delegate = db[m.delegate];
    if (!delegate || typeof delegate.findMany !== 'function') continue;
    const bytesFields = m.fields.filter((f) => f.scalar && f.type === 'Bytes').map((f) => f.name);
    const rows = [];
    for (let skip = 0; ; skip += PAGE) {
      const page = await delegate.findMany({ orderBy: { id: 'asc' }, skip, take: PAGE });
      rows.push(...page.map((r) => plainRow(r, bytesFields)));
      if (page.length < PAGE) break;
    }
    data[m.name] = rows;
    counts[m.name] = rows.length;
  }
  return { app: 'ZAPPI PAY', version: 1, at: new Date().toISOString(), counts, data };
}

async function makeFile(db) {
  if (!passwordOk()) {
    const e = new Error('Set BACKUP_PASSWORD (at least 12 characters) on Render first.');
    e.status = 409;
    throw e;
  }
  const snapshot = await dump(db);
  const file = encrypt(JSON.stringify(snapshot), process.env.BACKUP_PASSWORD);
  const day = new Date(Date.now() + LAGOS).toISOString().slice(0, 10);
  const rows = Object.values(snapshot.counts).reduce((s, n) => s + n, 0);
  return { file, filename: `zappipay-backup-${day}.zpbak`, rows, tables: Object.keys(snapshot.counts).length, customers: snapshot.counts.Customer || 0 };
}

// --- Emailing it -----------------------------------------------------------

const cleanEmails = (list) => [...new Set((Array.isArray(list) ? list : []).map((e) => String(e || '').trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)))].slice(0, 3);

async function record(status, extra = {}) {
  const s = await require('./vtpass').getSettings();
  await prismaClient().settings.update({ where: { id: s.id }, data: { backupLastAt: new Date(), backupLastStatus: String(status).slice(0, 300), ...extra } }).catch(() => {});
  require('./vtpass').invalidateSettings();
}

async function runAndEmail({ reason = 'nightly' } = {}) {
  const s = await require('./vtpass').getSettings();
  const to = cleanEmails(s.backupEmails);
  if (!to.length) return { sent: 0, skipped: 'Add at least one backup email first.' };
  const { sendEmail, isEmailConfigured } = require('./email');
  if (!isEmailConfigured()) {
    await record('Not sent: email (Resend) is not set up on the server.');
    return { sent: 0, skipped: 'Email is not set up on the server (RESEND_API_KEY / EMAIL_FROM).' };
  }
  let made;
  try {
    made = await makeFile();
  } catch (error) {
    await record(`Failed: ${error.message}`);
    require('./adminAlert').alertAdmins('Backup failed', `Tonight's database backup could not be made: ${error.message}`, '/admin/settings?tab=backups').catch(() => {});
    return { sent: 0, error: error.message };
  }
  const tooBig = made.file.length > MAX_EMAIL_BYTES;
  const mb = (made.file.length / 1024 / 1024).toFixed(2);
  const text = `ZAPPI PAY database backup (${reason})\n\n${made.customers} customers · ${made.rows.toLocaleString('en-NG')} records in ${made.tables} tables · ${mb} MB\n\n${tooBig ? 'The file is too big to email — download it from Admin → Settings → Backups.' : 'The file is attached. It is locked with your backup password (BACKUP_PASSWORD on Render) — keep this email; you need the file and the password to restore.'}\n\nTo restore: see docs/BACKUP.md in the backend repo.`;
  const html = `<p><b>ZAPPI PAY database backup</b> (${reason})</p><p>${made.customers} customers · ${made.rows.toLocaleString('en-NG')} records in ${made.tables} tables · ${mb} MB</p><p>${tooBig ? 'The file is too big to email — download it from <b>Admin → Settings → Backups</b>.' : 'The file is attached. It is locked with your backup password (<code>BACKUP_PASSWORD</code> on Render). Keep this email — you need both the file and the password to restore.'}</p><p style="color:#64748b;font-size:12px">To restore: see docs/BACKUP.md in the backend repo.</p>`;
  let sent = 0;
  for (const email of to) {
    const r = await sendEmail({ to: email, subject: `ZAPPI PAY backup — ${made.filename.slice(16, 26)}`, html, text, attachments: tooBig ? undefined : [{ filename: made.filename, content: made.file.toString('base64') }] });
    if (r.sent) sent += 1;
  }
  const ok = sent === to.length;
  await record(ok ? `Sent to ${sent} email${sent === 1 ? '' : 's'} · ${mb} MB${tooBig ? ' (too big to attach — download it)' : ''}` : `Sent to ${sent} of ${to.length} emails · ${mb} MB`, ok ? { backupLastOkAt: new Date() } : {});
  if (!ok) require('./adminAlert').alertAdmins('Backup email not delivered', `Tonight's backup reached ${sent} of ${to.length} backup emails. Check the addresses in Settings → Backups.`, '/admin/settings?tab=backups').catch(() => {});
  return { sent, of: to.length, bytes: made.file.length, rows: made.rows, tooBig };
}

// --- Schedule: about 2am Lagos time, and catch up after the server wakes
// (Render's free plan sleeps, so a fixed timer alone could miss nights).
let timer = null;
let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const s = await require('./vtpass').getSettings();
    if (!cleanEmails(s.backupEmails).length || !passwordOk()) return;
    const last = s.backupLastOkAt ? new Date(s.backupLastOkAt).getTime() : 0;
    const hourLagos = new Date(Date.now() + LAGOS).getUTCHours();
    if (Date.now() - last > 20 * 3600 * 1000 && (hourLagos >= 2 || Date.now() - last > 30 * 3600 * 1000)) await runAndEmail();
  } catch (error) {
    console.error('backup tick failed:', error.message);
  } finally {
    running = false;
  }
}
function start() {
  if (process.env.DISABLE_SCHEDULER === '1' || timer) return;
  setTimeout(tick, 2 * 60 * 1000).unref?.();
  timer = setInterval(tick, 60 * 60 * 1000);
  timer.unref?.();
}

async function status() {
  const s = await require('./vtpass').getSettings();
  const { isEmailConfigured } = require('./email');
  return {
    emails: cleanEmails(s.backupEmails),
    passwordSet: passwordOk(),
    emailReady: isEmailConfigured(),
    lastAt: s.backupLastAt || null,
    lastOkAt: s.backupLastOkAt || null,
    lastStatus: s.backupLastStatus || null,
  };
}

async function setEmails(list) {
  const raw = (Array.isArray(list) ? list : []).map((e) => String(e || '').trim()).filter(Boolean);
  if (raw.length > 3) { const e = new Error('Up to 3 backup emails.'); e.status = 400; throw e; }
  const emails = cleanEmails(raw);
  if (emails.length !== raw.length) { const e = new Error('One of those emails doesn’t look right.'); e.status = 400; throw e; }
  const s = await require('./vtpass').getSettings();
  await prismaClient().settings.update({ where: { id: s.id }, data: { backupEmails: emails } });
  require('./vtpass').invalidateSettings();
  return status();
}

// --- Restoring ----------------------------------------------------------
// Puts a backup into a database that already has the tables
// (`npx prisma db push` first). Parents before children; a table that
// points at itself (e.g. Customer.referredBy) is loaded without those
// links first, then the links are put back. JsonNull = Prisma.DbNull.
function loadOrder(models) {
  const byName = new Map(models.map((m) => [m.name, m]));
  const deps = new Map(models.map((m) => [m.name, new Set(m.fields.filter((f) => f.relation && f.relation.from.length && f.relation.model !== m.name && byName.has(f.relation.model)).map((f) => f.relation.model))]));
  const order = [];
  const done = new Set();
  const visiting = new Set();
  const visit = (n) => {
    if (done.has(n)) return;
    if (visiting.has(n)) return; // a loop between two tables: load in file order
    visiting.add(n);
    for (const d of deps.get(n) || []) visit(d);
    visiting.delete(n);
    done.add(n);
    order.push(n);
  };
  models.forEach((m) => visit(m.name));
  return order.map((n) => byName.get(n));
}

async function restore(db, snapshot, { DbNull = null, schemaText, log = () => {} } = {}) {
  if (!snapshot || snapshot.app !== 'ZAPPI PAY' || !snapshot.data) throw new Error('This file is not a ZAPPI PAY backup.');
  const models = loadOrder(parseSchema(schemaText));
  const later = [];
  const counts = {};
  for (const m of models) {
    const rows = snapshot.data[m.name];
    if (!Array.isArray(rows) || !rows.length) continue;
    const delegate = db[m.delegate];
    if (!delegate) continue;
    const scalars = new Map(m.fields.filter((f) => f.scalar).map((f) => [f.name, f]));
    const selfLinks = m.fields.filter((f) => f.relation && f.relation.model === m.name).flatMap((f) => f.relation.from);
    const fixed = rows.map((r) => {
      const out = {};
      for (const [k, v] of Object.entries(r)) {
        const f = scalars.get(k);
        if (!f) continue;
        if (v === null && f.type === 'Json') out[k] = DbNull;
        else if (v !== null && f.type === 'DateTime') out[k] = f.list ? v.map((x) => new Date(x)) : new Date(v);
        else if (v !== null && f.type === 'Bytes') out[k] = Buffer.from(v, 'base64');
        else out[k] = v;
      }
      const links = {};
      for (const k of selfLinks) if (out[k] != null) { links[k] = out[k]; out[k] = null; }
      if (Object.keys(links).length) later.push({ delegate, id: out.id, links });
      return out;
    });
    for (let i = 0; i < fixed.length; i += 500) await delegate.createMany({ data: fixed.slice(i, i + 500), skipDuplicates: true });
    counts[m.name] = fixed.length;
    log(`${m.name}: ${fixed.length}`);
  }
  for (const l of later) await l.delegate.update({ where: { id: l.id }, data: l.links });
  return counts;
}

module.exports = { restore, loadOrder, parseSchema, encrypt, decrypt, dump, makeFile, runAndEmail, start, tick, status, setEmails, cleanEmails, passwordOk, DAY };
