# Nomba — account numbers + Send to Bank

Code: `lib/nomba.js`, `routes/nomba.routes.js` (admin + payment partners), `routes/bankfunding.routes.js`
(customer + `POST /api/webhooks/nomba`), `lib/disbursement.js` (payouts / backup).

## Setup (owner)
1. Nomba dashboard → Developer → API keys (sandbox): client ID, client secret, parent **account ID**.
2. Developer → Webhook Setup: URL `https://<backend>/api/webhooks/nomba`, subscribe to payment_success,
   payout_success, payout_failed, payout_refund; copy the **signature key**.
3. Admin → Settings → Wallet funding & payment partners → Nomba: paste all four, Sandbox, Test connection.
4. Turn on Nomba account numbers. In "Payment partners" choose who gives new customers account numbers and who
   sends Send to Bank. Env fallback: NOMBA_CLIENT_ID, NOMBA_CLIENT_SECRET, NOMBA_ACCOUNT_ID, NOMBA_WEBHOOK_KEY, NOMBA_MODE.

## Money safety
- Webhook signature: HMAC-SHA256(signature key,
  `event_type:requestId:userId:walletId:transactionId:type:time:responseCode:nomba-timestamp`) → base64.
- Inflows cross-checked with `GET /v1/transactions/accounts/single?transactionRef=…` (status SUCCESS, same amount).
- `providerRef = NB-<sessionId or transactionId>` (unique) → never credited twice (webhook + "check now").
- Transfers: refund only on Nomba `REFUND` (their rule), or no record at all after 10 minutes. 201 / PENDING_BILLING /
  "duplicate reference" / 5xx stay PROCESSING. Clear refusals (400/401/403/429) → backup partner, else refund.
- Sandbox test accounts: 0000000201 pending→success, 0000000202 pending→refund, 0000000451 insufficient balance.

## To confirm with Nomba
Amount unit is assumed to be naira (all their examples). Whether customer BVN/NIN is required in live.

## Bet funding (Bill Payments API)

`lib/nombaBetting.js` — used when Settings → "🖨️ ClubKonnect & Bet Funding" → *Bet Funding goes through* = **Nomba**.

- Companies: `GET /v1/bill/betting/providers` (cached 6 h), shown to the app as serviceID `nb:<id>` (e.g. `nb:bet9ja`).
- Name check: `GET /v1/bill/betting/lookup?providerId=&customerId=` → `data` is the account name.
- Pay: `POST /v2/bill/betting` `{ bettingProvider, merchantTxRef (= order request ID), phoneNumber, payerName, amount, customerId }`. Paid from the parent (Nomba) wallet.
- Outcome: 200 `SUCCESS` → delivered. 201 `PENDING_BILLING`, no answer or 5xx → pending (re-checked 20 s / 2 min / 10 min, then every 15 min). 400/401/403/404/429 → refused before money moved → refund (owner alerted on 401/403/low balance).
- Re-check: `GET /v1/transactions/accounts/single?merchantTxRef=`. `REFUND` / `CANCELLED` → refund. `SUCCESS` → delivered. Not found after 30 min → refund. Anything else stays pending.
- Needs Nomba **Bill Payments API** access approved for live.
