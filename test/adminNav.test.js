// The admin AI's navigation buttons: screens, Settings sections and cards
// inside pages; anything else becomes plain text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const nav = require('../lib/adminNav');

test('section buttons allowed; unknown ones removed', () => {
  for (const p of ['/admin/money#compliance', '/admin/money#funds-guard', '/admin/partners#hidden-services', '/admin/go-live#reset-kyc', '/admin/customers/abc123def#adjust-wallet', '/admin/settings?tab=ai&sub=assistant', '/admin/settings?tab=monnify&sub=squad']) assert.ok(nav.allowed(p), p);
  for (const p of ['/admin/customers/abc123def#other', '/admin/money#nope', 'https://x.com', '/admin/nowhere']) assert.ok(!nav.allowed(p), p);
  assert.equal(nav.cleanLinks('[[go:/admin/money#nope|Bad]]'), 'Bad');
});

test('every section id exists on its page in the frontend (when the frontend is next to us)', () => {
  const fe = path.join(__dirname, '..', '..', 'zappi-pay-frontend', 'src');
  if (!fs.existsSync(fe)) return;
  const page = { '/admin/money': 'pages/admin/AdminMoney.jsx', '/admin/partners': 'pages/admin/AdminPartners.jsx', '/admin/go-live': 'pages/admin/AdminGoLive.jsx' };
  for (const [p] of nav.SECTIONS) {
    const [base, id] = p.split('#');
    if (!id) continue;
    assert.match(fs.readFileSync(path.join(fe, page[base]), 'utf8'), new RegExp(`id="${id}"`), p);
  }
  const cust = fs.readFileSync(path.join(fe, 'pages/admin/AdminCustomerDetail.jsx'), 'utf8');
  for (const id of nav.CUSTOMER_SECTIONS) assert.match(cust, new RegExp(`id="${id}"`), id);
});
