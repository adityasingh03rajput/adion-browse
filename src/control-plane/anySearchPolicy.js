const EXPLICIT_WEB_RESEARCH = /\b(?:search\s+(?:the\s+)?(?:web|internet|online)|web\s+search|search\s+online|look\s+(?:this\s+)?up|research\b|find\s+(?:me\s+)?(?:sources|articles|information|evidence))\b/i;
const INFORMATIONAL_REQUEST = /^(?:what|who|when|where|why|how|which|explain|summari[sz]e|tell\s+me\s+about|compare|find\s+out|what['’]s|who['’]s)\b/i;
const CURRENT_INFORMATION = /\b(?:latest|current|currently|today|recent|news|price|weather|stock\s+price|exchange\s+rate|release\s+date|version|as\s+of\s+\d{4})\b/i;
const PAGE_REFERENCES = /\b(?:this\s+page|this\s+article|this\s+site|this\s+website|current\s+page|on\s+this\s+page|above)\b/i;
const BROWSER_ACTION = /^(?:open|navigate|go\s+to|click|tap|type|send|message|text|close|switch|reload|refresh|scroll|play|set|change|make|turn|fill|submit|bookmark|download|upload)\b/i;
const HOW_TO_BROWSER_ACTION = /^how\s+(?:do|can|should)\s+(?:i|we|you)\s+(?:open|navigate|go\s+to|click|tap|type|send|message|close|switch|reload|refresh|scroll|play|set|change|turn|fill|submit|bookmark)\b/i;

function isExplicitWebResearchRequest(input) {
  return EXPLICIT_WEB_RESEARCH.test(String(input || '').trim());
}

function isInformationalRequest(input) {
  const text = String(input || '').trim();
  return INFORMATIONAL_REQUEST.test(text) && !BROWSER_ACTION.test(text) && !HOW_TO_BROWSER_ACTION.test(text);
}

function isPotentialWebResearchRequest(input) {
  return isExplicitWebResearchRequest(input) || isInformationalRequest(input);
}

function shouldSearchForContext(input, pageContext = {}) {
  const text = String(input || '').trim();
  if (!text) return false;
  if (isExplicitWebResearchRequest(text)) return true;
  if (!isInformationalRequest(text)) return false;

  const pageBound = PAGE_REFERENCES.test(text);
  const hasSharedPageText = pageContext.isShared !== false &&
    typeof pageContext.pageText === 'string' && pageContext.pageText.trim().length >= 300;

  // Page-bound prompts should use local page context; searching for phrases such
  // as "what does this page say" is both unhelpful and risks exposing intent.
  // The user can explicitly request an external web search to override this.
  if (pageBound) return false;
  if (CURRENT_INFORMATION.test(text)) return true;
  return !hasSharedPageText;
}

function shouldSearchAfterUncertainty(input) {
  const text = String(input || '').trim();
  if (!isInformationalRequest(text)) return false;
  // Page-specific questions must not be sent to the external provider implicitly.
  // The user can explicitly request a web search if they want that behavior.
  if (PAGE_REFERENCES.test(text)) return false;
  return true;
}

function isInsufficientContextThought(thought) {
  return /\b(?:not enough (?:context|information)|insufficient (?:context|information)|(?:i|we)\s+(?:do not|don't)\s+have\s+(?:enough|sufficient)\s+(?:context|information|evidence|details)|(?:i|we)\s+(?:cannot|can't|couldn't|do not|don't)\s+(?:answer|determine|verify|find)|unable to (?:answer|determine|verify|find)|need (?:more|additional) (?:context|information)|unclear from (?:the )?(?:page|context)|the page does not (?:say|include|contain))\b/i
    .test(String(thought || ''));
}

function buildSearchQuery(input) {
  let query = String(input || '').trim()
    .replace(/^(?:hey\s+)?(?:jarvis|adion)[,:\s]+/i, '')
    .replace(/^(?:can|could)\s+you\s+(?:please\s+)?/i, '')
    .replace(/^please\s+/i, '')
    .replace(/^(?:search\s+(?:the\s+)?(?:web|internet|online)\s+for|web\s+search\s+for|look\s+(?:this\s+)?up|research)\s*/i, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return query.slice(0, 500);
}

module.exports = {
  isExplicitWebResearchRequest,
  isInformationalRequest,
  isPotentialWebResearchRequest,
  shouldSearchForContext,
  shouldSearchAfterUncertainty,
  isInsufficientContextThought,
  buildSearchQuery
};
