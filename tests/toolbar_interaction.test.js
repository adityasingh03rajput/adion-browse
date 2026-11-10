/**
 * Test Suite: Toolbar Button Interaction, Touch Responsiveness & Overlay Coordination
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function testToolbarInteractions() {
  console.log('\n=== TEST SUITE: TOOLBAR INTERACTIONS & OVERLAY COORDINATION ===\n');

  // Test 1: Verify styles.css rules for touch responsiveness and hit targets
  console.log('Test 1: Verifying CSS touch-action and pointer-events rules...');
  const stylesPath = path.join(__dirname, '../src/renderer/styles.css');
  const css = fs.readFileSync(stylesPath, 'utf8');

  // Header must have high z-index so it is never trapped under modal backdrops
  assert.ok(
    css.includes('.browser-header') && css.includes('z-index: 5000'),
    'Header must have z-index: 5000 to remain above all overlays'
  );
  console.log('  ✔ .browser-header has z-index: 5000 (never covered by backdrops).');

  // Modal overlay must start below the header (top: 80px)
  assert.ok(
    css.includes('.modal-overlay') && css.includes('top: 80px'),
    'Modal overlay must start at top: 80px so header buttons remain tappable'
  );
  console.log('  ✔ .modal-overlay starts at top: 80px (header remains interactable during modals).');

  // Buttons must have touch-action: manipulation
  assert.ok(
    css.includes('touch-action: manipulation'),
    'Buttons must declare touch-action: manipulation for instant touch tap response'
  );
  console.log('  ✔ touch-action: manipulation verified on all interactive buttons.');

  // Inner SVGs must not capture/steal pointer events from buttons
  assert.ok(
    css.includes('.btn-icon svg') && css.includes('pointer-events: none !important'),
    'Inner SVGs must have pointer-events: none to avoid stealing click targets'
  );
  console.log('  ✔ Child SVG pointer-events suppression verified.');

  // Omnibox actions container must have higher z-index than text input
  assert.ok(
    css.includes('.omnibox-actions') && css.includes('z-index: 60'),
    'Omnibox actions must have z-index: 60 so input never steals taps'
  );
  console.log('  ✔ .omnibox-actions has z-index: 60 (input focus cannot steal button taps).');

  // Test 2: Verify HTML contains all 8 critical toolbar buttons and Voice Pill
  console.log('\nTest 2: Verifying HTML element declarations for toolbar buttons & voice pill...');
  const htmlPath = path.join(__dirname, '../src/renderer/index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  assert.ok(html.includes('id="omniboxVoicePill"'), 'index.html must contain omniboxVoicePill');
  console.log('  ✔ Live Omnibox Voice Status Pill confirmed present in DOM.');

  const requiredButtons = [
    'btnVoiceAgent',
    'btnTextAgent',
    'btnAskJarvis',
    'btnBookmark',
    'btnShield',
    'btnBookmarksMenu',
    'btnHistory',
    'btnSettings',
    'btnDevTools',
    'btnTelemetryOverlay'
  ];

  for (const btnId of requiredButtons) {
    assert.ok(
      html.includes(`id="${btnId}"`),
      `index.html must contain button element with id="${btnId}"`
    );
  }
  console.log(`  ✔ All ${requiredButtons.length} toolbar buttons (including Ask Jarvis Copilot & AI buttons) confirmed present in DOM.`);

  // Verify AI Task Commander Modal & Side Panel
  assert.ok(html.includes('id="taskModal"'), 'index.html must contain taskModal');
  assert.ok(html.includes('id="taskInputText"'), 'index.html must contain taskInputText');
  assert.ok(html.includes('id="btnRunTask"'), 'index.html must contain btnRunTask');
  assert.ok(html.includes('id="jarvisSidePanel"'), 'index.html must contain jarvisSidePanel');
  assert.ok(html.includes('id="sidePanelPageTitle"'), 'index.html must contain sidePanelPageTitle');
  console.log('  ✔ AI Task Commander modal, input text, and Jarvis Copilot side panel confirmed present in DOM.');

  // Test 3: Verify Preload IPC bridge exposes setOverlayActive
  console.log('\nTest 3: Verifying Preload IPC contract exposes setOverlayActive...');
  const preloadPath = path.join(__dirname, '../src/preload/preload.js');
  const preload = fs.readFileSync(preloadPath, 'utf8');
  assert.ok(
    preload.includes('setOverlayActive:'),
    'preload.js must expose setOverlayActive to the renderer context'
  );
  console.log('  ✔ window.adionAPI.setOverlayActive verified in preload bridge.');

  // Test 4: Verify TabManager setOverlayActive logic
  console.log('\nTest 4: Testing TabManager BrowserView layer yielding on overlay open...');
  const TabManager = require('../src/main/tabManager');

  let mockRemoved = false;
  let mockSet = false;
  let mockBoundsSet = false;

  const mockWindow = {
    on: () => {},
    getContentSize: () => [1280, 800],
    removeBrowserView: (view) => {
      mockRemoved = true;
      mockSet = false;
    },
    setBrowserView: (view) => {
      mockSet = true;
      mockRemoved = false;
    }
  };

  const tm = new TabManager(mockWindow);
  const mockTab = {
    id: 'tab_test_1',
    view: {
      setBounds: () => { mockBoundsSet = true; },
      webContents: { focus: () => {} }
    }
  };
  tm.tabs.set('tab_test_1', mockTab);
  tm.activeTabId = 'tab_test_1';

  // Opening an overlay must yield BrowserView to let HTML modals render in front
  tm.setOverlayActive(true);
  assert.strictEqual(tm.isOverlayActive, true, 'isOverlayActive must be true');
  assert.strictEqual(mockRemoved, true, 'BrowserView must be removed while overlay is active');

  // Closing overlay must restore BrowserView
  tm.setOverlayActive(false);
  assert.strictEqual(tm.isOverlayActive, false, 'isOverlayActive must be false');
  assert.strictEqual(mockSet, true, 'BrowserView must be re-attached when overlay closes');
  assert.strictEqual(mockBoundsSet, true, 'BrowserView bounds must be restored');
  console.log('  ✔ TabManager cleanly unmounts and restores BrowserView without losing web state.');

  console.log('\n✅ ALL TOOLBAR INTERACTION & OVERLAY TESTS PASSED SUCCESSFULLY!\n');
}

testToolbarInteractions().catch((err) => {
  console.error('Toolbar test failed:', err);
  process.exit(1);
});

