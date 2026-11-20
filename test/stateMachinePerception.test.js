'use strict';

const assert = require('assert');
const { classifyScreenState, detectLoopCycle } = require('../src/pc/stateMachinePerception');

function runPerceptionTests() {
  console.log('--- Running State Machine Perception Unit Tests ---');

  // Test 1: Classify screen when chat is open with recipient
  {
    const ocr = {
      lines: [
        { text: 'Don Pidduk', x: 350, y: 50, w: 120, h: 25 },
        { text: 'online', x: 350, y: 80, w: 60, h: 18 },
        { text: 'Type a message', x: 450, y: 920, w: 200, h: 30 }
      ],
      text: 'Don Pidduk\nonline\nType a message'
    };
    const elements = [
      { id: 1, type: 'Edit', name: 'Type a message' }
    ];
    const fg = { process: 'whatsapp', title: 'WhatsApp' };
    const goal = 'send a message to Pidduk saying i love her';

    const state = classifyScreenState(ocr, elements, fg, goal);
    assert.strictEqual(state.phase, 'CHAT_OPEN_READY_TO_COMPOSE');
    assert.strictEqual(state.recipientInHeader, true);
    assert.strictEqual(state.hasComposer, true);
    assert.ok(state.guidance.includes('ALREADY OPEN'));
    console.log('✓ Test 1: CHAT_OPEN_READY_TO_COMPOSE correctly detected with guidance');
  }

  // Test 2: Contact visible in list (not yet open)
  {
    const ocr = {
      lines: [
        { text: 'Chats', x: 50, y: 50, w: 80, h: 30 },
        { text: 'Pidduk', x: 80, y: 220, w: 90, h: 25 }
      ],
      text: 'Chats\nPidduk'
    };
    const elements = [];
    const fg = { process: 'whatsapp', title: 'WhatsApp' };
    const goal = 'open whatsapp and message Pidduk';

    const state = classifyScreenState(ocr, elements, fg, goal);
    assert.strictEqual(state.phase, 'CONTACT_VISIBLE_IN_LIST');
    assert.ok(state.targetContactInList);
    assert.strictEqual(state.targetContactInList.text, 'Pidduk');
    console.log('✓ Test 2: CONTACT_VISIBLE_IN_LIST correctly identified');
  }

  // Test 3: Loop cycle detection (Period 2)
  {
    const history = [
      { action: 'press', report: 'pressed ctrl+f' },
      { action: 'click', report: 'clicked start a chat' },
      { action: 'press', report: 'pressed ctrl+f' },
      { action: 'click', report: 'clicked start a chat' }
    ];
    const loop = detectLoopCycle(history);
    assert.ok(loop);
    assert.strictEqual(loop.type, 'PERIOD_2');
    console.log('✓ Test 3: detectLoopCycle flags period 2 oscillating cycle');
  }

  console.log('--- All Perception Tests Passed Successfully! ---');
}

runPerceptionTests();
