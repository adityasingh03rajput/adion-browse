# Adion Browse — Error Tickets & D:\help Solutions

Reference codebase: `D:\help\code\` (nus-companion 0.1.21, reverse-engineered).

---

## TICKET-01 — Click reports SUCCESS but page never changes (WhatsApp chat won't open)

**Status: FIXED (verification layer)** — root cause was TWO bugs:
1. `preClickState` was gated behind `this.vision` → vision unavailable = blind SUCCESS on every click. Now always captured.
2. `interactionStateChanged` used `>0` thresholds on textLen/nodes → WhatsApp's constantly-mutating DOM always reported "changed". Now meaningful thresholds: textLen>40, nodes>15, scrollY/X>80px, focus-change.

**Generalized fix (all actions now verify real effects):**
- `captureInteractionState` DOM signature now includes `scrollY`, `scrollX`, `focused` element
- `interactionStateChanged` detects scroll moves, focus changes, meaningful DOM deltas
- SCROLL: verifies scrollY/content actually moved (was blind)
- NAVIGATE: verifies landed URL contains destination host (was blind)
- NEW_TAB: verifies tab count/activeTabId changed (was blind)
- CLOSE_TAB: verifies tab count decreased (was blind)
- GO_BACK/GO_FORWARD: verifies URL actually changed (was blind)
- RELOAD: verifies did-start-loading fired (was blind)
- CLICK_SELECTOR: always captures pre-state + waits for settle + vision fallback (was vision-gated)
- INPUT_TEXT: `verified:false` → success:false (existed) + NEW `submitVerified` — polls for page reaction after Enter/send click, warns "submit not confirmed" when nothing visibly reacts
- STT: `collapseLoops()` ported — "Open WhatsApp. Open WhatsApp." → "Open WhatsApp." (was discard-or-keep)

**D:\help patterns confirmed already present:** repeats map, sameScreen stagnation, step budget, consent gates (MESSAGE_FIELD/Enter-key), settle watcher.

---

## TICKET-02 — Model re-plan latency looks like a freeze (10–20s silent gaps)

**Symptom:** Long silence between `Re-planning next step` and `FreeModel generated ...`.

**Root cause:** FreeModel `deepseek-v4.1-flash` on ~4k-char WhatsApp prompts is slow; no visible progress.

**D:\help solution** (`companion/src/reflex/index.js`): guard rails + fast local reflex path for common intents before hitting the big model.

**Fix direction (DONE):** heartbeat log `⏳ Still waiting on planner... Xs` every 5s added in `agentRuntime.js` replan block. Remaining: consider a fast-path intent router for trivial commands (scroll, back, open site) to skip model calls entirely.

---

## TICKET-03 — STT mis-transcribes / acoustic fallback misfires

**Symptom (earlier logs):** utterances classified as `"scroll up"` / `"go back"` by acoustic classifier; Whisper returns `"."` for quiet speech; `"I can go to Pintukchat"` for "Pidduk chat".

**Root cause:** VAD segments too eagerly (min speech ~350ms) → clipped audio; Groq Whisper gets poor audio; acoustic fallback guesses wrong.

**D:\help solution** (`companion/src/reflex/listen.js`):
- `speechRms: 400` threshold, `preRollMs: 200` pre-roll, `pauseMs: 450`, `minSpeechMs: 350` — all now ported.
- `collapseLoops()` — collapses Whisper decoder loop repeats ("Open WhatsApp. Open WhatsApp." → dedupe).
- Resident `whisper-server` process (0.43s → 0.17s per clip) — `src/whisper-server.js`.

**Fix direction:** port `collapseLoops()` into `sttEngine.js` post-processing; evaluate local whisper-server for lower latency/offline fallback.

---

## TICKET-04 — INPUT_TEXT "Field never appeared" on WhatsApp search

**Symptom:** `Field never appeared for "...Search or start new chat..." after 8s (NO_EDITABLE_TARGET)` repeatedly.

**Root cause:** WhatsApp's search box is `div[contenteditable]` inside a lazily-mounted panel; selector named the container/label, not the editable.

**Fix direction (PARTIALLY DONE):** added `div[contenteditable="true"]` to editable selectors, `data-tab='3'` WhatsApp pattern, hardware `sendInputEvent` per-char dispatch. Remaining: verify `verified:false` path reports truthfully (already does) and consider nus-companion's sensitive-field guard (`NOT_A_FIELD` regex — refuse typing into buttons/labels).

---

## TICKET-05 — EventEmitter memory leak (did-stop-loading listeners)

**Symptom:** `MaxListenersExceededWarning: 41 did-stop-loading listeners`.

**Fix direction (DONE):** handler refs stored on `wc.__adionHandlerRefs`, removed before re-attach in `tabManager.js`; `agentRuntime.js` load-wait uses self-removing `once` handlers + `timer.unref()`.

---

## TICKET-06 — Voice session drops speech during processing

**Symptom:** user speaks mid-task → audio discarded (`audioSession.active=false` for whole goal loop).

**Fix direction (DONE):** `pendingAudio` secondary VAD + `pendingQueue` (cap 5) drained serially in `triggerAutoEndpoint` finally, then `rearmAudioSession()`. Mirrors Gemini Live continuous `realtimeInput`.

---

## TICKET-07 — Scroll/action infinite loops

**Symptom:** "scroll down" → 12+ iterations of SCROLL.

**Fix direction (DONE):** `actionRepeats` map + `REPEAT_LIMIT=3` + `COOLDOWN_MS=4000` for NAVIGATE/NEW_TAB; screen-stagnation counter warns planner after 2 unchanged screens.

---

## TICKET-08 — WhatsApp-specific fragile selectors (AGENTS.md violation risk)

**Symptom:** planner emits WhatsApp-shaped selectors (`data-tab='3'`, "Search or start new chat").

**Note:** AGENTS.md requires site-agnostic primitives. The `data-tab` hint is a pragmatic bridge but should be generalized to "contenteditable inside the most recently opened dialog/panel" heuristic rather than WhatsApp-specific attributes long-term.

---

## TICKET-09 — "waiting for planner verification" ambiguity

**Symptom:** `Click succeeded ... waiting for planner verification before completing the goal` — unclear whether it's settle-wait or model call.

**Fix direction:** heartbeat added covers model wait; consider emitting explicit `[Settle] watching page...` log when `waitForSettle` runs so both waits are distinguishable.

---

## Priority order
1. **TICKET-01** (click-without-effect verification) — blocks all SPA tasks
2. **TICKET-03** (STT loop-collapse + quieter-speech handling)
3. **TICKET-04** (remaining INPUT_TEXT field discovery)
4. **TICKET-02/09** (visibility — mostly done)
5. **TICKET-08** (generalization cleanup)
