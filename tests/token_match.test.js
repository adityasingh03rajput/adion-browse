/**
 * Token-coverage matching tests: order-independent semantic grounding for
 * form fields whose labels differ from the planner's phrasing.
 */
const assert = require('assert');
const { scoreTokenOverlap } = require('../src/control-plane/tokenMatch');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('token_match');

check('order-independent label match resolves search field', () => {
  assert.ok(scoreTokenOverlap('elements search bar', 'Search elements') >= 0.6);
});

check('exact label scores a perfect match', () => {
  assert.strictEqual(scoreTokenOverlap('search elements', 'Search elements'), 1);
});

check('unrelated fields do not match', () => {
  assert.ok(scoreTokenOverlap('email address', 'Password') < 0.4);
});

check('partial coverage stays below the acceptance threshold', () => {
  assert.ok(scoreTokenOverlap('circle thumbnail', 'Add circle graphic to canvas') < 0.6);
});

check('stopword-only targets never match', () => {
  assert.strictEqual(scoreTokenOverlap('the input box', 'Search elements'), 0);
});

check('placeholder-style phrasing matches', () => {
  assert.ok(scoreTokenOverlap('message input', 'Type a message') >= 0.5);
});

console.log(`\n${passed} token-match tests passed`);
