# ZAPPI PAY — Connected apps API (for StoreWatch)

A connected app (e.g. StoreWatch) can **ask** ZAPPI PAY to pay a list of bank
accounts from the owner's wallet. **Nothing is paid until the owner approves the
request in ZAPPI PAY with their PIN.** The app key can only create requests and
read their status.

Base URL: `https://<zappi-pay-backend>/api` (the Render backend URL)

## 1. Connect

In ZAPPI PAY: **More → Connected apps → Connect an app** (needs PIN). Copy:

- **API key** `zpk_live_…`, stored in StoreWatch backend env as `ZAPPIPAY_API_KEY`
- **Signing secret** `whsec_…`, stored as `ZAPPIPAY_SIGNING_SECRET`
- Optional callback URL, e.g. `https://<storewatch-backend>/api/zappipay/webhook`

Keep both on the **server only**. Never send them to the browser.

Check the key: `GET /api/connect/ping` with `Authorization: Bearer <key>` returns `{ ok: true, app: "StoreWatch" }`.

Banks and name check (for saving supplier details):
`GET /api/connect/banks` → `{ banks: [{ code, name }] }` · `GET /api/connect/account-lookup?bankCode=058&accountNumber=0123456789` → `{ accountNumber, accountName }`

## 2. Create a payment request

`POST /api/connect/payout-requests`

```json
{
  "reference": "sw-IDIAPE-2026-10-11_13",
  "title": "Supplier payment · 11–13 Oct",
  "returnUrl": "https://<storewatch-frontend>/credit-purchase",
  "callbackUrl": "https://<storewatch-backend>/api/zappipay/webhook",
  "items": [
    {
      "label": "IDI APE · 11–13 Oct (3 days)",
      "bankCode": "058",
      "accountNumber": "0123456789",
      "accountName": "Okon Lubricants",
      "amount": 86013,
      "narration": "IDI APE 11-13 Oct supplies",
      "meta": { "branchId": "b1", "from": "2026-10-11", "to": "2026-10-13" }
    }
  ]
}
```

- `reference`: unique per request (4–80 chars: letters, numbers, `. _ : -`). Sending the same reference again returns the **same** request, so retries can't double-pay.
- `items`: 1–30 payments. One per branch, or one per branch per supplier.
- `accountName`: the name StoreWatch has saved. If the bank's name doesn't match, ZAPPI PAY warns the owner on the approval screen.
- `narration`: up to 60 characters, shown on the supplier's bank statement.
- Normal Send to Bank min/max per transfer apply. Each item's fee is added on top.

Response `201`: `{ request: { id, status: "AWAITING_APPROVAL", approveUrl, total, fees, totalWithFees, items:[…] } }`

The owner gets a ZAPPI PAY notification. StoreWatch should also show a **"Approve in ZAPPI PAY"** button that opens `approveUrl`. Requests expire after **72 hours**, so a weekend batch can still be approved on Monday.

## 3. Status and receipts

`GET /api/connect/payout-requests/:idOrReference`

`status`: `AWAITING_APPROVAL` · `PROCESSING` · `DONE` · `PARTIAL` · `FAILED` · `DECLINED` · `EXPIRED`

Each item has `payment: { status, reference, error, completedAt, receiptUrl }`, where item status is `SUCCESS` · `PROCESSING` · `UNDER_REVIEW` · `FAILED` · `REVERSED` · `NOT_SENT`. Transfers that are still `PROCESSING` turn into `SUCCESS` (or are refunded) when the bank confirms, so poll this endpoint to refresh. `receiptUrl` opens the ZAPPI PAY receipt (the owner must be logged in).

## 4. Callback (webhook)

After approve or decline, ZAPPI PAY POSTs `{ event: "payout_request.updated", data: <request> }` to the callback URL (up to 3 tries). Verify it:

```js
const sig = crypto.createHmac('sha256', process.env.ZAPPIPAY_SIGNING_SECRET).update(req.rawBody).digest('hex');
if (sig !== req.headers['x-zappipay-signature']) return res.status(401).end();
```

Use the raw request bytes, not re-stringified JSON. Reply 2xx.

## 5. StoreWatch side (to build)

- Settings: ZAPPI PAY connection status, plus suppliers' bank details (bank, account number, name) per supplier/branch.
- Credit Purchase Margin → **Pay supplier**: choose a date range (e.g. Fri–Sun together on Monday) and branches (one or all). It shows "amount owed" per branch, with a narration per branch, then **Send to ZAPPI PAY for approval** and opens `approveUrl`.
- Store `reference → request id`. Mark those days/branches **Paid** only when the item's status is `SUCCESS`, and keep the receipt link. Never mark the same day/branch twice: the reference should include the branch and date range.
