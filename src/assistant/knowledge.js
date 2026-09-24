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
    answer: 'Sending to bank accounts is coming soon — it is waiting on our payment partner\'s approval. For now you can send to any ZappiPay user.',
    actions: [{ label: 'Send Money', to: '/transfer' }],
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
    answer: 'BVN/NIN verification is coming soon. You do not need it to buy services or send money to other ZappiPay users today.',
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

export const QUICK_TOPICS = ['fund', 'failed', 'a2c', 'transfer', 'electricity', 'password'];

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
