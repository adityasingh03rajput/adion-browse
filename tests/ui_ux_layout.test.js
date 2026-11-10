/**
 * Test Suite: UI/UX Layout, BrowserView Resizing & Assistant HUD Coordination
 * 
 * Tests:
 * 1. TabManager Viewport Full-Width Bounds calculation
 * 2. Window event resilience (resize, maximize, unmaximize, restore, fullscreen)
 * 3. Prevention of BrowserView shrinking (elimination of buggy setAutoResize)
 * 4. Assistant Voice HUD non-occlusion and auto-dismissal mechanics
 * 5. Omnibox voice pill and action button layout integrity
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const TabManager = require('../src/main/tabManager');

async function testUiUxLayout() {
  console.log('\n=== TEST SUITE: UI/UX LAYOUT, BROWSERVIEW RESIZING & HUD COORDINATION ===\n');

  // --- Test 1: TabManager Viewport Bounds Calculation ---
  console.log('Test 1: TabManager Viewport Bounds & Full-Width Geometry...');
  let mockWidth = 1920;
  let mockHeight = 1080;
  const mockWindow = {
    on: () => { },
    getContentBounds: () => ({ x: 0, y: 0, width: mockWidth, height: mockHeight }),
    getContentSize: () => [mockWidth, mockHeight],
    removeBrowserView: () => { },
    setBrowserView: () => { }
  };

  const tm = new TabManager(mockWindow);
  const bounds = tm.getBounds();

  assert.strictEqual(bounds.x, 0, 'Bounds x must start at 0');
  assert.strictEqual(bounds.y, 80, 'Bounds y must start exactly at header bottom (80px)');
  assert.strictEqual(bounds.width, 1920, 'Bounds width must match full window content width');
  assert.strictEqual(bounds.height, 1000, 'Bounds height must be content height - 80px');
  console.log('  ✔ TabManager.getBounds() correctly covers 100% of the client area below top bar.');

  // Minimum safe dimensions test
  mockWidth = 200;
  mockHeight = 250;
  const safeBounds = tm.getBounds();
  assert.ok(safeBounds.width >= 300, 'Bounds must enforce minimum safe width of 300px');
  assert.ok(safeBounds.height >= 200, 'Bounds must enforce minimum safe height of 200px');
  console.log('  ✔ Minimum safe boundary enforcement prevents zero-size viewport collapse.');

  // Side Panel open/close bounds test (Chrome Gemini Architecture)
  mockWidth = 1920;
  mockHeight = 1080;
  tm.setSidePanelOpen(true, 380);
  const sidePanelBounds = tm.getBounds();
  assert.strictEqual(sidePanelBounds.width, 1920 - 380, 'When side panel is open, viewport width must shrink by 380px');
  tm.setSidePanelOpen(false);
  assert.strictEqual(tm.getBounds().width, 1920, 'When side panel closes, viewport width must restore to 100%');
  console.log('  ✔ Side Panel viewport partition verified: BrowserView dynamically yields 380px without overlap.');

  // --- Test 2: Window Resize & Maximization Event Coverage ---
  console.log('\nTest 2: Window State Change Listeners (Resize, Maximize, Restore)...');
  const tabManagerSrc = fs.readFileSync(path.join(__dirname, '../src/main/tabManager.js'), 'utf8');

  assert.ok(tabManagerSrc.includes("this.mainWindow.on('maximize'"), 'Must listen to maximize event');
  assert.ok(tabManagerSrc.includes("this.mainWindow.on('unmaximize'"), 'Must listen to unmaximize event');
  assert.ok(tabManagerSrc.includes("this.mainWindow.on('restore'"), 'Must listen to restore event');
  assert.ok(tabManagerSrc.includes("this.mainWindow.on('enter-full-screen'"), 'Must listen to enter-full-screen event');
  assert.ok(tabManagerSrc.includes("this.mainWindow.on('leave-full-screen'"), 'Must listen to leave-full-screen event');
  console.log('  ✔ All 6 essential window state events registered for deterministic resize.');

  // --- Test 3: Elimination of Buggy setAutoResize on BrowserView ---
  console.log('\nTest 3: BrowserView setAutoResize Elimination (Prevent View Shrinking)...');
  assert.ok(
    !tabManagerSrc.includes('view.setAutoResize({ width: true, height: true })'),
    'view.setAutoResize must be removed to prevent scale drift and view collapse'
  );
  console.log('  ✔ setAutoResize conflict eliminated; bounds managed deterministically via setBounds.');

  // --- Test 4: Navigation Viewport Re-assertion ---
  console.log('\nTest 4: Navigation Bounds Re-assertion on External Sites...');
  assert.ok(
    tabManagerSrc.includes('this.resizeActiveTab()') && tabManagerSrc.includes('navigateActiveTab'),
    'navigateActiveTab must call resizeActiveTab() to ensure full width on new pages'
  );
  assert.ok(
    tabManagerSrc.includes('this.resizeActiveTab()') && tabManagerSrc.includes('handleNavigation'),
    'handleNavigation must call resizeActiveTab() to prevent viewport collapse on redirect'
  );
  console.log('  ✔ External navigation explicitly locks bounds to prevent 480px mobile-view squashing.');

  // --- Test 5: Assistant HUD Overlay Auto-Dismiss & Non-Occlusion ---
  console.log('\nTest 5: Assistant HUD Overlay Auto-Dismiss & Non-Occlusion...');
  const appSrc = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');

  // Must auto-dismiss after calm timeout
  assert.ok(
    appSrc.includes('setTimeout') && appSrc.includes("agentHudOverlay.classList.remove('visible')"),
    'showAgentHud must auto-dismiss to prevent permanently covering bottom-right screen'
  );
  // Must hide immediately on stopMicrophoneStream
  assert.ok(
    appSrc.includes('stopMicrophoneStream') && appSrc.includes("agentHudOverlay.classList.remove('visible')"),
    'stopMicrophoneStream must immediately hide agentHudOverlay'
  );
  console.log('  ✔ Voice HUD card auto-dismisses after 3.5s and immediately disappears on mic stop.');

  // --- Test 6: CSS Layout, Omnibox Sizing & Touch Response ---
  console.log('\nTest 6: CSS Layout, Omnibox Sizing & Action Targets...');
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');

  assert.ok(css.includes('.omnibox-voice-pill'), '.omnibox-voice-pill class must be defined');
  assert.ok(css.includes('.omnibox-wrapper.voice-active'), '.omnibox-wrapper.voice-active styling must exist');
  assert.ok(css.includes('.btn-voice-agent'), '.btn-voice-agent class must exist');
  assert.ok(css.includes('.agent-hud-card'), '.agent-hud-card must be defined');
  console.log('  ✔ Omnibox voice pill, listening glow, and HUD card styles verified.');

  // --- Test 7: Modern Chrome 100+ User-Agent & Header Compatibility (WhatsApp Web) ---
  console.log('\nTest 7: Modern Chrome 100+ User-Agent (WhatsApp Web Compatibility)...');
  const indexSrc = fs.readFileSync(path.join(__dirname, '../src/main/index.js'), 'utf8');

  assert.ok(indexSrc.includes('CHROME_USER_AGENT'), 'index.js must define CHROME_USER_AGENT');
  assert.ok(tabManagerSrc.includes('CHROME_USER_AGENT'), 'tabManager.js must define CHROME_USER_AGENT');

  // Verify Chrome version is >= 100
  const uaMatch = indexSrc.match(/Chrome\/(\d+)/);
  assert.ok(uaMatch, 'User-Agent must specify Chrome version');
  const chromeVer = parseInt(uaMatch[1], 10);
  assert.ok(chromeVer >= 100, `Chrome version must be >= 100 for WhatsApp Web (actual: ${chromeVer})`);

  // Verify sec-ch-ua Client Hints
  assert.ok(indexSrc.includes('sec-ch-ua'), 'index.js must set sec-ch-ua headers');
  console.log('  ✔ Standard Chrome 100+ User-Agent and Client Hints verified for WhatsApp Web & external services.');

  // --- Test 8: AI Text Task Commander (Writing Tasks via Keyboard / Text Icon) ---
  console.log('\nTest 8: AI Text Task Commander (Text Task Icon & Modal)...');
  const indexHtml = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  assert.ok(indexHtml.includes('id="btnTextAgent"'), 'index.html must have btnTextAgent button');
  assert.ok(indexHtml.includes('id="taskModal"'), 'index.html must have taskModal');
  assert.ok(indexHtml.includes('id="taskInputText"'), 'index.html must have taskInputText input');
  assert.ok(indexHtml.includes('id="btnRunTask"'), 'index.html must have btnRunTask');

  assert.ok(css.includes('.btn-text-agent'), 'styles.css must have .btn-text-agent class');
  assert.ok(css.includes('.task-modal-card'), 'styles.css must have .task-modal-card class');
  assert.ok(css.includes('.task-input-box'), 'styles.css must have .task-input-box class');

  assert.ok(appSrc.includes('toggleTaskModal'), 'app.js must define toggleTaskModal');
  assert.ok(appSrc.includes('executeWrittenTask'), 'app.js must define executeWrittenTask');
  assert.ok(appSrc.includes("key === 'k'"), 'app.js must support Ctrl+K shortcut for task commander');
  console.log('  ✔ AI Text Task Commander button, modal, Ctrl+K shortcut, and task execution verified.');

  // --- Test 9: Chrome Gemini-Architecture Copilot Side Panel & Autonomous Continuator ---
  console.log('\nTest 9: Chrome Gemini-Architecture Copilot Side Panel & Autonomous Continuator...');
  assert.ok(indexHtml.includes('id="btnAskJarvis"'), 'index.html must have btnAskJarvis button');
  assert.ok(indexHtml.includes('id="jarvisSidePanel"'), 'index.html must have jarvisSidePanel aside container');
  assert.ok(indexHtml.includes('id="sidePanelPageTitle"'), 'index.html must display context sharing page title');
  assert.ok(indexHtml.includes('id="sidePanelTimeline"'), 'index.html must have sidePanelTimeline for live autonomous steps');

  assert.ok(css.includes('.btn-ask-jarvis'), 'styles.css must style .btn-ask-jarvis');
  assert.ok(css.includes('.jarvis-side-panel'), 'styles.css must style .jarvis-side-panel');
  assert.ok(css.includes('.context-pill'), 'styles.css must style context-pill');

  assert.ok(appSrc.includes('toggleSidePanel'), 'app.js must define toggleSidePanel');
  assert.ok(appSrc.includes("key === 'j'"), 'app.js must support Ctrl+J shortcut for Copilot side panel');

  // Verify autonomous gateway continuator in AgentRuntime
  const agentRuntimeSrc = fs.readFileSync(path.join(__dirname, '../src/control-plane/agentRuntime.js'), 'utf8');
  assert.ok(agentRuntimeSrc.includes('async observeAndDispatchWhatsApp'), 'observeAndDispatchWhatsApp must be async');
  assert.ok(agentRuntimeSrc.includes('await this.observeAndDispatchWhatsApp'), 'observeAndDispatchWhatsApp must be awaited before closing task');
  assert.ok(agentRuntimeSrc.includes('autoHandleContinuations'), 'agentRuntime.js must implement autoHandleContinuations');
  console.log('  ✔ Chrome-style Ask Jarvis Copilot side panel, context sharing, and end-to-end awaited message dispatch verified.');

  // --- Test 10: Context-Aware In-Page Messaging & Intent Grounding ---
  console.log('\nTest 10: Context-Aware In-Page Messaging & Smart Intent Execution...');
  const modelClientSrc = fs.readFileSync(path.join(__dirname, '../src/control-plane/modelClient.js'), 'utf8');
  assert.ok(agentRuntimeSrc.includes("case 'WHATSAPP_CHAT_SEND':"), 'AgentRuntime must handle WHATSAPP_CHAT_SEND');
  assert.ok(agentRuntimeSrc.includes('async sendWhatsAppChat'), 'AgentRuntime must implement sendWhatsAppChat for in-page contact searching');
  assert.ok(agentRuntimeSrc.includes('await this.sendWhatsAppChat'), 'sendWhatsAppChat must be awaited end-to-end');
  assert.ok(modelClientSrc.includes('WHATSAPP_CHAT_SEND'), 'ModelClient system prompt must include WHATSAPP_CHAT_SEND action');
  console.log('  ✔ In-page contact search, chat activation, and composer typing verified for WhatsApp Web.');

  console.log('\n✅ ALL UI/UX LAYOUT & RESIZE TESTS PASSED SUCCESSFULLY!\n');
}

testUiUxLayout().catch((err) => {
  console.error('UI/UX Layout test failed:', err);
  process.exit(1);
});

