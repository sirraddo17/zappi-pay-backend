// "Free from ₦X": deposits of at least X through Squad/Nomba pay no fee
// (ZAPPI PAY covers the partner's charge); smaller ones pay the normal fee.
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../lib/fundingFees');

const S = { bankFundingFeePercent: 1.6, bankFundingFeeCap: 2150, squadFundingFeePercent: 0.27, squadFundingFeeCap: 1075, squadFundingFreeFrom: 1000 };

test('Squad: free from ₦1,000; smaller deposits pay the normal fee', () => {
  assert.equal(F.computeFee(999, S, 'squad'), 2.7, '₦999 pays 0.27%');
  assert.equal(F.computeFee(1000, S, 'squad'), 0, '₦1,000 is free');
  assert.equal(F.computeFee(500000, S, 'squad'), 0);
  assert.equal(F.computeFee(1000, S, 'monnify'), 16, 'Monnify unchanged');
  assert.equal(F.computeFee(1000, S, 'nomba'), 16, 'Nomba has no free-from set (uses Monnify fee)');
});

test('off when empty or 0; shown to the app; saved by the admin form', () => {
  assert.equal(F.computeFee(5000, { ...S, squadFundingFreeFrom: null }, 'squad'), 13.5);
  assert.equal(F.computeFee(5000, { ...S, squadFundingFreeFrom: 0 }, 'squad'), 13.5);
  assert.equal(F.publicFees(S).squad.freeFrom, 1000);
  assert.deepEqual(F.parseFee({ fundingFreeFrom: '1000' }), { fundingFreeFrom: 1000 });
  assert.deepEqual(F.parseFee({ fundingFreeFrom: '' }), { fundingFreeFrom: null });
  assert.throws(() => F.parseFee({ fundingFreeFrom: -5 }), /free from/);
});
