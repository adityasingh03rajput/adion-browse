/**
 * Adion Browse — Action Consent & Authorization Gate
 *
 * Deterministic brakes for actions that are hard or impossible to undo.
 *
 * A prompt is not a safety boundary. The planner can propose anything, so the
 * decision about whether a *class* of action was asked for is made here, in
 * code, from the person's own words — never by asking the model again.
 *
 * Two surfaces:
 *   shell — the local terminal bridge, i.e. arbitrary command execution
 *   page  — clicks and typed submissions inside a tab (send, buy, delete, post)
 *
 * Nothing here reads a page, spawns a process, or calls a network. Pure
 * functions so the rules can be tested without Electron.
 */

'use strict';

// --- what the person's own request must have said -------------------------

const DELETE_VERB = /\b(delete|deletes|deleting|remove|removes|removing|erase|wipe|trash|purge|discard|uninstall|format|reset|clear|clean|cleans|cleanup|drop|kill|stop|terminate|close|shut\s*down|shutdown)\b/i;
// Starting a program or running remote code is an execution decision, not a
// writing one: "tidy my desktop" must never authorize launching a binary.
const RUN_VERB = /\b(run|running|execute|launch|start|invoke|open|install)\b/i;
const SEND_VERB = /\b(send|submit|post|publish|share|upload|email|mail|message|text|reply|comment|tweet|apply|order|buy|purchase|pay|checkout|subscribe|sign\s*out|log\s*out|book|say|tell|chat|ask|greet|write\s+to|turn\s+in|hand\s+in)\b/i;
const PRIV_VERB = /\b(admin|administrator|elevate|elevated|sudo|root|privilege|privileged|as\s+admin|grant|permission)\b/i;
const MONEY_VERB = /\b(buy|purchase|pay|checkout|order|transfer|subscribe|donate|tip|price|refund|top\s*up)\b/i;

// --- shell patterns, most dangerous first ---------------------------------

const SHELL_RULES = [
  {
    klass: 'privileged',
    family: 'remote-code',
    reason: 'downloads code from the network and executes it',
    test: /\b(iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget)\b[^|;&]*\|\s*(iex|invoke-expression|sh|bash|zsh|powershell|pwsh|cmd)\b/i
  },
  {
    klass: 'privileged',
    family: 'remote-code',
    reason: 'executes a dynamically built string',
    test: /\b(invoke-expression|iex)\b|-encodedcommand\b/i
  },
  {
    klass: 'destructive',
    family: 'disk',
    reason: 'formats or repartitions a disk',
    // The alternative set ends in ":" for a drive letter, so it cannot be
    // wrapped in one trailing \b: that boundary never matches after a colon
    // and "format c:" slipped through. Anchor per alternative instead.
    test: /(?:^|[\s;&|(])(?:format-volume\b|format\s+[a-z]:|diskpart\b|mkfs(?:\.[a-z0-9]+)?\b|dd\s+if=|clear-disk\b|initialize-disk\b)/i
  },
  {
    klass: 'destructive',
    family: 'delete',
    reason: 'deletes files recursively or without prompting',
    test: /remove-item\b[^\n]*-(recurse|force)/i
  },
  {
    klass: 'destructive',
    family: 'delete',
    reason: 'deletes files recursively or without prompting',
    test: /\b(del|erase)\s+[^\n]*\/[fsq]\b|\b(rd|rmdir)\s+[^\n]*\/s\b/i
  },
  {
    klass: 'destructive',
    family: 'delete',
    reason: 'deletes files recursively',
    test: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i
  },
  {
    klass: 'destructive',
    family: 'history',
    reason: 'discards uncommitted work or rewrites shared history',
    test: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*[fd]|push\s+(-f|--force)|branch\s+-d)/i
  },
  {
    klass: 'privileged',
    family: 'system-settings',
    reason: 'changes system configuration or accounts',
    test: /\b(reg\s+delete|sc\s+delete|bcdedit|net\s+user\b[^\n]*\/delete|net\s+localgroup|set-mppreference|takeown|icacls)\b/i
  },
  {
    klass: 'destructive',
    family: 'power',
    reason: 'shuts down, restarts or signs out of the machine',
    test: /\b(shutdown|restart-computer|stop-computer|logoff)\b/i
  },
  {
    klass: 'destructive',
    family: 'process',
    reason: 'force-kills running programs',
    test: /\b(taskkill|stop-process)\b/i
  }
];

// A file only counts as "running code" when no interpreter is named in front
// of it: `node build.js` is a normal command, `invoice.js` opened by the shell
// is running an unknown program.
const INTERPRETER_RUN = /\b(node|npx|py|python3?|deno|bun|yarn|pnpm|powershell|pwsh|bash|sh|zsh)\s+\S*\.(js|mjs|cjs|ts|py|ps1|sh)\b/i;
const RUNS_CODE = /\.(exe|msi|bat|cmd|com|scr|pif|ps1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|url|cpl|jar|reg|msc)\b/i;

// --- page labels ----------------------------------------------------------

const SAFE_LABEL = /\b(apply\s+(filters?|changes?|settings?)|sort|filter|search|find|next|previous|back|cancel|close|dismiss|open|view|show|details?|more|less|expand|collapse|refresh|reload|home|help|skip|continue|accept\s+cookies|agree)\b/i;
const RISKY_LABEL = /\b(buy|purchase|pay|checkout|check\s*out|place\s+order|order\s+now|confirm\s+order|send|submit|delete|remove|discard|erase|trash|transfer|subscribe|unsubscribe|sign\s*out|log\s*out|logout|book|publish|post|share|merge|deploy|uninstall|reset|format|empty|clear\s+all|turn\s+in|hand\s+in|unfriend|block|report|withdraw)\b/i;
const MONEY_LABEL = /\b(buy|purchase|pay|checkout|check\s*out|place\s+order|order\s+now|transfer|subscribe|donate|tip|bid|confirm\s+order)\b/i;
const MESSAGE_FIELD = /\b(message|chat|reply|comment|compose|email|mail|subject|post|tweet|status|dm|composer|send\s+a\s+message|write\s+a\s+message)\b/i;

// D:\help sensitive.js: fields the agent must never read, point at, or type
// into — passwords, card numbers, OTPs, government IDs. Enforced in code on
// every input path because a prompt is not a safety boundary.
const SENSITIVE_NAME = /\b(password|passcode|passwd|pwd|pin|cvv|cvc|ssn|passport|otp)\b|\b(?:card|credit|debit|account|routing|social security|national id|government id|tax id|driver.?s? licen[cs]e)\s*(?:number|no|num)?\b|\b(?:security|verification|one time)\s*code\b/i;
const FIELD_TYPES = new Set(['edit', 'combobox', 'textbox', 'password', 'document']);

function normalizeFieldText(s) {
  return String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').toLowerCase();
}

// -> true when the named field looks private (password, card, OTP, ID).
function sensitiveField(name, type) {
  const t = String(type || '').toLowerCase();
  if (t === 'password') return true;
  if (t && !FIELD_TYPES.has(t)) return false;
  return SENSITIVE_NAME.test(normalizeFieldText(name));
}

// -> true when a value reads like a secret (8+ digits, card/account/ID shape).
function looksSecretValue(value) {
  return /(?:\d[\s-]?){8,}/.test(String(value || ''));
}

function clip(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/**
 * Classify a shell command the planner wants to run.
 * -> { class, family, reason }
 */
function classifyCommand(command) {
  const cmd = String(command == null ? '' : command);
  if (!cmd.trim()) return { class: 'safe', family: 'empty', reason: 'no command' };

  for (const rule of SHELL_RULES) {
    if (rule.test.test(cmd)) {
      return { class: rule.klass, family: rule.family, reason: rule.reason };
    }
  }
  if (!INTERPRETER_RUN.test(cmd) && RUNS_CODE.test(cmd)) {
    return { class: 'run-file', family: 'run-file', reason: 'starts a program or script' };
  }
  return { class: 'safe', family: 'read', reason: 'no destructive or privileged pattern' };
}

/**
 * Classify a click or a typed submission inside the page.
 * -> { class, family, reason }
 */
function classifyPageAction(action = {}, intent = {}) {
  const label = String(action.label || action.text || '').trim();
  const fieldName = String(action.fieldName || action.selector || '');

  // Exception: Secret code fields for WhatsApp Chat Lock / protected chats
  // When user explicitly provides secretCode, allow typing into password/secret fields
  if (intent.secretCode && /password|passcode|pin|secret|code/i.test(fieldName)) {
    return { class: 'safe', family: 'secret-code-unlock', reason: 'secret code unlock for protected chat' };
  }

  // Private fields are never typed into or submitted — regardless of what the
  // prompt asked. Mirrors D:\help's sensitiveTarget refusal.
  if (action.fieldName && sensitiveField(fieldName, action.fieldType)) {
    return { class: 'refused', family: 'private-field', reason: 'that is a private field (password, card, or identity number); fill it in yourself' };
  }
  if (action.text && looksSecretValue(action.text) && /password|passcode|otp|pin|cvv/i.test(fieldName)) {
    return { class: 'refused', family: 'private-field', reason: 'refusing to type a secret-looking value into a private field' };
  }

  if (label && RISKY_LABEL.test(label) && !(SAFE_LABEL.test(label) && !RISKY_LABEL.test(label))) {
    if (MONEY_LABEL.test(label)) return { class: 'commit', family: 'money', reason: 'spends money' };
    return { class: 'commit', family: 'commit', reason: 'sends, submits, deletes or posts something' };
  }
  const hay = [fieldName, label, action.text].filter(Boolean).join(' ');
  if (action.submit && MESSAGE_FIELD.test(hay)) {
    // Search/filter boxes are never message composers — even when their
    // aria-label mentions "chat" (e.g. WhatsApp "Search or start a new chat").
    // Typing a query + Enter is a reversible search, not a send.
    const isSearchField = /\b(search|filter|find|query|lookup)\b/i.test(hay) &&
      !/\b(message|compose|reply|comment|tweet|status|dm|inbox|conversation)\b/i.test(fieldName);
    const looksLikeQuery = !action.text || String(action.text).trim().split(/\s+/).length <= 6;
    if (!(isSearchField && looksLikeQuery)) {
      return { class: 'commit', family: 'send', reason: 'types and sends a message' };
    }
    return { class: 'safe', family: 'navigation', reason: 'search or filter' };
  }
  if (label && SAFE_LABEL.test(label) && !RISKY_LABEL.test(label)) {
    return { class: 'safe', family: 'navigation', reason: 'reversible navigation' };
  }
  return { class: 'safe', family: 'page', reason: 'no irreversible label' };
}

function authorizedFor(target, prompt) {
  switch (target.family) {
    case 'money':
      return MONEY_VERB.test(prompt);
    case 'send':
    case 'commit':
      return SEND_VERB.test(prompt) || MONEY_VERB.test(prompt) || DELETE_VERB.test(prompt);
    case 'run-file':
      return RUN_VERB.test(prompt);
    case 'remote-code':
    case 'system-settings':
      return PRIV_VERB.test(prompt) || RUN_VERB.test(prompt);
    case 'delete':
    case 'disk':
    case 'history':
    case 'power':
    case 'process':
      return DELETE_VERB.test(prompt);
    default:
      return false;
  }
}

function refusal(target, subject, prompt) {
  const what = subject ? `\`${clip(subject, 90)}\`` : 'that action';
  const said = String(prompt || '').trim();
  const hint = said
    ? 'Your request did not ask for it.'
    : 'There was no request text to authorize it.';
  return `Not done: ${what} ${target.reason}. ${hint} Say it plainly (for example "delete …"), or do it yourself.`;
}

/**
 * The single entry point.
 *
 * spec: { kind: 'shell', command } | { kind: 'page', label, submit, fieldName, text }
 * prompt: the person's own words for this run
 * intent: the full action intent object (contains secretCode, explicitInput, etc.)
 * -> { allowed, class, family, reason, message }
 */
function evaluateAction(spec = {}, prompt = '', intent = {}) {
  const kind = String(spec.kind || 'page').toLowerCase();
  const target = kind === 'shell'
    ? classifyCommand(spec.command)
    : classifyPageAction(spec, intent);

  const verdict = { allowed: true, class: target.class, family: target.family, reason: target.reason, message: '' };
  if (target.class === 'safe') return verdict;

  if (authorizedFor(target, String(prompt || ''))) return verdict;

  verdict.allowed = false;
  verdict.message = refusal(target, kind === 'shell' ? spec.command : (spec.label || spec.text), prompt);
  return verdict;
}

module.exports = {
  evaluateAction,
  classifyCommand,
  classifyPageAction,
  // exported for tests and for future surfaces (a confirm card reuses the rules)
  SHELL_RULES,
  DELETE_VERB,
  RUN_VERB,
  SEND_VERB,
  PRIV_VERB,
  MONEY_VERB,
  RISKY_LABEL,
  SAFE_LABEL,
  MESSAGE_FIELD,
  sensitiveField,
  looksSecretValue,
  SENSITIVE_NAME
};
