/**
 * Universal Cognitive Element Grounding Engine Test Suite
 * 
 * Verifies:
 * 1. Formatting quirks: accidental spaces, irregular spacing, hyphens, non-breaking spaces (\u00A0), zero-width characters.
 * 2. Abstract shapes & visual element indicators: input submit values, SVGs, icon fonts.
 * 3. Semantic intent clusters: SIGN_UP, SIGN_IN, SEARCH, CART, MENU, CLOSE.
 * 4. Antonym protection: "Sign Up" vs "Sign In" conflict avoidance with cross-questioning.
 * 5. IIFE DOM Evaluation Script generation and correctness.
 */

const assert = require('assert');
const {
  SEMANTIC_CLUSTERS,
  canonicalNormalize,
  compactNormalize,
  detectSemanticCluster,
  buildDOMGroundingScript
} = require('../src/control-plane/universalGrounder');

async function runUniversalGroundingTests() {
  console.log('=== TEST SUITE: UNIVERSAL COGNITIVE ELEMENT GROUNDING ===\n');

  // Test 1: Accidental spaces and punctuation quirks
  console.log('Test 1: Formatting Quirks & Accidental Spaces Resilience...');
  assert.strictEqual(compactNormalize('sign   up'), 'signup', 'Multiple spaces should collapse');
  assert.strictEqual(compactNormalize('s i g n u p'), 'signup', 'Accidental letter spacing should collapse');
  assert.strictEqual(compactNormalize('  sign  -  up  '), 'signup', 'Hyphens and spaces should collapse');
  assert.strictEqual(compactNormalize('Sign-Up'), 'signup', 'Casing and hyphens should normalize');
  assert.strictEqual(compactNormalize('SIGN_UP'), 'signup', 'Underscore and casing should normalize');
  console.log('  ✔ Accidental spaces and punctuation variants normalized to compact canonical forms.');

  // Test 2: Unicode quirks (non-breaking spaces, zero-width chars, emojis)
  console.log('\nTest 2: Unicode Non-Breaking Spaces, Zero-Width Chars & Emojis...');
  const nbspStr = 'sign\u00A0up';
  const zwspStr = 'sign\u200Bup';
  const softHyphen = 'sign\u00ADup';
  assert.strictEqual(compactNormalize(nbspStr), 'signup', 'NBSP should be normalized');
  assert.strictEqual(compactNormalize(zwspStr), 'signup', 'ZWSP should be stripped');
  assert.strictEqual(compactNormalize(softHyphen), 'signup', 'Soft hyphen should be stripped');
  assert.strictEqual(canonicalNormalize('🚀 Sign Up Now! 🎯'), 'sign up now!', 'Emojis stripped cleanly');
  assert.strictEqual(compactNormalize('🚀 Sign Up Now! 🎯'), 'signupnow', 'Emojis stripped in compact form');
  console.log('  ✔ Unicode quirks & emojis handled with human-like visual resilience.');

  // Test 3: Semantic Intent Classification
  console.log('\nTest 3: Semantic Intent Classification (Sign Up vs Sign In, Search, Cart)...');
  assert.strictEqual(detectSemanticCluster('sign up'), 'SIGN_UP');
  assert.strictEqual(detectSemanticCluster('signup'), 'SIGN_UP');
  assert.strictEqual(detectSemanticCluster('s i g n   u p'), 'SIGN_UP');
  assert.strictEqual(detectSemanticCluster('create account'), 'SIGN_UP');
  assert.strictEqual(detectSemanticCluster('register now'), 'SIGN_UP');
  assert.strictEqual(detectSemanticCluster('join free'), 'SIGN_UP');

  assert.strictEqual(detectSemanticCluster('sign in'), 'SIGN_IN');
  assert.strictEqual(detectSemanticCluster('signin'), 'SIGN_IN');
  assert.strictEqual(detectSemanticCluster('log in'), 'SIGN_IN');
  assert.strictEqual(detectSemanticCluster('login'), 'SIGN_IN');
  assert.strictEqual(detectSemanticCluster('welcome back'), 'SIGN_IN');

  assert.strictEqual(detectSemanticCluster('search'), 'SEARCH');
  assert.strictEqual(detectSemanticCluster('find book'), 'SEARCH');
  assert.strictEqual(detectSemanticCluster('cart'), 'CART');
  assert.strictEqual(detectSemanticCluster('checkout'), 'CART');
  assert.strictEqual(detectSemanticCluster('menu'), 'MENU');
  assert.strictEqual(detectSemanticCluster('close dialog'), 'CLOSE');
  console.log('  ✔ Semantic intent clusters correctly classified across multi-token expressions.');

  // Test 4: Antonym Disambiguation & Reciprocal Conflict Prevention
  console.log('\nTest 4: Antonym Protection & Reciprocal Disambiguation...');
  assert.strictEqual(SEMANTIC_CLUSTERS.SIGN_UP.antonymCluster, 'SIGN_IN');
  assert.strictEqual(SEMANTIC_CLUSTERS.SIGN_IN.antonymCluster, 'SIGN_UP');

  const scriptSignUp = buildDOMGroundingScript('Sign Up');
  assert.ok(scriptSignUp.includes('OPPOSITE_INTENT_DETECTED'), 'Script must support cross-questioning on opposite intent');
  assert.ok(scriptSignUp.includes('score -= 2500'), 'Script must apply severe antonym penalty');
  assert.ok(scriptSignUp.includes('crossQuestion:'), 'Script must generate cross-questioning query');
  console.log('  ✔ Strict antonym penalty (-2500) and cross-questioning verified.');

  // Test 5: Abstract Shape & Visual Element Grounding
  console.log('\nTest 5: Abstract Shapes, SVG Icons & Submit Values...');
  const scriptSearch = buildDOMGroundingScript('search');
  assert.ok(scriptSearch.includes('valueAttr'), 'Script must evaluate input submit values');
  assert.ok(scriptSearch.includes('svgIconHint'), 'Script must evaluate SVG classes and names');
  assert.ok(scriptSearch.includes('magnifying'), 'Script must inspect magnifying glass icons');
  console.log('  ✔ Abstract shape & SVG icon detection rules confirmed.');

  // Test 6: End-to-End DOM Evaluation Simulation (BooksByMohit "Sign Up" vs "Log In")
  console.log('\nTest 6: End-to-End DOM Mock Grounding ("Sign Up" on navbar with "Log In")...');
  const elLogin = {
    tagName: 'BUTTON',
    innerText: 'Log In',
    value: '',
    getAttribute: (a) => a === 'role' ? 'button' : null,
    getBoundingClientRect: () => ({ left: 400, top: 20, width: 80, height: 36 }),
    closest: function() { return this; },
    querySelector: () => null,
    classList: ['btn-login'],
    scrollIntoView: () => {},
    dispatchEvent: () => {}
  };

  const elSignUp = {
    tagName: 'BUTTON',
    innerText: 'Sign Up',
    value: '',
    getAttribute: (a) => a === 'role' ? 'button' : null,
    getBoundingClientRect: () => ({ left: 500, top: 20, width: 90, height: 36 }),
    closest: function() { return this; },
    querySelector: () => null,
    classList: ['btn-signup', 'bg-orange'],
    scrollIntoView: () => {},
    dispatchEvent: () => {}
  };

  let list = [elLogin, elSignUp];
  let idx = 0;
  global.document = {
    body: { appendChild: () => {} },
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, remove: () => {}, style: {} }),
    head: { appendChild: () => {} },
    createTreeWalker: () => ({
      currentNode: list[0],
      nextNode: () => {
        idx++;
        return list[idx] || null;
      }
    })
  };
  global.NodeFilter = { SHOW_ELEMENT: 1 };
  global.window = {
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', cursor: 'pointer' })
  };

  // Case A: Both "Log In" and "Sign Up" are present (BooksByMohit navbar)
  idx = 0;
  const resBoth = eval(buildDOMGroundingScript('Sign Up'));
  assert.strictEqual(resBoth.found, true, 'Must find Sign Up button');
  assert.strictEqual(resBoth.name, 'Sign Up', 'Must target Sign Up, NOT Log In');
  assert.strictEqual(resBoth.tag, 'button');
  assert.strictEqual(resBoth.x, 545);
  assert.strictEqual(resBoth.y, 38);
  console.log('  ✔ Correctly targeted "Sign Up" button on navbar amidst "Log In" button.');

  // Case B: Only "Log In" is present on page when user asked for "Sign Up" -> Triggers Cross-Questioning!
  list = [elLogin];
  idx = 0;
  const resOpposite = eval(buildDOMGroundingScript('Sign Up'));
  assert.strictEqual(resOpposite.found, false, 'Must not click Log In blindly');
  assert.strictEqual(resOpposite.reason, 'OPPOSITE_INTENT_DETECTED');
  assert.ok(resOpposite.crossQuestion.includes('I found "Log In" on this page, but you asked for Sign Up'));
  console.log('  ✔ Triggered cross-questioning when only opposite intent ("Log In") was present.');

  console.log('\n========================================================');
  console.log('🎉 ALL UNIVERSAL ELEMENT GROUNDING TESTS PASSED (6/6)');
  console.log('========================================================\n');
}

runUniversalGroundingTests().catch(err => {
  console.error('❌ Universal Grounding Test Failed:', err);
  process.exit(1);
});
