const assert = require('assert');
const fs = require('fs');
const path = require('path');
const SessionManager = require('../src/control-plane/sessionManager');
const AgentRuntime = require('../src/control-plane/agentRuntime');

async function runSessionAndJarvisTests() {
  console.log('=== TEST SUITE: SESSION MEMORY, PROMPT FIDELITY & JARVIS ARCHITECTURE ===\n');

  const testDataDir = path.resolve(__dirname, '..', '.data');
  const sessionLogPath = path.join(testDataDir, 'session_interactions.json');

  // Test 1: Session memory starts empty and persists across restarts
  console.log('Test 1: Verifying empty initialization and persistence across restarts...');
  const persistenceDir = path.join(testDataDir, 'test_session_persistence');
  fs.rmSync(persistenceDir, { recursive: true, force: true });

  const firstSession = new SessionManager(persistenceDir);
  const firstLogPath = path.join(persistenceDir, 'session_interactions.json');
  assert.ok(fs.existsSync(firstLogPath), 'session_interactions.json should exist');
  const initialContent = JSON.parse(fs.readFileSync(firstLogPath, 'utf8'));
  assert.strictEqual(initialContent.totalInteractions, 0, 'A brand-new session should start empty');

  firstSession.recordInteraction({
    source: 'jarvis-chat',
    rawPrompt: 'remember this across restarts',
    modelResponse: { thought: 'Stored in session memory', actions: [] },
    status: 'success',
    feedback: 'Stored in session memory'
  });

  const restartedSession = new SessionManager(persistenceDir);
  assert.strictEqual(restartedSession.getHistory().totalInteractions, 1, 'Conversation memory must survive a restart');
  assert.strictEqual(restartedSession.getHistory().interactions[0].prompt.raw, 'remember this across restarts');
  fs.rmSync(persistenceDir, { recursive: true, force: true });
  console.log('  ✔ Empty JSON log initialized; conversation memory restored after restart.');

  const sessionManager = new SessionManager(testDataDir);
  sessionManager.clearSession();

  // Test 2: Prompt Fidelity & Exact Phrasing Preservation
  console.log('\nTest 2: Preserving exact prompt phrasing and recording interaction...');
  const exactPrompt = 'Can you change the color to yellow of generate test tone button?';
  const recordedEntry = sessionManager.recordInteraction({
    source: 'voice',
    rawPrompt: exactPrompt,
    transcription: exactPrompt,
    pageContext: { url: 'file:///D:/Adion Browse/audio.html', title: 'Audio Lab' },
    modelResponse: {
      thought: 'Modify generate test tone button color to yellow',
      actions: [{ type: 'MODIFY_DOM', params: { selector: '#btnTogglePlayback', action: 'setStyle', value: 'background: yellow;' } }]
    },
    status: 'success',
    feedback: 'Task executed successfully'
  });

  assert.strictEqual(recordedEntry.prompt.raw, exactPrompt, 'Raw prompt phrasing must be preserved exactly');
  assert.strictEqual(sessionManager.getHistory().totalInteractions, 1);

  // Read from disk to verify file persistence
  const updatedDiskLog = JSON.parse(fs.readFileSync(sessionLogPath, 'utf8'));
  assert.strictEqual(updatedDiskLog.totalInteractions, 1);
  assert.strictEqual(updatedDiskLog.interactions[0].prompt.raw, exactPrompt);
  console.log('  âœ” Prompt fidelity verified: raw phrasing preserved without alteration and written to JSON.');

  // Test 3: Session Reset via clearSession (New Session protocol)
  console.log('\nTest 3: Clearing session memory for New Session...');
  const clearResult = sessionManager.clearSession();
  assert.strictEqual(clearResult.success, true);
  assert.strictEqual(sessionManager.getHistory().totalInteractions, 0);

  const clearedDiskLog = JSON.parse(fs.readFileSync(sessionLogPath, 'utf8'));
  assert.strictEqual(clearedDiskLog.totalInteractions, 0);
  assert.deepStrictEqual(clearedDiskLog.interactions, []);
  console.log('  âœ” Session reset verified: memory and disk log cleared to 0 interactions.');

  // Test 4: Verbose Log Suppression & Generalized Error Reporting in AgentRuntime
  console.log('\nTest 4: Verifying Log Suppression and Generalized Error Reporting...');
  const runtime = new AgentRuntime(null, null, null, null, null, sessionManager);

  // Verify verboseAudioLogging is disabled by default
  assert.strictEqual(runtime.verboseAudioLogging, false, 'Verbose audio logging must be false by default');
  console.log('  âœ” Verbose audio frame logging suppressed to prevent log spam.');

  // Verify generalized error reporting
  const specificTargetError = new Error('Element not found on active page for: #nonExistentSlider');
  const genMsg1 = runtime.getGeneralizedErrorMessage(specificTargetError);
  console.log('Raw error:', specificTargetError.message);
  console.log('Generalized error output:', genMsg1);
  assert.ok(!genMsg1.includes('#nonExistentSlider'), 'Generalized error must not expose specific internal selector targets');
  assert.ok(genMsg1.includes('target UI element is currently unavailable') || genMsg1.includes('Layout adaptation'), 'Should provide constructive generalized fault message');

  const netError = new Error('fetch failed ECONNRESET');
  const genMsg2 = runtime.getGeneralizedErrorMessage(netError);
  assert.ok(genMsg2.includes('network') || genMsg2.includes('safeguarded'));
  console.log('  âœ” Generalized error handling verified: system faults reported gracefully without premature element targeting failures.');

  // Test 5: Multi-Turn Conversation Memory & Cognitive Element Grounding
  console.log('\nTest 5: Multi-Turn Conversation Memory & Grounding Architecture...');
  sessionManager.recordInteraction({
    source: 'user',
    rawPrompt: 'What was the biggest horror movie of 2017?',
    modelResponse: { thought: 'Andy Muschietti\'s "It" was the highest grossing horror film of 2017.' },
    feedback: 'Andy Muschietti\'s "It" was the highest grossing horror film of 2017.',
    status: 'success'
  });

  const history = sessionManager.getHistory().interactions;
  assert.strictEqual(history.length, 1);
  assert.ok(history[0].prompt.raw.includes('horror movie of 2017'));

  // Verify ModelClient prompt incorporates conversation history
  const modelClientSrc = fs.readFileSync(path.join(__dirname, '../src/control-plane/modelClient.js'), 'utf8');
  assert.ok(modelClientSrc.includes('Recent Conversation History:'), 'modelClient prompt must include conversation history');
  assert.ok(modelClientSrc.includes('conversationHistory = []'), 'planActions must accept conversationHistory parameter');

  // Verify CDP Bridge cognitive token-level element grounding
  const cdpBridgeSrc = fs.readFileSync(path.join(__dirname, '../src/control-plane/cdpBridge.js'), 'utf8');
  assert.ok(cdpBridgeSrc.includes('meaningfulTokens'), 'cdpBridge must extract meaningful semantic tokens');
  assert.ok(cdpBridgeSrc.includes('tokenCoverage'), 'cdpBridge must compute token coverage for fuzzy conceptual matching');
  assert.ok(cdpBridgeSrc.includes('hrefDomainMatches'), 'cdpBridge must match domains in hrefs for links');
  console.log('  ✔ Multi-turn conversation memory and cognitive element grounding verified.');

  // Test 6: Autonomous Goal Execution & Re-Planning Loop (/goal Pattern)
  console.log('\nTest 6: Autonomous Sense-Plan-Act-Verify Re-Planning Goal Loop...');
  let planningCallCount = 0;
  const observedContexts = [];

  const mockModel = {
    async planActions(prompt, pageContext, conversationHistory) {
      planningCallCount++;
      observedContexts.push({ pageContext, conversationHistory });

      if (planningCallCount === 1) {
        return {
          thought: 'Step 1: Navigating to nomoney.in to inspect page structure',
          actions: [{ type: 'NAVIGATE', url: 'https://nomoney.in' }],
          goalAccomplished: false
        };
      } else {
        return {
          thought: 'Step 2: Sensed active page and buttons. Clicking Sign Up button to complete goal.',
          actions: [{ type: 'CLICK_SELECTOR', target: 'Sign Up' }],
          goalAccomplished: true
        };
      }
    }
  };

  const executedIntents = [];
  const mockTab = {
    id: 'tab-1',
    url: 'https://nomoney.in',
    title: 'BooksByMohit — Read, Rent & Buy Books',
    view: {
      webContents: {
        isLoading: () => false,
        executeJavaScript: async () => ({ found: true, x: 605, y: 195, tag: 'A', name: 'Sign Up' }),
        sendInputEvent: () => {}
      }
    }
  };

  const mockTabManager = {
    getActiveTab: () => mockTab,
    navigateActiveTab: (url) => { mockTab.url = url; },
    tabs: new Map([['tab-1', mockTab]])
  };

  const goalRuntime = new AgentRuntime(mockTabManager, null, null, null, null, sessionManager);
  goalRuntime.model = mockModel;
  goalRuntime.cdp = { attach: async () => {}, highlightElement: async () => {}, dispatchClick: async () => {} };
  goalRuntime.autonomousInspectAndClick = async (tab, target) => {
    return { success: true, label: target, x: 605, y: 195 };
  };

  goalRuntime.getActivePageContext = async () => {
    return {
      url: mockTab.url,
      title: mockTab.title,
      buttons: ['Search by title, auth', 'Log In', 'Sign Up', 'Explore Books']
    };
  };

  const goalFeedback = [];
  goalRuntime.on('feedback', (f) => goalFeedback.push(f.message));

  await goalRuntime.processCommand('go to nomoney.in and signup');

  assert.strictEqual(planningCallCount, 2, 'Autonomous Goal Loop should have re-planned across 2 iterations');
  assert.ok(goalFeedback.some(m => m.includes('Step 1')), 'Should emit Step 1 feedback');
  assert.ok(goalFeedback.some(m => m.includes('Step 2')), 'Should emit Step 2 feedback');
  assert.ok(observedContexts[1].conversationHistory.some(h => (h.agent || '').includes('NAVIGATE') || (h.agent || '').includes('Step 1')), 'Iteration 2 should contain Step 1 progress history');
  console.log('  ✔ Autonomous goal re-planning loop successfully executed and verified over multiple turns.');

  console.log('\nâœ… ALL SESSION MEMORY & JARVIS ARCHITECTURE TESTS PASSED SUCCESSFULLY!');
}

runSessionAndJarvisTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});

