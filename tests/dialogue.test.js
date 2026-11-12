const assert = require('assert');
const { IntentParser } = require('../src/control-plane/dialogue/intentParser');
const { WorkflowState } = require('../src/control-plane/dialogue/workflowState');
const { findSite, findSection, siteOfUrl, isGenericSection } = require('../src/control-plane/dialogue/siteRegistry');

async function main() {
  console.log('=== TEST SUITE: DIALOGUE LAYER (intent + workflow + latency) ===\n');
  const parser = new IntentParser();

  // 1. Multilingual verb normalization + SOV reorder (generic grammar, not word lists)
  console.log('Test 1: Hinglish SOV + Devanagari...');
  assert.strictEqual(parser.parse('instagram kholo').intent, 'NAVIGATE_SITE');
  assert.strictEqual(parser.parse('instagram kholo').site, 'instagram');
  assert.ok(parser.parse('instagram kholo').confidence >= 0.85);
  assert.strictEqual(parser.parse('tab band karo').intent, 'TAB_OP');
  assert.strictEqual(parser.parse('messages kholo').intent, 'OPEN_SECTION');
  assert.strictEqual(parser.parse('इंस्टाग्राम खोलो').site, 'instagram');
  console.log('  ok — kholo/band karo/Devanagari all parse');

  // 2. Workflow: follow-up resolves from STATE even with empty page context
  console.log('Test 2: state-based follow-up (no URL needed)...');
  const wf = new WorkflowState();
  wf.observeTurn({ parse: parser.parse('instagram kholo'), pageUrl: 'adion://newtab', pageTitle: '' });
  const follow = parser.parse('open messages');
  assert.strictEqual(follow.intent, 'OPEN_SECTION');
  const action = wf.resolveAction(follow, { url: 'adion://newtab' });
  assert.ok(action && action.url === 'https://www.instagram.com/direct/inbox/', 'state must resolve inbox, got ' + JSON.stringify(action));
  console.log('  ok — "open messages" -> inbox from workflow state');

  // 3. Unknown site+section defers (never guesses)
  console.log('Test 3: deferral guarantee...');
  const wf2 = new WorkflowState();
  const amb = parser.parse('open orders');
  assert.strictEqual(wf2.resolveAction(amb, { url: 'adion://newtab' }), null, 'no workflow + no URL must defer');
  console.log('  ok — ambiguous follow-ups defer to LLM, never web-search');

  // 4. Registry lookups
  console.log('Test 4: registry...');
  assert.strictEqual(findSite('insta').id, 'instagram');
  assert.strictEqual(findSite('www.youtube.com').id, 'youtube');
  assert.ok(findSection(findSite('gmail'), 'inbox').url.includes('mail.google.com'));
  assert.strictEqual(siteOfUrl('https://www.instagram.com/direct/inbox/').id, 'instagram');
  assert.ok(isGenericSection('messages') && !isGenericSection('xylophone'));
  console.log('  ok — aliases, sections, generic-section set');

  // 5. Compound utterances: deterministic prefix + LLM remainder
  console.log('Test 5: compounds...');
  const wfC = new WorkflowState();
  const logUtter = 'Open youtube and search for the unheard music and then just open the first video';
  const comp = parser.parseCompound(logUtter);
  assert.ok(comp && comp.segments.length === 3, 'must split into 3 segments, got ' + JSON.stringify(comp && comp.segments.map(s => s.raw)));
  assert.strictEqual(comp.segments[0].intent, 'NAVIGATE_SITE');
  assert.strictEqual(comp.segments[1].intent, 'SEARCH_WEB');
  const res = wfC.resolveCompound(comp, { url: 'adion://newtab' });
  assert.strictEqual(res.actions.length, 2, 'prefix must be [youtube nav, youtube search], got ' + JSON.stringify(res.actions));
  assert.ok(res.actions[0].url.includes('youtube.com'), 'seg1 -> youtube home, got ' + res.actions[0].url);
  assert.ok(res.actions[1].url.includes('youtube.com/results?search_query='), 'seg2 -> youtube search (not Google), got ' + res.actions[1].url);
  assert.ok(/first video/i.test(res.remainder), 'remainder goes to LLM, got ' + res.remainder);
  // Fully deterministic compound executes whole
  const comp2 = parser.parseCompound('open youtube and open subscriptions');
  const res2 = new WorkflowState().resolveCompound(comp2, { url: 'adion://newtab' });
  assert.strictEqual(res2.remainder, null, 'fully grounded compound must have no remainder');
  assert.strictEqual(res2.actions.length, 2);
  // Single-action input is not a compound
  assert.strictEqual(parser.parseCompound('open messages'), null);
  console.log('  ok — prefix/remainder split; youtube-scoped search; no Google detour');

  // 6. Latency: parser must stay sub-millisecond class (<5ms like the old fast path)
  console.log('Test 6: parse latency (1000 iterations)...');  parser.parse('warm up');
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) parser.parse('instagram kholo');
  const avgMs = Number(process.hrtime.bigint() - t0) / 1e6 / 1000;
  console.log(`  avg parse: ${avgMs.toFixed(4)}ms`);
  assert.ok(avgMs < 5.0, `parser avg must be <5ms (actual ${avgMs}ms)`);
  const w0 = process.hrtime.bigint();
  const wf3 = new WorkflowState();
  for (let i = 0; i < 1000; i++) { wf3.observeTurn({ parse: parser.parse('open messages'), pageUrl: 'https://x.com/' }); wf3.resolveAction(parser.parse('open messages'), { url: 'https://x.com/' }); }
  const wAvg = Number(process.hrtime.bigint() - w0) / 1e6 / 1000;
  console.log(`  avg observe+resolve: ${wAvg.toFixed(4)}ms`);
  assert.ok(wAvg < 5.0, `workflow step avg must be <5ms (actual ${wAvg}ms)`);
  console.log('  ok — fast enough to sit in front of the old fast path');

  console.log('Test 7: Hindi / Devanagari...');
  assert.strictEqual(parser.parse('इंस्टाग्राम खोलो').intent, 'NAVIGATE_SITE');
  assert.strictEqual(parser.parse('इंस्टाग्राम खोलो').site, 'instagram');
  assert.ok(parser.parse('इंस्टाग्राम खोलो').confidence >= 0.85);
  assert.strictEqual(parser.parse('टैब बंद करो').intent, 'TAB_OP');
  assert.strictEqual(parser.parse('संदेश खोलो').intent, 'OPEN_SECTION');
  assert.strictEqual(parser.parse('यूट्यूब पर गाने खोजो').site, 'youtube');
  const wfH = new WorkflowState();
  wfH.observeTurn({ parse: parser.parse('इंस्टाग्राम खोलो'), pageUrl: 'adion://newtab', pageTitle: '' });
  const hAct = wfH.resolveAction(parser.parse('संदेश खोलो'), { url: 'adion://newtab' });
  assert.ok(hAct && hAct.url === 'https://www.instagram.com/direct/inbox/', 'state must resolve Hindi follow-up, got ' + JSON.stringify(hAct));
  const hComp = parser.parseCompound('यूट्यूब खोलो और बिल्ली वीडियो खोजो');
  assert.ok(hComp && hComp.segments.length === 2, 'Hindi compound must split on और, got ' + JSON.stringify(hComp && hComp.segments.map(s => s.raw)));
  const hRes = new WorkflowState().resolveCompound(hComp, { url: 'adion://newtab' });
  assert.strictEqual(hRes.actions.length, 2, 'Hindi prefix must fully resolve, got ' + JSON.stringify(hRes.actions));
  assert.ok(hRes.actions[1].url.includes('youtube.com/results?search_query='), 'seg2 -> youtube search, got ' + hRes.actions[1].url);
  assert.strictEqual(hRes.remainder, null);
  console.log('  ok — Devanagari verbs, Hindi follow-ups, और-compounds');

  console.log('\nALL DIALOGUE TESTS PASSED');
}

main().catch(e => { console.error('DIALOGUE TESTS FAILED:', e); process.exit(1); });
