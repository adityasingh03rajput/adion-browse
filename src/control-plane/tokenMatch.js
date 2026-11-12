/**
 * Adion Browse — Token-coverage matching for semantic element grounding.
 *
 * Web UIs rarely label a control with the planner's exact phrase: a search
 * field is "Search elements", not "elements search bar". Substring matching
 * fails those cases, so targets and labels are compared by meaningful token
 * coverage instead. Keep this function self-contained: it is injected into
 * the page via Function.prototype.toString for in-DOM field resolution.
 */

function scoreTokenOverlap(target, candidate) {
  const STOPWORDS = new Set([
    'the', 'a', 'an', 'to', 'into', 'in', 'on', 'at', 'for', 'of', 'and',
    'or', 'with', 'this', 'that', 'these', 'those', 'it', 'its', 'my',
    'element', 'elements', 'field', 'box', 'bar', 'area', 'input', 'button',
    'please', 'click', 'type', 'enter', 'fill', 'write', 'put'
  ]);
  const normalize = (value) => String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097F]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const targetTokens = [...new Set(normalize(target).filter((t) => !STOPWORDS.has(t)))];
  const candidateTokens = [...new Set(normalize(candidate).filter((t) => !STOPWORDS.has(t)))];
  if (targetTokens.length === 0 || candidateTokens.length === 0) return 0;

  let hits = 0;
  for (const token of targetTokens) {
    const matched = candidateTokens.some((candidateToken) => {
      if (candidateToken === token) return true;
      return token.length >= 4 && candidateToken.length >= 4 &&
        (candidateToken.includes(token) || token.includes(candidateToken));
    });
    if (matched) hits += 1;
  }
  return hits / targetTokens.length;
}

module.exports = { scoreTokenOverlap };
