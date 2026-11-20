/**
 * Adion Browse — Vision-Grounded PC State Machine & Perception Engine
 *
 * Dynamically perceives the interface state from OCR text and UIA elements,
 * identifies functional goals, verifies state transitions, and prevents
 * circular blind script loops.
 *
 * Capabilities:
 *   - classifyScreenState(ocr, elements, fg, goal)
 *   - verifyStateTransition(beforeState, afterState, expectedGoal)
 *   - detectCycle(stateHistory, actionHistory)
 */

'use strict';

/**
 * Extracts words and clean tokens from text.
 */
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

/**
 * Analyzes the live screen to determine the semantic interface state.
 *
 * @param {object} ocr - { lines: [...], text: '...' }
 * @param {Array} elements - UIA controls list
 * @param {object} fg - foreground window info { title, process, hwnd }
 * @param {string} goal - overall user prompt / goal
 * @returns {object} semantic state object
 */
function classifyScreenState(ocr, elements, fg, goal = '') {
  const lines = Array.isArray(ocr?.lines) ? ocr.lines : [];
  const allText = String(ocr?.text || '').toLowerCase();
  const els = Array.isArray(elements) ? elements : [];
  const proc = String(fg?.process || '').toLowerCase();
  const title = String(fg?.title || '').toLowerCase();

  const goalTokens = tokenize(goal).filter(t => !['open', 'send', 'message', 'text', 'chat', 'to', 'the', 'and', 'app', 'with', 'saying'].includes(t));

  // 1. Detect open chat / thread header
  let activeRecipient = null;
  let recipientInHeader = false;
  let composerLine = null;
  let searchActive = false;
  let searchInput = null;

  // Find editable inputs and composer
  for (const l of lines) {
    const lt = (l.text || '').trim().toLowerCase();
    if (/type\s+a\s+message|message\s+#|write\s+a\s+reply|send\s+a\s+message|start\s+a\s+message/i.test(lt)) {
      composerLine = l;
    }
    if (/search\s+or\s+start|search\s+chats|search\s+messages|find\s+or\s+start|search/i.test(lt) && l.y < 250) {
      searchInput = l;
    }
  }

  // Check UIA controls for textboxes and headers
  let composerControl = null;
  for (const el of els) {
    const name = String(el.name || '').toLowerCase();
    const type = String(el.type || '');
    if (/edit|textbox/i.test(type)) {
      if (/message|type|compose|reply/i.test(name)) composerControl = el;
      if (/search/i.test(name)) searchActive = true;
    }
  }

  // Detect which contact / channel is open at the top of the chat panel (y < 250, center-right)
  // In WhatsApp / Slack / Teams / Discord, the chat header is located in the upper-right pane (x > 300, y < 150)
  const headerLines = lines.filter(l => l.y >= 20 && l.y <= 130 && l.x > 250);
  for (const hl of headerLines) {
    const ht = (hl.text || '').trim();
    if (!ht || /search|menu|calls|status|chats|settings|community|profile/i.test(ht)) continue;
    // Check if header matches any goal target tokens
    const hTokens = tokenize(ht);
    const matchesGoal = goalTokens.some(gt => hTokens.some(tok => tok.includes(gt) || gt.includes(tok)));
    if (matchesGoal) {
      activeRecipient = ht;
      recipientInHeader = true;
      break;
    } else if (!activeRecipient && ht.length > 2) {
      activeRecipient = ht;
    }
  }

  // Check if target contact is visible in chat list
  let targetContactInList = null;
  for (const l of lines) {
    const lt = (l.text || '').trim();
    if (!lt || l.y > 900) continue;
    const lTokens = tokenize(lt);
    const isTarget = goalTokens.some(gt => lTokens.some(tok => tok.includes(gt) || gt.includes(tok)));
    if (isTarget && l !== composerLine) {
      targetContactInList = l;
      break;
    }
  }

  // Determine High-Level Semantic Phase
  let phase = 'UNKNOWN';
  let guidance = '';

  if (recipientInHeader && (composerLine || composerControl)) {
    phase = 'CHAT_OPEN_READY_TO_COMPOSE';
    guidance = `Target chat "${activeRecipient}" is ALREADY OPEN in the foreground! The message composer is ready. DO NOT press Ctrl+F or search. Click or type directly into the composer.`;
  } else if (recipientInHeader) {
    phase = 'CHAT_OPEN_NO_COMPOSER';
    guidance = `Target chat "${activeRecipient}" is open in header. Click the bottom composer area to type message.`;
  } else if (targetContactInList) {
    phase = 'CONTACT_VISIBLE_IN_LIST';
    guidance = `Target contact "${targetContactInList.text}" is visible on screen! Click directly on "${targetContactInList.text}" to open the chat.`;
  } else if (allText.includes('search') || searchInput) {
    phase = 'SEARCH_AVAILABLE';
    guidance = `Target contact is not immediately visible. Use search to find recipient.`;
  } else {
    phase = 'MAIN_WINDOW_ACTIVE';
    guidance = `App is in foreground. Look for recipient or navigation options.`;
  }

  const stateId = `${proc}:${phase}:${recipientInHeader ? activeRecipient : 'no-recipient'}:${Boolean(composerLine || composerControl)}`;

  return {
    stateId,
    phase,
    activeRecipient,
    recipientInHeader,
    hasComposer: Boolean(composerLine || composerControl),
    composerCoords: composerLine ? { x: Math.round(composerLine.x + composerLine.w / 2), y: Math.round(composerLine.y + composerLine.h / 2) } : null,
    targetContactInList: targetContactInList ? { text: targetContactInList.text, x: Math.round(targetContactInList.x + targetContactInList.w / 2), y: Math.round(targetContactInList.y + targetContactInList.h / 2) } : null,
    guidance
  };
}

/**
 * Detects cyclic action loops (e.g. A -> B -> A -> B or A -> B -> C -> A)
 * across the action history and semantic states.
 */
function detectLoopCycle(history = []) {
  if (history.length < 3) return null;

  const actions = history.map(h => `${h.action}:${(h.report || '').slice(0, 30)}`);
  const n = actions.length;

  // Check period 2: A B A B
  if (n >= 4 && actions[n - 1] === actions[n - 3] && actions[n - 2] === actions[n - 4]) {
    return {
      type: 'PERIOD_2',
      cycle: [actions[n - 2], actions[n - 1]],
      warning: `Oscillating loop detected between "${actions[n - 2]}" and "${actions[n - 1]}". STOP repeating this cycle. Take an entirely different action or interact directly with the input/target.`
    };
  }

  // Check period 3: A B C A B C
  if (n >= 6 && actions[n - 1] === actions[n - 4] && actions[n - 2] === actions[n - 5] && actions[n - 3] === actions[n - 6]) {
    return {
      type: 'PERIOD_3',
      cycle: [actions[n - 3], actions[n - 2], actions[n - 1]],
      warning: `3-step circular loop detected. Break out of this cycle immediately.`
    };
  }

  // Repeated same action without progress
  if (n >= 2 && actions[n - 1] === actions[n - 2] && history[n - 1].changed === false) {
    return {
      type: 'REPEATED_NOOP',
      action: actions[n - 1],
      warning: `Action "${actions[n - 1]}" had no effect. Do NOT repeat it.`
    };
  }

  return null;
}

module.exports = {
  classifyScreenState,
  detectLoopCycle,
  tokenize
};
