<!-- Owner's runbook: servers, database, hosting, domains, email and partner dashboards. Used by the admin AI assistant (lib/opsGuide.js, tool get_ops_guide) to walk the owner through setup and fixes step by step. Owner only. Keep it in step with how the app is hosted. -->
# ZAPPI PAY Owner's Runbook

## Golden rules

- **Secrets never go in chat.** API keys, passwords, OTPs, PINs, the database URL and webhook signature keys are typed or pasted only into the place they belong (a partner dashboard, Admin → Settings, or the server settings file `.env`). Not into the AI chat, WhatsApp or email. If a screenshot shows one, crop it out — and if one was shared by mistake, rotate it (make a new one and replace the old).
- **Know which window you are in.** "PowerShell" = your Windows computer (C:\Users\user\…). "VPS" = the server, after `ssh root@107.173.6.63` (the prompt shows `root@racknerd-…`). Commands for one don't work in the other.
- **Paste each command once, as one line.** Two commands pasted together run into each other (e.g. `.envcd`). If a command breaks across two lines, paste it again as one.
- **Logging in again starts you in the home folder (`~`).** Go to the app first: `cd /opt/zappi-pay-backend`.
- **Download a backup before big changes** (moving servers, database changes): Admin → Settings → 💾 Backups → Download a backup.
- Nobody (not the AI, not support) needs your keys to help you. Anyone who asks is not genuine.

## Where everything lives

| Part | Where | Notes |
| --- | --- | --- |
| Customer app | Vercel project zappi-pay-frontend → www.zappipay.com.ng | Builds automatically on every push to GitHub |
| Admin app | admin.zappipay.com.ng (same Vercel project) | |
| Backend (API) | RackNerd VPS 107.173.6.63, folder /opt/zappi-pay-backend, run by pm2 as `zappi-pay-api`, port 4000 | nginx + certbot serve https://api.zappipay.com.ng |
| Database | Neon project zappi-pay (AWS US East 2) | Free plan: 100 compute-hours and 0.5 GB per month |
| Code | GitHub sirraddo17/zappi-pay-backend and sirraddo17/zappi-pay-frontend; local copies C:\Users\user\zappi-pay-backend and \zappi-pay-frontend | |
| Domain / DNS | Whogohost (zappipay.com.ng) | `api` A record → 107.173.6.63 |
| Uptime check | cron-job.org "ZappiPay uptime check" → https://api.zappipay.com.ng/api/health | Emails on failure, recovery, TLS expiry |
| Email sending | Resend (domain zappipay.com.ng) | Password resets, alerts, backups |
| support@ forwarding | ImprovMX → sirraddoventures@gmail.com | |
| Old backend | Render (suspended, fallback only) | Delete after about a week of the VPS running well |

## Pushing an update (code from Claude)

1. Download the zip to **Downloads**.
2. In **PowerShell**:
```
cd $HOME\Downloads
Expand-Archive NAME.zip -DestinationPath zp-NAME -Force
Copy-Item zp-NAME\zappi-pay-backend\* $HOME\zappi-pay-backend -Recurse -Force
Copy-Item zp-NAME\zappi-pay-frontend\* $HOME\zappi-pay-frontend -Recurse -Force
```
(Skip a Copy-Item line if the zip has no folder for that repo.)
3. Only if the update changed the database (it will say so):
```
cd $HOME\zappi-pay-backend
for ($i=1; $i -le 3; $i++) { npx prisma db push; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 5 }
```
If it asks about data loss, answer **no** and ask for help.
4. Push:
```
cd $HOME\zappi-pay-backend; git add .; git commit -m "short note"; git push
cd $HOME\zappi-pay-frontend; git add src; git commit -m "short note"; git push
```
"LF will be replaced by CRLF" warnings are harmless.
5. Update the server — **VPS**:
```
ssh root@107.173.6.63
cd /opt/zappi-pay-backend && git pull && npm ci && npx prisma generate && pm2 restart zappi-pay-api && sleep 5 && curl -s https://api.zappipay.com.ng/api/health
```
Good result ends with `{"ok":true,"service":"zappi-pay-backend"}`. Ignore "npm audit fix --force" (don't run it) and Prisma's "update available" (don't upgrade). Type `exit` to leave the VPS.
6. The frontend updates by itself on Vercel in 1–3 minutes. Reload the app (twice if it still looks old — the app caches itself).

## VPS basics

- Log in: `ssh root@107.173.6.63` (password typing shows nothing — normal).
- Is the API running? `pm2 status` → `zappi-pay-api` should be **online**. The ↺ number counts restarts since setup; if it climbs on its own, check the logs.
- Recent errors: `pm2 logs zappi-pay-api --lines 50` (press Ctrl+C to stop watching). Send a screenshot of the error lines — crop anything that looks like a key or password.
- Restart: `pm2 restart zappi-pay-api` (add `--update-env` after changing `.env`).
- Health: `curl -s https://api.zappipay.com.ng/api/health`
- Disk / memory: `df -h /` and `free -h`.
- Web server: `nginx -t && systemctl reload nginx` (test, then reload). SSL renew test: `certbot renew --dry-run` (certbot renews by itself).
- pm2 starts the API automatically after a reboot (pm2 startup + save are set up). After adding a new app: `pm2 save`.
- Ubuntu "new release available": don't upgrade the operating system without a backup and a plan.

## Server settings (.env)

The file `/opt/zappi-pay-backend/.env` holds the server's secret settings (database URL, partner keys, Neon key…). Never share it or print it.

1. **VPS**: `cd /opt/zappi-pay-backend && nano .env`
2. Move with the arrow keys. Each line is `NAME=value` — `=` with no spaces around it, no quotes.
3. Paste with a right-click. Save: **Ctrl+O**, **Enter**. Exit: **Ctrl+X**.
4. Apply: `pm2 restart zappi-pay-api --update-env`
5. Check a line without showing the value (replace NAME):
```
cd /opt/zappi-pay-backend; awk '/^NAME=/{v=substr($0,index($0,"=")+1); print "length:", length(v), "| has space/quote:", (v ~ /[ "\047]/ ? "YES" : "no")}' .env
```
Nothing printed = the line is missing.
- Keys from partners that live in Admin → Settings (VTpass, Monnify, Squad, Nomba live keys, AI keys) are entered there, not in `.env`.
- After changing the database password in Neon: update `DATABASE_URL` in the VPS `.env` (and your local C:\Users\user\zappi-pay-backend\.env), then restart with `--update-env`.

## Neon database

- **Plan**: Free = 100 compute-hours (CU-hrs) and 0.5 GB storage per project per month. If a project reaches the limit, Neon pauses it until the month resets — the app stops working. The Neon console shows a yellow "nearing free plan limit" bar at 80%.
- **Check usage**: Neon console → Projects (Compute, Storage, History, Network transfer for the month) and Admin → 🗄️ Database (health, size, connections, speed).
- **Upgrade to Launch** (pay for what you use, no monthly minimum; about $0.106 per compute-hour and $0.35 per GB-month — check the Billing page for current prices): Neon console → **Upgrade** (top right) → Launch → the owner enters the card details himself. Then update `.env`: `NEON_STORAGE_LIMIT_GB` / `NEON_COMPUTE_LIMIT_HOURS` to your own warning levels (e.g. 10 and 300) and add `NEON_PRICE_CU_HOUR=0.106` and `NEON_PRICE_GB_MONTH=0.35` for the bill estimate; restart with `--update-env`.
- **On Free**, set `NEON_STORAGE_LIMIT_GB=0.5` and `NEON_COMPUTE_LIMIT_HOURS=100` (no price lines).
- **Saving compute**: the database sleeps after 5 minutes with no queries; background jobs are spaced out when nobody uses the app. Keep-awake pings that touch the database waste hours — the uptime check uses /api/health, which doesn't.
- **API key (for Neon figures in Admin → Database)**: profile → Account settings → Personal API keys → Create new API key → put it in `.env` as `NEON_API_KEY=…` and the project ID (Project → Settings, looks like `fancy-shape-21833872`) as `NEON_PROJECT_ID=…`, then restart with `--update-env`. Known issue: Neon's Cloudflare firewall blocks API calls from the VPS IP (HTTP 403 challenge page) — the key is fine; usage is read on the Neon console until Neon allows the IP. Support tickets come with paid plans (Free plan: community Discord only).
- **Database password**: Neon → project → Roles → reset password → update `DATABASE_URL` everywhere (VPS `.env`, local `.env`). Never paste it in chat.
- **Restore**: Neon keeps history (point-in-time restore on Branches → Restore) within the plan's window; nightly emailed backups (.zpbak) are the second copy — restore with ops/restore-backup.js (docs/BACKUP.md).

## Vercel (frontend)

- Each GitHub push builds a new deployment. Vercel → zappi-pay-frontend → **Deployments**: the top one should be **Ready**.
- "Production deployment failed" email: open the deployment → **Build Logs** → the red error near the bottom; send a screenshot. Old emails are about old commits — check the top deployment first.
- Settings → **Environment Variables**: `VITE_API_URL=https://api.zappipay.com.ng` — type **Config**, not Secret (VITE_ values are public; Vercel won't save them as Secret). After changing a variable: Deployments → top one → ⋯ → **Redeploy**.
- Domains: www.zappipay.com.ng and admin.zappipay.com.ng point at this project.
- App still looks old after a deploy: reload twice (the app caches itself), or close and reopen it.

## Domain and DNS (Whogohost)

- Whogohost → Domains → zappipay.com.ng → **Manage DNS**.
- `api` → A record → `107.173.6.63` (TTL 300). The website and admin records point to Vercel (leave them).
- Email records (Resend sending, ImprovMX forwarding: MX/TXT/CNAME) — don't delete them.
- DNS changes take minutes to a few hours. Check: `nslookup api.zappipay.com.ng` in PowerShell.

## Uptime and alerts

- cron-job.org → "ZappiPay uptime check" calls https://api.zappipay.com.ng/api/health and emails on failure, recovery and TLS (certificate) expiry.
- The app itself emails/pushes the owner for: errors (see `pm2 logs`), database problems (Admin → 🗄️ Database), overdue funding requests, paused partners, low balances, failed backups.
- If the uptime check fails: VPS → `pm2 status` → `pm2 logs zappi-pay-api --lines 50` → `pm2 restart zappi-pay-api`; if pm2 is fine, `systemctl status nginx`; if the server doesn't answer at all, RackNerd → SolusVM control panel → check it's running / reboot.

## Email (Resend and ImprovMX)

- Resend sends from zappipay.com.ng (password resets, alerts, backups). Its key is `RESEND_API_KEY` in `.env`; sender `EMAIL_FROM`.
- Emails not arriving: Resend → Logs (bounced? domain unverified?) → Domains (all records green). Ask the person to check spam.
- support@zappipay.com.ng forwards to sirraddoventures@gmail.com through ImprovMX.

## Partner dashboards (webhooks, IPs, keys)

Server IP for every whitelist: **107.173.6.63**. Webhook base: **https://api.zappipay.com.ng/api/webhooks/**.

| Partner | Webhook URL | Notes |
| --- | --- | --- |
| VTpass | …/webhooks/vtpass | IP whitelisted (approved). Error 027 = IP not whitelisted. Keys in Admin → Settings → VTpass |
| Monnify | …/webhooks/monnify | Events: transaction completion + disbursement. Sandbox now; set the live webhook when live keys arrive |
| Squad | …/webhooks/squad | IP whitelisting via Squad support |
| Nomba | …/webhooks/nomba | Events: payment_success, payout_success, payout_failed, payout_refund. IP whitelisted 21 Oct 2026. Live webhook needs its own signature key — the same key goes in Admin → Settings → Nomba. Technical details by email (docs@nomba.com), not WhatsApp |
| Flutterwave | …/webhooks/flutterwave | Set the webhook and whitelist the IP |

- Live keys: copy from the partner dashboard and paste into Admin → Settings → that partner (you type them; never into chat). Then Admin → 🚦 Go-live check.
- Test a partner after going live with a small real amount to your own account first (e.g. ₦100).
- StoreWatch connects to ZAPPI PAY with `ZAPPIPAY_API_URL=https://api.zappipay.com.ng/api` in StoreWatch's own hosting settings (a 503 "ZAPPI PAY isn't answering" there means it still points at the old Render address).

## When something is wrong

| Symptom | First check | Fix |
| --- | --- | --- |
| App says "can't reach server" | Uptime email, `curl -s https://api.zappipay.com.ng/api/health` | VPS: `pm2 status`, `pm2 logs zappi-pay-api --lines 50`, `pm2 restart zappi-pay-api` |
| Everything slow / login fails | Admin → 🗄️ Database; Neon console (limit reached?) | Upgrade Neon if the free limit is hit; wait for wake-up if just slow |
| VTpass purchases fail with 027 | VTpass dashboard → API settings → whitelisted IP | Add 107.173.6.63 and ask VTpass to approve |
| Deposits not credited | Admin → Pending Funding / Unmatched payments; the partner's webhook page | Correct webhook URL, partner on live mode, `pm2 logs` for webhook errors |
| Frontend build failed | Vercel → Deployments → Build Logs | Send the error; usually a one-line code fix |
| `git push` rejected | The message in PowerShell | `git pull` first, then push again (ask for help if it mentions conflicts) |
| ssh "connection refused/timed out" | RackNerd control panel | Server running? Reboot from the panel |
