/**
 * Adion Browse — PC session (the loop)
 *
 * Adapted from nus-companion's hands/agent.js and guide/session.js (Apache-2.0,
 * potlakai/nus-companion v0.1.21), renamed and re-fitted to Adion's primitives:
 * the consent gate from src/control-plane/actionConsent.js and the settle
 * watcher from src/control-plane/settleWatcher.js.
 *
 *   idle -> running -> acting -> looking -> ... -> done | stopped | guarded | budget
 *
 * Honesty rules carried over, because they are the point:
 *   - the same action + args is never tried three times
 *   - an action that already failed is never retried identically
 *   - "done" is refused when the last action changed nothing (twice, then given up)
 *   - a screen that has not moved for two steps is reported to the planner
 *   - every step is bounded, and the run always ends with a sentence
 */

'use strict';

const { createSettleWatcher } = require('../control-plane/settleWatcher');
const { createStateObserver } = require('./stateObserver');
const { controlSignature } = require('./grounding');
const { classifyScreenState, detectLoopCycle } = require('./stateMachinePerception');

const MAX_STEPS = 15;
const EXTRA_STEPS = 10;
const REPEAT_LIMIT = 3;
const DONE_REJECTIONS = 2;

const SWITCHER_TITLES = /^(?:task switching|task view|snap assist|search|start|windows input experience)$/i;
function isSwitcher(fg) {
  if (!fg) return false;
  const title = String(fg.title || '').trim();
  const proc = String(fg.process || '').toLowerCase();
  if (SWITCHER_TITLES.test(title) && (!proc || /^(?:explorer|searchhost|startmenuexperiencehost|shellexperiencehost|textinputhost)$/.test(proc))) return true;
  return false;
}
const OPENERS = new Set(['open_app', 'open_url', 'web_search', 'open_file']);
const OPEN_GRACE_READS = 3;
function appOf(fg) { return fg ? String(fg.process || '').toLowerCase() : ''; }

function clip(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * createPcSession({ read, actions, plan, send, log, now, sleep, runbooks, maxSteps })
 *
 * read():  -> { fg, elements, capture, originPhys }   (foreground window + controls + screen)
 * plan(ctx): -> { instruction, actions:[{name,args}], done, note }
 * send(channel, payload): the overlay/HUD
 */
function createPcSession(deps = {}) {
  const read = deps.read;
  const actions = deps.actions;
  const plan = deps.plan;
  const send = typeof deps.send === 'function' ? deps.send : () => {};
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const sleep = typeof deps.sleep === 'function' ? deps.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const runbooks = deps.runbooks || null;
  const maxSteps = Number(deps.maxSteps) > 0 ? Number(deps.maxSteps) : MAX_STEPS;
  // StateObserver wired in from index.js for event-driven verification
  const stateObserver = deps.stateObserver || null;

  let running = false;
  let generation = 0;
  let lastRecord = null;

  function status() {
    return { running, generation };
  }

  /** Stop the current run. The in-flight step finishes; nothing new starts. */
  function stop(reason) {
    if (!running) return false;
    generation++;
    log(`pc stop: ${reason || 'asked'}`);
    return true;
  }

  /** The baseline must use the same shape as the samples, or every screen
   *  looks "changed" and the honesty guards never fire. */
  function snapshot(elements) {
    const list = elements || [];
    return { dom: { url: controlSignature(list), textLen: list.length, nodes: list.length } };
  }

  async function waitForScreen(beforeElements, options = {}) {
    // PRIMARY PATH: use stateObserver if available (event-driven, real OCR polling)
    if (stateObserver) {
      const timeoutMs = options.timeoutMs || 1800;
      const result = await stateObserver.waitForStateChange(timeoutMs);
      return result.changed;
    }
    // FALLBACK: legacy UIA-element-based settle watcher (no stateObserver wired)
    if (!Array.isArray(beforeElements)) return true;
    const before = snapshot(beforeElements);
    const watcher = createSettleWatcher({
      sample: async () => snapshot((await read() || {}).elements)
    });
    let outcome = { changed: false };
    try {
      outcome = await watcher.waitForSettle(
        before,
        Object.assign({ timeoutMs: 1800, giveUpMs: 900, settleAfterMs: 700 }, options)
      );
    } catch (error) {
      log(`pc settle failed: ${error.message}`);
    }
    return Boolean(outcome.changed);
  }

  async function runReplay(entry, ctx, gen) {
    const steps = entry.steps;
    for (let index = 0; index < steps.length; index++) {
      if (gen !== generation) return { outcome: 'stopped', report: 'Stopped.' };
      const saved = steps[index];
      let found = null;
      try {
        const reply = await deps.probeRequest('uia.find', { hwnd: ctx.fg ? ctx.fg.hwnd : undefined, name: saved.target.name, type: saved.target.type || '' }, 2500);
        if (reply && reply.element && reply.element.rect && Number(reply.score) >= 60) found = reply.element;
      } catch (error) {
        log(`runbook find failed: ${error.message}`);
      }
      if (!found) {
        if (runbooks && runbooks.miss) {
          const retired = runbooks.miss(entry.key);
          log(`runbook miss on step ${index + 1}${retired ? ' (retired)' : ''}`);
        }
        return { outcome: 'fallback', report: 'the saved run no longer matches this screen' };
      }
      const result = await actions.run('click', { id: found.id }, ctx);
      send('pc:step', { step: index + 1, instruction: saved.instruction || `click "${saved.target.name}"`, ok: result.ok });
      if (!result.ok) return { outcome: 'fallback', report: result.report };
      await sleep(250);
      ctx = await read();
      await waitForScreen(ctx && ctx.elements, { timeoutMs: 1600 });
      ctx = await read();
    }
    return { outcome: 'ok', report: 'Done, same as last time.' };
  }

  async function run(task, options = {}) {
    const goal = String(task || '').trim();
    if (!goal) return { outcome: 'error', report: 'Nothing to do.' };
    if (running) return { outcome: 'busy', report: 'Still on the last task. Stop it first.' };

    running = true;
    const gen = ++generation;
    const startedAt = now();
    const history = [];
    const repeats = new Map();
    const failed = new Set();
    let budget = maxSteps;
    let rejections = 0;
    let lastFailure = null;
    let collected = '';
    let shownPlan = '';
    let deadFingerprint = '';
    let deadRepeats = 0;
    let forcedNote = '';
    let lastSignature = null;
    let sameScreen = 0;
    let outcome = 'ok';
    let report = 'Done.';
    let steps = 0;
    const allowedApps = new Set();
    let openGrace = 0;

    // Start state observer for event-driven screen change detection
    if (stateObserver) {
      try { await stateObserver.start(); } catch (_) {}
    }

    try {
      let ctx = await read();
      if (!ctx || !ctx.fg || !ctx.fg.hwnd) {
        return { outcome: 'error', report: 'There is no window in front to work in.' };
      }
      send('pc:start', { goal });

      // A kept runbook for this app and ask replays with no model call.
      if (runbooks && runbooks.find) {
        const entry = runbooks.find({ process: ctx.fg.process, title: ctx.fg.title, task: goal });
        if (entry && entry.steps && entry.steps.length) {
          log(`runbook replay: ${entry.key} (${entry.steps.length} steps)`);
          const replayed = await runReplay(entry, ctx, gen);
          if (replayed.outcome !== 'fallback') {
            return { outcome: replayed.outcome, report: replayed.report, steps: entry.steps.length };
          }
        }
      }

      while (gen === generation) {
        if (steps >= budget) {
          outcome = 'budget';
          report = 'That is as far as I got in one go. Ask again to continue.';
          break;
        }

        // Focus / Away Guard: Stop if an uninvited window comes to the front
        const app = appOf(ctx.fg);
        const real = app && !isSwitcher(ctx.fg) && !/^program manager$/i.test(String(ctx.fg.title || '').trim()) && (ctx.elements || []).length > 0;
        if (real) {
          if (!allowedApps.size || openGrace > 0) {
            allowedApps.add(app);
          } else if (!allowedApps.has(app)) {
            log(`away: "${clip(ctx.fg.title, 60)}" (${app}) came to the front; task works in ${Array.from(allowedApps).join(', ')}`);
            outcome = 'away';
            report = `I stopped: "${clip(ctx.fg.title || app, 50)}" came to the front, and I did not open it. Ask again to continue there.`;
            break;
          }
        }
        if (openGrace > 0) openGrace--;

        const signature = controlSignature(ctx.elements);
        sameScreen = signature === lastSignature ? sameScreen + 1 : 0;
        lastSignature = signature;

        let note = '';
        if (sameScreen >= 2) {
          note = 'Nothing on screen has changed for two steps: do something genuinely different, or stop and say what is in the way.';
        }

        const noteForPlan = forcedNote || note;
        forcedNote = '';
        const decision = await plan({ goal, window: ctx.fg, elements: ctx.elements, capture: ctx.capture, ocr: ctx.ocr, history, note: noteForPlan, prompt: goal });
        if (!decision || typeof decision !== 'object') {
          outcome = 'error';
          report = 'The planner returned nothing I can act on.';
          break;
        }

        // The plan the model wrote, shown once and again only when it changes.
        if (Array.isArray(decision.plan) && decision.plan.length) {
          const signature = decision.plan.join('\n');
          if (signature !== shownPlan) {
            shownPlan = signature;
            send('pc:plan', { steps: decision.plan.slice(), step: decision.step || 1 });
            log(`pc plan: ${decision.plan.join(' -> ')}`);
          }
        }

        if (decision.done && !decision.actions.length) {
          const last = history[history.length - 1];
          // Never claim done on top of a failed step: that is the whole point.
          if (last && last.ok === false) {
            outcome = 'step-failed';
            report = last.report;
            break;
          }
          const lastWasAction = last && ['click', 'type', 'press'].includes(last.action);
          if (lastWasAction && last.changed === false && rejections < DONE_REJECTIONS) {
            rejections++;
            history.push({ action: 'verify', ok: false, report: 'claimed done with no visible change' });
            send('pc:note', { message: 'It said done, but the screen did not change. Checking once more.' });
            continue;
          }
          // The last thing that actually happened is a better answer than a
          // bare "Done.", and a read's words are the answer itself.
          const lastOk = [...history].reverse().find((entry) => entry.ok);
          report = decision.report || decision.thought || (collected
            ? `Read ${collected.length} characters from the window.`
            : (lastOk && lastOk.report ? lastOk.report : 'Done.'));
          break;
        }

        if (!decision.actions.length) {
          outcome = 'asked';
          report = decision.report || decision.thought || 'I need something from you before I can go on.';
          break;
        }

        // The same action on a screen that did not move is a loop, not a try.
        // Refuse it and make the planner take another route.
        if (decision.actions.length) {
          const firstAction = decision.actions[0];
          const fingerprint = `${firstAction.name} ${JSON.stringify(firstAction.args || {})}`;
          if (deadFingerprint && fingerprint === deadFingerprint) {
            deadRepeats++;
            if (deadRepeats >= 2) {
              outcome = 'stuck';
              report = `I stopped: repeating "${firstAction.name}" on a screen that did not change is not going to work.`;
              break;
            }
            history.push({ action: 'replan', ok: false, report: 'the planner offered the same action on an unchanged screen' });
            forcedNote = `Your last action (${firstAction.name}) was just taken and the screen did not change. Do not repeat it: use a different control, another route, or stop and say what is blocking.`;
            send('pc:note', { message: 'The same action did nothing; asking for another route.' });
            continue;
          }

          // Vision-Grounded Dynamic State Machine: Detect multi-step oscillating & circular cycles
          const loopCycle = detectLoopCycle(history);
          if (loopCycle) {
            log(`[pcSession] ${loopCycle.type} detected: ${loopCycle.warning}`);
            forcedNote = loopCycle.warning;
            send('pc:note', { message: loopCycle.warning });
          }

          // Detect alternating 2-action oscillating loops (e.g. A -> B -> A -> B)
          if (history.length >= 3) {
            const lastH = history[history.length - 1];
            const prevH = history[history.length - 2];
            const prev2H = history[history.length - 3];
            const curFp = `${firstAction.name} ${JSON.stringify(firstAction.args || {})}`;
            const prevFp = `${prevH.action} ${JSON.stringify(prevH.args || {})}`;
            if (curFp === prevFp && lastH.action === prev2H.action) {
              forcedNote = `You are alternating in an oscillating loop between ${firstAction.name} and ${lastH.action}. STOP this loop! Take a completely different approach (e.g. use keyboard shortcuts like Ctrl+V, navigate by text labels, or verify next step).`;
              send('pc:note', { message: 'Oscillating loop detected; forcing a different approach.' });
            }
          }
        }

        let halted = false;
        for (const action of decision.actions) {
          if (gen !== generation) break;
          const name = String(action.name || '').toLowerCase();
          const args = action.args || {};
          const fingerprint = `${name} ${JSON.stringify(args)}`;

          const seen = (repeats.get(fingerprint) || 0) + 1;
          repeats.set(fingerprint, seen);
          if (seen >= REPEAT_LIMIT) {
            halted = true;
            history.push({ action: name, ok: false, report: 'same action for the third time; it is not working' });
            report = `I stopped: repeating "${name}" 3 times without progress is not working.`;
            outcome = 'stuck';
            break;
          }
          if (failed.has(fingerprint)) {
            halted = true;
            history.push({ action: name, ok: false, report: 'that exact action already failed' });
            report = `I stopped: "${name}" already failed in this session and was not repeated.`;
            outcome = 'stuck';
            break;
          }

          steps++;
          send('pc:step', { step: steps, instruction: decision.instruction || name, ok: true });
          const before = ctx.elements;
          const result = await actions.run(name, args, ctx);
          if (result.ok && OPENERS.has(name)) {
            openGrace = OPEN_GRACE_READS;
          }

          if (result.refused) {
            outcome = 'guarded';
            report = result.report;
            halted = true;
            break;
          }
          if (!result.ok) {
            failed.add(fingerprint);
            halted = true;
            lastFailure = result.report;
            history.push({ action: name, ok: false, report: clip(result.report, 200), changed: null });
            report = result.report;
            break;
          }

          // Wait for the screen to react and settle, then look again.
          // PRIMARY: stateObserver.waitForStateChange() — event-driven, real OCR polling
          // FALLBACK: legacy waitForScreen() with UIA element signature
          if (result.lookAfter) await sleep(result.lookAfter);
          let changed;
          if (stateObserver && result.settle !== 0) {
            const obs = await stateObserver.waitForStateChange(result.settle || 1600);
            changed = obs.changed;
            // POST-ACTION VERIFICATION for critical actions
            if (name === 'type' && result.ok && !changed) {
              // If type action didn't visibly change anything, we may have typed into wrong field
              const typedText = String((action.args || {}).text || '').slice(0, 30);
              if (typedText) {
                // Give it one more short wait — some apps buffer keystrokes
                const retry = await stateObserver.waitForStateChange(800);
                changed = retry.changed;
              }
              if (!changed) {
                // Screen truly didn't react. Report this as an unverified action.
                log(`[pcSession] WARN: type "${typedText}" produced no visible screen change`);
                forcedNote = `Your type action did not produce any visible change on screen. ` +
                  `The text may have gone to the wrong field. ` +
                  `Verify what field is currently focused (use describe_screen or look), ` +
                  `then explicitly click the correct target field before typing.`;
              }
            }
            if (name === 'click' && result.ok && !changed) {
              // Click with no visible change — might have hit wrong target
              log(`[pcSession] WARN: click "${String((action.args || {}).text || '')}" produced no visible screen change`);
            }
          } else {
            changed = result.settle === 0 ? null : await waitForScreen(before, { timeoutMs: result.settle || 1600 });
          }
          if (result.text) collected = String(result.text);
            if (changed === false) {
              deadFingerprint = fingerprint;
              deadRepeats = 0;
            } else if (changed === true) {
              deadFingerprint = '';
              deadRepeats = 0;
            }
            history.push({ action: name, ok: true, report: clip(result.report, 200), text: result.text ? clip(result.text, 200) : undefined, changed });
            lastFailure = null;
          ctx = await read();
          // Vision-Grounded State Transition Verification
          if (ctx && ctx.ocr) {
            const postState = classifyScreenState(ctx.ocr, ctx.elements, ctx.fg, goal);
            if (postState.phase === 'CHAT_OPEN_READY_TO_COMPOSE' && name === 'click') {
              log(`[pcSession] State transition verified: chat with "${postState.activeRecipient}" is open and composer is ready.`);
              result.report = `Opened chat with "${postState.activeRecipient}"; composer is ready.`;
            }
          }
        }

        // A consent refusal ends the run on its own line. An ordinary failure
        // gives the planner another turn, with the failure in its history; the
        // failed-set guard stops it if it tries the same thing again.
        if (outcome !== 'ok') break;
        if (halted && lastFailure) report = lastFailure;
        if (steps === budget - 2 && history.slice(-3).every((entry) => entry.ok)) {
          budget = Math.min(budget + EXTRA_STEPS, maxSteps + EXTRA_STEPS);
        }
      }
    } catch (error) {
      outcome = 'error';
      report = `The PC run failed: ${error.message}`;
      log(`pc session error: ${error.stack || error.message}`);
    } finally {
      running = false;
      send('pc:done', { outcome, report, steps });
      if (actions && actions.cursorOverlay && typeof actions.cursorOverlay.hide === 'function') {
        try { actions.cursorOverlay.hide(); } catch (_) {}
      }
      if (stateObserver) {
        try { stateObserver.stop(); } catch (_) {}
      }
    }

    lastRecord = { goal, steps: history, startedAt, endedAt: now(), outcome };
    log(`pc run ${outcome} after ${steps} step(s): ${clip(report, 100)}`);
    return {
      outcome,
      report,
      steps,
      history,
      text: collected,
      plan: shownPlan ? shownPlan.split('\n') : [],
      session: lastRecord
    };
  }

  /** Keep the last run so it can be replayed later without a model call. */
  function keep(app) {
    const record = lastRecord;
    lastRecord = null;
    if (!record || !runbooks || !app) return null;
    const clicks = record.steps.filter((step) => step.action === 'click' && step.target && step.target.name);
    if (!clicks.length) return null;
    return runbooks.record({
      task: record.goal,
      app: { process: app.process, title: app.title },
      steps: clicks.map((step) => ({ instruction: step.report, name: step.target.name, type: step.target.type }))
    });
  }

  function skip() {
    lastRecord = null;
  }

  return { run, stop, status, keep, skip, canKeep: () => Boolean(lastRecord) };
}

module.exports = { createPcSession, MAX_STEPS, EXTRA_STEPS, REPEAT_LIMIT, DONE_REJECTIONS };
