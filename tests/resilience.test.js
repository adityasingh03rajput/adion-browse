const assert = require('assert');
const AgentRuntime = require('../src/control-plane/agentRuntime');
const { ActionType } = require('../src/control-plane/protocol');
const ModelClient = require('../src/control-plane/modelClient');

async function runTests() {
  console.log('=== TEST SUITE: RESILIENCE, BACKOFF & SLIDER TARGETING ===\n');

  // 1. Commands must be planned by the AI; no local fast path may intercept them
  console.log('Test 1: Verifying no local fast-path interception...');
  const runtime = new AgentRuntime();
  assert.strictEqual(typeof runtime.parseIntent, 'undefined', 'runtime must not expose a rule-based intent parser');
  assert.strictEqual(runtime.preprocessor, undefined, 'runtime must not pre-parse commands');
  assert.strictEqual(runtime.workflow, undefined, 'runtime must not resolve commands through dialogue state');
  assert.strictEqual(runtime.intentParser, undefined, 'runtime must not expose a site registry parser');
  console.log('  ✔ Commands can only reach the AI planner; no fast path exists.');

  // 2. Test ModelClient Exponential Backoff
  console.log('\nTest 2: Verifying ModelClient Exponential Backoff and retry mechanism...');
  const modelClient = new ModelClient();
  assert.strictEqual(typeof modelClient.queryGroq, 'function');

  let callCount = 0;
  const attemptsRecorded = [];

  // Mock fetch to simulate 503 Service Unavailable twice, then 200 OK
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    callCount++;
    const body = JSON.parse(opts.body);
    attemptsRecorded.push({ attempt: callCount, model: body.model });

    if (callCount < 3) {
      // Simulate Groq 503 Service Unavailable
      return {
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable - Provider capacity exceeded'
      };
    }

    // Success on 3rd attempt
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              thought: "Recovered via exponential backoff with zero-cost model failover",
              actions: [{ type: "MODIFY_DOM", params: { selector: "#sliderBass", action: "setValue", value: "10" } }]
            })
          }
        }]
      })
    };
  };

  try {
    const result = await modelClient.queryGroq('change base frequency boost to 10 decibels');
    console.log('Backoff recovery result:', result);
    assert.ok(result && result.actions && result.actions.length > 0);
    assert.strictEqual(callCount, 3);
    assert.strictEqual(attemptsRecorded.length, 3);
    console.log('  âœ” 503 Service Unavailable successfully recovered via exponential backoff after 3 attempts.');
    console.log('  âœ” Models rotated:', attemptsRecorded.map(a => a.model).join(' -> '));
  } finally {
    global.fetch = originalFetch;
  }

  // 3. Test Slider and DOM persistence
  console.log('\nTest 3: Testing Slider and DOM persistence in audio.html...');
  const fs = require('fs');
  const audioHtml = fs.readFileSync('audio.html', 'utf8');

  // Verify that audio.html has sliderBass and valBass
  assert.ok(audioHtml.includes('id="sliderBass"'));
  assert.ok(audioHtml.includes('id="valBass"'));
  console.log('  ✔ audio.html contains target range slider (#sliderBass) and value display span (#valBass).');

  // Test persistDOMChangeToFile with slider value
  const modResult = {
    success: true,
    elementId: 'sliderBass',
    renderedTag: 'INPUT',
    action: 'setValue',
    appliedValue: '10'
  };

  const persisted = await runtime.persistDOMChangeToFile('file:///D:/Adion%20Browse/audio.html', modResult);
  assert.strictEqual(persisted, true);
  const updatedHtml = fs.readFileSync('audio.html', 'utf8');
  assert.ok(updatedHtml.includes('id="sliderBass" min="-12" max="12" value="10"'));
  assert.ok(updatedHtml.includes('<span id="valBass">10 dB</span>'));
  console.log('  ✔ Disk persistence verified: sliderBass value set to 10 and valBass updated to "10 dB" in audio.html');

  // Revert back for clean state
  await runtime.persistDOMChangeToFile('file:///D:/Adion%20Browse/audio.html', {
    success: true,
    elementId: 'sliderBass',
    renderedTag: 'INPUT',
    action: 'setValue',
    appliedValue: '0'
  });
  console.log('  ✔ Test state safely reverted to baseline value 0 dB.');

  console.log('\nâœ… ALL RESILIENCE AND EDITING TESTS PASSED SUCCESSFULLY!');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
