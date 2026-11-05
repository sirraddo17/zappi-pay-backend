// Send to Bank backup partner safety: a transfer that started on a LIVE
// partner never falls back to a SANDBOX partner, and the backup's name
// check must show the same account holder the customer confirmed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test';
const d = require('../lib/disbursement');

test('live never falls back to sandbox', () => {
  assert.equal(d.backupAllowed('live', 'sandbox'), false);
  assert.equal(d.backupAllowed('live', undefined), false);
  assert.equal(d.backupAllowed('live', 'live'), true);
  assert.equal(d.backupAllowed('sandbox', 'sandbox'), true, 'testing on sandbox can still use a sandbox backup');
});

test('backup must confirm the same account holder', () => {
  assert.equal(d.sameAccountHolder('RIDWAN OLALEKAN ADEYEMO', 'Ethan Amelia'), false, 'sandbox dummy name is refused');
  assert.equal(d.sameAccountHolder('RIDWAN OLALEKAN ADEYEMO', 'ADEYEMO RIDWAN'), true, 'word order differs between banks');
  assert.equal(d.sameAccountHolder('RIDWAN OLALEKAN ADEYEMO', 'ADEYEMO RIDWAN OLALEKAN'), true);
  assert.equal(d.sameAccountHolder('DAMILARE SAMUEL OGUNNAIKE', 'DAMILARE ADEYEMO'), false, 'one shared word is not enough');
});

test('reroute keeps the confirmed name and checks it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'disbursement.js'), 'utf8');
  const reroute = src.slice(src.indexOf('async function reroute('), src.indexOf('// tried: partners this transfer'));
  assert.match(reroute, /sameAccountHolder\(transfer\.accountName, acct\.accountName\)/);
  assert.ok(!/accountName: acct\.accountName/.test(reroute), 'the backup name never replaces the confirmed one');
  assert.match(src.slice(src.indexOf('async function backupFor('), src.indexOf('// Free balance check')), /backupAllowed\(modes\[p\], modes\[b\]\)/);
});
