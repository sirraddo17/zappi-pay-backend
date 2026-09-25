// Help-centre facts for the AI assistant, copied from the app's
// rule-based helper (frontend src/assistant/knowledge.js). Update both
// when a feature changes.
const KNOWLEDGE = `- Fund my wallet: To fund your wallet: go to Wallet and get your personal account number (a one-time step with your BVN or NIN). Any bank transfer to that account is added to your wallet automatically, usually within a minute. You can also send to our business account and submit the reference for an admin to approve. (Screens: Go to Wallet = /wallet)
- Funding not credited: Transfers to your personal account number are usually credited within a minute — on the Wallet page, tap "I've sent money — check now". Manual funding requests are checked against our bank alerts, so they can take a little while. If it has been a long time, talk to support and include the transfer reference. (Screens: Check Wallet = /wallet)
- Purchase failed / debited: If a purchase fails, the amount is refunded to your wallet automatically — check Orders and your wallet balance. If an order shows SUCCESS but you did not get the value, open that receipt and tap "Report an Issue" so we can check it with the provider. (Screens: View Orders = /orders)
- Refunds: Failed purchases are refunded to your wallet instantly and show as "Refund" in your transactions. Successful purchases cannot be reversed by the network — but for airtime bought by mistake you can use Airtime to Cash. (Screens: View Orders = /orders; Airtime to Cash = /airtime-cash)
- Buy airtime: Tap Airtime on the home screen, choose the network, enter the phone number and amount, then pay from your wallet. (Screens: Buy Airtime = /buy/airtime)
- Buy data: Tap Data, choose the network and a plan, enter the phone number, then pay. The price shown is exactly what your wallet is charged. (Screens: Buy Data = /buy/data)
- Electricity / token: Tap Electricity, pick your disco and meter type, enter your meter number and tap Verify to confirm the name, then pay. Your token is on the order receipt under Orders. (Screens: Pay Electricity = /buy/electricity)
- Cable TV: Tap Cable TV, choose the provider, enter your smartcard/IUC number and Verify it, pick a package, then pay. (Screens: Pay Cable TV = /buy/cable)
- Exam PINs: Tap Education, choose the exam type and pay. Your PIN appears on the order receipt under Orders. (Screens: Buy Exam PIN = /buy/education)
- Bet wallet funding: Tap Bet Funding, pick the platform, enter your betting account ID and Verify it, then enter the amount. (Screens: Fund Bet Wallet = /buy/betting)
- Internet subscription: Tap Internet, choose your provider and plan, enter your account/MAC ID, then pay. (Screens: Pay Internet = /buy/internet)
- Send money to a user: Tap Send Money, enter the other person's phone number or ZappiPay username, check their name, then send. It arrives in their wallet instantly. (Screens: Send Money = /transfer)
- Withdraw / send to bank: Sending to bank accounts is coming soon — it is waiting on our payment partner's approval. For now you can send to any ZappiPay user. (Screens: Send Money = /transfer)
- Airtime to Cash: Bought airtime by mistake? Use Airtime to Cash: submit the request, transfer the airtime to the number shown, and once we confirm it the value (minus a small fee) is added to your wallet. (Screens: Airtime to Cash = /airtime-cash)
- Discounts: When a service is on discount you will see a "% OFF" badge on the home screen, and the reduced total is applied automatically before you pay. (Screens: Home = /)
- Receipts & tokens: Open Orders and tap any order to see its receipt. You can Download or Share it from there. (Screens: View Orders = /orders)
- Change password: To change your password, go to Profile → Change Password. If you forget it, tap "Forgot password?" on the login page to get a reset link by email, or message us on WhatsApp or email support@zappipay.com.ng and support will give you a temporary password. (Screens: Go to Profile = /profile)
- PIN & fingerprint: Your 4-digit PIN confirms every purchase and transfer. Create or change it in Profile → Security (you'll need your password). There you can also turn on quick login with your PIN and fingerprint / Face ID for this device. Five wrong PIN tries lock it for 15 minutes — logging in with your password unlocks it. (Screens: Security settings = /security)
- Saved numbers & auto top-up: When buying, tick "Save this number" to reuse it with one tap, or "Repeat this purchase automatically" to have it bought from your wallet every day, week or month. Tap "Buy again" on a receipt or the home screen to repeat a past purchase. Manage everything under Saved & Scheduled. (Screens: Saved & Scheduled = /saved)
- Refer & earn: Your username is your referral code. Share it (or your invite link) from Refer & Earn. When a friend signs up with it and makes their first qualifying purchase, a bonus is added to your wallet automatically. (Screens: Refer & Earn = /refer)
- Profile & photo: Go to Profile to update your name, email and profile photo. (Screens: Go to Profile = /profile)
- Minimum amounts: There is a minimum amount for funding and for purchases — the form will tell you if your amount is too low.
- BVN / NIN: BVN/NIN verification is coming soon. You do not need it to buy services or send money to other ZappiPay users today.
- Contact details: You can reach ZappiPay support by email at support@zappipay.com.ng, on WhatsApp, or by sending a message from this help chat. We are based in Ibadan, Nigeria. (Screens: Contact page = /legal/contact)
- Notifications: Tap the bell on the home screen to see updates about funding, purchases, replies from support and announcements. (Screens: Notifications = /notifications)
- Safety: ZappiPay staff will never ask for your password. Do not share it with anyone. If you think someone accessed your account, change your password in Profile and talk to support right away. (Screens: Change Password = /profile)`;

// Screens the assistant may link to (anything else is dropped).
const LINKS = {
  '/': 'Home',
  '/wallet': 'Wallet',
  '/statement': 'Account statement',
  '/orders': 'Orders',
  '/transfer': 'Send money',
  '/airtime-cash': 'Airtime to Cash',
  '/bulk': 'Bulk airtime & data',
  '/buy/airtime': 'Buy Airtime',
  '/buy/data': 'Buy Data',
  '/buy/electricity': 'Pay Electricity',
  '/buy/cable': 'Pay Cable TV',
  '/buy/education': 'Education PINs',
  '/buy/internet': 'Internet',
  '/buy/betting': 'Bet Funding',
  '/profile': 'Profile',
  '/security': 'Security & PIN',
  '/saved': 'Saved beneficiaries',
  '/refer': 'Refer & Earn',
  '/notifications': 'Notifications',
  '/legal/contact': 'Contact us',
};

module.exports = { KNOWLEDGE, LINKS };
