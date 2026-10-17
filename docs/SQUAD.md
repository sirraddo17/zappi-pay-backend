# Squad — GTBank account numbers for wallet funding

Code: `lib/squad.js`, `routes/squad.routes.js`, `routes/bankfunding.routes.js` (customer + webhook).

## What it does
- Each customer can get a personal **GTBank** account number (Squad static virtual account).
- Money sent to it is added to their wallet automatically (same bank processing fee setting as Monnify).
- Customers who already have Monnify numbers see **"Add a GTBank account number"**. With
  *Make it the main option* on, new customers get GTBank instead of Monnify.
- Squad needs the **BVN** (not NIN), date of birth, gender, home address and the phone linked to the BVN,
  and checks name + date of birth + phone strictly.

## Money safety
- Webhook `POST /api/webhooks/squad` must carry `x-squad-signature` = HMAC-SHA512(secret key, body).
- Amount cross-checked with Squad's API when it answers; a mismatch is NOT credited (owner alerted).
- `WalletTransaction.providerRef = "SQ-<transaction_reference>"` is unique → never credited twice.
- Frozen payments (`meta.freeze_transaction_ref`) are never credited — owner alerted.
- Missed webhooks: Squad's webhook error log is re-checked every 10 min (and "Check now" in admin);
  customers can tap "I've sent money — check now".

## Setup (owner)
1. Squad sandbox dashboard → Profile/Settings → API & Webhook: copy the **sandbox secret key**.
2. Admin → Settings → Wallet funding → Squad: paste the key, keep **Sandbox**, Test connection.
3. Set the webhook URL shown there in Squad's dashboard.
4. Turn on *GTBank account numbers*. Create a test account from a test customer, then use
   *Send a test payment (sandbox)* and check the wallet.
5. After UAT with Squad: switch to the **live** key and mode Live. Optional: add the company GTBank
   account as settlement account (instant settlement instead of T+1).

Env fallback (if no key saved in admin): `SQUAD_SECRET_KEY`, `SQUAD_MODE`.

## Send to Bank through Squad (Transfer API)
- Admin → Settings → Wallet funding → Squad → **Send to Bank through: Monnify / Squad** (needs key + merchant ID).
- References are `<MERCHANTID>_ZPT-…`, amounts in kobo, bank codes are Squad's NIP codes (`lib/squadBanks.js`).
  Old saved codes from Monnify's list are translated (code table, then bank name).
- Same money rules as Monnify: wallet debited first; only a clear refusal refunds at once; timeouts (424) and
  network errors stay PROCESSING until `/payout/requery` says success / failed / reversed; never refunded twice.
- Each BankTransfer stores `provider`, so old Monnify transfers are still checked with Monnify after switching.
- No OTP with Squad. A transfer unclear for 6+ hours alerts the owner.
- Funds guard counts Monnify + Squad wallets for customer money; the free balance is checked on the paying partner.

## Automatic backup (Monnify ⇄ Squad)
- Setting `payoutFallback` (default on; Admin → Squad → "Use the other partner as automatic backup").
- Switches only when no money left: wallet too low on the main partner (checked before charging), main partner's
  account check failed, or main partner clearly refused the transfer (4xx). Timeouts / 5xx never switch.
- One switch per transfer (no bouncing back). Owner alerted (at most hourly per reason).
- References carry the Squad merchant ID whenever it's saved, so a transfer keeps its reference when moved.

## Waiting on Squad
Whether collections can stay in the Squad balance for payouts (vs automatic T+1 settlement to GTBank) and the
Transfer API limits. Until then keep Monnify as the payout partner in live.
