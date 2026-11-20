/**
 * Adion Browse — PC task planner
 *
 * One natural-language ask becomes an ordered plan ("1. open WhatsApp, 2. search
 * Pidduk, 3. type the message, 4. send"), then one action at a time. After every
 * action the session reports what the screen actually did; the planner sees that
 * reaction and either continues along the plan or revises it.
 *
 * The model's reply is taken raw (modelClient.queryJSON) because the browser
 * pipeline normalises every action into the browser schema, which would destroy
 * the PC vocabulary. Both shapes are accepted here anyway, so a provider that
 * does normalise still works.
 *
 * No model, or a failed model call, is reported with the real error — never
 * disguised as "no model configured".
 */

'use strict';

const { classifyScreenState } = require('./stateMachinePerception');
const { StatefulPCSession } = require('./semanticAffordanceEngine');

const PC_ACTION_TYPES = new Set(['click', 'type', 'press', 'scroll', 'open_app', 'read', 'wait', 'look', 'list_windows', 'find_window', 'screenshot', 'describe_screen', 'move']);

const TYPE_MAP = {
  OPEN: 'open_app', OPEN_APP: 'open_app', LAUNCH: 'open_app', LAUNCH_APP: 'open_app', START: 'open_app',
  CLICK: 'click', CLICK_SELECTOR: 'click', TAP: 'click', CLICK_BUTTON: 'click', SELECT: 'click',
  INPUT_TEXT: 'type', TYPE: 'type', TYPE_TEXT: 'type', FILL: 'type', SET_TEXT: 'type', WRITE: 'type',
  KEY: 'press', KEYS: 'press', KEYPRESS: 'press', PRESS_KEY: 'press', HOTKEY: 'press', PRESS: 'press',
  SCROLL: 'scroll',
  MOVE: 'move', MOUSE_MOVE: 'move', HOVER: 'move',
  READ: 'read', READ_WINDOW: 'read', GET_TEXT: 'read', PAGE_ANALYSIS_OR_QA: 'read', SUMMARIZE: 'read',
  WAIT: 'wait', SLEEP: 'wait',
  LOOK: 'look', SCREENSHOT: 'screenshot',
  LIST_WINDOWS: 'list_windows', WINDOWS: 'list_windows', LIST: 'list_windows',
  FIND_WINDOW: 'find_window', FIND: 'find_window',
  DESCRIBE: 'describe_screen', DESCRIBE_SCREEN: 'describe_screen', WHAT_AM_I_LOOKING_AT: 'describe_screen',
  READ_SCREEN: 'read', OCR: 'read'
};

const MAX_CONTROLS = 120;

const SYSTEM_PROMPT = [
  'You are the Desktop Operator for Adion Browse, a Production-Grade Computer-Using Agent (CUA).',
  '',
  '## Your Mission',
  'Drive the FOREGROUND WINDOW on a real Windows PC. You see the active window, its interactive controls, and native OCR on-screen text. You can interact with ANY visible text directly via click(text) — e.g. {"name": "click", "args": {"text": "Search"}} or {"name": "click", "args": {"text": "Aksh"}}. Local WinRT OCR automatically maps text to coordinates at zero cost.',
  '',
  '## Core Principles (BUA Best Practices)',
  '- Architecture over model scale: layered perception-reasoning-execution design',
  '- Deterministic safety first: code-level guards precede any probabilistic checks',
  '- Bulk action planning: reduce round-trips via sequential actions',
  '- Context trimming: keep only goal-relevant controls (<150 elements)',
  '- Failure adaptation: never retry the same failed action',
  '',
  '## Action Vocabulary (Use ONLY these primitives)',
  '1. open_app(name) — launch an app by exact name. Example: {"name": "open_app", "args": {"name": "whatsapp"}}',
  '2. click(id) or click(text) — click a control from list or by text label. Local OCR will locate text coordinates automatically. Coordinates also work: {"name": "click", "args": {"x1000": 500, "y1000": 300}} (0-1000 across the screen) or absolute pixels {"x": 960, "y": 540}',
  '3. type(text, target: "", enter: false) — type into focused field, or specify target field/text to focus it first. Example: {"name": "type", "args": {"text": "Aksh", "enter": true}}',
  '4. press(keys) — key chord. Example: {"name": "press", "args": {"keys": "enter"}} or {"name": "press", "args": {"keys": "ctrl+f"}}',
  '5. scroll(direction: "up"|"down", amount: number)',
  '6. read() — read window text for Q&A tasks (falls back to local screen OCR)',
  '7. wait(ms) — brief pause for async updates',
  '8. list_windows() — list open windows when target is not foreground',
  '9. find_window(name) — check a window by app/title',
  '10. screenshot() — save a whole-screen PNG file',
  '11. describe_screen() — describe visual scene (only when non-text visual reasoning is required)',
  '12. move(x1000, y1000) — move mouse to position',
  '',
  '## Critical Safety Rules',
  '- Password fields are NEVER typed into UNLESS user explicitly provides secret code for unlocking (WhatsApp Chat Lock, hidden folder PIN, etc.)',
  '- Never click "delete", "transfer", "submit" without explicit user authorization',
  '- If a button triggers sensitive action, refuse and explain why',
  '- For multi-step desktop tasks (e.g. "open app, find contact, type message"), decompose into sequential steps: first launch the application, wait for its window to appear, then search/navigate and type.',
  '',
  '## Reliability Protocol',
  '- NEVER repeat the same failed action',
  '- NEVER loop on observation tools (read, describe_screen, screenshot) without taking concrete action (click, type, press).',
  '- NEVER hallucinate that an action is "(done)" in thought or plan before it was actually executed and verified in history.',
  '- Sharing/Sending Screenshots in Any Chat App:',
  '  * Taking a screenshot automatically COPIES the image to the Windows clipboard.',
  '  * To send a screenshot to a contact (e.g. Pranav): (1) click/search the contact to open chat, (2) paste with ctrl+v: {"name": "press", "args": {"keys": "ctrl+v"}}, (3) send: {"name": "press", "args": {"keys": "enter"}}.',
  '  * NEVER click paperclip icons, attachment menus, file pickers, or press ctrl+shift+a. Pasting directly with Ctrl+V is the instant, standard, 100% reliable way to send images.',
  '- Multi-Step Milestones:',
  '  * Once you type and send a message to Contact A, DO NOT repeat sending the message to Contact A!',
  '  * Move immediately to the next milestone in your plan (e.g. taking screenshot, opening Contact B, pasting screenshot with Ctrl+V, and sending).',
  '- Click targets: Prefer click(text) — e.g. {"name": "click", "args": {"text": "Aksh"}} or {"name": "click", "args": {"text": "Search"}}. You can also use exact pixel coordinates from the OCR list: {"name": "click", "args": {"x": 280, "y": 190}}.',
  '- NEVER guess random screen coordinates blindly. Always use text labels or exact coordinates from the visible controls and OCR list.',
  '- State-Driven Dynamic Messaging Workflows (WhatsApp, Slack, Telegram, Teams):',
  '  1. RECOGNIZE CURRENT SCREEN STATE:',
  '     * Look at the "Current Interface State (Dynamic Perception)" block in the prompt.',
  '     * If the recipient\'s chat is ALREADY OPEN in the header (or you just clicked their name), DO NOT press Ctrl+F! DO NOT search!',
  '     * Jump straight to Step 3: Type message into composer.',
  '  2. LOCATING RECIPIENT (ONLY if not already open):',
  '     * If recipient is visible in the chat list, click their name directly: {"name": "click", "args": {"text": "Name"}}.',
  '     * If NOT visible: press ctrl+f, type recipient name, then click the contact in the search results.',
  '  3. COMPOSE AND SEND MESSAGE:',
  '     * Once the chat is open, click or type directly into the composer: {"name": "type", "args": {"target": "Type a message", "text": "...", "enter": true}}.',
  '     * NEVER press ctrl+f when composing or sending a message! ctrl+f focuses the search box and takes you away from the chat!',
  '  4. NEVER REPEAT SEARCH OR CLICK LOOPS:',
  '     * Clicking a contact opens the chat. The immediate next action must be typing the message into the composer.',
  '     * Do NOT click "Chats", "start a chat", or search buttons repeatedly when a chat is already open.',
  '- Discord Navigation Workflows:',
  '  1. Quick Switcher: Press ctrl+k to open Quick Switcher ("Where would you like to go?").',
  '  2. Switch to channel or user: Type the channel name (e.g. {"name": "type", "args": {"text": "general", "enter": true}}) to jump straight to that channel.',
  '  3. Direct Click: You can also click the channel or server directly from the OCR list (e.g. {"name": "click", "args": {"text": "general"}}).',
  '  4. Message Composer in Discord: Target "Message #" or click the bottom input area, then type with enter:true (e.g. {"name": "type", "args": {"target": "Message", "text": "hello", "enter": true}}).',
  '  6. If task requires a screenshot: {"name": "screenshot", "args": {}} (this automatically copies to clipboard).',
  '  7. Set "done": true once the task is accomplished.',
  '- NEVER click window titlebar buttons ("Restore", "Minimize", "Close", id 2) to activate a window: clicking Restore resizes or un-maximizes the app! The window is already active after open_app.',
  '- If screen unchanged for 2+ steps, something is wrong: try different control, shortcut, or stop',
  '- A click that opens a dialog is NOT completion: inspect dialog fields next',
  '- System/popup menus (Win+X, tray, context menus) expose NO clickable elements: NEVER click a menu item. Drive an open menu with press (underlined accelerator letter, or arrows + Enter; Esc closes it), or skip the menu and open the target directly with open_app (e.g. Event Viewer, Device Manager).',
  '- When vision shows the target but the control list has no id for it, answer with text in click, or exact coordinates from the OCR list in click/move — never invent an id, never click blind.',
  '- If terminal command fails, diagnose error — DO NOT switch to web navigation',
  '',
  '## Work in Two Phases',
  'PHASE 1 (first reply): Turn the request into an ordered plan (2-6 short steps). Give only the FIRST action.',
  'PHASE 2 (every later reply): You get the plan, what each step did, and whether screen changed. Give the next action, or revise plan when reality differs.',
  '',
  '## Plan Flexibility & Window Management',
  '- The plan is a draft, not a contract — update it when reality differs',
  '- Do not Alt+Tab or switch windows after opening an app unless explicitly requested',
  '- Focus on completing tasks within the current foreground window',
  '',
  '## Output Format (RAW JSON, NO markdown)',
  '{"thought":"one short sentence","memory":"key progress for next steps","next_goal":"immediate next action",',
  ' "plan":["Step 1","Step 2",...],"step":1,',
  ' "instruction":"what this does, max 12 words","actions":[{"name":"click","args":{"id":12}}],"done":false}',
  '',
  '## Rules',
  '1. Never invent an id that is not in the control list. If missing, use search box or admit it is not reachable.',
  '2. One action per reply unless inseparable (e.g., type then Enter is one action with enter:true).',
  '3. Set "done":true with no actions when request is genuinely finished.',
  '4. Never claim a step is done because you emitted an action; screen report decides that.',
  '5. The person writes one request. You own the decomposition; do not ask them to split unless truly blocked.',
  '6. Keep the plan short and concrete, update "step" to the step you are performing now.',
  '7. The plan is a draft, not a contract. When what the person asked for is true on screen, reply done:true.',
  '8. Opening an app brings it to front. Only switch windows when request is about a different existing window.'
].join('\n');

function clip(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Accept {name,args} and the browser-normalised {type,params} alike. */
function normalizeAction(action, contextGoal = '', instruction = '') {
  if (!action || typeof action !== 'object') return null;
  const params = (action.args && typeof action.args === 'object') ? action.args : (action.params && typeof action.params === 'object' ? action.params : {});

  let name = String(action.name || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!PC_ACTION_TYPES.has(name)) {
    const byType = TYPE_MAP[String(action.type || action.action || name).toUpperCase().trim()];
    name = byType || name;
  }
  if (!PC_ACTION_TYPES.has(name)) return null;

  const args = { ...params };
  // Cross-shape field names the browser schema uses.
  if (name === 'click') {
    args.text = args.text || args.target || args.selector || args.label || action.text || action.target || '';
    if (args.id == null && typeof args.index === 'number') args.id = args.index;
  }
  if (name === 'type') {
    args.text = args.text != null ? args.text : (args.value != null ? args.value : (action.text != null ? action.text : ''));
    args.enter = args.enter === true || action.enter === true;
    args.target = args.target || args.field || args.placeholder || params.target || action.target || '';
  }
  if (name === 'press') args.keys = args.keys || args.key || args.hotkey || action.keys || '';
  if (name === 'open_app') {
    args.name = args.name || args.app || args.application || args.text || action.name || action.app || action.application || '';
    // If model omitted app name inside args/params, derive from instruction or goal
    if (!args.name) {
      const match = (instruction || '').match(/(?:open|launch|start)\s+(?:the\s+|my\s+)?([a-zA-Z0-9\s_-]+?)(?:\s+app|\s+application|$)/i) ||
                    (contextGoal || '').match(/(?:open|launch|start)\s+(?:the\s+|my\s+)?([a-zA-Z0-9\s_-]+?)(?:\s+app|\s+application|\s+and|\s+to|$)/i);
      if (match) args.name = match[1].trim();
    }
  }
  if (name === 'scroll') args.direction = String(args.direction || 'down').toLowerCase();
  if (name === 'find_window') args.name = args.name || args.text || args.window || '';
  if (name === 'describe_screen') args.prompt = args.prompt || args.text || '';
  if (name !== 'type') {
    delete args.target;
  }
  delete args.selector;
  return { name, args };
}

function planTitles(parsed) {
  const list = Array.isArray(parsed.plan) ? parsed.plan : (Array.isArray(parsed.tasks) ? parsed.tasks : []);
  return list
    .map((entry) => {
      if (typeof entry === 'string') return clip(entry, 60);
      if (entry && typeof entry === 'object') {
        const title = entry.title || entry.name || entry.text || entry.step || '';
        if (!title) return '';
        return entry.status ? `${clip(title, 60)}` : clip(title, 60);
      }
      return '';
    })
    .filter(Boolean)
    .slice(0, 8);
}

function createPcPlanner(deps = {}) {
  const modelClient = deps.modelClient;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  let planSteps = [];
  let cursor = 0;
  let revisions = 0;
  let session = new StatefulPCSession();

  function reset() {
    planSteps = [];
    cursor = 0;
    revisions = 0;
    session = new StatefulPCSession();
  }

  function extractMilestones(history) {
    if (!history || !history.length) return [];
    const milestones = [];
    for (const h of history) {
      if (!h.ok) continue;
      if (h.action === 'open_app') {
        milestones.push(`Opened application: ${h.report}`);
      } else if (h.action === 'type' && !h.report.includes('ctrl+f')) {
        milestones.push(`Message/Text sent: ${h.report}`);
      } else if (h.action === 'screenshot') {
        milestones.push(`Screenshot taken and copied to clipboard`);
      } else if (h.action === 'click' && h.report && !h.report.includes('(')) {
        milestones.push(`Clicked: ${h.report}`);
      }
    }
    return milestones.slice(-5);
  }

  function describeHistory(history) {
    if (!history || !history.length) return 'Nothing has been done yet.';
    const slice = history.slice(-6);
    const offset = history.length - slice.length;
    const lines = slice.map((entry, index) => {
      const reaction = entry.changed === true
        ? 'the screen changed'
        : entry.changed === false
          ? 'THE SCREEN DID NOT CHANGE'
          : 'not observed';
      const textPreview = entry.text ? ` [Output: "${clip(entry.text, 140)}"]` : '';
      return `${offset + index + 1}. ${entry.action}: ${entry.ok ? 'ok' : 'FAILED'} — ${clip(entry.report, 140)}${textPreview} [${reaction}]`;
    });
    if (offset > 0) {
      return `... (${offset} earlier actions completed successfully)\n${lines.join('\n')}`;
    }
    return lines.join('\n');
  }

  function describeControls(elements, goal, ocr, winInfo) {
    if (session.goal !== goal) {
      session = new StatefulPCSession(goal);
    }
    const state = session.update(ocr, elements, winInfo);
    return session.formatCompactAffordanceContext(state);
  }

  function buildPrompt(ctx) {
    const planBlock = planSteps.length
      ? `Task Roadmap:\n${planSteps.map((step, index) => `  ${index + 1}. [${index < cursor ? 'DONE' : index === cursor ? 'ACTIVE' : 'UPCOMING'}] ${step}`).join('\n')}`
      : 'No plan yet: this is the first reply, so produce the numbered plan now.';
    const winRect = (ctx.window && ctx.window.rect)
      ? ` [window bounds: x=${ctx.window.rect.x}, y=${ctx.window.rect.y}, w=${ctx.window.rect.w}, h=${ctx.window.rect.h}]`
      : '';
    const milestones = extractMilestones(ctx.history);
    const milestoneBlock = milestones.length
      ? `Completed Milestones (DO NOT REPEAT):\n${milestones.map(m => `  ✓ ${m}`).join('\n')}\n\n`
      : '';

    // Dynamic State Machine Perception
    const perception = classifyScreenState(ctx.ocr, ctx.elements, ctx.window, ctx.goal);
    const perceptionBlock = [
      '## Live Interface State Perception (Ground Truth):',
      `- Phase: ${perception.phase}`,
      `- Active Recipient / Header: ${perception.activeRecipient || 'None detected'}`,
      `- Message Composer Available: ${perception.hasComposer ? 'YES (ready to type)' : 'NO'}`,
      perception.guidance ? `- Recommended Functional Action: ${perception.guidance}` : ''
    ].filter(Boolean).join('\n');

    return [
      `Request: ${clip(ctx.goal, 400)}`,
      '',
      `Foreground window: ${clip((ctx.window && ctx.window.title) || '', 120)} (${(ctx.window && ctx.window.process) || 'unknown'}${ctx.window && ctx.window.pid ? `, pid ${ctx.window.pid}` : ''})${winRect}`,
      '',
      perceptionBlock,
      '',
      planBlock,
      '',
      milestoneBlock,
      `What has happened so far:\n${describeHistory(ctx.history)}`,
      ctx.note ? `\nNote from the screen watcher: ${ctx.note}` : '',
      '',
      describeControls(ctx.elements, ctx.goal, ctx.ocr, ctx.window),
      '',
      'Reply with the next action as RAW JSON.'
    ].filter(Boolean).join('\n');
  }

  async function plan(ctx) {
    if (!modelClient || typeof modelClient.queryJSON !== 'function') {
      return {
        thought: '', instruction: '', actions: [], done: false, modelFailed: true,
        report: 'PC planning needs a model, and none is wired into this build.'
      };
    }

    let parsed;
    try {
      // Vision grounding: only pass large base64 screenshot when no OCR/elements exist
      // or when visual scene analysis is specifically demanded (saves ~85% token bandwidth)
      const isVisualTask = /\b(describe|what\s+does|color|image|picture|look|visual)\b/i.test(ctx.goal || '');
      const hasNoText = (!ctx.ocr || !ctx.ocr.lines || !ctx.ocr.lines.length) && (!ctx.elements || !ctx.elements.length);
      const shouldIncludeImage = isVisualTask || hasNoText;

      parsed = await modelClient.queryJSON(buildPrompt(ctx), SYSTEM_PROMPT, {
        timeoutMs: 30000,
        imageDataUrl: shouldIncludeImage ? (ctx.capture && ctx.capture.dataUrl) : undefined
      });
    } catch (error) {
      log(`pc planner model call failed: ${error.message}`);
      return {
        thought: '',
        instruction: '',
        actions: [],
        done: false,
        modelFailed: true,
        report: `I could not plan that: ${error.message}`
      };
    }
    if (!parsed || typeof parsed !== 'object') {
      return { thought: '', instruction: '', actions: [], done: false, modelFailed: true, report: 'The model returned nothing I could read.' };
    }

    const titles = planTitles(parsed);
    if (titles.length) {
      if (planSteps.length === 0) {
        planSteps = titles;
        cursor = 0;
      } else {
        const changed = titles.join('\n') !== planSteps.join('\n');
        if (changed && titles.length >= Math.max(3, planSteps.length - 1)) {
          revisions++;
          planSteps = titles;
        }
      }
    }
    if (Number.isFinite(Number(parsed.step)) && Number(parsed.step) > 0) {
      const candidate = Number(parsed.step) - 1;
      if (candidate >= cursor && candidate < planSteps.length) {
        cursor = candidate;
      }
    } else if (!planSteps.length) {
      cursor = 0;
    }

    const actions = (Array.isArray(parsed.actions) ? parsed.actions : [])
      .map(act => normalizeAction(act, ctx.goal, parsed.instruction || parsed.thought))
      .filter(Boolean)
      .slice(0, 3);

    const done = parsed.done === true || parsed.goalAccomplished === true;
    const thought = String(parsed.thought || '').trim();
    const decision = {
      thought,
      instruction: String(parsed.instruction || thought).trim(),
      actions: done && !actions.length ? [] : actions,
      done: done && actions.length === 0,
      report: String(parsed.report || '').trim(),
      plan: planSteps.slice(),
      step: planSteps.length ? Math.min(cursor + 1, planSteps.length) : 0,
      revisions
    };

    // A model that returns neither an action nor a finish is stuck, and saying
    // so beats pretending there is more to try.
    if (!decision.actions.length && !decision.done) {
      decision.report = thought || 'The planner gave me no next action.';
    }
    log(`pc plan step ${decision.step}/${planSteps.length || '?'}: ${clip(decision.instruction || thought, 90)} (${decision.actions.map((a) => a.name).join(',') || 'none'})`);

    // Advance the local cursor only when an action is actually handed over.
    if (decision.actions.length && planSteps.length) {
      cursor = Math.min(planSteps.length - 1, cursor + 1);
    }
    return decision;
  }

  return {
    plan,
    reset,
    get steps() { return planSteps.slice(); },
    get revisions() { return revisions; }
  };
}

module.exports = { createPcPlanner, normalizeAction, planTitles, SYSTEM_PROMPT, PC_ACTION_TYPES, TYPE_MAP };
