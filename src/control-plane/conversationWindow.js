/**
 * Adion Browse - Role-Based Conversation Window
 *
 * Builds a bounded user/assistant message window from persisted session
 * interactions. The planner needs the real conversation (what the user asked
 * and what the agent replied/did), not a handful of truncated text lines.
 */

const DEFAULT_MAX_CHARS = 24000;
const DEFAULT_MAX_TURNS = 40;

function oneLine(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function summarizeActions(actions) {
  if (!Array.isArray(actions)) return '';
  return actions.map((action) => {
    if (!action || typeof action !== 'object') return '';
    const type = String(action.type || action.action || '').toUpperCase();
    if (!type) return '';
    const params = action.params && typeof action.params === 'object' ? action.params : action;
    const detail = params.url || params.query || params.target || params.selector ||
      params.text || params.command || params.contact || params.direction || '';
    const clean = oneLine(detail).slice(0, 120);
    return clean ? `${type}(${clean})` : type;
  }).filter(Boolean).join(', ');
}

function toTurn(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const user = oneLine(
    entry.user ||
    entry.rawPrompt ||
    entry.transcription ||
    entry.prompt?.raw ||
    entry.prompt?.transcription
  );
  if (!user) return null;

  const thought = oneLine(
    entry.agent ||
    entry.feedback ||
    entry.thought ||
    entry.response?.thought ||
    entry.response?.feedback
  );
  const executed = summarizeActions(
    entry.actions || entry.response?.actions || entry.modelResponse?.actions
  );
  const status = entry.status || entry.response?.status || 'success';
  const failed = status === 'failed' || status === 'error';

  let assistant = thought;
  if (executed) assistant += `${assistant ? ' ' : ''}[executed: ${executed}]`;
  if (!assistant) assistant = failed ? 'Action failed.' : 'Done.';
  if (failed) assistant = `(failed) ${assistant}`;

  return { user, assistant };
}

/**
 * Convert persisted interactions into provider-ready messages.
 * Newest turns are always kept; older turns are dropped once the character
 * budget is exhausted so the prompt stays bounded but the recent thread intact.
 */
function buildConversationMessages(interactions = [], options = {}) {
  const maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : DEFAULT_MAX_CHARS;
  const maxTurns = Number(options.maxTurns) > 0 ? Number(options.maxTurns) : DEFAULT_MAX_TURNS;

  const turns = (Array.isArray(interactions) ? interactions : [])
    .slice(-maxTurns)
    .map(toTurn)
    .filter(Boolean);

  const messages = [];
  let usedChars = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    const cost = turn.user.length + turn.assistant.length + 16;
    if (messages.length > 0 && usedChars + cost > maxChars) break;
    messages.unshift(
      { role: 'user', content: turn.user },
      { role: 'assistant', content: turn.assistant }
    );
    usedChars += cost;
  }
  return messages;
}

/** Merge consecutive same-role messages (Anthropic/Gemini require alternation). */
function coalesceMessages(messages) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || !message.content) continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const previous = out[out.length - 1];
    if (previous && previous.role === role) {
      previous.content += `\n${message.content}`;
    } else {
      out.push({ role, content: String(message.content) });
    }
  }
  return out;
}

module.exports = {
  buildConversationMessages,
  coalesceMessages,
  summarizeActions,
  oneLine
};
