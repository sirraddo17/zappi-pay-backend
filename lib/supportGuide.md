<!-- Source: the ZAPPI PAY Support Guide doc. Shown in Admin → 📘 Support guide and used by the admin AI assistant (lib/supportGuide.js). Keep it in step with features. -->
# ZAPPI PAY Support Guide

## Before you help anyone

Confirm who you are talking to, check what the app already shows, and never move money without a record. Every action in admin is saved in the Audit Log with your name.

**1. Confirm it is really them.** Open the customer (Admin → Customers → tap the name) and use **Check it's really them** at the top. Ask for their date of birth or security answer. You get 5 tries every 15 minutes. Do this before any reset, contact change, unfreeze or money fix.

**2. Look before you act.** The customer page shows their wallet history, orders, ID checks, account numbers and any freeze reason. Most questions are answered there.

**3. Know who can do what.**

| Action | Support staff | Owner |
| --- | --- | --- |
| View customers, orders, transfers, unmatched payments | Yes | Yes |
| Reply to and resolve support tickets | Yes | Yes |
| Check funding, re-check an order or transfer | Yes | Yes |
| Freeze an account (safety) | Yes | Yes |
| Unfreeze, reset PIN/password, change contact | Request approval | Yes |
| Credit or debit a wallet, refunds, payouts, chargebacks | Request approval | Yes |
| Credit or close an unmatched payment | Request approval | Yes |

Staff use **Request admin approval** on the customer's page; the owner approves it in Admin → ✅ Approvals.

**4. Money rules.**

- Never credit a wallet because a customer says so. Use **Check funding** first; it asks Monnify, Squad and Nomba directly and only credits what they confirm, never twice.
- Never promise a refund for a delivered order until VTpass (or the betting partner) confirms it failed.
- Ask for a bank receipt (amount, date, reference) for any missing deposit.
- Never ask for or accept a customer's PIN, password or full card number. ZAPPI PAY staff never need them.
- The AI assistant can draft replies and find screens, but cannot move money, freeze accounts or close payments.

## Account problems

Most account fixes are one button in **Account tools** on the customer's page (owner), after you confirm who they are. Staff send the same fixes through Request admin approval.

| Customer says | What to do | Where |
| --- | --- | --- |
| "I lost my phone" / "someone is using my account" | Freeze it now (no identity check needed to freeze). Then Remove devices. Unfreeze only after confirming who they are. | Customers → Freeze; Account tools → Remove devices |
| "My account is paused / frozen" | Read the freeze reason on their page. Confirm identity, fix the cause, then Reactivate. | Customer page (red box); Customers → Reactivate |
| "I forgot my PIN" / "PIN locked" | Reset PIN (they set a new one) or Unlock PIN after 5 wrong tries. | Account tools |
| "I can't log in, locked out" | Unlock login (locks after 5 wrong passwords for 15 minutes). | Account tools |
| "I forgot my password and can't get the email" | Reset password: gives a 24-hour temporary password they must change. Send it privately; it also signs out old sessions. | Customer page → Reset password |
| "I changed my SIM / email" | Change contact. It blocks numbers or emails already used by another account and tells the customer. | Account tools → New phone number or email |
| "BVN/NIN check says I've used all my tries" | They get 3 counted tries a day (only name/date mismatches count). After checking their details are right, give fresh tries. | Account tools → Give fresh tries |

**Freezing, in detail.** When anyone taps **Freeze**, the app asks for a reason (only staff see it) and signs the customer out on every device within 30 seconds. They can't log in, spend or receive. They see: "This account is paused for a safety check. Contact ZAPPI PAY support — your money is safe." If the customer froze it themselves from their security page, the red box on their page says so. Only an owner can unfreeze.

**Name or BVN mismatch.** If the name on their BVN/NIN is spelt differently (married name, initials), ask them to update their profile name to match exactly, then give fresh tries. If the name in the app itself is wrong, the owner corrects it in 🧰 Support tools → Correct their name.

## Funding problems

Almost every "I sent money but it didn't show" is solved by **Funding not showing? Check with the bank partners** on the customer's page. It asks Monnify, Squad and Nomba directly and credits only what they confirm, never twice.

**Money sent to their account number but not in the wallet**

1. Ask for the bank receipt: amount, date and time, reference (session ID).
2. Open their page and run **Funding not showing?** Paste the reference if they have it.
3. If it credits, tell them. If nothing is found, check the account number on the receipt matches one on their page.
4. Bank transfers can take up to an hour on busy days. If the partner still has no record after that, ask the customer to contact their bank with the session ID.

**Money sent to an old, removed or deleted account number.** These are never lost or credited to the wrong person. They wait in **Admin → 💸 Unmatched payments**, with the amount, sender's name, account number and who that number used to belong to. The owner is alerted when one arrives.

- Match it to the customer's receipt (amount, time, sender name).
- Owner: **Credit a customer**, search them, choose whether to take the normal funding fee, add a note on how you confirmed it.
- If the number belonged to a deleted account, or you can't find the owner: send the money back to the payer from your bank or partner dashboard, then tap **I sent it back** and enter the reference.
- Sandbox test money: **Ignore (test)**.

**Card payments (Flutterwave).** Open the customer → **💳 Money tools → Card payments**.

- "My card was charged but the wallet didn't go up": tap **Check again**. It credits only if Flutterwave confirms the payment succeeded, including payments the app gave up on after 24 hours.
- "Flutterwave says the card owner disputed it" (often a stolen card): tap **Chargeback** and enter Flutterwave's reference. The app takes back what is left of that money in the wallet, freezes the account and signs it out, and shows how much was already spent. Collect that before unfreezing.

**Manual funding.** Customers who pay into your business account appear in **Pending Funding**. Approve only after you see the money in your bank. Each request shows how long it has waited (green, then amber at 15 min, red at 30). Approve credits the wallet straight away; to reject, type the reason the customer will see. A customer can only have one request waiting, and a reference can't be used twice — if they say they sent money twice, approve the first, then ask them to submit the second after. Overdue requests send you reminders and tell the customer support is on it; nothing is rejected automatically.

## Purchase problems

Orders are handled in **Admin → Orders**. A failed order is refunded to the wallet automatically; a pending one is re-checked in the background, and you are alerted if it is still pending after 15 minutes.

| Customer says | What to do |
| --- | --- |
| "It's still pending" | Tap **Check now** on the order. If VTpass still can't confirm after a while, the owner chooses **Delivered** or **Failed + refund** (after checking with VTpass support). |
| "It says successful but I didn't get it" (airtime, data, TV) | Ask them to wait 10 minutes and check their balance or decoder (TV: switch the decoder off and on, on the channel). Still nothing: open **Details → Ask VTpass now** to see what VTpass says, then **Report to VTpass** on the order. Refund only after VTpass confirms it wasn't delivered. Staff: **Ask admin to refund** once VTpass replies. |
| "Where is my light token?" | Tell them to open the order in their history: the token is there with Copy, Download and Share. You can also read it to them from Orders → Details. |
| "I lost my WAEC/JAMB PIN" | They can see it again under More → Exam PINs, or in the order. |
| "I bought for the wrong number / meter / decoder" | A delivered purchase can't be reversed by VTpass. Be kind and clear: the money went to that number. For airtime sent to a wrong number, they can ask the person to return it, or use Airtime to Cash if it's theirs. |
| "I was charged twice" | Check Orders for two SUCCESS orders for the same number and amount. If both delivered, both were real purchases. If one failed it was already refunded. Unsure: ask the owner. |
| "Bet funding didn't reach my betting account" | Open **Details → Ask Nomba now** (or ClubKonnect). Bet funding doesn't go through VTpass, so there's no Report to VTpass; raise it with that partner quoting the reference shown. |
| "My promo code didn't work" | Check the code in Admin → Promo Codes (active, dates, uses left). If it should have worked, the owner can credit the discount. |

**Never refund a SUCCESS order on the customer's word.** The app blocks it until the order is reported and confirmed, because VTpass may have delivered it.

**Scheduled top-ups and other requests.** On the customer's page, **🧰 Support tools** shows each scheduled top-up with its next run, failed runs and last error. Anyone can **Pause** one that keeps failing; the owner can **Resume** or **Delete**. A complaint that came by WhatsApp, email or phone goes in as a ticket with **Log a complaint as a ticket**, so it's tracked in Support. The owner can also set a **daily spending limit** for one customer (for example a verified agent) and **give a reward that didn't arrive** (cashback, referral bonus or loyalty points), each with a reason.

## Withdrawals and transfers

Send to Bank transfers live in **Admin → Bank Transfers**. The wallet is debited first; a transfer that clearly fails or is reversed is refunded automatically, and a timeout stays processing until the partner confirms, so nothing is paid twice.

| Customer says | What to do | Where |
| --- | --- | --- |
| "My transfer is still processing" | Tap **Check** on the transfer. Banks can take a few hours on busy days. | Bank Transfers |
| "My transfer is held" | Held transfers are waiting for an OTP or a safety review (big amount, new device). Owner: confirm it's them, then **Release** or **Cancel** (refunds). | Bank Transfers → Held |
| "Bank transfers are paused" | The funds guard paused all transfers because a partner wallet holds less than customers are owed. Their money is safe. Owner tops up the partner wallet; transfers resume. | Money check |
| "I sent to the wrong bank account" | Open a wrong-transfer case and request a recall from the partner. Record what was recovered. Recalls are not guaranteed. | ↩️ Wrong transfers |
| "I sent to the wrong ZAPPI PAY user" | The customer reports it in the app, which holds the money in the receiver's wallet for 14 days. The owner decides in Wrong transfers. | ↩️ Wrong transfers |
| "I sent airtime for Airtime to Cash but wasn't paid" | Check the request. Approve with the amount actually received, or reject with a reason. | Airtime to Cash |

**Paying a customer out by hand.** Use this when Send to Bank is off, or to empty an account before closing it. Owner only.

1. Confirm the customer's bank, account number and account name (the name must match theirs).
2. Send the money yourself from your bank app or partner dashboard. Copy the session ID or reference.
3. Open their page → **💳 Money tools → Record a manual payout** and enter the amount, bank, account number, name and reference.
4. It comes off their wallet with the details, and they get a notification. The same reference can't be recorded twice.

**Closing an account (customer asked to delete it).** Requests show in Admin → Customers. The wallet and savings must be empty first; use a manual payout for any balance. Deleting removes their details and all their account numbers (Monnify, Squad, Nomba). Any payment that still arrives on those numbers lands in Unmatched payments for you to send back.

## Quick reference

The admin AI assistant can open any of these screens for you: ask it "where is…" and tap the button it gives.

| Tool | Where |
| --- | --- |
| Check it's really them | Customer page, top |
| Account tools (PIN, login, devices, contact, ID tries) | Customer page (owner) |
| Freeze / Reactivate | Customers list |
| Funding not showing? | Customer page |
| Money tools (card re-check, chargeback, manual payout) and Support tools (top-ups, outside complaints, name, limit, missing rewards) | Customer page (owner) |
| Unmatched payments | Admin menu → 💸 Unmatched payments |
| Details, Ask the provider, Check now, Report to VTpass, refunds | Orders |
| Transfer check, held transfers | Bank Transfers |
| Recalls and wrong ZAPPI PAY transfers | ↩️ Wrong transfers |
| Request admin approval (staff) | Customer page |
| Approve staff requests (owner) | ✅ Approvals |
| Everything that was done, by whom | Audit Log |

**Ready replies** (adjust names and amounts):

- **Asking for proof of a deposit:** "Sorry about the delay. Please send your bank receipt showing the amount, date and reference/session ID, and we'll check with our payment partner straight away."
- **Deposit found and credited:** "Thanks for waiting. We've confirmed your ₦[amount] and added it to your wallet. Please refresh the app."
- **Paid to an old account number:** "Your money isn't lost. We received it on an old account number and have added it to your wallet now. Please always copy your current account number from the Wallet page."
- **Order successful but not received:** "Our records show it was delivered, but we've reported it to our provider to confirm. If it wasn't delivered, we'll refund your wallet. We'll update you within 24 hours."
- **Wrong number or meter:** "We're sorry, but once a purchase is delivered our provider can't reverse it, as the value has already gone to that number. Please double-check the number before paying next time."
- **Account paused:** "For your safety we've paused your account. Your money is safe. To restore it, please confirm your date of birth (or security answer) here."
- **Lost phone:** "We've frozen your account and signed it out on all devices, so no one can use it. When you're ready, we'll confirm it's you and restore access."

Never ask a customer for their PIN, password, OTP or full card number, and never send them a link to "verify" outside the app.
