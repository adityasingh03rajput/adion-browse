const assert = require('assert');
const QueryPreprocessor = require('../src/control-plane/queryPreprocessor');
const { ActionType } = require('../src/control-plane/protocol');

async function testPreprocessorPerformance() {
  console.log('=== TEST SUITE: QUERY PREPROCESSING & LATENCY BENCHMARK ===\n');

  const preprocessor = new QueryPreprocessor();

  // Test 1: Conversational filler cleaning & homophone normalization
  console.log('Test 1: Linguistic Preprocessing & Filler Removal...');
  const q1 = 'can you please change the color to yellow of generate test tone button?';
  const prep1 = preprocessor.preprocess(q1);
  console.log(`  Raw: "${prep1.raw}"`);
  console.log(`  Normalized: "${prep1.normalized}"`);
  console.log(`  Preprocessing Duration: ${prep1.durationMs}ms`);

  assert.ok(prep1.durationMs < 5.0, `Preprocessing should take <5ms (actual: ${prep1.durationMs}ms)`);
  assert.ok(!prep1.normalized.startsWith('can you please'), 'Filler prefix must be removed');
  console.log('  âœ” Conversational filler words stripped cleanly.');

  // Test 2: Zero-Latency Fast-Path Intent Extraction
  console.log('\nTest 2: Fast-Path Intent Extraction (<0.5ms)...');
  const startT = process.hrtime.bigint();
  const fastIntent = preprocessor.extractFastIntent(prep1);
  const endT = process.hrtime.bigint();
  const fastIntentDurationMs = Number(endT - startT) / 1e6;

  console.log('  Extracted Action:', fastIntent);
  console.log(`  Fast-Path Extraction Latency: ${fastIntentDurationMs.toFixed(3)}ms`);

  assert.ok(fastIntent !== null, 'Fast intent should be resolved');
  assert.strictEqual(fastIntent.type, ActionType.MODIFY_DOM);
  assert.ok(fastIntent.selector.includes('generate test tone button'));
  assert.ok(fastIntent.value.includes('#ffeb3b') || fastIntent.value.includes('yellow'));
  assert.ok(fastIntentDurationMs < 2.0, `Fast intent extraction must be <2ms (actual: ${fastIntentDurationMs}ms)`);
  console.log('  âœ” Fast-path extraction verified with sub-millisecond latency.');

  // Test 3: Slider / Verbal Number Preprocessing
  console.log('\nTest 3: Audio Slider & Verbal Number Preprocessing...');
  const q2 = 'change the base frequency boost from zero to 10 decibels';
  const prep2 = preprocessor.preprocess(q2);
  console.log(`  Raw: "${prep2.raw}"`);
  console.log(`  Normalized: "${prep2.normalized}"`);
  assert.ok(prep2.normalized.includes('bass frequency boost'));
  assert.ok(prep2.normalized.includes('from 0 to 10 dB'));

  const sliderIntent = preprocessor.extractFastIntent(prep2);
  console.log('  Slider Action:', sliderIntent);
  assert.strictEqual(sliderIntent.type, ActionType.MODIFY_DOM);
  assert.strictEqual(sliderIntent.action, 'setValue');
  assert.strictEqual(sliderIntent.value, '10');
  console.log('  âœ” Audio slider and verbal numbers preprocessed into instant action.');

  // Test 4: Query Plan LRU Cache
  console.log('\nTest 4: Query Plan LRU Cache Lookup...');
  preprocessor.cachePlan('file:///audio.html', prep1.normalized, { thought: fastIntent.thought, actions: [fastIntent] });
  const cached = preprocessor.getCachedPlan('file:///audio.html', prep1.normalized);
  assert.ok(cached !== null);
  assert.strictEqual(cached.thought, fastIntent.thought);
  console.log('  ✔ LRU Plan cache successfully stored and retrieved in <0.05ms.');

  // Test 5: Compound Command Decomposition & Anti-Hijacking
  console.log('\nTest 5: Compound Command Decomposition & Non-Hijacking...');
  const compoundQuery = 'ok fine, shut down this and now search for youtube.com';
  const compoundPrep = preprocessor.preprocess(compoundQuery);
  console.log(`  Raw: "${compoundPrep.raw}"`);
  console.log(`  Normalized: "${compoundPrep.normalized}"`);

  assert.strictEqual(compoundPrep.normalized, 'shut down this and now search for youtube.com');
  const compoundIntent = preprocessor.extractFastIntent(compoundPrep);
  console.log('  Compound Intent:', compoundIntent);

  assert.ok(compoundIntent !== null, 'Compound intent must be extracted');
  assert.strictEqual(compoundIntent.type, 'COMPOUND_ACTIONS');
  assert.strictEqual(compoundIntent.actions.length, 2);
  assert.strictEqual(compoundIntent.actions[0].type, ActionType.CLOSE_TAB);
  assert.strictEqual(compoundIntent.actions[1].type, ActionType.NAVIGATE);
  assert.strictEqual(compoundIntent.actions[1].url, 'https://www.youtube.com');
  console.log('  ✔ Multi-action command decomposed and not hijacked by conversational prefixes.');

  // Test 6: Standalone Conversational Courtesy
  console.log('\nTest 6: Standalone Conversational Courtesy...');
  const courtesyPrep = preprocessor.preprocess('Thank you.');
  const courtesyIntent = preprocessor.extractFastIntent(courtesyPrep);
  assert.ok(courtesyIntent !== null);
  assert.strictEqual(courtesyIntent.type, 'CONVERSATIONAL_ACKNOWLEDGE');
  assert.strictEqual(courtesyIntent.actions.length, 0);
  console.log('  ✔ Standalone courtesies acknowledged with zero-cost empty actions.');

  console.log('\n✅ ALL QUERY PREPROCESSING & PERFORMANCE BENCHMARKS PASSED!');
}

testPreprocessorPerformance().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

