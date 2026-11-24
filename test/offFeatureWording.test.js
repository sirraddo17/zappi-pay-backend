// Switched-off features: one plain answer (no launch hint, no outside
// vendor); admin AI rule for replying to customer messages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const f = require('../lib/features');

const ROOT = path.resolve(__dirname, '..');

test('off reply: plain, no launch hint; Airtime to Cash adds the scam warning', () => {
  const a = f.offReply('Family wallet', 'family');
  assert.equal(a, 'Family wallet isn’t available on ZAPPI PAY yet. You can buy airtime, data, electricity, cable TV and exam PINs from your wallet.');
  const b = f.offReply('Airtime to Cash', 'airtimeToCash');
  assert.match(b, /We don’t work with outside vendors for this, so we can’t recommend one\./);
  assert.match(b, /send airtime first or shows “payment successful” screenshots — that’s a common scam\./);
  for (const t of [a, b]) assert.ok(!/announce it|when it.s ready|almost ready/i.test(t), t);
  const note = f.offNote({}, 'x');
  assert.match(note, /Never say "coming soon"/);
  assert.match(note, /For Airtime to Cash also add/);
  assert.ok(!f.offNote({ airtimeToCashEnabled: true }, 'x').includes('For Airtime to Cash'), 'no A2C line when it is on');
});

test('customer AI: prompt, A2C tool and bet funding follow the rule', () => {
  const routes = fs.readFileSync(path.join(ROOT, 'routes/ai.routes.js'), 'utf8');
  const cust = routes.slice(routes.indexOf('function customerSystemPrompt'), routes.indexOf("router.get('/ai/status'"));
  assert.ok(!/bet funding|airtime-to-cash/i.test(cust.split('\n')[1]), 'intro lists only core services');
  assert.match(cust, /Never say "coming soon"/);
  const help = fs.readFileSync(path.join(ROOT, 'lib/chatHelp.js'), 'utf8');
  assert.match(help, /enabled: false, replyExactly: require\('\.\/features'\)\.offReply\('Airtime to Cash', 'airtimeToCash'\)/);
  assert.ok(!/coming soon/i.test(fs.readFileSync(path.join(ROOT, 'lib/chatBuy.js'), 'utf8')));
});

test('admin AI: rule for replying to customer / public messages', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/ai.routes.js'), 'utf8');
  const adm = src.slice(src.indexOf('function adminSystemPrompt'));
  const rule = adm.slice(adm.indexOf('Messages FROM CUSTOMERS'), adm.indexOf('- Rough text from the owner'));
  assert.ok(rule.length > 200, 'rule present before the rough-text rule');
  for (const re of [/say in one line what they want/, /get_feature_guide and get_settings_overview/, /find_customers/, /— ZAPPI PAY/, /"Subject: …"/, /not offered on ZAPPI PAY yet/, /never recommend or name an outside vendor/, /scam warning/, /never ask for or repeat a PIN, password, OTP, BVN, NIN or card number/, /never promise a refund/, /don't repeat it/]) assert.match(rule, re);
});
