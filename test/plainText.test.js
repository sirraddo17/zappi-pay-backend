// AI Markdown → real formatting in emails, clean text elsewhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const { stripMarkdown, markdownToHtml } = require('../lib/plainText');

const BRIEF = 'Good morning! Yesterday was quiet.\n\n**What needs your attention today:**\n\n- **VTpass wallet at ₦6,864** – top up ₦10,000\n* **1 ticket waiting 522 hours** – "Why does my order failed"\n\n**Suggested action:** Fund VTpass. 2*500 = 1000';

test('plain text: no ** marks, bullets kept, maths untouched', () => {
  const t = stripMarkdown(BRIEF);
  assert.ok(!t.includes('**'));
  assert.match(t, /^• VTpass wallet at ₦6,864/m);
  assert.match(t, /^• 1 ticket waiting/m);
  assert.match(t, /What needs your attention today:/);
  assert.match(t, /2\*500 = 1000/);
});

test('email HTML: bold is real bold and customer text is escaped', () => {
  const h = markdownToHtml(`${BRIEF}\n<script>alert(1)</script>`);
  assert.match(h, /<b>What needs your attention today:<\/b>/);
  assert.match(h, /• <b>VTpass wallet at ₦6,864<\/b>/);
  assert.ok(!h.includes('**'));
  assert.ok(!h.includes('<script>'));
  assert.match(h, /&lt;script&gt;/);
});
