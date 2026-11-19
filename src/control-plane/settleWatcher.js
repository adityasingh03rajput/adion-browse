/**
 * Adion Browse — Settle Watcher
 *
 * "Did the action take?" answered by watching the page instead of napping a
 * fixed 700–900 ms and looking once.
 *
 * A click has taken when the snapshot moves away from the one taken before the
 * action, and then holds still. The wait ends the moment that happens, so a
 * fast page is no longer penalised with a fixed sleep, and a slow one is no
 * longer read before it has rendered.
 *
 * Snapshots are whatever the caller's `sample()` returns; distance() only knows
 * the shape AdionRuntime's captureInteractionState() produces:
 *   { dom: { url, textLen, nodes }, visual?: number[] }
 *
 * Pure apart from the injected sample/sleep/now, so it runs under node --test.
 */

'use strict';

const DEFAULT_INTERVAL_MS = 140;
const DEFAULT_TIMEOUT_MS = 1600;
const DEFAULT_GIVE_UP_MS = 800;
const DEFAULT_SETTLE_AFTER_MS = 700;
const DEFAULT_STILL_EPSILON = 0.001;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

/**
 * How different two snapshots are, 0 (identical) .. 1 (unrelated).
 * The worst single component wins: a URL change is a full change even if the
 * document length happens to match.
 */
function distance(a, b) {
  if (!a || !b) return 1;
  const ad = a.dom || {};
  const bd = b.dom || {};
  const parts = [];

  parts.push(ad.url !== bd.url ? 1 : 0);
  parts.push(clamp01(Math.abs(Number(ad.textLen || 0) - Number(bd.textLen || 0)) / 400));
  parts.push(clamp01(Math.abs(Number(ad.nodes || 0) - Number(bd.nodes || 0)) / 80));

  const av = a.visual;
  const bv = b.visual;
  if (Array.isArray(av) && Array.isArray(bv) && av.length > 0 && av.length === bv.length) {
    let differing = 0;
    for (let i = 0; i < av.length; i++) {
      if (Math.abs(Number(av[i] || 0) - Number(bv[i] || 0)) >= 2) differing++;
    }
    parts.push(differing / av.length);
  }

  return Math.max(...parts);
}

function isStill(a, b, epsilon = DEFAULT_STILL_EPSILON) {
  return distance(a, b) <= epsilon;
}

/**
 * createSettleWatcher({ sample, intervalMs, changeTest, now, sleep })
 *
 * sample:     async () => snapshot | null
 * changeTest: optional (before, current) => boolean; defaults to distance()
 * now/sleep:  injectable clock for tests
 */
function createSettleWatcher(options = {}) {
  const sample = options.sample;
  if (typeof sample !== 'function') throw new Error('settleWatcher requires a sample() function');
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : DEFAULT_INTERVAL_MS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep;
  const customChangeTest = typeof options.changeTest === 'function' ? options.changeTest : null;

  /**
   * -> { changed, settled, frames, ms, gaveUp?, stale? }
   *
   * before:  snapshot taken before the action (required for a "changed" answer)
   * opts:    { timeoutMs, giveUpMs, settleAfterMs, stillFrames, stillEpsilon,
   *            moveThreshold, isStale }
   */
  async function waitForSettle(before, opts = {}) {
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const giveUpMs = Math.min(
      Number(opts.giveUpMs) > 0 ? Number(opts.giveUpMs) : DEFAULT_GIVE_UP_MS,
      timeoutMs
    );
    const settleAfterMs = Math.min(
      Number(opts.settleAfterMs) > 0 ? Number(opts.settleAfterMs) : DEFAULT_SETTLE_AFTER_MS,
      timeoutMs
    );
    const stillFrames = Number.isFinite(opts.stillFrames) && opts.stillFrames > 0 ? Math.round(opts.stillFrames) : 1;
    const epsilon = Number.isFinite(opts.stillEpsilon) ? opts.stillEpsilon : DEFAULT_STILL_EPSILON;
    const moveThreshold = Number.isFinite(opts.moveThreshold) ? opts.moveThreshold : 0.005;
    const isStale = typeof opts.isStale === 'function' ? opts.isStale : () => false;

    const changeTest = customChangeTest
      ? (base, current) => customChangeTest(base, current)
      : (base, current) => distance(base, current) > moveThreshold;

    const startedAt = now();
    const deadline = startedAt + timeoutMs;
    const giveUpAt = startedAt + giveUpMs;

    let moved = false;
    let movedAt = 0;
    let previous = null;
    let steady = 0;
    let frames = 0;

    const result = (extra) => Object.assign({ changed: moved, settled: false, frames, ms: now() - startedAt }, extra || {});

    while (now() < deadline) {
      if (isStale()) return result({ stale: true });

      // Nothing has moved at all by now: it is not going to.
      if (!moved && frames > 0 && now() >= giveUpAt) return result({ changed: false, settled: true, gaveUp: true });

      let current = null;
      try {
        current = await sample();
      } catch (_) {
        current = null;
      }
      frames++;

      if (!current) {
        await sleep(intervalMs);
        continue;
      }

      if (!moved) {
        if (before && changeTest(before, current)) {
          moved = true;
          movedAt = now();
        }
      } else if (previous && isStill(previous, current, epsilon)) {
        steady++;
        if (steady >= stillFrames) return result({ changed: true, settled: true });
      } else {
        steady = 0;
      }

      // The page reacted and has been busy changing for a while: it reacted,
      // which is all the caller needed to know. Do not hold up the run for it.
      if (moved && now() - movedAt >= settleAfterMs) return result({ changed: true, settled: false });

      previous = current;
      await sleep(intervalMs);
    }

    return result();
  }

  return { waitForSettle, distance, isStill };
}

module.exports = {
  createSettleWatcher,
  distance,
  isStill,
  DEFAULT_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_GIVE_UP_MS,
  DEFAULT_SETTLE_AFTER_MS,
  DEFAULT_STILL_EPSILON
};
