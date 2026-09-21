const test = require('node:test');
const assert = require('node:assert/strict');
const { lastPage, verdict, exitCode } = require('../scripts/smoke-verdict');

const bar = (label, kind = '') => ({ kind, label });

test('smoke: only finished page bars count as pages', () => {
  assert.equal(lastPage([bar('Page 2'), bar('Page 3')]), 3);
  assert.equal(lastPage([bar('Page 2 failed (HTTP 403). Paused.', 'err')]), 1, 'a failed page is not a page');
  assert.equal(lastPage([bar('Page 2'), bar('Loading page 3…', 'loading'), bar('No more pages.', 'end')]), 2);
  assert.equal(lastPage([]), 1);
});

test('smoke: verdicts', () => {
  const active = { expect: 'active' };
  const quiet = { expect: 'inactive' };
  const base = { bars: [], active: false, onwardErrors: [] };
  assert.equal(verdict(active, { ...base, active: true, bars: [bar('Page 2')] }), 'OK');
  // XenForo in the review's run: its only bar was a failure, which used to count as page 2.
  assert.match(verdict(active, { ...base, active: true, bars: [bar('Page 2 failed (HTTP 403). Paused.', 'err')], refused: 'HTTP 403' }), /^NOT CHECKED \(the site refused/);
  assert.match(verdict(active, { ...base, active: true, bars: [bar('Page 2 failed (HTTP 500). Paused.', 'err')] }), /^MISMATCH/);
  assert.equal(verdict(quiet, base), 'OK');
  assert.match(verdict(quiet, { ...base, active: true }), /^MISMATCH/, 'active without a page yet is not inactive');
  assert.match(verdict(quiet, { ...base, onwardErrors: ['boom'] }), /^MISMATCH \(Onward threw: boom\)/, 'a crash is not staying inactive');
  assert.match(verdict(active, { ...base, botCheck: true }), /^NOT CHECKED/);
  assert.equal(verdict({}, base), '', 'no expectation, no verdict');
});

test('smoke: a run that could check nothing does not pass', () => {
  assert.equal(exitCode({ OK: 3, 'NOT CHECKED': 2, MISMATCH: 0 }), 0);
  assert.equal(exitCode({ OK: 3, 'NOT CHECKED': 0, MISMATCH: 1 }), 1);
  assert.equal(exitCode({ OK: 0, 'NOT CHECKED': 5, MISMATCH: 0 }), 2);
});
