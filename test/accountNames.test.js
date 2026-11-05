// What the sender's bank app shows for each partner's account number.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bankShowsName } = require('../lib/accountNames');

test('Monnify live: SIRRADDO GLOBAL- plus the short name Monnify returns', () => {
  assert.equal(bankShowsName({ provider: 'monnify', accountName: 'RID' }), 'SIRRADDO GLOBAL-RID');
  assert.equal(bankShowsName({ accountName: 'RID' }), 'SIRRADDO GLOBAL-RID', 'old rows without a provider are Monnify');
  assert.equal(bankShowsName({ provider: 'monnify', accountName: 'SIRRADDO GLOBAL-RID' }), 'SIRRADDO GLOBAL-RID', 'never doubled');
});
test('Nomba: company name; Squad: what Squad returned', () => {
  assert.equal(bankShowsName({ provider: 'nomba', accountName: 'ZAPPI PAY/ADEYEMO' }), 'SIRRADDO GLOBAL LIMITED');
  assert.equal(bankShowsName({ provider: 'squad', accountName: 'ADEYEMO RIDWAN' }), 'ADEYEMO RIDWAN');
});
