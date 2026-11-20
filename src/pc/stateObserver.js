/**
 * Adion Browse — StateObserver
 *
 * Continuous screen-state polling engine. Replaces all fixed sleep() delays
 * in the PC engine with event-driven, verifiable state transitions.
 *
 * Architecture:
 *   - Polls OCR every POLL_INTERVAL_MS (default 300ms)
 *   - Builds a lightweight "screen signature" from OCR line hashes + pixel sample
 *   - Emits state changes as resolved Promises (no EventEmitter dependency needed)
 *   - Provides: waitForStateChange(), waitForText(), waitForElement(), getSignature()
 *
 * Rules:
 *   - Never throws for a timeout; returns { changed: false, reason: 'timeout' }
 *   - Every poll is independently try/catch'd — a bad OCR read doesn't halt the loop
 *   - Screen signatures are lightweight strings: no image bytes stored in memory
 */

'use strict';

const POLL_INTERVAL_MS = 300;
const HISTORY_DEPTH = 5;

/**
 * Build a cheap screen signature from OCR lines.
 * We hash the concatenation of all line texts + their approximate y-positions.
 * This is O(n) in line count and < 1ms per call.
 * @param {Array} lines - OCR lines [{text, x, y, w, h}]
 * @returns {string} signature
 */
function buildSignature(lines) {
  if (!Array.isArray(lines) || !lines.length) return '__empty__';
  // Sort by y-position for stable ordering regardless of OCR engine output order
  const sorted = lines.slice().sort((a, b) => (a.y || 0) - (b.y || 0));
  // Include text + quantized y position (bucket by 20px to absorb minor jitter)
  return sorted
    .map(l => `${Math.round((l.y || 0) / 20) * 20}:${String(l.text || '').trim()}`)
    .join('|');
}

/**
 * Simple djb2 hash — not cryptographic, just stable string identity
 */
function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (((h << 5) + h) + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * createStateObserver({ readScreen, log, pollIntervalMs })
 *
 * readScreen(): async → { ok, lines: [{text, x, y, w, h}], text, words }
 *   Must return an OCR result. This is the same readScreen() from screenWatch.js.
 *
 * log(msg): optional logger
 */
function createStateObserver({ readScreen, log, pollIntervalMs } = {}) {
  if (typeof readScreen !== 'function') {
    throw new Error('StateObserver requires a readScreen() function');
  }
  const logger = typeof log === 'function' ? log : () => {};
  const interval = Number(pollIntervalMs) > 0 ? Number(pollIntervalMs) : POLL_INTERVAL_MS;

  let running = false;
  let currentSignature = null;
  let currentLines = [];
  let currentText = '';
  let history = []; // last HISTORY_DEPTH signatures
  let pollTimer = null;
  let consecutiveSameCount = 0;

  // --- Internal poll loop ---

  async function doPoll() {
    try {
      const result = await readScreen();
      if (!result || !result.ok) return; // degraded gracefully; keep last known state
      const lines = Array.isArray(result.lines) ? result.lines : [];
      const sig = hash(buildSignature(lines));
      if (sig !== currentSignature) {
        currentSignature = sig;
        currentLines = lines;
        currentText = String(result.text || '');
        history.push({ sig, lines, text: currentText, at: Date.now() });
        if (history.length > HISTORY_DEPTH) history.shift();
        consecutiveSameCount = 0;
      } else {
        consecutiveSameCount++;
      }
    } catch (err) {
      logger(`[StateObserver] poll error: ${err.message}`);
    }
  }

  /**
   * Start continuous background polling.
   * Call start() once when the PC engine begins a task run.
   */
  async function start() {
    if (running) return;
    running = true;
    // Take an immediate baseline reading
    try {
      const result = await readScreen();
      if (result && result.ok) {
        const lines = Array.isArray(result.lines) ? result.lines : [];
        currentSignature = hash(buildSignature(lines));
        currentLines = lines;
        currentText = String(result.text || '');
        history = [{ sig: currentSignature, lines, text: currentText, at: Date.now() }];
      }
    } catch (_) {}

    function scheduleNext() {
      if (!running) return;
      pollTimer = setTimeout(async () => {
        await doPoll();
        scheduleNext();
      }, interval);
    }
    scheduleNext();
    logger('[StateObserver] continuous polling started');
  }

  /**
   * Stop the polling loop. Call when the task run ends.
   */
  function stop() {
    running = false;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    logger('[StateObserver] polling stopped');
  }

  /**
   * Get the current screen signature (opaque string).
   */
  function getSignature() {
    return currentSignature;
  }

  /**
   * Get the current OCR lines.
   */
  function getLines() {
    return currentLines;
  }

  /**
   * Check if the screen has been stuck (same signature) for N consecutive polls.
   */
  function isStuck(consecutiveThreshold = 3) {
    return consecutiveSameCount >= consecutiveThreshold;
  }

  /**
   * waitForStateChange(timeoutMs)
   *
   * Resolves as soon as the screen signature changes from what it was when this
   * was called. Returns { changed: true } or { changed: false, reason: 'timeout' }.
   *
   * This is the primary replacement for `await sleep(settle)` throughout pcSession.js.
   */
  async function waitForStateChange(timeoutMs = 1800) {
    const baselineSig = currentSignature;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      // Poll directly (not just wait for background timer) for lower latency
      await doPoll();
      if (currentSignature !== baselineSig) {
        logger(`[StateObserver] state changed after ${timeoutMs - (deadline - Date.now())}ms`);
        return { changed: true, signature: currentSignature, lines: currentLines };
      }
      // Small yield — don't hammer the OCR engine
      await sleep(Math.min(interval, deadline - Date.now()));
    }

    logger(`[StateObserver] waitForStateChange timeout after ${timeoutMs}ms`);
    return { changed: false, reason: 'timeout', signature: currentSignature };
  }

  /**
   * waitForText(pattern, timeoutMs)
   *
   * Polls until the given text pattern appears in OCR output.
   *
   * pattern: string (substring match) or RegExp
   * Returns { found: true, line, text } or { found: false, reason: 'timeout' }
   *
   * Usage examples:
   *   await stateObserver.waitForText('Type a message', 3000)  // composer appeared
   *   await stateObserver.waitForText(/Pramod/i, 4000)         // contact name in header
   *   await stateObserver.waitForText('Message sent', 5000)    // send confirmation
   */
  async function waitForText(pattern, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    const isRegex = pattern instanceof RegExp;
    const test = isRegex
      ? (t) => pattern.test(t)
      : (t) => String(t).toLowerCase().includes(String(pattern).toLowerCase());

    while (Date.now() < deadline) {
      await doPoll();
      // Check full text first (fast path)
      if (test(currentText)) {
        // Find the specific line that matches
        const line = currentLines.find(l => test(l.text || ''));
        logger(`[StateObserver] text "${isRegex ? pattern : pattern}" found in OCR`);
        return { found: true, line: line || null, text: currentText };
      }
      await sleep(Math.min(interval, deadline - Date.now()));
    }

    logger(`[StateObserver] waitForText timeout: "${isRegex ? pattern : pattern}" not found in ${timeoutMs}ms`);
    return { found: false, reason: 'timeout' };
  }

  /**
   * waitForTextGone(pattern, timeoutMs)
   *
   * Polls until the given text pattern DISAPPEARS from OCR output.
   * Useful for: waiting for a search box to clear, a dialog to close, etc.
   */
  async function waitForTextGone(pattern, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    const isRegex = pattern instanceof RegExp;
    const test = isRegex
      ? (t) => pattern.test(t)
      : (t) => String(t).toLowerCase().includes(String(pattern).toLowerCase());

    while (Date.now() < deadline) {
      await doPoll();
      if (!test(currentText)) {
        logger(`[StateObserver] text pattern gone from screen`);
        return { gone: true };
      }
      await sleep(Math.min(interval, deadline - Date.now()));
    }

    return { gone: false, reason: 'timeout' };
  }

  /**
   * verifyActionEffect(description, verifyFn, timeoutMs)
   *
   * After performing an action, call this to verify its actual effect on-screen.
   * verifyFn(lines, text) → boolean
   *
   * Returns { verified: true } or { verified: false, reason, lines, text }
   *
   * This is used for POST-ACTION VERIFICATION — the state machine's VERIFYING state.
   */
  async function verifyActionEffect(description, verifyFn, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await doPoll();
      try {
        if (verifyFn(currentLines, currentText)) {
          logger(`[StateObserver] verified: ${description}`);
          return { verified: true, lines: currentLines, text: currentText };
        }
      } catch (err) {
        logger(`[StateObserver] verifyFn error: ${err.message}`);
      }
      await sleep(Math.min(interval, deadline - Date.now()));
    }

    logger(`[StateObserver] verification failed: ${description} (timeout ${timeoutMs}ms)`);
    return {
      verified: false,
      reason: `Verification timed out: "${description}" was not confirmed on-screen within ${timeoutMs}ms`,
      lines: currentLines,
      text: currentText
    };
  }

  /**
   * snapshot()
   * Returns the current state for use in planner context enrichment.
   */
  function snapshot() {
    return {
      signature: currentSignature,
      lines: currentLines.slice(),
      text: currentText,
      consecutiveSame: consecutiveSameCount,
      stuck: consecutiveSameCount >= 3,
      historyDepth: history.length,
    };
  }

  return {
    start,
    stop,
    getSignature,
    getLines,
    isStuck,
    waitForStateChange,
    waitForText,
    waitForTextGone,
    verifyActionEffect,
    snapshot,
  };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, Math.max(0, ms)));
}

module.exports = { createStateObserver, buildSignature, hash };
