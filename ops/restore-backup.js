#!/usr/bin/env node
// Restore a ZAPPI PAY backup (.zpbak) into a database.
//
// Just check a backup opens (changes nothing):
//     node ops/restore-backup.js --check
//   It finds the newest .zpbak in your Downloads folder (or give a path:
//   node ops/restore-backup.js "C:\path\file.zpbak" --check) and asks for
//   the backup password (nothing shows while you type).
//
// Restore for real (into a NEW, empty database):
//   1. Point DATABASE_URL at that database and create the tables:
//        $env:DATABASE_URL="postgresql://...new database..."; npx prisma db push
//   2. node ops/restore-backup.js
//   --force restores into a database that already has customers
//   (existing rows are kept; only missing ones are added).
const fs = require('fs');
const os = require('os');
const path = require('path');
const backup = require('../lib/backup');

function findBackup(arg) {
  if (arg) {
    if (fs.existsSync(arg)) return arg;
    throw new Error(`File not found: ${arg}`);
  }
  const dirs = [path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Desktop'), process.cwd()];
  const found = dirs.flatMap((d) => { try { return fs.readdirSync(d).filter((f) => f.toLowerCase().endsWith('.zpbak')).map((f) => path.join(d, f)); } catch { return []; } });
  if (!found.length) throw new Error('No .zpbak file found in Downloads or Desktop. Save the backup from your email first, or give its path.');
  return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

// Asks for the password without showing it.
function askPassword() {
  if (process.env.BACKUP_PASSWORD) return Promise.resolve(process.env.BACKUP_PASSWORD);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write('Backup password (nothing shows while you type): ');
    let pw = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(pw);
        }
        if (c === '\u0003') process.exit(1); // Ctrl+C
        if (c === '\u0008' || c === '\u007f') pw = pw.slice(0, -1);
        else pw += c;
      }
    };
    stdin.on('data', onData);
  });
}

(async () => {
  const check = process.argv.includes('--check');
  const force = process.argv.includes('--force');
  const file = findBackup(process.argv.slice(2).find((a) => !a.startsWith('--')));
  console.log(`Backup file: ${file}`);
  const password = await askPassword();
  const snap = backup.decrypt(fs.readFileSync(file), password);
  console.log(`✔ Opened. Backup from ${snap.at}: ${snap.counts.Customer || 0} customers, ${Object.values(snap.counts).reduce((s, n) => s + n, 0)} records in ${Object.keys(snap.counts).length} tables.`);
  if (check) return;
  const { PrismaClient, Prisma } = require('@prisma/client');
  const db = new PrismaClient();
  const existing = await db.customer.count();
  if (existing && !force) throw new Error(`This database already has ${existing} customers. Restore into an empty database, or add --force (existing rows are kept; only missing ones are added).`);
  const counts = await backup.restore(db, snap, { DbNull: Prisma.DbNull, log: (l) => console.log('  ' + l) });
  console.log(`Done: ${Object.values(counts).reduce((s, n) => s + n, 0)} records restored.`);
  await db.$disconnect();
})().catch((e) => {
  console.error('Restore failed:', e.message);
  process.exit(1);
});
