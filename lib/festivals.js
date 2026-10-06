// Festival greetings: Christian, Muslim and national holidays, worked out
// for any year (Easter by the church calendar, Islamic days by the
// Umm al-Qura calendar). Each comes with a ready greeting design for Ad
// Studio (pictures + caption) and a slide the app shows by itself on
// the day. Islamic dates follow the moon, so Nigeria's announced date can
// move by a day — the app slide runs for a few days to cover that.

const DAY = 24 * 3600 * 1000;
const ymd = (d) => d.toISOString().slice(0, 10);
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 12));

// Western (Gregorian) Easter Sunday.
function easter(y) {
  const a = y % 19; const b = Math.floor(y / 100); const c = y % 100;
  const d = Math.floor(b / 4); const e = b % 4; const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(y, month, day);
}

const HIJRI = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { timeZone: 'UTC', day: 'numeric', month: 'numeric', year: 'numeric' });
function hijri(d) {
  const p = Object.fromEntries(HIJRI.formatToParts(d).map((x) => [x.type, x.value]));
  return { day: Number(p.day), month: Number(p.month), year: Number(String(p.year).replace(/\D/g, '')) };
}
// Every Gregorian date in year y that falls on Hijri month/day.
function islamicDates(y, month, day) {
  const out = [];
  for (let t = utc(y, 1, 1).getTime(); t <= utc(y, 12, 31).getTime(); t += DAY) {
    const h = hijri(new Date(t));
    if (h.month === month && h.day === day) out.push({ date: new Date(t), hijriYear: h.year });
  }
  return out;
}

const SITE = 'www.zappipay.com.ng';

// ZAPPI PAY's launch day (also the founder's birthday) — celebrated every year.
const LAUNCH = (() => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(process.env.LAUNCH_DATE || '2026-11-17');
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
})();
const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : n % 10] || 'th'}`;
// Customer Service Week: the first full week of October (Monday–Friday).
function csWeekStart(y) {
  const d = utc(y, 10, 1);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
const tags = (...t) => ['#ZappiPay', ...t].join(' ');

// show: [days before, days after] the app shows the greeting slide.
const FESTIVALS = [
  {
    key: 'launch', group: 'zappi', name: 'ZAPPI PAY launch day', notifyAll: true, show: [0, 2],
    when: (y) => (y < LAUNCH.y ? [] : [{ date: utc(y, LAUNCH.m, LAUNCH.d), years: y - LAUNCH.y }]),
    design: (y, x) => (x?.years > 0
      ? { headline: `${x.years} year${x.years === 1 ? '' : 's'} of ZAPPI PAY!`, highlight: 'ZAPPI PAY!', subtext: `Today is our ${ordinal(x.years)} anniversary. Thank you for trusting us with your airtime, data and bills — we couldn’t have done it without you`, emoji: '🎂', theme: 'purple', badges: ['Thank you', `Since ${LAUNCH.y}`], caption: `🎉 ZAPPI PAY is ${x.years} year${x.years === 1 ? '' : 's'} old today! 🎂\n\nTo every customer, agent and partner: THANK YOU for trusting us with your airtime, data, bills and payments. You made this possible 💜\n\nHere’s to many more years of serving you better.\n\n${SITE}\n${tags('#ZappiPayTurns' + x.years, '#Anniversary', '#ThankYou')}`, notice: `🎂 ZAPPI PAY is ${x.years} year${x.years === 1 ? '' : 's'} old today! Thank you for trusting us — we’re grateful to have you.` }
      : { headline: 'ZAPPI PAY is LIVE!', highlight: 'LIVE!', subtext: 'Airtime, data, electricity, TV and more — fast, safe and from one wallet. Thank you for joining us from day one', emoji: '🚀', theme: 'purple', badges: ['Launch day', 'Thank you'], caption: `🚀 ZAPPI PAY is officially LIVE!\n\nBuy airtime, data, electricity, cable TV and more in seconds — all from one wallet. Thank you to everyone who believed in us from day one 💜\n\nDownload / open the app today 👉 ${SITE}\n${tags('#ZappiPayIsLive', '#LaunchDay', '#Fintech')}`, notice: '🚀 ZAPPI PAY is officially live today! Thank you for being with us from day one.' }),
  },
  {
    key: 'cs-week', group: 'zappi', name: 'Customer Service Week', notifyAll: true, show: [0, 4],
    when: (y) => [{ date: csWeekStart(y) }],
    design: () => ({ headline: 'Happy Customer Service Week!', highlight: 'Customer Service Week!', subtext: 'You are the reason we exist. Thank you for every purchase and every bit of feedback', emoji: '💜', theme: 'blue', badges: ['Thank you', 'We hear you'], caption: `Happy Customer Service Week! 💜\n\nTo our amazing customers: you are the reason ZAPPI PAY exists. Thank you for your trust, your feedback and your patience as we grow. And to our support team — thank you for showing up every day 🙌\n\nNeed help? Tap Help in the app anytime.\n\n${SITE}\n${tags('#CustomerServiceWeek', '#CSWeek', '#ThankYou')}`, notice: '💜 Happy Customer Service Week! Thank you for trusting ZAPPI PAY. Tell us how we can serve you better — tap Help → Feedback anytime.' }),
  },
  {
    key: 'new-year', group: 'national', name: 'New Year', when: (y) => [{ date: utc(y, 1, 1) }], show: [0, 2],
    design: (y) => ({ headline: `Happy New Year ${y}!`, highlight: String(y), subtext: 'Thank you for growing with us. Here’s to a year of answered prayers, good health and plenty blessings', emoji: '🎆', theme: 'gold', badges: ['New year', 'New blessings'], caption: `Happy New Year ${y}! 🎆✨\n\nFrom all of us at ZAPPI PAY: thank you for trusting us. May this year bring you good health, peace and plenty blessings. 🙏\n\n${SITE}\n${tags('#HappyNewYear', `#${y}`)}` }),
  },
  {
    key: 'ramadan', group: 'muslim', name: 'Start of Ramadan', when: (y) => islamicDates(y, 9, 1), show: [0, 2], moon: true,
    design: () => ({ headline: 'Ramadan Kareem', highlight: 'Kareem', subtext: 'May this holy month bring you peace, mercy and answered prayers', emoji: '🌙', theme: 'green', badges: ['Ramadan Mubarak'], caption: `Ramadan Kareem 🌙\n\nTo all our Muslim customers and friends: may Allah accept your fasting and prayers, and fill this holy month with peace and mercy. 🤲\n\n${SITE}\n${tags('#RamadanKareem', '#RamadanMubarak')}` }),
  },
  {
    key: 'eid-fitr', group: 'muslim', name: 'Eid-el-Fitr', when: (y) => islamicDates(y, 10, 1), show: [0, 3], moon: true,
    design: () => ({ headline: 'Eid Mubarak!', highlight: 'Mubarak!', subtext: 'Happy Eid-el-Fitr. May Allah accept our fasting and prayers, and bless you and your family', emoji: '🕌', theme: 'green', badges: ['Eid-el-Fitr', 'Barka da Sallah'], caption: `Eid Mubarak! 🌙🕌\n\nHappy Eid-el-Fitr to all our Muslim customers and friends. May Allah accept our fasting and prayers, and bless you and your family. Barka da Sallah! 🤲\n\n${SITE}\n${tags('#EidMubarak', '#EidElFitr', '#BarkaDaSallah')}` }),
  },
  {
    key: 'eid-adha', group: 'muslim', name: 'Eid-el-Kabir (Eid al-Adha)', when: (y) => islamicDates(y, 12, 10), show: [0, 3], moon: true,
    design: () => ({ headline: 'Eid Mubarak!', highlight: 'Mubarak!', subtext: 'Happy Eid-el-Kabir. May your sacrifice be accepted and your home be filled with joy', emoji: '🐏', theme: 'green', badges: ['Eid-el-Kabir', 'Barka da Sallah'], caption: `Eid Mubarak! 🐏🌙\n\nHappy Eid-el-Kabir to all our Muslim customers and friends. May Allah accept your sacrifice and fill your home with peace and joy. Barka da Sallah! 🤲\n\n${SITE}\n${tags('#EidMubarak', '#EidElKabir', '#EidAlAdha', '#BarkaDaSallah')}` }),
  },
  {
    key: 'islamic-new-year', group: 'muslim', name: 'Islamic New Year', when: (y) => islamicDates(y, 1, 1), show: [0, 1], moon: true,
    design: (y, x) => ({ headline: x?.hijriYear ? `Happy Islamic New Year ${x.hijriYear} AH` : 'Happy Islamic New Year', highlight: 'New Year', subtext: 'May the new Hijri year bring you peace, guidance and blessings', emoji: '🌙', theme: 'green', badges: ['Hijri New Year'], caption: `Happy Islamic New Year${x?.hijriYear ? ` ${x.hijriYear} AH` : ''} 🌙\n\nTo all our Muslim customers and friends: may this new year bring you peace, guidance and blessings. 🤲\n\n${SITE}\n${tags('#IslamicNewYear', '#HijriNewYear')}` }),
  },
  {
    key: 'mawlid', group: 'muslim', name: 'Eid-el-Maulud (birth of Prophet Muhammad, SAW)', when: (y) => islamicDates(y, 3, 12), show: [0, 1], moon: true,
    design: () => ({ headline: 'Happy Eid-el-Maulud', highlight: 'Eid-el-Maulud', subtext: 'Celebrating the birth of the Holy Prophet Muhammad (SAW). May his teachings of peace and kindness guide us', emoji: '✨', theme: 'green', badges: ['Maulud Nabiyy'], caption: `Happy Eid-el-Maulud ✨🌙\n\nAs we celebrate the birth of the Holy Prophet Muhammad (SAW), may his teachings of peace, love and kindness guide us all. 🤲\n\n${SITE}\n${tags('#EidElMaulud', '#MawlidAnNabi')}` }),
  },
  {
    key: 'good-friday', group: 'christian', name: 'Good Friday', when: (y) => [{ date: new Date(easter(y).getTime() - 2 * DAY) }], show: [0, 0],
    design: () => ({ headline: 'Blessed Good Friday', highlight: 'Good Friday', subtext: 'Remembering the love and sacrifice of Christ. Peace be with you and your family', emoji: '✝️', theme: 'dark', badges: ['Holy week'], caption: `Blessed Good Friday ✝️\n\nToday we remember the great love and sacrifice of Jesus Christ. Peace be with you and your family. 🙏\n\n${SITE}\n${tags('#GoodFriday', '#HolyWeek')}` }),
  },
  {
    key: 'easter', group: 'christian', name: 'Easter', when: (y) => [{ date: easter(y) }], show: [0, 1],
    design: () => ({ headline: 'Happy Easter!', highlight: 'Easter!', subtext: 'He is risen! Wishing you and your family joy, hope and new beginnings', emoji: '🐣', theme: 'gold', badges: ['He is risen'], caption: `Happy Easter! 🐣✝️\n\nHe is risen! From all of us at ZAPPI PAY, wishing you and your family joy, hope and new beginnings this Easter. 🙏\n\n${SITE}\n${tags('#HappyEaster', '#HeIsRisen')}` }),
  },
  {
    key: 'christmas', group: 'christian', name: 'Christmas', when: (y) => [{ date: utc(y, 12, 25) }], show: [1, 1],
    design: () => ({ headline: 'Merry Christmas!', highlight: 'Christmas!', subtext: 'Celebrating the birth of Jesus Christ. Wishing you love, peace and joy this season', emoji: '🎄', theme: 'red', badges: ['Season’s greetings'], caption: `Merry Christmas! 🎄🎁\n\nAs we celebrate the birth of Jesus Christ, ZAPPI PAY wishes you and your loved ones love, peace and joy this season. ❤️\n\n${SITE}\n${tags('#MerryChristmas', '#Christmas')}` }),
  },
  {
    key: 'independence', group: 'national', name: 'Independence Day', when: (y) => [{ date: utc(y, 10, 1) }], show: [0, 0],
    design: (y) => ({ headline: 'Happy Independence Day, Nigeria!', highlight: 'Nigeria!', subtext: `${y - 1960} years of a great nation. Together we grow 🇳🇬`, emoji: '🇳🇬', theme: 'green', badges: ['1st October'], caption: `Happy Independence Day, Nigeria! 🇳🇬\n\n${y - 1960} years strong. ZAPPI PAY is proud to serve Nigerians every day. Together we grow 💚🤍💚\n\n${SITE}\n${tags('#IndependenceDay', '#Nigeria')}` }),
  },
  {
    key: 'democracy', group: 'national', name: 'Democracy Day', when: (y) => [{ date: utc(y, 6, 12) }], show: [0, 0],
    design: () => ({ headline: 'Happy Democracy Day!', highlight: 'Democracy Day!', subtext: 'Celebrating freedom and the voice of every Nigerian 🇳🇬', emoji: '🇳🇬', theme: 'green', badges: ['June 12'], caption: `Happy Democracy Day! 🇳🇬\n\nCelebrating freedom and the voice of every Nigerian. ZAPPI PAY wishes you a peaceful June 12. 💚🤍💚\n\n${SITE}\n${tags('#DemocracyDay', '#June12', '#Nigeria')}` }),
  },
];

function occurrences(year) {
  const out = [];
  for (const f of FESTIVALS) {
    for (const x of f.when(year)) {
      const d = x.date;
      out.push({
        id: `${f.key}-${ymd(d)}`,
        key: f.key,
        group: f.group,
        name: f.name,
        date: ymd(d),
        moon: Boolean(f.moon),
        notifyAll: Boolean(f.notifyAll),
        showFrom: ymd(new Date(d.getTime() - f.show[0] * DAY)),
        showTo: ymd(new Date(d.getTime() + f.show[1] * DAY)),
        design: { cta: 'Open ZAPPI PAY', link: '/', ...f.design(d.getUTCFullYear(), x) },
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// Lagos "today" as YYYY-MM-DD.
const lagosToday = (now = new Date()) => ymd(new Date(now.getTime() + 3600 * 1000));

function upcoming(days = 90, now = new Date()) {
  const today = lagosToday(now);
  const y = Number(today.slice(0, 4));
  const end = ymd(new Date(Date.parse(`${today}T12:00:00Z`) + days * DAY));
  return [...occurrences(y - 1), ...occurrences(y), ...occurrences(y + 1)]
    .filter((f) => f.showTo >= today && (f.date <= end || f.showFrom <= today))
    .map((f) => ({ ...f, daysAway: Math.round((Date.parse(`${f.date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY), live: f.showFrom <= today && today <= f.showTo }));
}

// The greeting the app shows today, if any (first one wins).
function today(now = new Date()) {
  const f = upcoming(0, now).find((x) => x.live);
  if (!f) return null;
  const d = f.design;
  return { id: f.id, name: f.name, title: d.headline, body: d.subtext, emoji: d.emoji, theme: d.theme };
}

// Tells the admins a few days before, once per festival.
async function checkAlerts() {
  const prisma = require('./prisma');
  const settings = await require('./vtpass').getSettings();
  if (settings.festivalGreetingsEnabled === false) return;
  const ahead = Math.max(1, Math.min(14, Number(settings.festivalAlertDays ?? 3)));
  for (const f of upcoming(ahead)) {
    if (f.daysAway < 0) continue;
    const done = await prisma.festivalAlert.findUnique({ where: { id: f.id } }).catch(() => null);
    if (done) continue;
    try {
      await prisma.festivalAlert.create({ data: { id: f.id } });
    } catch {
      continue; // another server got it first
    }
    const when = f.daysAway === 0 ? 'today' : f.daysAway === 1 ? 'tomorrow' : `in ${f.daysAway} days (${f.date})`;
    require('./adminAlert').alertAdmins(`${f.name} is ${when} — greeting ready`, `Your ${f.name} greeting pictures and caption are ready in Ad Studio → Festival greetings. Download them for social media; the app shows a greeting slide by itself on the day.${f.moon ? ' The date follows the moon sighting and may move by a day.' : ''}`, `/admin/ad-studio?festival=${encodeURIComponent(f.id)}`);
  }
}

// On the day: thank-you message to every customer (launch, anniversary,
// Customer Service Week). Once per date.
async function sendDayMessages() {
  const prisma = require('./prisma');
  const settings = await require('./vtpass').getSettings();
  if (settings.festivalGreetingsEnabled === false) return;
  for (const f of upcoming(0)) {
    if (!f.notifyAll || !f.live || f.daysAway > 0 || !f.design.notice) continue;
    try {
      await prisma.festivalAlert.create({ data: { id: `sent-${f.id}` } });
    } catch {
      continue;
    }
    const n = await require('./celebrations').messageEveryone(f.design.headline, f.design.notice);
    console.log('festival message sent:', f.id, n);
  }
}

function start() {
  if (process.env.DISABLE_SCHEDULER === '1') return;
  const run = () => {
    checkAlerts().catch((e) => console.error('festival alerts failed:', e.message));
    sendDayMessages().catch((e) => console.error('festival messages failed:', e.message));
    require('./celebrations').checkMilestones().catch((e) => console.error('milestones failed:', e.message));
  };
  setTimeout(run, 90 * 1000).unref?.();
  setInterval(run, 3 * 3600 * 1000).unref?.();
}

module.exports = { LAUNCH, csWeekStart, sendDayMessages, FESTIVALS, occurrences, upcoming, today, checkAlerts, start, easter, hijri };
