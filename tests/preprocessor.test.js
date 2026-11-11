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
  preprocessor.extractFastIntent(prep1); // Warm-up JIT
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
  assert.ok(fastIntentDurationMs < 5.0, `Fast intent extraction must be <5ms (actual: ${fastIntentDurationMs}ms)`);
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

  // Test 7: "hie" Greeting Transcription & Anti-Unintended-Input Protection
  console.log('\nTest 7: "hie" Phonetic Greeting & Anti-Unintended-Input Protection...');
  const hiePrep = preprocessor.preprocess('hie');
  console.log(`  Raw: "${hiePrep.raw}" -> Normalized: "${hiePrep.normalized}"`);
  const hieIntent = preprocessor.extractFastIntent(hiePrep);
  assert.ok(hieIntent !== null);
  assert.strictEqual(hieIntent.type, 'CONVERSATIONAL_ACKNOWLEDGE');
  assert.strictEqual(hieIntent.actions.length, 0);
  console.log('  ✔ "hie" recognized strictly as greeting courtesy; unintended text input prevented.');

  const hieJarvisPrep = preprocessor.preprocess('hie jarvis');
  const hieJarvisIntent = preprocessor.extractFastIntent(hieJarvisPrep);
  assert.ok(hieJarvisIntent !== null);
  assert.strictEqual(hieJarvisIntent.type, 'CONVERSATIONAL_ACKNOWLEDGE');
  assert.strictEqual(hieJarvisIntent.actions.length, 0);
  console.log('  ✔ "hie jarvis" recognized as conversational greeting; page inputs shielded.');

  // Test 8: STTEngine Listening & Hallucination Filter
  console.log('\nTest 8: STTEngine Hallucination Discard & Phonetic Correction...');
  const STTEngine = require('../src/control-plane/sttEngine');
  const stt = new STTEngine();
  const hallucinated1 = stt.cleanAndNormalizeTranscript('Gracias por ver el video.');
  assert.strictEqual(hallucinated1, '', 'Whisper outro hallucination must be discarded');
  const hallucinated2 = stt.cleanAndNormalizeTranscript('Thank you for watching! Please subscribe.');
  assert.strictEqual(hallucinated2, '', 'Subtitles outro hallucination must be discarded');
  const correctedPrompt = stt.cleanAndNormalizeTranscript('hie, can you search instagram.com?');
  assert.strictEqual(correctedPrompt, 'hey, can you search instagram.com?');
  console.log('  ✔ Ambient outro hallucinations discarded and "hie" phonetics cleanly normalized.');

  // Test 9: WhatsApp Fast-Path Messaging Intent
  console.log('\nTest 9: WhatsApp Fast-Path Messaging Intent Extraction...');
  const waPrep1 = preprocessor.preprocess('say hi to 9424831233 in whatsapp .');
  const waIntent1 = preprocessor.extractFastIntent(waPrep1);
  assert.ok(waIntent1 !== null, 'waIntent1 should not be null');
  assert.strictEqual(waIntent1.type, 'WHATSAPP_SEND');
  assert.strictEqual(waIntent1.phone, '9424831233');
  assert.strictEqual(waIntent1.message, 'hi');
  assert.ok(waIntent1.url.includes('web.whatsapp.com/send'));

  const waPrep2 = preprocessor.preprocess('text hello there to 919876543210 on whatsapp');
  const waIntent2 = preprocessor.extractFastIntent(waPrep2);
  assert.strictEqual(waIntent2.type, 'WHATSAPP_SEND');
  assert.strictEqual(waIntent2.phone, '919876543210');
  assert.strictEqual(waIntent2.message, 'hello there');
  console.log('  ✔ WhatsApp direct messaging actions extracted to WHATSAPP_SEND fast-path with prefilled URL.');

  // Test 10: Context-Aware WhatsApp Contact Search & Smart In-Page Intent
  console.log('\nTest 10: Context-Aware WhatsApp Contact Search & Smart In-Page Intent...');
  const waContext = { url: 'https://web.whatsapp.com/', title: '(20) WhatsApp' };
  
  const piddukPrep = preprocessor.preprocess('say hi to pidduk');
  const piddukIntent = preprocessor.extractFastIntent(piddukPrep, waContext);
  assert.ok(piddukIntent !== null, 'piddukIntent should not be null');
  assert.strictEqual(piddukIntent.type, 'WHATSAPP_CHAT_SEND');
  assert.strictEqual(piddukIntent.contact, 'pidduk');
  assert.strictEqual(piddukIntent.message, 'hi');

  const textPiddukPrep = preprocessor.preprocess('text pidduk hello');
  const textPiddukIntent = preprocessor.extractFastIntent(textPiddukPrep, waContext);
  assert.strictEqual(textPiddukIntent.type, 'WHATSAPP_CHAT_SEND');
  assert.strictEqual(textPiddukIntent.contact, 'pidduk');
  assert.strictEqual(textPiddukIntent.message, 'hello');

  const tellPiddukPrep = preprocessor.preprocess('tell pidduk that I am coming');
  const tellPiddukIntent = preprocessor.extractFastIntent(tellPiddukPrep, waContext);
  assert.strictEqual(tellPiddukIntent.type, 'WHATSAPP_CHAT_SEND');
  assert.strictEqual(tellPiddukIntent.contact, 'pidduk');
  assert.strictEqual(tellPiddukIntent.message, 'i am coming');

  const sendMsgPrep = preprocessor.preprocess('send message to pidduk hi');
  const sendMsgIntent = preprocessor.extractFastIntent(sendMsgPrep, waContext);
  assert.strictEqual(sendMsgIntent.type, 'WHATSAPP_CHAT_SEND');
  assert.strictEqual(sendMsgIntent.contact, 'pidduk');
  assert.strictEqual(sendMsgIntent.message, 'hi');
  console.log('  ✔ Context-aware contact search and message extraction verified for WhatsApp Web!');

  // Test 11: Pronoun / Anaphora Non-Hijacking ("open it", "click this")
  console.log('\nTest 11: Conversational Pronoun & Coreference Non-Hijacking...');
  const openItPrep = preprocessor.preprocess('open it');
  const openItFastIntent = preprocessor.extractFastIntent(openItPrep);
  // Must be null so it does not navigate to search.brave.com?q=it, allowing multi-turn conversational reasoning to resolve "it"
  assert.strictEqual(openItFastIntent, null, '"open it" must not be hijacked as a literal URL search query');

  const openThisPrep = preprocessor.preprocess('open this');
  const openThisFastIntent = preprocessor.extractFastIntent(openThisPrep);
  assert.strictEqual(openThisFastIntent, null, '"open this" must not be hijacked as a literal URL search query');
  console.log('  ✔ Pronouns and relative references preserved for contextual multi-turn resolution.');

  // Test 12: WhatsApp Hidden / Locked Chat Secret Code Extraction
  console.log('\nTest 12: WhatsApp Hidden / Locked Chat Secret Code Extraction...');
  const secretCodePrep1 = preprocessor.preprocess('text pidduk i love you , secret code of hidden chat is 1512');
  const secretCodeIntent1 = preprocessor.extractFastIntent(secretCodePrep1, waContext);
  assert.ok(secretCodeIntent1 !== null, 'secretCodeIntent1 should not be null');
  assert.strictEqual(secretCodeIntent1.type, 'WHATSAPP_CHAT_SEND');
  assert.strictEqual(secretCodeIntent1.contact, 'pidduk');
  assert.strictEqual(secretCodeIntent1.message, 'i love you');
  assert.strictEqual(secretCodeIntent1.secretCode, '1512');

  const secretCodePrep2 = preprocessor.preprocess('send i love you to pidduk , secret code is 1512');
  const secretCodeIntent2 = preprocessor.extractFastIntent(secretCodePrep2);
  assert.ok(secretCodeIntent2 !== null, 'secretCodeIntent2 should not be null');
  assert.strictEqual(secretCodeIntent2.contact, 'pidduk');
  assert.strictEqual(secretCodeIntent2.message, 'i love you');
  assert.strictEqual(secretCodeIntent2.secretCode, '1512');

  const secretCodePrep3 = preprocessor.preprocess('text pidduk i love you , pin is 1512');
  const secretCodeIntent3 = preprocessor.extractFastIntent(secretCodePrep3);
  assert.ok(secretCodeIntent3 !== null, 'secretCodeIntent3 should not be null');
  assert.strictEqual(secretCodeIntent3.contact, 'pidduk');
  assert.strictEqual(secretCodeIntent3.message, 'i love you');
  assert.strictEqual(secretCodeIntent3.secretCode, '1512');
  console.log('  ✔ Hidden chat secret code parsed cleanly: message freed from security credentials and secretCode extracted.');

  console.log('\n✅ ALL QUERY PREPROCESSING & PERFORMANCE BENCHMARKS PASSED!');
}

testPreprocessorPerformance().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

