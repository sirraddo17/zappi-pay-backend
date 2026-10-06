// The feature guide the AI assistants answer "how does X work?" from.
// lib/featureGuide.txt was written from the app's actual code: what each
// feature is, benefits, exact steps with real button names, rules and
// common questions. Here it is split into sections, matched to the
// question, and the live admin values (on/off, amounts) are attached so
// the AI never relies on defaults. UPDATE featureGuide.txt WHEN A FEATURE
// CHANGES.

const fs = require('fs');
const path = require('path');

const RAW = fs.readFileSync(path.join(__dirname, 'featureGuide.txt'), 'utf8');

// Sections look like:  ----\nN. TITLE\n----\nbody
const SECTIONS = [];
{
  const re = /^-{20,}\n(\d+)\. (.+)\n-{20,}\n([\s\S]*?)(?=^-{20,}\n\d+\. |^={20,}|(?![\s\S]))/gm;
  let m;
  while ((m = re.exec(RAW))) SECTIONS.push({ n: Number(m[1]), title: m[2].trim(), body: m[3].trim() });
}
const settingsListAt = RAW.indexOf('Settings that change customer-visible numbers');
const SETTINGS_NOTES = settingsListAt > 0 ? RAW.slice(settingsListAt) : '';
const INTRO = (RAW.match(/HOW TO READ THIS\n([\s\S]*?)\n-{20,}/) || [])[1] || '';

// Admin-only background details customers don't need explained.
const ADMIN_ONLY = new Set([0, 25, 49, 54]);

// Extra words people use for each section (title words also count).
const ALIASES = {
  1: 'fund funding deposit add money top up wallet account number bvn nin monnify transfer to wallet credited not credited manual',
  2: 'purchase failed debited refund pending how buying works pin pay',
  3: 'airtime recharge vtu credit',
  4: 'data bundle internet data mb gb sme plan',
  5: 'electricity light nepa token meter prepaid postpaid disco ikedc ekedc ibedc phed',
  6: 'cable tv dstv gotv startimes showmax decoder smartcard iuc subscription',
  7: 'education exam waec jamb neco pin result checker profile id',
  8: 'internet smile spectranet router mac',
  9: 'bet betting bet9ja sportybet betking fund bet wallet',
  10: 'send money transfer user friend p2p username phone qr scan receive',
  11: 'airtime to cash convert airtime sell airtime change airtime',
  12: 'best data deals cheapest budget finder',
  13: 'gift gifts gift card gift link surprise birthday',
  14: 'delivery promise late slow bonus seconds',
  15: 'family wallet family member child children kids pocket money allowance parent limit control spouse',
  16: 'bulk many numbers staff 50 numbers',
  17: 'reminder reminders renewal renew expiry due remind',
  18: 'agent agents agent mode agent pricing reseller become agent apply',
  19: 'profit book sales record owing debt customers book',
  20: 'print cards recharge card printing epin e-pin card pins sell cards shop kiosk pos printer',
  21: 'shop link agent shop link my shop store page commission',
  22: 'refer referral invite earn username code bonus friend',
  23: 'cashback loyalty points promo code coupon discount reward redeem',
  24: 'challenge challenges task reward monthly target',
  26: 'saved beneficiaries schedule scheduled repeat automatic auto top up recurring',
  27: 'order orders history receipt buy again report issue wrong',
  28: 'bank transfer send to bank withdraw withdrawal account name fee',
  29: 'savings save interest',
  30: 'kyc verify verification bvn nin daily limit limits unverified',
  31: 'transaction pin pin forgot pin change pin locked pin',
  32: 'quick login fingerprint face id biometric pin login',
  33: 'security devices sessions logged in freeze lost phone stolen hacked password',
  34: 'notification notifications push alerts email alerts bell',
  35: 'language pidgin yoruba hausa igbo dark mode theme lite mode slow network data saver',
  36: 'help chat ai assistant buy by chat voice note microphone talk',
  37: 'support ticket complain complaint screenshot report talk to support human agent',
  38: 'help centre faq questions',
  39: 'service status down network outage',
  40: 'maintenance paused pause notice',
  41: 'statement account statement history pdf download',
  42: 'delete account close account remove account',
  43: 'test mode banner not real',
  44: 'other extras',
  45: 'funding not showing not credited sent money wallet not funded bank alert screenshot check funding missing money',
  46: 'scam fraud fake message call link otp real legit genuine scammer suspicious',
  47: 'which data plan best data plan advice recommend data youtube tiktok whatsapp usage monthly',
  48: 'getting started get started new customer first steps checklist monthly summary weekly report shop report',
  50: 'request money pay me link ask for money split bill share bill group gift contribution collect money birthday wedding chip in owe',
  51: 'international airtime foreign airtime abroad ghana uk usa canada top up overseas diaspora',
  52: 'insurance car insurance third party motor insurance vehicle keke tricycle motorcycle certificate plate chassis',
  53: 'bulk exam pins waec result checker many pins school print sheet cyber cafe students',
  55: 'ajo circle esusu adashe isusu contribution thrift group savings rotating payout packing number pot late fee strike default circle members weekly monthly daily',
  56: 'owambe spray money party wedding birthday celebrant naming ceremony guests qr big screen dash',
  57: 'association dues estate landlord church mosque alumni club levy treasurer auto-pay reminder unpaid members',
  58: 'pay it for me ask someone to pay help me pay request link family pay my light data dstv for me',
  59: 'shared light pot housemates flatmates meter token contribute nepa electricity together split light bill',
  60: 'safebuy safe buy escrow buyer protection seller whatsapp instagram online deal hold money received dispute scam',
  61: 'payroll salary salaries staff staffs worker workers my staff pay staff employees payslip shop wages',
  62: 'daily rewards check in streak quiz question of the day free cashback bonus',
  63: 'bulk sms send sms text message customers members broadcast sender id sender name dnd marketing',
  64: 'event tickets ticket sell tickets buy ticket concert owambe party church programme seminar qr check in guest list',
  65: 'more bills tax taxes land use charge income tax lirs firs waste lawma water toll school fees professional body offering tithe donation biller',
  54: 'admin overview dashboard stat boxes pending orders failed orders successful orders held pins clickable',
  49: 'win back winback what if pricing problem spotter feedback digest scam reports agent verdict plan week check reply',
};

const STOP = new Set('the a an and or of to for in on with my is it how do does what why can i me you your use using work works about this that get start started benefit benefits'.split(' '));
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));

function score(section, q) {
  const hay = new Set(words(`${section.title} ${ALIASES[section.n] || ''}`));
  let s = 0;
  for (const w of q) {
    if (hay.has(w)) s += w.length > 3 ? 2 : 1;
    else if (w.length > 4 && [...hay].some((h) => h.length > 4 && (h.startsWith(w) || w.startsWith(h)))) s += 1;
  }
  // All the main title words asked about ("family wallet") → strong match.
  const tw = words(section.title.replace(/\(.*?\)/g, '')).filter((w) => w.length > 2);
  if (tw.length && tw.every((w) => q.includes(w))) s += 4;
  return s;
}

const SECRET = /key|secret|password|token|hash|vapid/i;
function fmt(v) {
  if (v === null || v === undefined || v === '') return 'not set';
  if (typeof v === 'boolean') return v ? 'ON' : 'OFF';
  if (typeof v === 'object' && typeof v.toNumber === 'function') return String(v.toNumber());
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 160);
  return String(v);
}

// Live admin values for every setting the section mentions.
function liveValues(text, settings) {
  if (!settings) return '';
  const names = new Set((text.match(/\b[a-z][a-zA-Z]{4,}\b/g) || []).filter((w) => /[A-Z]/.test(w) && Object.prototype.hasOwnProperty.call(settings, w) && !SECRET.test(w)));
  if (!names.size) return '';
  return `\nLIVE VALUES RIGHT NOW (use these, not the defaults above; OFF means the feature is switched off for customers):\n${[...names].map((n) => `- ${n} = ${fmt(settings[n])}`).join('\n')}`;
}

function index({ audience = 'customer' } = {}) {
  return SECTIONS.filter((s) => audience === 'admin' || !ADMIN_ONLY.has(s.n)).map((s) => `${s.n}. ${s.title}`).join('\n');
}

// Best 1-2 sections for a question or topic (or a section number).
function lookup(query, { settings, audience = 'customer', max = 2 } = {}) {
  const allowed = SECTIONS.filter((s) => audience === 'admin' || !ADMIN_ONLY.has(s.n));
  const asNum = parseInt(String(query).trim(), 10);
  let picked = [];
  if (String(asNum) === String(query).trim()) picked = allowed.filter((s) => s.n === asNum);
  if (!picked.length) {
    const q = words(query);
    if (/\bget(ting)? started\b|\bnew here\b|\bfirst time\b/i.test(String(query))) q.push('getting', 'started', 'new', 'customer');
    const ranked = allowed.map((s) => ({ s, v: score(s, q) })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
    // A second section only when it is nearly as relevant as the first.
    picked = ranked.filter((x, i) => i === 0 || x.v >= ranked[0].v * 0.7).slice(0, max).map((x) => x.s);
  }
  if (!picked.length) return { found: false, note: 'No guide section matches. Do not guess how this works — say you are not sure and offer to connect them to support.', topics: index({ audience }) };
  return {
    found: true,
    sections: picked.map((s) => `### ${s.n}. ${s.title}\n${s.body}${liveValues(s.body, settings)}`).join('\n\n'),
    howToRead: INTRO.trim(),
  };
}

module.exports = { lookup, index, SECTIONS, SETTINGS_NOTES };
