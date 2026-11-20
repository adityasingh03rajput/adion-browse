/**
 * Adion Browse — DOM State Machine & Event-Driven Perception Engine
 *
 * Replaces all brittle imperative script execution and fixed delays with a
 * state-driven architecture that continuously observes DOM mutations,
 * evaluates application states, and verifies functional goals.
 *
 * Core Primitives:
 *   - waitForDOMCondition: evaluates predicate against live DOM with timeout
 *   - waitForElementWithObserver: MutationObserver-driven wait for interactive elements
 *   - waitForDOMSettled: waits for DOM mutations to cease (quiet window)
 *   - waitForFileInput: waits for file inputs across standard DOM & Shadow roots
 *   - waitForNavigationSettled: did-stop-loading with did-fail-load safety
 *   - waitForURLChange: URL delta detection via events + polling
 *   - waitForTabCountChange / waitForTabClose: tab lifecycle state verification
 *   - waitForScrollChange: scroll position delta verification
 *   - retryWithBackoff: exponential-backoff retry with jitter
 *   - StateMachine: dynamic state machine coordinator (Sense -> Plan -> Act -> Verify)
 */

'use strict';

const DEFAULT_POLL_MS    = 60;   // DOM poll interval
const DEFAULT_TIMEOUT_MS = 5000; // Max wait for any condition
const MAX_BACKOFF_MS     = 6000; // Ceiling for exponential backoff

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

/**
 * Polls a JS expression against the page context until it returns truthy,
 * the timeout expires, or the abort signal triggers.
 */
async function waitForDOMCondition(webContents, jsExpression, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const pollMs    = Number(opts.pollMs)    > 0 ? opts.pollMs    : DEFAULT_POLL_MS;
  const label     = opts.label || 'DOM condition';
  const signal    = opts.abortSignal || null;

  const start = Date.now();
  const deadline = start + timeoutMs;

  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, timedOut: false, ms: 0, reason: 'webContents unavailable' };
  }

  while (Date.now() < deadline) {
    if (signal && signal.aborted) {
      return { ok: false, timedOut: false, ms: Date.now() - start, reason: 'aborted' };
    }

    try {
      let result = null;
      if (webContents.debugger && webContents.debugger.isAttached()) {
        const cdpResult = await webContents.debugger
          .sendCommand('Runtime.evaluate', {
            expression: `!!(${jsExpression})`,
            returnByValue: true,
            awaitPromise: false
          })
          .catch(() => null);
        result = cdpResult?.result?.value;
      } else {
        result = await webContents
          .executeJavaScript(`!!(${jsExpression})`, true)
          .catch(() => false);
      }

      if (result) {
        return { ok: true, timedOut: false, ms: Date.now() - start };
      }
    } catch (_) {
      // In-flight navigation or transient context destruction: continue polling
    }

    await _sleep(pollMs);
  }

  return {
    ok: false,
    timedOut: true,
    ms: Date.now() - start,
    reason: `${label} not met within ${timeoutMs}ms`
  };
}

/**
 * MutationObserver-backed element waiter.
 * Monitors DOM mutations directly in the page to detect element presence the
 * moment it renders in React 18, Vue, Angular, Svelte, or Shadow DOM, rather than
 * relying on blind delays.
 */
async function waitForElementWithObserver(webContents, targetSelectorOrText, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? opts.timeoutMs : 6000;
  const start = Date.now();

  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, timedOut: false, ms: 0, reason: 'webContents unavailable' };
  }

  const query = JSON.stringify(String(targetSelectorOrText || '').trim());

  const observerScript = `
    (() => {
      return new Promise((resolve) => {
        const target = ${query};
        if (!target) return resolve({ found: false, reason: 'empty query' });

        const isInteractive = (el) => {
          if (!el) return false;
          const tag = el.tagName.toLowerCase();
          const role = (el.getAttribute('role') || '').toLowerCase();
          if (['button', 'a', 'input', 'textarea', 'select', 'option'].includes(tag)) return true;
          if (['button', 'link', 'menuitem', 'tab', 'checkbox', 'switch', 'radio', 'textbox'].includes(role)) return true;
          if (el.onclick || el.getAttribute('onclick') || el.isContentEditable || el.hasAttribute('contenteditable')) return true;
          if (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') return true;
          return !!el.closest('button, a[href], [role="button"], [role="link"], input, textarea, select');
        };

        const checkMatch = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;

          const tLow = target.toLowerCase();
          // Selector test
          try {
            if (el.matches && el.matches(target)) return true;
          } catch (_) {}

          // Semantic attributes
          const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
          const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
          const title = (el.getAttribute('title') || '').toLowerCase();
          const text = (el.innerText || el.textContent || '').trim().toLowerCase();

          if (ariaLabel.includes(tLow) || placeholder.includes(tLow) || title.includes(tLow)) return true;
          if (text === tLow || (text.includes(tLow) && text.length < tLow.length + 50)) return true;
          return false;
        };

        // Immediate check
        const findInRoot = (root) => {
          // Direct selector attempt
          try {
            const el = root.querySelector(target);
            if (el && checkMatch(el)) return el;
          } catch (_) {}

          const all = root.querySelectorAll('*');
          for (let i = 0; i < all.length; i++) {
            const el = all[i];
            if (checkMatch(el)) return el;
            if (el.shadowRoot) {
              const shadowMatch = findInRoot(el.shadowRoot);
              if (shadowMatch) return shadowMatch;
            }
          }
          return null;
        };

        const existing = findInRoot(document);
        if (existing) {
          const rect = existing.getBoundingClientRect();
          return resolve({
            found: true,
            interactive: isInteractive(existing),
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            tag: existing.tagName.toLowerCase()
          });
        }

        // MutationObserver: react instantly to DOM changes
        let resolved = false;
        const observer = new MutationObserver((mutations) => {
          if (resolved) return;
          const el = findInRoot(document);
          if (el) {
            resolved = true;
            observer.disconnect();
            const rect = el.getBoundingClientRect();
            resolve({
              found: true,
              interactive: isInteractive(el),
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              tag: el.tagName.toLowerCase()
            });
          }
        });

        observer.observe(document.documentElement || document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-hidden']
        });

        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            observer.disconnect();
            resolve({ found: false, timeout: true });
          }
        }, ${timeoutMs});
      });
    })()
  `;

  try {
    const res = await webContents.executeJavaScript(observerScript, true);
    if (res && res.found) {
      return { ok: true, found: true, ...res, ms: Date.now() - start };
    }
    return { ok: false, found: false, timedOut: true, ms: Date.now() - start, reason: `Element "${targetSelectorOrText}" did not render within ${timeoutMs}ms` };
  } catch (err) {
    return { ok: false, found: false, error: err.message, ms: Date.now() - start };
  }
}

/**
 * Waits for DOM mutations to settle (quiet window).
 * Ensures SPAs, lazy loaders, and animated panels have stopped mutating before next step.
 */
async function waitForDOMSettled(webContents, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? opts.timeoutMs : 3000;
  const quietMs   = Number(opts.quietMs)   > 0 ? opts.quietMs   : 140;
  const start     = Date.now();

  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, ms: 0, reason: 'webContents unavailable' };
  }

  const settleScript = `
    (() => {
      return new Promise((resolve) => {
        let quietTimer = null;
        let settled = false;

        const finish = (changed) => {
          if (settled) return;
          settled = true;
          if (observer) observer.disconnect();
          if (quietTimer) clearTimeout(quietTimer);
          resolve({ settled: true, changed });
        };

        const onMutation = () => {
          if (settled) return;
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = setTimeout(() => finish(true), ${quietMs});
        };

        const observer = new MutationObserver(onMutation);
        observer.observe(document.documentElement || document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true
        });

        // If no mutations occur initially within quietMs, it's already settled
        quietTimer = setTimeout(() => finish(false), ${quietMs});

        // Max hard timeout
        setTimeout(() => finish(true), ${timeoutMs});
      });
    })()
  `;

  try {
    const res = await webContents.executeJavaScript(settleScript, true);
    return { ok: true, settled: res?.settled !== false, changed: res?.changed, ms: Date.now() - start };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: err.message };
  }
}

/**
 * Waits for a file input element to be present in DOM or mount via MutationObserver.
 * Traverses standard DOM, iframes, and Shadow DOM.
 */
async function waitForFileInput(webContents, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? opts.timeoutMs : 4000;
  const start = Date.now();

  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, found: false, ms: 0, reason: 'webContents unavailable' };
  }

  const findFileInputScript = `
    (() => {
      return new Promise((resolve) => {
        const findInput = () => {
          // Standard input[type="file"]
          let input = document.querySelector('input[type="file"]');
          if (input) return input;

          // Piercing shadow roots
          const allEls = document.querySelectorAll('*');
          for (const el of allEls) {
            if (el.shadowRoot) {
              const shadowInput = el.shadowRoot.querySelector('input[type="file"]');
              if (shadowInput) return shadowInput;
            }
          }

          // In-page drop targets
          const dropTarget = document.querySelector('[data-drop-zone="true"], .dropzone, [role="button"][aria-label*="attach" i], [role="button"][aria-label*="upload" i]');
          if (dropTarget) return dropTarget;

          return null;
        };

        const el = findInput();
        if (el) return resolve({ found: true, isInput: el.tagName.toLowerCase() === 'input' });

        const observer = new MutationObserver(() => {
          const matched = findInput();
          if (matched) {
            observer.disconnect();
            resolve({ found: true, isInput: matched.tagName.toLowerCase() === 'input' });
          }
        });

        observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
        setTimeout(() => {
          observer.disconnect();
          resolve({ found: false, timedOut: true });
        }, ${timeoutMs});
      });
    })()
  `;

  try {
    const res = await webContents.executeJavaScript(findFileInputScript, true);
    return { ok: Boolean(res?.found), found: Boolean(res?.found), isInput: res?.isInput, ms: Date.now() - start };
  } catch (err) {
    return { ok: false, found: false, ms: Date.now() - start, error: err.message };
  }
}

/**
 * Resolves when webContents finishes loading, or fails.
 */
function waitForNavigationSettled(webContents, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? opts.timeoutMs : 8000;
  const label     = opts.label || 'navigation';
  const start     = Date.now();

  return new Promise((resolve) => {
    if (!webContents || webContents.isDestroyed()) {
      return resolve({ ok: false, timedOut: false, ms: 0, reason: 'webContents unavailable' });
    }

    if (!webContents.isLoading()) {
      return resolve({ ok: true, timedOut: false, ms: 0 });
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: false, timedOut: true, ms: Date.now() - start, reason: `${label} timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    function onStop() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: true, timedOut: false, ms: Date.now() - start });
    }

    function onFail(_e, errorCode, errorDescription) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: false, timedOut: false, ms: Date.now() - start, reason: `Navigation failed: ${errorDescription} (${errorCode})` });
    }

    function cleanup() {
      clearTimeout(timer);
      try { webContents.removeListener('did-stop-loading', onStop); } catch (_) {}
      try { webContents.removeListener('did-fail-load', onFail); } catch (_) {}
    }

    try {
      webContents.once('did-stop-loading', onStop);
      webContents.once('did-fail-load', onFail);
    } catch (err) {
      cleanup();
      resolve({ ok: false, timedOut: false, ms: Date.now() - start, reason: err.message });
    }
  });
}

/**
 * Waits for active URL to change from fromUrl via event listeners and polling.
 */
async function waitForURLChange(webContents, fromUrl, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? opts.timeoutMs : 5000;
  const pollMs    = Number(opts.pollMs)    > 0 ? opts.pollMs    : DEFAULT_POLL_MS;
  const start     = Date.now();
  const deadline  = start + timeoutMs;

  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, timedOut: false, ms: 0, reason: 'webContents unavailable' };
  }

  const eventResult = await new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) { resolved = true; cleanup(); resolve(null); }
    }, Math.min(timeoutMs, 2000));

    function onNavigate(_, url) {
      if (!resolved && url && url !== fromUrl) {
        resolved = true;
        cleanup();
        resolve({ ok: true, timedOut: false, ms: Date.now() - start, url });
      }
    }

    function cleanup() {
      clearTimeout(timer);
      try { webContents.removeListener('did-navigate', onNavigate); } catch (_) {}
      try { webContents.removeListener('did-navigate-in-page', onNavigate); } catch (_) {}
    }

    try {
      webContents.on('did-navigate', onNavigate);
      webContents.on('did-navigate-in-page', onNavigate);
    } catch (_) {
      cleanup();
      resolve(null);
    }
  });

  if (eventResult) return eventResult;

  while (Date.now() < deadline) {
    try {
      const cur = webContents.getURL ? webContents.getURL() : '';
      if (cur && cur !== fromUrl) {
        return { ok: true, timedOut: false, ms: Date.now() - start, url: cur };
      }
    } catch (_) {}
    await _sleep(pollMs);
  }

  return { ok: false, timedOut: true, ms: Date.now() - start, reason: `URL unchanged from "${fromUrl}" after ${timeoutMs}ms` };
}

/**
 * Waits for tab count change in tabManager.
 */
async function waitForTabCountChange(tabManager, fromCount, opts = {}) {
  const timeoutMs  = Number(opts.timeoutMs) > 0 ? opts.timeoutMs : 3000;
  const pollMs     = Number(opts.pollMs)    > 0 ? opts.pollMs    : DEFAULT_POLL_MS;
  const direction  = opts.direction || 'any';
  const start      = Date.now();
  const deadline   = start + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const cur = tabManager && tabManager.tabs ? tabManager.tabs.size : fromCount;
      if (direction === 'increase' && cur > fromCount) return { ok: true, timedOut: false, ms: Date.now() - start, count: cur };
      if (direction === 'decrease' && cur < fromCount) return { ok: true, timedOut: false, ms: Date.now() - start, count: cur };
      if (direction === 'any'      && cur !== fromCount) return { ok: true, timedOut: false, ms: Date.now() - start, count: cur };
    } catch (_) {}
    await _sleep(pollMs);
  }

  return { ok: false, timedOut: true, ms: Date.now() - start, reason: `Tab count did not change from ${fromCount} within ${timeoutMs}ms` };
}

/**
 * Waits for specific tab to close.
 */
async function waitForTabClose(tabManager, tabId, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? opts.timeoutMs : 2500;
  const pollMs    = Number(opts.pollMs)    > 0 ? opts.pollMs    : DEFAULT_POLL_MS;
  const start     = Date.now();
  const deadline  = start + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if (!tabManager.tabs.has(tabId)) {
        return { ok: true, timedOut: false, ms: Date.now() - start };
      }
    } catch (_) {}
    await _sleep(pollMs);
  }

  return { ok: false, timedOut: true, ms: Date.now() - start, reason: `Tab ${tabId} still present after ${timeoutMs}ms` };
}

/**
 * Waits for scroll position delta.
 */
async function waitForScrollChange(webContents, fromScrollY, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? opts.timeoutMs : 1500;
  const pollMs    = Number(opts.pollMs)    > 0 ? opts.pollMs    : DEFAULT_POLL_MS;
  const threshold = Number(opts.threshold) > 0 ? opts.threshold : 5;
  const start     = Date.now();
  const deadline  = start + timeoutMs;

  if (!webContents || webContents.isDestroyed()) {
    return { ok: false, timedOut: false, ms: 0, reason: 'webContents unavailable' };
  }

  while (Date.now() < deadline) {
    try {
      let scrollY;
      if (webContents.debugger && webContents.debugger.isAttached()) {
        const r = await webContents.debugger
          .sendCommand('Runtime.evaluate', { expression: 'window.scrollY || document.documentElement.scrollTop || 0', returnByValue: true })
          .catch(() => null);
        scrollY = r?.result ? Number(r.result.value) : fromScrollY;
      } else {
        scrollY = await webContents
          .executeJavaScript('window.scrollY || document.documentElement.scrollTop || 0', true)
          .catch(() => fromScrollY);
      }

      if (Math.abs(scrollY - fromScrollY) >= threshold) {
        return { ok: true, timedOut: false, ms: Date.now() - start, scrollY };
      }
    } catch (_) {}
    await _sleep(pollMs);
  }

  return { ok: false, timedOut: true, ms: Date.now() - start, reason: `Scroll unchanged from ${fromScrollY}` };
}

/**
 * Exponential backoff retry with jitter.
 */
async function retryWithBackoff(fn, opts = {}) {
  const maxAttempts = Number(opts.maxAttempts) > 0 ? opts.maxAttempts : 5;
  const initialMs   = Number(opts.initialMs)   > 0 ? opts.initialMs   : 400;
  const maxMs       = Number(opts.maxMs)       > 0 ? opts.maxMs       : MAX_BACKOFF_MS;
  const shouldRetry = typeof opts.shouldRetry === 'function'
    ? opts.shouldRetry
    : (r) => !r || r.success === false || r.ok === false;
  const onRetry     = typeof opts.onRetry === 'function' ? opts.onRetry : () => {};
  const start       = Date.now();

  let result;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      result = await fn(attempt);
    } catch (err) {
      result = { success: false, ok: false, error: err.message };
    }

    if (!shouldRetry(result, attempt)) {
      return { result, attempts: attempt, totalMs: Date.now() - start };
    }

    if (attempt < maxAttempts) {
      let delayMs = Math.min(initialMs * Math.pow(1.8, attempt - 1), maxMs);
      delayMs = Math.round(delayMs * (0.8 + Math.random() * 0.4));
      onRetry(attempt, delayMs);
      await _sleep(delayMs);
    }
  }

  return { result, attempts: maxAttempts, totalMs: Date.now() - start };
}

/**
 * StateMachine
 * Light, robust state-driven execution engine.
 */
class StateMachine {
  constructor(name = 'dom-state-machine', log = () => {}) {
    this.name    = name;
    this.log     = log;
    this._states = new Map();
  }

  define(stateName, handler) {
    this._states.set(stateName, handler);
    return this;
  }

  to(stateName, payload = {}) {
    return { __transition: true, state: stateName, payload };
  }

  done(result = {}) {
    return { __done: true, result };
  }

  error(reason, details = {}) {
    return { __done: true, result: { success: false, reason, ...details } };
  }

  async run(initialState, initialContext = {}, maxSteps = 40) {
    let current = initialState;
    let context = { ...initialContext };
    let stepCount = 0;

    while (current && stepCount < maxSteps) {
      stepCount++;
      const handler = this._states.get(current);
      if (!handler) {
        this.log(`[StateMachine:${this.name}] Unknown state: "${current}"`);
        return { success: false, reason: `Unknown state: ${current}`, stepCount };
      }

      this.log(`[StateMachine:${this.name}] state="${current}" step=${stepCount}`);
      let outcome;
      try {
        outcome = await handler(context);
      } catch (err) {
        this.log(`[StateMachine:${this.name}] state="${current}" error: ${err.message}`);
        return { success: false, reason: err.message, failedState: current, stepCount };
      }

      if (!outcome) break;
      if (outcome.__done) {
        return { ...(outcome.result || {}), stepCount };
      }
      if (outcome.__transition) {
        current = outcome.state;
        context = { ...context, ...(outcome.payload || {}) };
        continue;
      }
      return { ...(outcome || {}), stepCount };
    }

    return { success: false, reason: `Max steps (${maxSteps}) exceeded in state machine "${this.name}"`, stepCount };
  }
}

module.exports = {
  waitForDOMCondition,
  waitForElementWithObserver,
  waitForDOMSettled,
  waitForFileInput,
  waitForNavigationSettled,
  waitForURLChange,
  waitForTabCountChange,
  waitForTabClose,
  waitForScrollChange,
  retryWithBackoff,
  StateMachine,
  _sleep
};
