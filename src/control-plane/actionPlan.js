/**
 * Adion Browse - Action Plan Parsing & Normalization
 *
 * Single source of truth for decoding model output into an executable plan.
 * Works for every provider and keeps the planner metadata (thought, tasks,
 * goalAccomplished, extendCapBy) that the goal loop relies on.
 */

const PARAM_KEYS = [
  'url', 'query', 'direction', 'amount', 'target', 'selector', 'text',
  'command', 'value', 'attribute', 'action', 'message', 'contact', 'phone',
  'secretCode', 'panel', 'key', 'keys', 'x', 'y', 'path', 'id', 'name', 'app', 'enter', 'shortcut'
];

const TYPE_ALIASES = {
  TYPE: 'INPUT_TEXT',
  INPUT: 'INPUT_TEXT',
  TYPE_TEXT: 'INPUT_TEXT',
  FILL: 'INPUT_TEXT',
  CLICK: 'CLICK_SELECTOR',
  TAP: 'CLICK_SELECTOR',
  PRESS: 'CLICK_SELECTOR',
  GOTO: 'NAVIGATE',
  GO_TO: 'NAVIGATE',
  OPEN_URL: 'NAVIGATE',
  BROWSE: 'NAVIGATE',
  SEARCH: 'NAVIGATE',
  CLOSE: 'CLOSE_TAB',
  REFRESH: 'RELOAD',
  BACK: 'GO_BACK',
  FORWARD: 'GO_FORWARD',
  RUN: 'TERMINAL_EXEC',
  EXEC: 'TERMINAL_EXEC',
  SHELL: 'TERMINAL_EXEC',
  ANSWER: 'PAGE_ANALYSIS_OR_QA',
  CHAT: 'PAGE_ANALYSIS_OR_QA',
  PAGE_ANALYSIS: 'PAGE_ANALYSIS_OR_QA',
  PAGE_ANALYSIS_OR_QA: 'PAGE_ANALYSIS_OR_QA',
  QA: 'PAGE_ANALYSIS_OR_QA'
};

/**
 * Balance braces/brackets and close an unterminated string so a truncated
 * model response can still be decoded instead of failing the whole turn.
 */
function repairTruncatedJSON(text) {
  let raw = String(text || '').trim();
  if (!raw) return raw;

  let inString = false;
  let escaped = false;
  const stack = [];

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }

  if (inString) raw += '"';
  raw = raw.replace(/,\s*$/, '');
  while (stack.length > 0) {
    const open = stack.pop();
    raw += open === '{' ? '}' : ']';
  }
  return raw;
}

function normalizeAction(action) {
  if (!action || typeof action !== 'object') return null;

  let type = String(action.type || action.action || action.name || '').toUpperCase().trim();
  type = TYPE_ALIASES[type] || type;
  if (!type) return null;

  const params = {};
  if (action.params && typeof action.params === 'object' && !Array.isArray(action.params)) {
    Object.assign(params, action.params);
  }
  if (action.args && typeof action.args === 'object' && !Array.isArray(action.args)) {
    Object.assign(params, action.args);
  }
  for (const key of PARAM_KEYS) {
    if (params[key] === undefined && action[key] !== undefined) {
      params[key] = action[key];
    }
  }

  if (type === 'NAVIGATE' && !params.url && params.query) {
    // Keep query-based navigation intact; the runtime resolves it.
  }
  if (type === 'SCROLL' && !params.direction) {
    if (action.up) params.direction = 'up';
    else if (action.down) params.direction = 'down';
  }

  const result = { type, params };
  if (action.args || Object.keys(params).length > 0) {
    result.args = { ...params, ...(action.args || {}) };
  }
  if (action.name) result.name = action.name;
  return result;
}

function normalizePlan(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed === 'string') return null;

  const rawActions = Array.isArray(parsed.actions)
    ? parsed.actions
    : (parsed.action ? [parsed.action] : []);

  const plan = {
    ...parsed,
    thought: typeof parsed.thought === 'string' && parsed.thought.trim()
      ? parsed.thought
      : 'Executing browser command',
    actions: rawActions.map(normalizeAction).filter(Boolean)
  };

  if (Array.isArray(parsed.tasks)) {
    plan.tasks = parsed.tasks
      .filter(task => task && typeof task === 'object')
      .map((task, index) => ({
        id: task.id !== undefined ? task.id : index + 1,
        title: String(task.title || task.description || `Step ${index + 1}`),
        status: ['pending', 'in_progress', 'completed'].includes(task.status)
          ? task.status
          : 'pending'
      }));
  }

  // BUA self-correction pattern: memory and next_goal fields for compressed history
  const responseText = parsed.response || parsed.reply || parsed.message || parsed.answer;
  if (typeof responseText === 'string' && responseText.trim()) {
    plan.response = responseText.trim();
  }
  if (parsed.memory && typeof parsed.memory === 'string') {
    plan.memory = parsed.memory.trim();
  }
  if (parsed.next_goal && typeof parsed.next_goal === 'string') {
    plan.next_goal = parsed.next_goal.trim();
  }

  plan.goalAccomplished = parsed.goalAccomplished === true || parsed.accomplished === true;
  plan.extendCapBy = Number.isFinite(Number(parsed.extendCapBy)) ? Number(parsed.extendCapBy) : 0;

  return plan;
}

/** Parse raw model text into a normalized plan, or null when undecodable. */
function parsePlanResponse(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  }

  let parsed = null;
  const candidates = [cleaned];
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) candidates.push(match[0]);

  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch (_) {
      try {
        parsed = JSON.parse(repairTruncatedJSON(candidate));
        break;
      } catch (__) {
        // try the next candidate
      }
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return normalizePlan(parsed);
}

module.exports = {
  PARAM_KEYS,
  TYPE_ALIASES,
  repairTruncatedJSON,
  normalizeAction,
  normalizePlan,
  parsePlanResponse
};