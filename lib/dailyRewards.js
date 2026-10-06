// Daily rewards: check in every day to grow a streak (a cashback reward
// on every 7th day), and answer one quick question a day for a small
// cashback. Only verified customers earn; a daily budget caps the total.
// Rewards go to the cashback balance (lib/cashback.js).

const prisma = require('./prisma');
const { getSettings } = require('./vtpass');
const { notify } = require('./notify');
const F = require('./features');

const QUESTIONS = [
  ['Where do you keep cashback on ZAPPI PAY?', ['In my bank account', 'In my cashback balance', 'It disappears'], 1],
  ['What should you NEVER share with anyone, not even “ZAPPI PAY staff”?', ['My username', 'My PIN or OTP', 'My first name'], 1],
  ['How can someone pay your DStv for you?', ['Send them a “Pay It For Me” link', 'Give them your PIN', 'Send them your password'], 0],
  ['What does “Shared Light” do?', ['Shares your token on WhatsApp', 'Lets housemates pay into one pot for a token', 'Turns off NEPA'], 1],
  ['In an Ajo Circle, when is the payout made?', ['When everyone has paid', 'Whenever the creator wants', 'Never'], 0],
  ['What is the fastest way to fund your ZAPPI PAY wallet?', ['Your personal account number', 'Posting cash', 'Sending an email'], 0],
  ['What can you do with extra airtime you don’t need?', ['Throw it away', 'Airtime to Cash', 'Nothing'], 1],
  ['Which of these is Nigeria’s Independence Day?', ['1st October', '12th June', '25th December'], 0],
  ['How many states does Nigeria have?', ['30', '36', '40'], 1],
  ['What is the capital of Nigeria?', ['Lagos', 'Abuja', 'Kano'], 1],
  ['A message says “your ZAPPI PAY account is blocked, send your OTP to unlock”. What do you do?', ['Send the OTP quickly', 'Ignore it — it’s a scam — and report it', 'Send my PIN instead'], 1],
  ['What is a prepaid meter token?', ['A code you enter into your meter for units', 'A coin', 'A bank card'], 0],
  ['Bulk airtime & data lets you top up how many numbers at once?', ['Up to 50', 'Only 1', 'Up to 2'], 0],
  ['Where do you see every purchase you’ve made?', ['Orders', 'Settings', 'Nowhere'], 0],
  ['What does “Owambe Spray” let guests do?', ['Spray money from their phone at a party', 'Spray perfume', 'Book a DJ'], 0],
  ['What should you do before buying data for someone else?', ['Check their number twice', 'Nothing', 'Ask for their PIN'], 0],
  ['What happens if a purchase fails?', ['The money is lost', 'The money comes back to your wallet automatically', 'You must call the bank'], 1],
  ['Which festival celebrates the birth of Jesus Christ?', ['Easter', 'Christmas', 'Eid'], 1],
  ['Eid-el-Fitr comes at the end of which month?', ['Ramadan', 'January', 'Rabi al-Awwal'], 0],
  ['What does SafeBuy protect?', ['Your money until you confirm delivery', 'Your phone screen', 'Your SIM card'], 0],
  ['What should you check before paying for electricity?', ['That the meter name shows correctly', 'The weather', 'Nothing'], 0],
  ['Which Nigerian city is known as the “Centre of Excellence”?', ['Lagos', 'Ibadan', 'Port Harcourt'], 0],
  ['How do you get a ZAPPI PAY agent price?', ['Apply to become an agent in Profile', 'Change your name', 'It’s automatic for everyone'], 0],
  ['What does “Refer & Earn” pay you for?', ['Inviting friends who join and buy', 'Sleeping', 'Changing your PIN'], 0],
  ['Which of these is a safe password?', ['123456', 'Your name', 'A long mix of words and numbers'], 2],
  ['What do Association Dues help with?', ['Collecting estate/church/club dues', 'Paying taxes', 'Buying land'], 0],
  ['What is the Nigerian Democracy Day?', ['12th June', '1st May', '1st January'], 0],
  ['Where do you turn on fingerprint / Face ID login?', ['Profile → Security', 'Orders', 'Data page'], 0],
  ['A friend pays you by scanning your QR. What do they need?', ['The ZAPPI PAY app', 'Your PIN', 'Your BVN'], 0],
  ['What does a “gift” purchase add?', ['A nice gift card with your message', 'A delivery fee', 'Nothing'], 0],
];

const lagosDay = (d = new Date()) => new Date(d.getTime() + 3600 * 1000).toISOString().slice(0, 10);
const dayIndex = (day) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86400000);

function questionFor(day) {
  const q = QUESTIONS[dayIndex(day) % QUESTIONS.length];
  return { question: q[0], options: q[1], answer: q[2] };
}

async function verified(customerId) {
  const c = await prisma.customer.findUnique({ where: { id: customerId }, select: { kycType: true, kycVerifiedAt: true, active: true } });
  return Boolean(c?.active && (c.kycType || c.kycVerifiedAt));
}

async function spentToday(day) {
  const rows = await prisma.dailyCheckin.findMany({ where: { day } });
  return rows.reduce((t, r) => t + Number(r.reward) + Number(r.quizReward), 0);
}

async function give(customerId, amount, note, s) {
  await prisma.$transaction(async (tx) => {
    await require('./cashback').creditEarned(tx, s, { customerId, amount, note });
  });
}

async function status(customerId) {
  const s = await getSettings();
  const day = lagosDay();
  const today = await prisma.dailyCheckin.findUnique({ where: { customerId_day: { customerId, day } } });
  const yesterday = await prisma.dailyCheckin.findUnique({ where: { customerId_day: { customerId, day: lagosDay(new Date(Date.now() - 86400000)) } } });
  const streak = today ? today.streak : yesterday ? yesterday.streak : 0;
  const q = questionFor(day);
  return {
    enabled: Boolean(s.dailyRewardsEnabled),
    verified: await verified(customerId),
    checkedIn: Boolean(today),
    streak,
    nextStreakReward: Number(s.dailyStreakReward || 0),
    daysToReward: today ? 7 - (streak % 7) : (7 - ((streak + 1) % 7)) % 7,
    quiz: { question: q.question, options: q.options, done: Boolean(today?.quizDone), reward: Number(s.dailyQuizReward || 0) },
  };
}

async function checkin(customerId) {
  const s = await F.requireOn('dailyRewards');
  if (!(await verified(customerId))) throw new F.FeatureError('Verify your account (get your account number on the Wallet page) to earn daily rewards.', 403, 'NOT_VERIFIED');
  const day = lagosDay();
  const y = await prisma.dailyCheckin.findUnique({ where: { customerId_day: { customerId, day: lagosDay(new Date(Date.now() - 86400000)) } } });
  const streak = y ? y.streak + 1 : 1;
  let reward = streak % 7 === 0 ? Number(s.dailyStreakReward || 0) : 0;
  if (reward > 0 && (await spentToday(day)) + reward > Number(s.dailyRewardsBudget || 0)) reward = 0;
  try {
    await prisma.dailyCheckin.create({ data: { customerId, day, streak, reward, quizDone: false, quizReward: 0 } });
  } catch (e) {
    if (e.code === 'P2002') throw new F.FeatureError('You’ve already checked in today — come back tomorrow!');
    throw e;
  }
  if (reward > 0) {
    await give(customerId, reward, `7-day streak reward 🔥`, s);
    notify(customerId, 'Streak reward 🔥', `7 days in a row! ${F.naira(reward)} cashback has been added.`, { category: 'TRANSACTION' });
  }
  return { streak, reward };
}

async function answer(customerId, choice) {
  const s = await F.requireOn('dailyRewards');
  const day = lagosDay();
  const row = await prisma.dailyCheckin.findUnique({ where: { customerId_day: { customerId, day } } });
  if (!row) throw new F.FeatureError('Check in first, then answer the question.');
  if (row.quizDone) throw new F.FeatureError('You’ve answered today’s question — come back tomorrow!');
  const q = questionFor(day);
  const correct = Number(choice) === q.answer;
  let reward = correct ? Number(s.dailyQuizReward || 0) : 0;
  if (reward > 0 && (await spentToday(day)) + reward > Number(s.dailyRewardsBudget || 0)) reward = 0;
  const r = await prisma.dailyCheckin.updateMany({ where: { id: row.id, quizDone: false }, data: { quizDone: true, quizReward: reward } });
  if (r.count !== 1) throw new F.FeatureError('You’ve answered today’s question.');
  if (reward > 0) await give(customerId, reward, 'Daily quiz reward 🎯', s);
  return { correct, answer: q.answer, reward, budgetUsedUp: correct && reward === 0 && Number(s.dailyQuizReward || 0) > 0 };
}

module.exports = { QUESTIONS, questionFor, lagosDay, status, checkin, answer };
