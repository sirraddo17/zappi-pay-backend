// Help chat quick airtime buy without the AI: only clear requests become a
// Pay card; questions and complaints are left to the help answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parse } = require('../lib/quickBuy');

test('clear airtime requests are understood', () => {
  assert.deepEqual(parse('₦500 MTN airtime to 08167550937'), { amount: 500, network: 'mtn', phone: '08167550937', self: false });
  assert.deepEqual(parse('airtime 1k for me'), { amount: 1000, network: null, phone: null, self: true });
  assert.deepEqual(parse('Buy 2,000 glo recharge for 0805 123 4567'), { amount: 2000, network: 'glo', phone: '08051234567', self: false });
  assert.equal(parse('send 200 airtel credit to +2348031234567').phone, '08031234567');
});

test('questions, complaints, data and unclear messages are not turned into a purchase', () => {
  for (const t of ['how do I buy airtime?', 'my airtime was not credited 08031234567', '₦500 MTN data to 08031234567', 'airtime to cash 1000', 'airtime', '500 airtime', 'why did my airtime fail']) assert.equal(parse(t), null, t);
});

test('wiring: quick buy route uses the normal Pay card (no purchase without PIN)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/quickBuy.js'), 'utf8');
  assert.match(src, /prepare_purchase\(/);
  assert.ok(!/require\('\.\/purchase'\)/.test(src), 'never buys by itself');
  assert.match(fs.readFileSync(path.join(__dirname, '../routes/ai.routes.js'), 'utf8'), /router\.post\('\/chat\/quick-buy', requireCustomerAuth/);
});
