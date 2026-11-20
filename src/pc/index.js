/**
 * Adion Browse — PC engine
 *
 * Wires the pieces into one object the browser can call:
 *
 *   probe.ps1  (read-only)  ─┐
 *   input.ps1  (input)      ─┼─> desktopActions -> pcSession -> report
 *   desktopCapturer         ─┤
 *   runbooks (local JSON)   ─┤
 *   planner.js (model)      ─┘
 *
 * Windows only. Every entry point tolerates the sidecars being unavailable:
 * the engine reports why instead of hanging. Nothing in this file sends input
 * that has not passed src/control-plane/actionConsent.js inside desktopActions.
 */

'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { createSidecar } = require('./sidecarClient');
const { captureDisplay } = require('./screenCapture');
const { createDesktopActions } = require('./desktopActions');
const { createScreenWatch } = require('./screenWatch');
const { createRunbooks } = require('./runbooks');
const { createPcSession } = require('./pcSession');
const { createPcPlanner } = require('./planner');

/**
 * The no-model planner: one clear PC verb becomes one action.
 * Used only when a model call fails, so a flaky provider does not take simple
 * commands down with it. Anything else returns null.
 */
function planByRules(task) {
  const text = String(task || '').trim();
  if (!text) return null;

  // "open X" is only one step when X really is an app name. A sentence with a
  // second clause ("open whatsapp and text her") is a plan, not an app.
  let match = text.match(/^(?:open|launch|start)\s+(?:the\s+|my\s+)?(.+?)(?:\s+app)?$/i);
  if (match) {
    const app = match[1].trim();
    const multiStep = /\b(and|then|also|text|message|send|click|type|press|search|tell|ask)\b/i.test(app) || /[,;.]/.test(app);
    if (app && app.split(/\s+/).length <= 4 && !multiStep) {
      return { action: { name: 'open_app', args: { name: app } }, instruction: `Open ${app}` };
    }
    return null;
  }

  match = text.match(/^(?:type|write|enter|paste)\s+["']?([\s\S]+?)["']?(\s+and\s+(?:press\s+)?enter)?$/i);
  if (match) {
    return {
      action: { name: 'type', args: { text: match[1], enter: Boolean(match[2]) } },
      instruction: `Type ${match[1].slice(0, 40)}`
    };
  }

  // A chord first: "press ctrl+s" is a key press, not a click on "ctrl+s".
  match = text.match(/^(?:press|hit)\s+((?:ctrl|alt|shift|win|\+|[a-z0-9])[\w+]*)$/i);
  if (match) return { action: { name: 'press', args: { keys: match[1] } }, instruction: `Press ${match[1]}` };

  match = text.match(/^(?:click|press|tap)\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+button)?$/i);
  if (match) return { action: { name: 'click', args: { text: match[1] } }, instruction: `Click ${match[1]}` };

  match = text.match(/^scroll\s*(up|down)?/i);
  if (match) return { action: { name: 'scroll', args: { direction: (match[1] || 'down').toLowerCase() } }, instruction: `Scroll ${match[1] || 'down'}` };

  match = text.match(/^(?:(?:list|show)(?:\s+me)?\s+(?:open\s+|all\s+)?windows|what\s+windows\s+are\s+open)$/i); // audit-fix: "show me ..." variant
  if (match) return { action: { name: 'list_windows', args: {} }, instruction: 'List open windows' };

  // audit-fix: screenshot had no rule — "take a screenshot" fell through to ask-the-user
  match = text.match(/^(?:take|grab|capture)(?:\s+a)?\s+screens?hot$|^screens?hot$/i);
  if (match) return { action: { name: 'screenshot', args: {} }, instruction: 'Take a screenshot' };

  match = text.match(/^(?:describe|what).*(?:screen|showing|display)|^where am i$/i);
  if (match && !/what does this (?:say|do)/i.test(text)) {
    return { action: { name: 'describe_screen', args: {} }, instruction: 'Describe the screen' };
  }

  if (/^(?:read|summari[sz]e|what does this (?:say|do)|read this)/i.test(text)) {
    return { action: { name: 'read', args: {} }, instruction: 'Read the window' };
  }
  return null;
}

function createPcEngine(options = {}) {
  const log = typeof options.log === 'function' ? options.log : (...args) => console.log('[pc]', ...args);
  const send = typeof options.send === 'function' ? options.send : () => {};
  const platform = options.platform || process.platform;
  const selfPid = options.selfPid != null ? options.selfPid : process.pid;
  const resourcesPath = options.resourcesPath || null;
  const userDataPath = options.userDataPath || '';

  const probe = createSidecar({ name: 'probe.ps1', resourcesPath, platform, log });
  const input = createSidecar({ name: 'input.ps1', resourcesPath, platform, log });

  const launchApp = options.launchApp || ((name) => new Promise((resolve) => {
    if (platform !== 'win32') return resolve({ ok: false, report: 'launching apps is Windows only' });
    try {
      const clean = String(name || '').trim().replace(/['"]/g, '');
      if (!clean) return resolve({ ok: false, report: 'empty app name' });

      // Direct protocol URI mapping for modern Windows apps
      const uriMap = {
        whatsapp: 'whatsapp:',
        spotify: 'spotify:',
        discord: 'discord:',
        slack: 'slack:',
        telegram: 'tg:',
        tg: 'tg:',
        teams: 'msteams:',
        msteams: 'msteams:',
        calculator: 'calculator:',
        calc: 'calculator:',
        settings: 'ms-settings:',
        vscode: 'vscode:',
        code: 'vscode:',
        chrome: 'chrome:',
        edge: 'microsoft-edge:',
        terminal: 'wt:'
      };
      const directUri = uriMap[clean.toLowerCase()];
      if (directUri) {
        const child = spawn('cmd.exe', ['/c', 'start', '', directUri], { windowsHide: true, detached: true, stdio: 'ignore' });
        child.unref();
        return resolve({ ok: true });
      }

      // Universal launcher (StartApps -> Start Menu .lnk -> LocalAppData Squirrel/Electron -> Path)
      const psCommand = `
        $t = '${clean.replace(/'/g, "''")}';
        $app = Get-StartApps | Where-Object { $_.Name -like "*$t*" -or $_.AppID -like "*$t*" } | Select-Object -First 1;
        if ($app) {
          Start-Process ("shell:AppsFolder\\" + $app.AppID);
          exit 0;
        }
        $lnks = @(Get-ChildItem -Path "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs", "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs" -Filter "*$t*.lnk" -Recurse -ErrorAction SilentlyContinue);
        if ($lnks.Count -gt 0) {
          Start-Process $lnks[0].FullName;
          exit 0;
        }
        $localApp = "$env:LOCALAPPDATA\\$t";
        if (Test-Path $localApp) {
          $updateExe = Join-Path $localApp "Update.exe";
          if (Test-Path $updateExe) {
            Start-Process $updateExe -ArgumentList "--processStart", "$t.exe";
            exit 0;
          }
          $exe = Get-ChildItem -Path $localApp -Filter "$t.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1;
          if ($exe) {
            Start-Process $exe.FullName;
            exit 0;
          }
        }
        try {
          Start-Process $t;
          exit 0;
        } catch {
          Start-Process "cmd.exe" -ArgumentList "/c", "start", "", $t -WindowStyle Hidden;
          exit 0;
        }
      `;
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      resolve({ ok: true });
    } catch (error) {
      resolve({ ok: false, report: error.message });
    }
  }));

  // screenWatch: the tool-scan scanner wired in — win.list, whole-screen
  // shots, OCR reads and vision descriptions that the planner actions use.
  const { createCursorOverlay } = require('./cursorOverlay');
  const cursorOverlay = createCursorOverlay({ log });
  const watch = createScreenWatch({ probe, log, workDir: userDataPath || undefined, selfPid });
  const desktopActions = createDesktopActions({ probe, input, launchApp, log, selfPid, watch, cursorOverlay });
  const actions = {
    ...desktopActions.actions,
    cursorOverlay,
    run: desktopActions.run,
    resolvePoint: desktopActions.resolvePoint,
    focusedField: desktopActions.focusedField
  };
  const runbooks = createRunbooks({
    file: userDataPath ? path.join(userDataPath, 'pc-runbooks.json') : null,
    log
  });

  // The model that decomposes one request into numbered steps and replans after
  // every observed reaction. Without it, only single clear verbs work.
  const planner = options.modelClient && typeof options.modelClient.queryJSON === 'function'
    ? createPcPlanner({ modelClient: options.modelClient, log })
    : null;

  let lastApp = null;

  async function read() {
    if (!probe.available) return null;
    let fg = null;
    try {
      fg = await probe.request('fg', { ignorePid: selfPid }, 2500);
    } catch (error) {
      log(`pc fg failed: ${error.message}`);
    }
    if (!fg || !fg.hwnd) return null;
    lastApp = { process: fg.process || '', title: fg.title || '' };
    let elements = [];
    try {
      const list = await probe.request('uia.list', { hwnd: fg.hwnd, max: 150, budgetMs: 1200 }, 3000);
      elements = (list && list.elements) || [];
    } catch (error) {
      log(`pc controls failed: ${error.message}`);
    }
    let capture = null;
    try {
      capture = await captureDisplay();
    } catch (error) {
      log(`pc capture failed: ${error.message}`);
    }

    // Windows caption bar & window frame expose 6-12 standard controls (Minimize, Maximize, Close, TitleBar)
    // even when the client area is custom-drawn (canvas/Electron/WhatsApp/Spotify/Slack).
    // Count meaningful interactive body elements to know if UIA is sufficient.
    const nonChromeElements = (elements || []).filter(el => {
      const name = (el.name || '').trim().toLowerCase();
      const type = String(el.type || '').toLowerCase();
      if (/^(close|minimize|maximize|restore|system|title\s*bar)$/i.test(name)) return false;
      if (type.includes('titlebar') || type.includes('menubar') || type.includes('header')) return false;
      return true;
    });

    let ocr = null;
    if (capture && capture.dataUrl) {
      try {
        const { recognizeWordsInBase64 } = require('./ocr');
        ocr = await recognizeWordsInBase64(capture.dataUrl);
        if (ocr && (ocr.lines || ocr.words)) {
          const scaleX = (capture.pxWidth && capture.width) ? (capture.pxWidth / capture.width) : 1;
          const scaleY = (capture.pxHeight && capture.height) ? (capture.pxHeight / capture.height) : 1;
          const offsetX = (capture.display && capture.display.bounds && capture.display.bounds.x) || 0;
          const offsetY = (capture.display && capture.display.bounds && capture.display.bounds.y) || 0;

          if (Array.isArray(ocr.lines)) {
            for (const l of ocr.lines) {
              l.x = Math.round(offsetX + l.x * scaleX);
              l.y = Math.round(offsetY + l.y * scaleY);
              l.w = Math.round(l.w * scaleX);
              l.h = Math.round(l.h * scaleY);
            }
          }
          if (Array.isArray(ocr.words)) {
            for (const w of ocr.words) {
              w.x = Math.round(offsetX + w.x * scaleX);
              w.y = Math.round(offsetY + w.y * scaleY);
              w.w = Math.round(w.w * scaleX);
              w.h = Math.round(w.h * scaleY);
            }
          }
        }
      } catch (ocrErr) {
        log(`pc local ocr note: ${ocrErr.message}`);
      }
    }
    return {
      fg,
      elements,
      capture,
      ocr,
      originPhys: capture ? { x: capture.display.bounds.x, y: capture.display.bounds.y } : { x: 0, y: 0 }
    };
  }

  let stepIndex = 0;

  async function plan(ctx) {
    stepIndex++;

    if (planner) {
      const decision = await planner.plan(ctx);
      if (decision && (decision.actions.length || decision.done)) return decision;

      // A dead model must not silently disable a command a rule can do.
      if (decision && decision.modelFailed && stepIndex === 1) {
        const rule = planByRules(ctx.goal);
        if (rule) {
          log('model unavailable for PC planning; using the built-in single-step planner');
          return { thought: rule.instruction, instruction: rule.instruction, actions: [rule.action], done: false, modelFailed: true };
        }
      }
      if (decision) return decision;
    }

    if (stepIndex === 1) {
      const rule = planByRules(ctx.goal);
      if (rule) return { thought: rule.instruction, instruction: rule.instruction, actions: [rule.action], done: false };
    }

    // First step unmatched: ask, never claim done. After a completed step there
    // is simply nothing left to plan, and the session reports what happened.
    return {
      thought: stepIndex === 1 ? 'I could not turn that into a PC action without a model.' : '',
      instruction: '',
      actions: [],
      done: stepIndex > 1,
      report: stepIndex === 1
        ? 'That is more than one PC step and no model planned it. Configure a provider (Groq or Mercury) and I will break it into steps myself — or give me one step at a time (open, type, click, press, scroll, read).'
        : ''
    };
  }

  const session = createPcSession({
    read,
    actions,
    plan,
    send,
    log,
    runbooks,
    probeRequest: (op, params, timeout) => probe.request(op, params, timeout),
    maxSteps: options.maxSteps
  });

  return {
    platform,
    get available() {
      return platform === 'win32' && probe.available && input.available;
    },
    get hasModel() {
      return Boolean(planner);
    },
    status() {
      return {
        platform,
        available: platform === 'win32' && probe.available && input.available,
        planning: planner ? 'model' : 'single-step',
        probe: probe.status(),
        input: input.status(),
        runbooks: runbooks.list().length
      };
    },
    async start() {
      if (platform !== 'win32') return { ok: false, report: 'PC control is Windows only' };
      probe.start();
      input.start();
      // The ping decides availability; give it a moment before the first read.
      const startedAt = Date.now();
      while (Date.now() - startedAt < 8000 && !(probe.available && input.available)) {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      return { ok: probe.available && input.available, report: probe.available && input.available ? 'PC control is ready' : 'the Windows sidecars did not start' };
    },
    stop() {
      probe.stop();
      input.stop();
    },
    async run(goal, opts = {}) {
      stepIndex = 0;
      if (planner) planner.reset();
      if (platform !== 'win32') return { outcome: 'error', report: 'PC control is Windows only.' };
      if (!probe.available || !input.available) {
        // Started on demand: a /pc command is the user asking for this.
        const started = await this.start();
        if (!started.ok) return { outcome: 'unavailable', report: started.report };
      }
      return session.run(goal, opts);
    },
    stopRun(reason) {
      return session.stop(reason);
    },
    sessionStatus: () => session.status(),
    keep: (app) => session.keep(app || lastApp),
    skip: () => session.skip(),
    runbooks,
    actions,
    watch,
    sidecars: { probe, input },
    planner,
    planByRules
  };
}

module.exports = { createPcEngine, planByRules };
