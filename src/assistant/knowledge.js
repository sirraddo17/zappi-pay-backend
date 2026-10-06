// Rule-based knowledge for the customer Help assistant — no AI, no
// network calls. Each topic has keyword phrases; the customer's message
// is matched against them and the best-scoring topic answers. Keep
// answers short and point to the right screen with `actions`.
//
// To add a topic: copy one entry, give it a unique id, a few keywords
// people would actually type (lowercase, Nigerian phrasing welcome),
// the answer, and optional buttons ({ label, to }).

export const WHATSAPP_NUMBER = '2348134209037';
export const SUPPORT_EMAIL = 'support@zappipay.com.ng';

export const TOPICS = [
  {
    id: 'services',
    title: 'What can ZAPPI PAY do?',
    keywords: ['services', 'service you offer', 'what do you offer', 'what can i do', 'what can zappi', 'what does zappi', 'what is zappi', 'features', 'what you do', 'offers', 'what una dey do', 'wetin una dey do', 'wetin i fit do'],
    answer:
      'With ZAPPI PAY you can:\n• Buy airtime and data (all networks), pay electricity (prepaid & postpaid tokens), cable TV (DStv, GOtv, Startimes, Showmax), internet, exam PINs (WAEC, JAMB) and fund betting wallets.\n• Send money to other ZAPPI PAY users free, or to any bank account.\n• Fund your wallet by bank transfer to your own account number.\n• More: Request money (Pay me links, split a bill, group gift), Car insurance, Exam PINs in bulk, Print recharge cards, Bulk airtime & data, Best data deals, Airtime to Cash, Family wallet and Refer & Earn.\n• Extras: cashback and rewards, gifts, repeat/scheduled top-ups, renewal reminders, and an agent account with cheaper prices for resellers.',
    actions: [{ label: 'Open More', to: '/more' }, { label: 'Fund wallet', to: '/wallet' }],
  },
  {
    id: 'request-money',
    title: 'Request money / split a bill',
    keywords: ['request money', 'pay me', 'split bill', 'split a bill', 'group gift', 'contribution', 'collect money', 'chip in', 'owe me'],
    answer: 'Go to More → Request money. Make a “Pay me” link, split a bill between friends, or start a group gift. Share the link on WhatsApp — people pay from their ZAPPI PAY wallet with their PIN, and the money comes straight to you.',
    actions: [{ label: 'Request money', to: '/requests' }],
  },
  {
    id: 'owambe-spray',
    title: 'Owambe Spray (spray money at a party)',
    keywords: ['spray', 'owambe', 'party', 'wedding', 'celebrant', 'spray money', 'naming ceremony', 'big screen'],
    answer: 'More → Owambe Spray (when it’s switched on). The host starts an event and shows the QR code. Guests scan it, set a spray budget with their PIN once, then tap SPRAY with ₦100–₦5,000 notes — the money lands in the host’s wallet instantly, and the big screen shows notes flying and the top sprayers.',
    actions: [{ label: 'Owambe Spray', to: '/spray' }],
  },
  {
    id: 'association-dues',
    title: 'Association Dues',
    keywords: ['dues', 'estate dues', 'association', 'church dues', 'alumni', 'levy', 'treasurer', 'club'],
    answer: 'More → Association Dues: the treasurer creates a group (amount, weekly/monthly/yearly, due day) and shares the link. Members pay each period with their PIN or switch on auto-pay; dues go straight to the treasurer, who sees who has paid and can send reminders or download the list.',
    actions: [{ label: 'Association Dues', to: '/dues' }],
  },
  {
    id: 'pay-for-me',
    title: 'Pay It For Me',
    keywords: ['pay it for me', 'ask someone to pay', 'pay for me', 'help me pay', 'pay my light for me', 'someone else pay'],
    answer: 'Open the service (e.g. Electricity), fill in your meter or number and amount, then tap “🙏 Ask someone to pay”. Send the link — they pay from their own wallet and it goes straight to you. See your requests in More → Pay It For Me.',
    actions: [{ label: 'Pay It For Me', to: '/pay-for-me' }],
  },
  {
    id: 'shared-light',
    title: 'Shared Light',
    keywords: ['shared light', 'light pot', 'housemates', 'flatmates', 'split light', 'contribute for light', 'shared meter'],
    answer: 'More → Shared Light: create a pot for your shared meter and token amount, invite housemates, and everyone puts in their share with their PIN. When the pot is full the token buys itself and shows on the pot page. Closing a pot returns the money to whoever paid it.',
    actions: [{ label: 'Shared Light', to: '/shared-light' }],
  },
  {
    id: 'safebuy',
    title: 'SafeBuy (buyer protection)',
    keywords: ['safebuy', 'safe buy', 'escrow', 'buyer protection', 'online seller', 'instagram vendor', 'whatsapp vendor', 'scammed', 'not delivered'],
    answer: 'More → SafeBuy: the seller sends you a SafeBuy link. When you pay, the money is held — not sent to the seller. Tap “I’ve received it” when the item arrives and the seller is paid. If something is wrong, tap “Report a problem” before the auto-release date and the money stays held while ZAPPI PAY checks.',
    actions: [{ label: 'SafeBuy', to: '/safebuy' }],
  },
  {
    id: 'payroll',
    title: 'Payroll',
    keywords: ['payroll', 'salary', 'pay staff', 'workers', 'employees', 'payslip'],
    answer: 'More → Payroll: add your staff (ZAPPI PAY username/phone — free and instant — or a bank account), set their salaries, then tap “Pay everyone” and confirm with your PIN. You see who was paid and who failed.',
    actions: [{ label: 'Payroll', to: '/payroll' }],
  },
  {
    id: 'daily-rewards',
    title: 'Daily rewards',
    keywords: ['daily rewards', 'check in', 'streak', 'quiz', 'question of the day', 'free cashback'],
    answer: 'More → Daily rewards: check in every day — every 7th day in a row earns a cashback reward — and answer the question of the day for a small bonus. Rewards go to your cashback balance; only verified accounts earn.',
    actions: [{ label: 'Daily rewards', to: '/rewards' }],
  },
  {
    id: 'ajo-circle',
    title: 'Ajo Circle (group contributions)',
    keywords: ['ajo', 'esusu', 'adashe', 'isusu', 'thrift', 'contribution group', 'rotating savings', 'circle', 'packing number', 'my turn', 'payout delayed'],
    answer: 'More → Ajo Circle: save with people you trust. Everyone pays the same amount every day, week or month — it’s taken from your wallet automatically — and each period one member receives the whole pot, in payout-number order. The pot is locked until everyone has paid; late payments get a late fee and a strike. Read the agreement before you join.',
    actions: [{ label: 'Ajo Circle', to: '/circles' }],
  },
  {
    id: 'cashback-balance',
    title: 'Using my cashback',
    keywords: ['cashback', 'use cashback', 'cash back balance', 'where is my cashback'],
    answer: 'Cashback is kept in its own balance (Wallet → 🎁 Cashback). When you buy, switch on “Use cashback” to pay less — up to a set % of each purchase; the rest stays for next time. Cashback can’t be sent or withdrawn.',
    actions: [{ label: 'Wallet', to: '/wallet' }],
  },
  {
    id: 'insurance',
    title: 'Car insurance',
    keywords: ['insurance', 'third party', 'car papers', 'vehicle insurance', 'keke insurance', 'okada insurance'],
    answer: 'More → Car insurance: third-party motor insurance (private car, commercial, keke, motorcycle). Enter the vehicle details, pay, and download the certificate from Orders right away.',
    actions: [{ label: 'Car insurance', to: '/insurance' }],
  },
  {
    id: 'exam-bulk',
    title: 'Exam PINs in bulk',
    keywords: ['waec pin', 'result checker', 'bulk waec', 'many pins', 'exam pins', 'school pins', 'scratch card'],
    answer: 'One PIN: Home → Education. Many PINs (schools, cyber cafés): More → Exam PINs (bulk) — buy up to 50 WAEC result checkers at once and print them on a sheet with your school or shop name.',
    actions: [{ label: 'Exam PINs (bulk)', to: '/exam-pins' }],
  },
  {
    id: 'scam',
    title: 'Is this a scam?',
    keywords: ['scam', 'scammer', 'fraudster', 'is this real', 'fake message', 'fake call', 'asked for my otp', 'asked for my pin', 'someone called me', 'suspicious', 'legit', 'genuine'],
    answer:
      'ZAPPI PAY will NEVER ask for your PIN, password, OTP, BVN or card details, never calls to "verify" or "unlock" your account, and never asks you to pay to receive a prize or refund. Our only website is zappipay.com.ng and support is here in the app or support@zappipay.com.ng. If someone asked for any of these, it is a scam — don\'t reply, block them. If you already shared something, change your password and PIN now (Profile → Security) and tell support.',
    actions: [{ label: 'Security settings', to: '/security' }],
    escalate: true,
  },
  {
    id: 'fund',
    title: 'Fund my wallet',
    keywords: ['fund', 'deposit', 'add money', 'top up wallet', 'topup', 'credit wallet', 'load wallet', 'pay in', 'transfer to wallet'],
    answer:
      'To fund your wallet: go to Wallet and get your personal account number (a one-time step with your BVN or NIN). Any bank transfer to that account is added to your wallet automatically, usually within a minute. You can also send to our business account and submit the reference for an admin to approve.',
    actions: [{ label: 'Go to Wallet', to: '/wallet' }],
  },
  {
    id: 'funding-pending',
    title: 'Funding not credited',
    keywords: ['not credited', 'funding pending', 'wallet not updated', 'money not reflect', 'not reflecting', 'balance not', 'still pending', 'fund not', 'funded but', 'sent money but'],
    answer:
      'Transfers to your personal account number are usually credited within a minute — on the Wallet page, tap "I\'ve sent money — check now". Manual funding requests are checked against our bank alerts, so they can take a little while. If it has been a long time, talk to support and include the transfer reference.',
    actions: [{ label: 'Check Wallet', to: '/wallet' }],
    escalate: true,
  },
  {
    id: 'failed',
    title: 'Purchase failed / debited',
    keywords: ['failed', 'debited', 'deducted', 'not delivered', 'not received', 'didnt get', "didn't get", 'did not get', 'no value', 'money gone', 'charged'],
    answer:
      'If a purchase fails, the amount is refunded to your wallet automatically — check Orders and your wallet balance. If an order shows SUCCESS but you did not get the value, open that receipt and tap "Report an Issue" so we can check it with the provider.',
    actions: [{ label: 'View Orders', to: '/orders' }],
    escalate: true,
  },
  {
    id: 'refund',
    title: 'Refunds',
    keywords: ['refund', 'reverse', 'reversal', 'money back', 'return my money'],
    answer:
      'Failed purchases are refunded to your wallet instantly and show as "Refund" in your transactions. Successful purchases cannot be reversed by the network — but for airtime bought by mistake you can use Airtime to Cash.',
    actions: [
      { label: 'View Orders', to: '/orders' },
      { label: 'Airtime to Cash', to: '/airtime-cash' },
    ],
  },
  {
    id: 'airtime',
    title: 'Buy airtime',
    keywords: ['airtime', 'recharge', 'credit card for phone', 'vtu', 'buy card'],
    answer: 'Tap Airtime on the home screen, choose the network, enter the phone number and amount, then pay from your wallet.',
    actions: [{ label: 'Buy Airtime', to: '/buy/airtime' }],
  },
  {
    id: 'data',
    title: 'Buy data',
    keywords: ['data', 'bundle', 'subscription data', 'gb', 'mb', 'internet data'],
    answer: 'Tap Data, choose the network and a plan, enter the phone number, then pay. The price shown is exactly what your wallet is charged.',
    actions: [{ label: 'Buy Data', to: '/buy/data' }],
  },
  {
    id: 'electricity',
    title: 'Electricity / token',
    keywords: ['electricity', 'light', 'nepa', 'token', 'meter', 'prepaid', 'postpaid', 'disco', 'ikedc', 'ekedc', 'aedc', 'phed'],
    answer:
      'Tap Electricity, pick your disco and meter type, enter your meter number and tap Verify to confirm the name, then pay. Your token is on the order receipt under Orders.',
    actions: [{ label: 'Pay Electricity', to: '/buy/electricity' }],
  },
  {
    id: 'cable',
    title: 'Cable TV',
    keywords: ['cable', 'dstv', 'gotv', 'startimes', 'showmax', 'smartcard', 'iuc', 'decoder', 'tv'],
    answer: 'Tap Cable TV, choose the provider, enter your smartcard/IUC number and Verify it, pick a package, then pay.',
    actions: [{ label: 'Pay Cable TV', to: '/buy/cable' }],
  },
  {
    id: 'education',
    title: 'Exam PINs',
    keywords: ['waec', 'neco', 'jamb', 'exam', 'result checker', 'education', 'pin'],
    answer: 'Tap Education, choose the exam type and pay. Your PIN appears on the order receipt under Orders.',
    actions: [{ label: 'Buy Exam PIN', to: '/buy/education' }],
  },
  {
    id: 'betting',
    title: 'Bet wallet funding',
    keywords: ['bet', 'betting', 'sportybet', 'bet9ja', 'betking', '1xbet', 'nairabet', 'merrybet', 'bangbet'],
    answer: 'Tap Bet Funding, pick the platform, enter your betting account ID and Verify it, then enter the amount.',
    actions: [{ label: 'Fund Bet Wallet', to: '/buy/betting' }],
  },
  {
    id: 'internet',
    title: 'Internet subscription',
    keywords: ['spectranet', 'smile', 'swift', 'ipnx', 'router', 'mifi', 'broadband'],
    answer: 'Tap Internet, choose your provider and plan, enter your account/MAC ID, then pay.',
    actions: [{ label: 'Pay Internet', to: '/buy/internet' }],
  },
  {
    id: 'transfer',
    title: 'Send money to a user',
    keywords: ['send money', 'transfer', 'send to friend', 'pay someone', 'username', 'another user'],
    answer:
      'Tap Send Money, enter the other person\'s phone number or ZappiPay username, check their name, then send. It arrives in their wallet instantly.',
    actions: [{ label: 'Send Money', to: '/transfer' }],
  },
  {
    id: 'bank',
    title: 'Withdraw / send to bank',
    keywords: ['withdraw', 'bank account', 'cash out', 'to my bank', 'opay', 'palmpay', 'moniepoint', 'kuda', 'gtb', 'access bank'],
    answer: 'Home → Send Money → tab "Bank Account": choose the bank, enter the 10-digit account number (the account name shows automatically), enter the amount, then confirm with your PIN. Any transfer fee is shown before you send and is added on top. If you don\'t see the Bank Account tab, sending to banks isn\'t switched on yet.',
    actions: [{ label: 'Send Money', to: '/transfer' }],
  },
  {
    id: 'family',
    title: 'Family wallet',
    keywords: ['family', 'family wallet', 'pocket money', 'allowance', 'my child', 'my children', 'my kids', 'my son', 'my daughter', 'my wife', 'my husband', 'parent'],
    answer:
      'Family wallet lets you link a family member\'s ZAPPI PAY account, send them automatic pocket money (weekly or monthly) and set a daily spending limit, which services they can buy, and whether they can send money out. To start: Home → More → "Family wallet" → enter their username or phone number → "Send invite". When they accept, tap "Limits & allowance" on their card, set it up and tap "Save settings". Either of you can end it any time.',
    actions: [{ label: 'Family wallet', to: '/family' }],
  },
  {
    id: 'print-cards',
    title: 'Print recharge cards',
    keywords: ['print card', 'print cards', 'recharge card', 'printing', 'epin', 'e-pin', 'sell recharge card', 'card pin'],
    answer:
      'Print Cards lets you buy MTN, Glo, Airtel or 9mobile airtime PINs (₦100, ₦200 or ₦500) to print and sell. Home → More → "Print Cards" → choose network, card value and how many → "Buy & print" → enter your PIN. Then open the batch to print (A4, small or 58mm POS printer), copy the PINs or download them, and tap a PIN to mark it sold. If cards can\'t be delivered, your money comes back automatically.',
    actions: [{ label: 'Print Cards', to: '/print-cards' }],
  },
  {
    id: 'gift',
    title: 'Send a gift',
    keywords: ['gift', 'gift card', 'surprise', 'birthday', 'send as gift'],
    answer:
      'You can send airtime or data as a gift with a card and message. On the Airtime or Data screen, enter their number, tick "🎁 Send as a gift with a message", pick a theme, write your message and pay. Then share it on WhatsApp or copy the link. You can also turn a past purchase into a gift from its receipt.',
    actions: [{ label: 'Buy Data', to: '/buy/data' }],
  },
  {
    id: 'reminders',
    title: 'Renewal reminders',
    keywords: ['reminder', 'remind me', 'renewal', 'expire', 'expiry', 'due date'],
    answer:
      'After you pay for cable TV, data or internet, we remind you before it runs out (cable 3 days before, internet 2 days, data 1 day). The Home screen shows a renewals card with a "Renew" button. Tap "×" to stop one reminder, or turn them back on under Notifications → "Renewal reminders".',
    actions: [{ label: 'Home', to: '/' }],
  },
  {
    id: 'agent',
    title: 'Become an agent',
    keywords: ['become agent', 'become an agent', 'agent price', 'agent account', 'reseller', 'resell', 'shop link', 'profit book'],
    answer:
      'If you sell airtime or data, you can apply to be a ZAPPI PAY agent: Profile → "Become a ZappiPay agent" → "Apply to be an agent" → enter your shop name and address. Once approved you get cheaper agent prices, a Profit book to track sales and who owes you, and a shop link you can share. (If you don\'t see the agent card, agent pricing isn\'t open yet.)',
    actions: [{ label: 'Profile', to: '/profile' }],
  },
  {
    id: 'deals',
    title: 'Best data for my budget',
    keywords: ['cheap data', 'cheapest data', 'best data', 'data deal', 'budget', 'most data'],
    answer:
      'Use "Best data for your budget": Home → More → "Best data deals". Enter how much you want to spend and it shows the most data on every network. Tap a plan to buy it.',
    actions: [{ label: 'Best data deals', to: '/deals' }],
  },
  {
    id: 'a2c',
    title: 'Airtime to Cash',
    keywords: ['airtime to cash', 'convert airtime', 'wrong number', 'mistake', 'mistakenly', 'sell airtime', 'swap airtime'],
    answer:
      'Bought airtime by mistake? Use Airtime to Cash: submit the request, transfer the airtime to the number shown, and once we confirm it the value (minus a small fee) is added to your wallet.',
    actions: [{ label: 'Airtime to Cash', to: '/airtime-cash' }],
  },
  {
    id: 'discount',
    title: 'Discounts',
    keywords: ['discount', 'promo', 'offer', 'cheaper', '% off', 'percent off', 'coupon'],
    answer: 'When a service is on discount you will see a "% OFF" badge on the home screen, and the reduced total is applied automatically before you pay.',
    actions: [{ label: 'Home', to: '/' }],
  },
  {
    id: 'receipt',
    title: 'Receipts & tokens',
    keywords: ['receipt', 'download', 'print', 'share receipt', 'proof', 'history', 'orders'],
    answer: 'Open Orders and tap any order to see its receipt. You can Download or Share it from there.',
    actions: [{ label: 'View Orders', to: '/orders' }],
  },
  {
    id: 'password',
    title: 'Change password',
    keywords: ['password', 'change password', 'reset password', 'forgot password', 'forgot my password'],
    answer:
      'To change your password, go to Profile → Change Password. If you forget it, tap "Forgot password?" on the login page to get a reset link by email, or message us on WhatsApp or email support@zappipay.com.ng and support will give you a temporary password.',
    actions: [{ label: 'Go to Profile', to: '/profile' }],
  },
  {
    id: 'pin',
    title: 'PIN & fingerprint',
    keywords: ['pin', 'transaction pin', 'forgot pin', 'change pin', 'reset pin', 'wrong pin', 'pin locked', 'fingerprint', 'face id', 'biometric', 'quick login'],
    answer:
      'Your 4-digit PIN confirms every purchase and transfer. Create or change it in Profile → Security (you\'ll need your password). There you can also turn on quick login with your PIN and fingerprint / Face ID for this device. Five wrong PIN tries lock it for 15 minutes — logging in with your password unlocks it.',
    actions: [{ label: 'Security settings', to: '/security' }],
  },
  {
    id: 'saved',
    title: 'Saved numbers & auto top-up',
    keywords: ['save number', 'saved number', 'beneficiary', 'beneficiaries', 'buy again', 'repeat', 'auto', 'automatic', 'schedule', 'scheduled', 'every month', 'subscription renew', 'auto renew', 'recurring'],
    answer:
      'When buying, tick "Save this number" to reuse it with one tap, or "Repeat this purchase automatically" to have it bought from your wallet every day, week or month. Tap "Buy again" on a receipt or the home screen to repeat a past purchase. Manage everything under Saved & Scheduled.',
    actions: [{ label: 'Saved & Scheduled', to: '/saved' }],
  },
  {
    id: 'referral',
    title: 'Refer & earn',
    keywords: ['refer', 'referral', 'invite', 'invite friend', 'referral code', 'referral bonus', 'earn money', 'bonus'],
    answer:
      'Your username is your referral code. Share it (or your invite link) from Refer & Earn. When a friend signs up with it and makes their first qualifying purchase, a bonus is added to your wallet automatically.',
    actions: [{ label: 'Refer & Earn', to: '/refer' }],
  },
  {
    id: 'profile',
    title: 'Profile & photo',
    keywords: ['profile', 'photo', 'picture', 'avatar', 'name', 'email', 'edit account'],
    answer: 'Go to Profile to update your name, email and profile photo.',
    actions: [{ label: 'Go to Profile', to: '/profile' }],
  },
  {
    id: 'limits',
    title: 'Minimum amounts',
    keywords: ['minimum', 'least amount', 'limit', 'maximum', 'how much can'],
    answer: 'There is a minimum amount for funding and for purchases — the form will tell you if your amount is too low.',
  },
  {
    id: 'verification',
    title: 'BVN / NIN',
    keywords: ['bvn', 'nin', 'kyc', 'verify identity', 'verification'],
    answer: 'You verify by getting your personal account number: Wallet → "Get your personal account number" → choose BVN or NIN → enter the 11 digits → "Get My Account Number". Profile then shows "✓ Verified". Verified accounts can get a higher daily limit.',
  },
  {
    id: 'contact',
    title: 'Contact details',
    keywords: ['support email', 'your email', 'zappipay email', 'contact', 'phone number of zappipay', 'reach you', 'office', 'address'],
    answer: 'You can reach ZappiPay support by email at support@zappipay.com.ng, on WhatsApp, or by sending a message from this help chat. We are based in Ibadan, Nigeria.',
    actions: [{ label: 'Contact page', to: '/legal/contact' }],
    escalate: true,
  },
  {
    id: 'notifications',
    title: 'Notifications',
    keywords: ['notification', 'bell', 'alert', 'message from zappipay'],
    answer: 'Tap the bell on the home screen to see updates about funding, purchases, replies from support and announcements.',
    actions: [{ label: 'Notifications', to: '/notifications' }],
  },
  {
    id: 'safety',
    title: 'Safety',
    keywords: ['scam', 'fraud', 'hack', 'someone asked', 'otp', 'share my password', 'suspicious'],
    answer:
      'ZappiPay staff will never ask for your password. Do not share it with anyone. If you think someone accessed your account, change your password in Profile and talk to support right away.',
    actions: [{ label: 'Change Password', to: '/profile' }],
    escalate: true,
  },
];

// Words that mean "I want a person".
export const HUMAN_KEYWORDS = ['human', 'agent', 'customer care', 'customer service', 'support', 'person', 'talk to someone', 'complain', 'complaint', 'help me please', 'admin'];

export const GREETING_KEYWORDS = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'howfa', 'how far'];

export const QUICK_TOPICS = ['services', 'fund', 'failed', 'a2c', 'transfer', 'electricity', 'password'];

function normalize(text) {
  return ` ${String(text || '').toLowerCase().replace(/[^a-z0-9%'\s]/g, ' ').replace(/\s+/g, ' ')} `;
}

function hits(text, keywords) {
  // Multi-word phrases score higher than single words, and single
  // words must match whole words so "gb" doesn't match "rugby".
  let score = 0;
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    if (k.includes(' ')) {
      if (text.includes(k)) score += 2;
    } else if (text.includes(` ${k} `)) {
      score += 1;
    }
  }
  return score;
}

// Returns { type: 'topic', topic } | { type: 'human' } | { type: 'greeting' } | { type: 'unknown' }
export function matchMessage(message) {
  const text = normalize(message);
  let best = null;
  let bestScore = 0;
  for (const topic of TOPICS) {
    const score = hits(text, topic.keywords);
    if (score > bestScore) {
      best = topic;
      bestScore = score;
    }
  }
  const wantsHuman = hits(text, HUMAN_KEYWORDS) > 0;
  if (best && bestScore > 0) return { type: 'topic', topic: best, wantsHuman };
  if (wantsHuman) return { type: 'human' };
  if (hits(text, GREETING_KEYWORDS) > 0) return { type: 'greeting' };
  return { type: 'unknown' };
}

export function topicById(id) {
  return TOPICS.find((t) => t.id === id);
}
