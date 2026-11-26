const test = require('node:test');
const assert = require('node:assert');
const { withWakeTime } = require('../lib/dbUrl');

test('database link gets 15s to wake, without overriding a set value', () => {
  assert.equal(withWakeTime('postgresql://u:p@h/db?sslmode=require'), 'postgresql://u:p@h/db?sslmode=require&connect_timeout=15');
  assert.equal(withWakeTime('postgresql://u:p@h/db'), 'postgresql://u:p@h/db?connect_timeout=15');
  assert.equal(withWakeTime('postgresql://u:p@h/db?connect_timeout=30'), 'postgresql://u:p@h/db?connect_timeout=30');
  assert.equal(withWakeTime(''), '');
});

test('squad sweep rests on refused keys only', () => {
  const { keysRefused } = require('../lib/squad');
  assert.equal(keysRefused({ status: 401, message: 'x' }), true);
  assert.equal(keysRefused({ status: 400, message: 'Authentication failed' }), true);
  assert.equal(keysRefused({ status: 500, message: 'Server error' }), false);
  assert.equal(keysRefused({ message: "Can't reach database server" }), false);
});
