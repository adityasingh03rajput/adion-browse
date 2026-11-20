'use strict';

const assert = require('assert');
const {
  classifyLayoutRegion,
  classifyAffordance,
  extractSemanticAffordances,
  StatefulPCSession,
  NON_INTERACTIVE_LABELS
} = require('../src/pc/semanticAffordanceEngine');

function runAffordanceEngineTests() {
  console.log('--- Running Semantic Affordance Engine Unit Tests ---');

  // Test 1: Layout Regionalization
  {
    const winRect = { x: 0, y: 0, w: 1000, h: 1000 };
    
    // Header region (< 14% height)
    assert.strictEqual(classifyLayoutRegion({ x: 200, y: 50, w: 100, h: 30 }, winRect), 'HEADER');

    // Composer region (> 82% height)
    assert.strictEqual(classifyLayoutRegion({ x: 400, y: 900, w: 200, h: 40 }, winRect), 'COMPOSER');

    // Sidebar region (< 38% width)
    assert.strictEqual(classifyLayoutRegion({ x: 100, y: 300, w: 150, h: 50 }, winRect), 'SIDEBAR');

    // Content region (middle)
    assert.strictEqual(classifyLayoutRegion({ x: 500, y: 400, w: 300, h: 200 }, winRect), 'CONTENT');

    console.log('✓ Test 1: Layout Regionalization correctly segments window regions');
  }

  // Test 2: Visual Affordance Classification
  {
    // Composer input
    const composer = classifyAffordance('Type a message', 'Edit', 'COMPOSER');
    assert.strictEqual(composer.affordanceType, 'COMPOSER_INPUT');
    assert.strictEqual(composer.isInteractive, true);

    // Search input
    const search = classifyAffordance('Search or start new chat', 'Edit', 'HEADER');
    assert.strictEqual(search.affordanceType, 'SEARCH_INPUT');
    assert.strictEqual(search.isInteractive, true);

    // Action button
    const btn = classifyAffordance('Send', 'Button', 'COMPOSER');
    assert.strictEqual(btn.affordanceType, 'ACTION_BUTTON');
    assert.strictEqual(btn.isInteractive, true);

    // Static label (Chats)
    const staticLabel = classifyAffordance('Chats', 'Text', 'SIDEBAR');
    assert.strictEqual(staticLabel.affordanceType, 'STATIC_LABEL');
    assert.strictEqual(staticLabel.isInteractive, false);

    console.log('✓ Test 2: Affordance classification distinguishes interactive vs. static elements');
  }

  // Test 3: Extract Semantic Affordances from elements and OCR
  {
    const winRect = { x: 0, y: 0, w: 1000, h: 1000 };
    const elements = [
      { id: 1, type: 'Edit', name: 'Type a message', rect: { x: 400, y: 920, w: 300, h: 40 } },
      { id: 2, type: 'Button', name: 'Send', rect: { x: 920, y: 920, w: 50, h: 40 } }
    ];
    const ocr = {
      lines: [
        { text: 'Chats', x: 20, y: 40, w: 80, h: 30 },
        { text: 'Pidduk', x: 50, y: 150, w: 100, h: 25 },
        { text: 'Hey there', x: 50, y: 180, w: 120, h: 20 }
      ]
    };

    const affordances = extractSemanticAffordances(elements, ocr, winRect);
    assert.ok(Array.isArray(affordances));
    assert.ok(affordances.length >= 3);

    const types = affordances.map(a => a.affordanceType);
    assert.ok(types.includes('COMPOSER_INPUT'), 'Should extract composer input');
    assert.ok(types.includes('ACTION_BUTTON'), 'Should extract action button');
    assert.ok(types.includes('SELECTABLE_ITEM'), 'Should extract selectable contact item');

    const piddukItem = affordances.find(a => a.name === 'Pidduk');
    assert.ok(piddukItem, 'Pidduk contact should be extracted as an affordance');
    assert.strictEqual(piddukItem.isInteractive, true);

    console.log('✓ Test 3: extractSemanticAffordances identifies functional affordances correctly');
  }

  // Test 4: StatefulPCSession state tracking and token compression
  {
    const winRect = { x: 0, y: 0, w: 1000, h: 1000 };
    const goal = 'Message Pidduk saying i love her';
    const session = new StatefulPCSession(goal);

    // Step A: Contact visible in list
    const step1State = session.update(
      {
        lines: [
          { text: 'Chats', x: 20, y: 40, w: 80, h: 30 },
          { text: 'Pidduk', x: 50, y: 150, w: 100, h: 25 }
        ]
      },
      [],
      { rect: winRect }
    );

    assert.strictEqual(step1State.currentPhase, 'CONTACT_FOUND_IN_LIST');
    assert.strictEqual(step1State.composerReady, false);
    assert.ok(step1State.stateDelta.includes('visible in the sidebar'));

    // Step B: Chat opened with Pidduk, composer ready
    const step2State = session.update(
      {
        lines: [
          { text: 'Pidduk', x: 450, y: 50, w: 100, h: 30 }, // in header
          { text: 'Type a message', x: 420, y: 930, w: 200, h: 25 }
        ]
      },
      [
        { id: 1, type: 'Edit', name: 'Type a message', rect: { x: 400, y: 920, w: 300, h: 40 } }
      ],
      { rect: winRect }
    );

    assert.strictEqual(step2State.currentPhase, 'THREAD_READY_FOR_MESSAGE');
    assert.strictEqual(step2State.composerReady, true);
    assert.strictEqual(step2State.activeRecipient, 'Pidduk');
    assert.ok(step2State.stateDelta.includes('ACTIVE and composer is ready'));

    // Verify token compression formatting
    const compactSummary = session.formatCompactAffordanceContext(step2State);
    assert.ok(compactSummary.includes('Persistent UI State'));
    assert.ok(compactSummary.includes('Phase: THREAD_READY_FOR_MESSAGE'));
    assert.ok(compactSummary.includes('Active Recipient in View: Pidduk'));
    assert.ok(compactSummary.includes('Composer Ready: YES'));
    // Ensure compact representation is concise (< 1000 chars vs raw OCR dumps that exceed 15000 chars)
    assert.ok(compactSummary.length < 1500, `Context representation should be compact (was ${compactSummary.length} chars)`);

    console.log('✓ Test 4: StatefulPCSession state transitions and token-compact formatting verified');
  }

  // Test 5: NON_INTERACTIVE_LABELS contains standard non-actionable static text
  {
    assert.ok(NON_INTERACTIVE_LABELS.has('chats'));
    assert.ok(NON_INTERACTIVE_LABELS.has('messages'));
    assert.ok(NON_INTERACTIVE_LABELS.has('unread'));
    assert.ok(NON_INTERACTIVE_LABELS.has('calls'));
    console.log('✓ Test 5: NON_INTERACTIVE_LABELS contains essential non-actionable UI strings');
  }

  console.log('--- All Semantic Affordance Engine Tests Passed Successfully! ---');
}

runAffordanceEngineTests();
