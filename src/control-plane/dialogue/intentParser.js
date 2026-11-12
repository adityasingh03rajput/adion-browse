/**
 * Adion Browse — Intent Parser (algorithmic NLU, dependency-free).
 *
 * Replaces per-case regex chains with a uniform pipeline:
 *   tokenize → verb normalize (multilingual dictionary) →
 *   SOV→SVO reorder (grammar rule, any verb/object) →
 *   entity extract (site / section / query from the registry) →
 *   classify with confidence.
 *
 * Confidence contract:
 *   >= 0.85 deterministic — safe to execute without the LLM.
 *   0.60–0.85  context-dependent — needs dialogue state to resolve.
 *   < 0.60     unknown — caller MUST defer to the LLM planner.
 */

const { findSite, siteMentioned, findSection, isGenericSection } = require('./siteRegistry');

/** Canonical verb → surface forms (English + transliterated Hindi/Hinglish + Devanagari). */
const VERBS = {
  open: ['open', 'kholo', 'khol', 'kholna', 'kholiye', 'kholega', 'kholde', 'kholdo', 'खोलो', 'खोल', 'खोलना', 'खोलिए', 'खोलिये', 'खोल दो', 'खोले', 'chalao', 'chala', 'lagao', 'go', 'goto', 'visit', 'launch', 'jao'],
  close: ['close', 'band', 'shut', 'band karo', 'bandh karo', 'बंद', 'बंद करो', 'roko', 'रोको', 'rok', 'रोक'],
  show: ['show', 'dikhao', 'dikha', 'dekho', 'dikhaiye', 'दिखाओ', 'दिखा', 'दिखाइए', 'दिखलाओ', 'बताओ', 'batao', 'view', 'display'],
  search: ['search', 'khojo', 'khoj', 'dhoondo', 'dhundo', 'ढूंढो', 'खोजो', 'खोजिए', 'सर्च करो', 'तलाश', 'talash', 'तलाशो'],
  click: ['click', 'tap', 'press', 'dabao', 'दबाओ', 'क्लिक करो', 'छुओ', 'chhuo'],
  type: ['type', 'likho', 'bharo', 'write', 'enter', 'fill', 'लिखो', 'लिखिए', 'टाइप करो'],
  login: ['login', 'log in', 'log', 'signin', 'sign in', 'sign', 'logout', 'log out', 'लॉगिन', 'लॉग इन', 'साइन इन', 'साइनइन'],
  scroll: ['scroll', 'upar', 'neeche', 'स्क्रॉल', 'स्क्रोल'],
  back: ['back', 'peeche', 'वापस', 'wapas', 'वापिस'],
  reload: ['reload', 'refresh', 'रिफ्रेश', 'ताज़ा करो', 'ताजा करो'],
};

const VERB_TO_CANON = new Map();
for (const [canon, forms] of Object.entries(VERBS)) {
  for (const f of forms) VERB_TO_CANON.set(f.toLowerCase(), canon);
}
// Multi-word verbs are matched before tokenization (Roman + Devanagari).
const MULTIWORD_VERBS = ['band karo', 'bandh karo', 'type karo', 'log in', 'log out', 'sign in', 'sign out', 'बंद करो', 'खोल दो', 'टाइप करो', 'क्लिक करो', 'सर्च करो', 'ताज़ा करो', 'ताजा करो', 'लॉग इन', 'लॉग आउट', 'साइन इन'];

function tokenize(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[?!.,;:"“”‘’()[\]।]/g, ' ') // NOTE: Devanagari danda (।) is a sentence stop too
    .split(/\s+/)
    .filter(Boolean);
}

/** Normalize a token list: fold multiword verbs, map surface verbs to canonical. */
function normalizeVerbs(tokens) {
  const joined = ' ' + tokens.join(' ') + ' ';
  let s = joined;
  for (const mw of MULTIWORD_VERBS) {
    const canon = VERB_TO_CANON.get(mw);
    if (canon) s = s.split(' ' + mw + ' ').join(` ${canon} `);
  }
  return s.trim().split(/\s+/).filter(Boolean).map(t => VERB_TO_CANON.get(t) || t);
}

function isVerb(tok) { return Object.prototype.hasOwnProperty.call(VERBS, tok); }

class IntentParser {
  parse(rawText) {
    const raw = String(rawText || '').trim();
    if (!raw) return { intent: 'EMPTY', confidence: 0, raw };
    let tokens = normalizeVerbs(tokenize(raw));

    // Grammar rule (generic SOV→SVO): Hindi/Hinglish puts the verb last
    // ("instagram kholo", "tab band karo") — rotate a trailing verb to front.
    // Applies to ANY verb in the table and ANY object phrase, not a word list.
    if (tokens.length >= 2 && !isVerb(tokens[0]) && isVerb(tokens[tokens.length - 1])) {
      const verb = tokens.pop();
      tokens = [verb, ...tokens];
    }

    const verb = isVerb(tokens[0]) ? tokens[0] : null;
    const rest = verb ? tokens.slice(1) : tokens.slice();
    // Strip leading determiners / prepositions.
    while (rest.length && ['the', 'my', 'to', 'on', 'a', 'an'].includes(rest[0])) rest.shift();

    const objectPhrase = rest.join(' ').trim();
    // Site disambiguation: when multiple sites are mentioned (e.g. "open canva.com
    // and log in ... gmail.com"), pick the site whose mention is CLOSEST to the
    // verb — the verb's object — not the first registry-order match.
    const site = this._siteNearVerb(raw, tokens, verb) || findSite(objectPhrase) || siteMentioned(objectPhrase) || siteMentioned(raw);
    const firstTok = rest[0] || '';

    // --- classification ---
    if (!verb) {
      // No verb: bare site mention ("instagram") or bare query.
      if (site && rest.length <= 2) {
        return { intent: 'NAVIGATE_SITE', verb: 'open', site: site.id, confidence: 0.8, raw, objectPhrase };
      }
      return { intent: 'UNKNOWN', confidence: 0.4, raw, objectPhrase };
    }

    if (verb === 'open' || verb === 'show' || verb === 'go') {
      if (site && (!objectPhrase || objectPhrase === site.id || rest.length <= 2)) {
        // "open instagram" / "instagram kholo" (post-reorder)
        return { intent: 'NAVIGATE_SITE', verb, site: site.id, confidence: 0.95, raw, objectPhrase };
      }
      if (isGenericSection(objectPhrase) || isGenericSection(firstTok)) {
        return { intent: 'OPEN_SECTION', verb, site: site ? site.id : null, section: objectPhrase, confidence: site ? 0.9 : 0.7, raw, objectPhrase };
      }
      if (site) {
        // Verb + site + extra words ("open instagram login page") — site is certain, rest is fuzzy.
        return { intent: 'NAVIGATE_SITE', verb, site: site.id, confidence: 0.85, raw, objectPhrase };
      }
      if (/^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,}(\/\S*)?$/.test(objectPhrase)) {
        return { intent: 'NAVIGATE_URL', verb, url: objectPhrase, confidence: 0.9, raw, objectPhrase };
      }
      return { intent: 'UNKNOWN', verb, confidence: 0.45, raw, objectPhrase };
    }

    if (verb === 'search') {
      if (!objectPhrase) return { intent: 'UNKNOWN', verb, confidence: 0.3, raw, objectPhrase };
      const query = objectPhrase.replace(/^for\s+/i, '').trim() || objectPhrase;
      const inSite = query.match(/(.+?)\s+(?:in|on|par|mein)\s+([a-z0-9.\-]+)$/);
      if (inSite && findSite(inSite[2])) {
        return { intent: 'SEARCH_SITE', verb, query: inSite[1].trim(), site: findSite(inSite[2]).id, confidence: 0.85, raw, objectPhrase };
      }
      return { intent: 'SEARCH_WEB', verb, query, site: site ? site.id : null, confidence: site ? 0.7 : 0.85, raw, objectPhrase };
    }

    if (verb === 'close') {
      return { intent: 'TAB_OP', op: 'close', verb, confidence: 0.9, raw, objectPhrase };
    }
    if (verb === 'click') {
      if (!objectPhrase) return { intent: 'UNKNOWN', verb, confidence: 0.3, raw, objectPhrase };
      return { intent: 'CLICK', verb, target: objectPhrase, confidence: 0.8, raw, objectPhrase };
    }
    if (verb === 'type') {
      return { intent: 'TYPE', verb, text: objectPhrase, confidence: objectPhrase ? 0.75 : 0.3, raw, objectPhrase };
    }
    if (verb === 'login') {
      // "log in using X at Y" / "login to canva" — site context if present, else defer.
      return { intent: 'LOGIN', verb, site: site ? site.id : null, credentials: objectPhrase, confidence: site ? 0.8 : 0.6, raw, objectPhrase };
    }
    if (verb === 'scroll' || verb === 'back' || verb === 'reload') {
      return { intent: 'VIEW_OP', op: verb, verb, confidence: 0.85, raw, objectPhrase };
    }
    return { intent: 'UNKNOWN', verb, confidence: 0.4, raw, objectPhrase };
  }

  /**
   * Find the site whose mention appears closest to the verb position.
   * Scans raw text for every known site mention and returns the one with the
   * smallest token distance from the verb. Prevents a later-mentioned site
   * (e.g. gmail.com in credentials) from hijacking the verb's object site.
   */
  _siteNearVerb(raw, tokens, verb) {
    if (!verb || !tokens || tokens.length < 2) return null;
    const verbIdx = tokens.indexOf(verb);
    if (verbIdx < 0) return null;
    const { SITES } = require('./siteRegistry');
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u0900-\u097F. ]/gi, ' ');
    const padded = ' ' + norm(raw) + ' ';
    let best = null, bestDist = Infinity;
    for (const site of SITES) {
      const needles = [...(site.aliases || []), ...(site.domains || []).map(d => d.replace(/^www\./, ''))];
      for (const n of needles) {
        const needle = ' ' + n.toLowerCase();
        let idx = padded.indexOf(needle + ' ');
        if (idx < 0) idx = padded.indexOf(needle + '.');
        if (idx < 0) continue;
        // Approximate token position of the mention.
        const mentionTokens = norm(padded.slice(0, idx)).split(/\s+/).filter(Boolean).length;
        const dist = Math.abs(mentionTokens - verbIdx);
        if (dist < bestDist) { bestDist = dist; best = site; }
        break; // one match per site is enough
      }
    }
    return best;
  }

  /**
   * Split a multi-action utterance into per-segment parses.
   * Joiners: "and then / and now / and also / then / ;" plus bare "and"
   * before a verb ("open youtube and search for cats"). Hindi equivalents:
   * "और / फिर / तथा / उसके बाद" ("यूट्यूब खोलो और गाने खोजो").
   * NOTE: no \b after Devanagari verbs — \b never matches non-Latin text,
   * so the Devanagari lookahead uses plain prefix alternatives.
   * Returns null for single-action input so callers can fast-path past it.
   */
  parseCompound(rawText) {
    const raw = String(rawText || '').trim();
    if (!raw) return null;
    const parts = raw
      .split(/\s+(?:and\s+then|and\s+now|and\s+also|then|उसके\s+बाद|और|फिर|तथा)\s+|\s*;\s*|,\s*then\s+/i)
      .map(s => s.trim()).filter(Boolean);
    const out = [];
    for (const p of parts) {
      const sub = p
        .split(/\s+(?:and|और)\s+(?=(?:open|search|click|go|play|show|close|type|scroll|launch|visit|log|login|sign)\b|खोल|बंद|खोज|ढूंढ|दिखा|देखो|बता|लिख|भरो|दबा|भेज|चला|टाइप|क्लिक|स्क्रॉल|स्क्रोल|वापस|रिफ्रेश|लॉग)/i)
        .map(s => s.trim()).filter(Boolean);
      out.push(...sub);
    }
    const segs = out
      .map(s => s.replace(/^(?:just|simply|please|now|so|ok|कृपया|प्लीज|अरे|सुनो)\s+/i, '').trim())
      .filter(Boolean);
    if (segs.length < 2) return null;
    return { segments: segs.map(s => this.parse(s)), raw };
  }
}

module.exports = { IntentParser, VERBS };
