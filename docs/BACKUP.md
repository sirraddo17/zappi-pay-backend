# Database backups

`lib/backup.js` makes a full copy of every table (all 98 models), compresses it, locks it with
AES-256-GCM using the `BACKUP_PASSWORD` environment variable, and emails it every night (~2am
Lagos) to up to 3 addresses set in **Admin → Settings → 💾 Backups**. If the server was asleep at
2am it catches up when it wakes (any time a backup is over a day old). The owner can also
**Send a backup now** or **Download a backup** there. The Go-live check shows when the last one went out.

The password is **never stored in the app or the database**. Keep it somewhere safe (e.g. a
password manager). Without it, a backup can't be opened, and that's intentional.

## Set up (once)

1. Render → backend → **Environment** → add `BACKUP_PASSWORD` (12+ characters). Save, then redeploy.
2. Admin → Settings → 💾 Backups → add 1–3 emails → **Save emails** → **Send a backup now**.
3. Check the email arrived with a `zappipay-backup-YYYY-MM-DD.zpbak` attachment.

## Restore

Restore into a **new, empty** database (a new Neon branch is easiest). Never restore over the
live database unless you're sure.

```powershell
cd C:\Users\user\zappi-pay-backend
# 1. Point at the database to restore INTO, and create the tables
$env:DATABASE_URL="postgresql://...new database..."
npx prisma db push
# 2. Check the file opens (lists what's inside, changes nothing)
$env:BACKUP_PASSWORD="your backup password"
node ops/restore-backup.js C:\Users\user\Downloads\zappipay-backup-2026-10-18.zpbak --check
# 3. Restore
node ops/restore-backup.js C:\Users\user\Downloads\zappipay-backup-2026-10-18.zpbak
```

Then point Render's `DATABASE_URL` at the restored database.

`--force` restores into a database that already has customers. Existing rows are kept, and only
missing ones are added.

**Test a restore once** (into a throwaway Neon branch) so you know it works before you need it.
