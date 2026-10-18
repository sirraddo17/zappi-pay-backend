#!/usr/bin/env node
// Restore a ZAPPI PAY backup (.zpbak) into a database.
//
//   1. Point DATABASE_URL at the database to restore INTO (best: a new,
//      empty Neon branch/database) and create the tables:
//        npx prisma db push
//   2. Run (PowerShell):
//        $env:BACKUP_PASSWORD="your backup password"; node ops/restore-backup.js C:\path\zappipay-backup-2026-10-18.zpbak
//      Add --check to only open the file and list what's inside.
//      Add --force to restore into a database that already has customers.
const fs = require('fs');
const backup = require('../lib/backup');

(async () => {
  const file = process.argv.find((a) => a.endsWith('.zpbak'));
  const check = process.argv.includes('--check');
  const force = process.argv.includes('--force');
  if (!file) throw new Error('Give the path to the .zpbak file.');
  if (!process.env.BACKUP_PASSWORD) throw new Error('Set BACKUP_PASSWORD to the backup password first.');
  const snap = backup.decrypt(fs.readFileSync(file), process.env.BACKUP_PASSWORD);
  console.log(`Backup from ${snap.at}: ${snap.counts.Customer || 0} customers, ${Object.values(snap.counts).reduce((s, n) => s + n, 0)} records in ${Object.keys(snap.counts).length} tables.`);
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
