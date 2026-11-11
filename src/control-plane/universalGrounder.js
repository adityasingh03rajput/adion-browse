/**
 * Universal Cognitive Element Grounding Engine
 * 
 * Provides human-like visual flexibility and semantic robustness across ANY modern website:
 * - Formatting quirk resilience: accidental spaces ("sign   up", "s i g n u p", "sign-up" vs "signup"),
 *   non-breaking spaces (\u00A0), zero-width characters, casing, punctuation, and soft hyphens.
 * - Abstract shape & icon detection: visual elements without plain innerText (SVG shapes, icon fonts,
 *   role="img", submit values, alt text, icon classes like fa-search, lucide-menu, user-plus).
 * - Semantic intent inference: recognizes functional clusters (Sign Up vs Sign In, Search, Cart, Menu, Close)
 *   and applies strict antonym protection so "Sign Up" never mistakenly clicks "Sign In".
 * - Cross-questioning protocol: cleanly flags ambiguous options or when only the opposite action is available,
 *   enabling the autonomous agent to ask for precise clarification instead of faking or mis-clicking.
 */

const SEMANTIC_CLUSTERS = {
  SIGN_UP: {
    id: 'SIGN_UP',
    label: 'Sign Up / Registration',
    synonyms: [
      'signup', 'sign up', 'register', 'registration', 'create account', 'create an account',
      'create new account', 'join', 'join now', 'join free', 'get started', 'start free',
      'start free trial', 'new user', 'sign me up', 'subscribe', 'open an account'
    ],
    antonymCluster: 'SIGN_IN',
    iconHints: ['user-plus', 'person-add', 'user-add', 'signup', 'register'],
    hrefPatterns: ['signup', 'register', 'join', 'create-account', 'get-started', 'auth/new']
  },
  SIGN_IN: {
    id: 'SIGN_IN',
    label: 'Sign In / Log In',
    synonyms: [
      'signin', 'sign in', 'login', 'log in', 'enter', 'log into', 'my account',
      'welcome back', 'portal', 'existing user', 'auth', 'log on'
    ],
    antonymCluster: 'SIGN_UP',
    iconHints: ['login', 'sign-in', 'lock', 'key', 'user', 'enter', 'log-in'],
    hrefPatterns: ['login', 'signin', 'auth/login', 'portal', 'session/new']
  },
  SEARCH: {
    id: 'SEARCH',
    label: 'Search',
    synonyms: ['search', 'find', 'lookup', 'query', 'explore'],
    antonymCluster: null,
    iconHints: ['search', 'magnifying', 'glass', 'find', 'loupe', 'search-icon'],
    hrefPatterns: ['search', 'find', 'explore']
  },
  CART: {
    id: 'CART',
    label: 'Shopping Cart',
    synonyms: ['cart', 'basket', 'bag', 'checkout', 'my cart', 'shopping bag', 'view cart'],
    antonymCluster: null,
    iconHints: ['cart', 'shopping-cart', 'bag', 'basket', 'checkout'],
    hrefPatterns: ['cart', 'basket', 'bag', 'checkout']
  },
  MENU: {
    id: 'MENU',
    label: 'Navigation Menu',
    synonyms: ['menu', 'navigation', 'nav', 'hamburger', 'sidebar', 'drawer', 'more options'],
    antonymCluster: null,
    iconHints: ['menu', 'bars', 'hamburger', 'nav-icon', 'dots-vertical', 'more', 'drawer'],
    hrefPatterns: []
  },
  CLOSE: {
    id: 'CLOSE',
    label: 'Close / Dismiss',
    synonyms: ['close', 'dismiss', 'cancel', 'exit', 'cross', 'x'],
    antonymCluster: null,
    iconHints: ['close', 'times', 'cross', 'x', 'cancel', 'dismiss'],
    hrefPatterns: []
  }
};

/**
 * Normalizes text by removing non-standard unicode spaces, zero-width characters, and emojis
 */
function canonicalNormalize(str) {
  if (!str) return '';
  return String(str)
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, ' ')
    .replace(/[\u00AD\u200B\u200C\u200D]/g, '')
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * Strips all spaces, hyphens, and punctuation to create a continuous compact token
 * e.g. "sign   up" -> "signup", "s i g n - u p" -> "signup", "log-in" -> "login"
 */
function compactNormalize(str) {
  return canonicalNormalize(str).replace(/[\s\-_.\/\\:;,'"`!?()[\]{}]+/g, '');
}

/**
 * Identifies if a query matches a known high-level semantic intent cluster
 */
function detectSemanticCluster(query) {
  const norm = canonicalNormalize(query);
  const compact = compactNormalize(query);

  for (const [clusterKey, cluster] of Object.entries(SEMANTIC_CLUSTERS)) {
    for (const syn of cluster.synonyms) {
      if (norm === syn || compact === compactNormalize(syn)) {
        return clusterKey;
      }
    }
  }

  // Token level matching
  for (const [clusterKey, cluster] of Object.entries(SEMANTIC_CLUSTERS)) {
    for (const syn of cluster.synonyms) {
      if (norm.includes(syn) || compact.includes(compactNormalize(syn))) {
        return clusterKey;
      }
    }
  }

  return null;
}

/**
 * Builds the in-page client-side DOM evaluation script.
 * Returns an IIFE that traverses live DOM + Shadow DOM, scoring elements with
 * canonical compact matching, abstract shape detection, and semantic intent disambiguation.
 */
function buildDOMGroundingScript(targetQuery, options = {}) {
  const queryStr = JSON.stringify(targetQuery || '');
  const optionsStr = JSON.stringify(options || {});

  return `
    (() => {
      const rawQuery = ${queryStr};
      const opts = ${optionsStr};

      // In-page Canonical & Compact Normalizers
      function canonicalNormalize(str) {
        if (!str) return '';
        return String(str)
          .replace(/[\\u00A0\\u1680\\u2000-\\u200B\\u202F\\u205F\\u3000\\uFEFF]/g, ' ')
          .replace(/[\\u00AD\\u200B\\u200C\\u200D]/g, '')
          .replace(/[\\u{1F600}-\\u{1F64F}\\u{1F300}-\\u{1F5FF}\\u{1F680}-\\u{1F6FF}\\u{1F1E0}-\\u{1F1FF}\\u{2600}-\\u{26FF}\\u{2700}-\\u{27BF}\\u{FE00}-\\u{FE0F}]/gu, '')
          .toLowerCase()
          .trim();
      }

      function compactNormalize(str) {
        return canonicalNormalize(str).replace(/[\\s\\-_\\.\\/\\\\:;,'"\`!?()\\[\\]{}]+/g, '');
      }

      function stripSymbols(s) {
        if (!s) return '';
        return canonicalNormalize(s)
          .replace(/[^\\p{L}\\p{N}\\s]/gu, ' ')
          .replace(/\\s+/g, ' ')
          .trim();
      }

      const cleanQuery = stripSymbols(rawQuery);
      const compactQuery = compactNormalize(rawQuery);

      // Semantic Intent Engine inside Page Context
      const CLUSTERS = ${JSON.stringify(SEMANTIC_CLUSTERS)};

      function detectQueryIntent(q) {
        const norm = canonicalNormalize(q);
        const comp = compactNormalize(q);
        for (const [key, cl] of Object.entries(CLUSTERS)) {
          for (const s of cl.synonyms) {
            if (norm === s || comp === compactNormalize(s)) return key;
          }
        }
        for (const [key, cl] of Object.entries(CLUSTERS)) {
          for (const s of cl.synonyms) {
            if (norm.includes(s) || comp.includes(compactNormalize(s))) return key;
          }
        }
        return null;
      }

      const activeIntent = detectQueryIntent(rawQuery);

      // Stop words for multi-token fuzzy matching
      const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'for', 'in', 'on', 'at', 'to', 'from', 'by', 'with', 'link', 'website', 'page', 'site', 'button', 'click', 'open', 'tap', 'please', 'can', 'you']);
      const queryTokens = cleanQuery.split(/\\s+/).filter(t => !stopWords.has(t) && t.length > 1);

      // Recursive tree walker traversing standard DOM & Shadow DOM
      function getAllElements(root = document.body) {
        let elements = [];
        if (!root) return elements;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
        let node = walker.currentNode;
        while (node) {
          const style = window.getComputedStyle(node);
          if (style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
            const rect = node.getBoundingClientRect();
            if (rect.width > 2 && rect.height > 2) {
              elements.push(node);
            }
          }
          if (node.shadowRoot) {
            elements = elements.concat(getAllElements(node.shadowRoot));
          }
          node = walker.nextNode();
        }
        return elements;
      }

      let bestMatch = null;
      let highestScore = 0;
      let oppositeCandidate = null;
      let ambiguousCandidates = [];

      // Direct CSS selector check first
      if (/^[#\\.]?[a-zA-Z0-9_\\-\\[\\]="':*^~$]+$/.test(rawQuery)) {
        try {
          const el = document.querySelector(rawQuery);
          if (el) {
            const r = el.getBoundingClientRect();
            if (r.width > 2 && r.height > 2) {
              bestMatch = el;
              highestScore = 2000;
            }
          }
        } catch (_) {}
      }

      if (!bestMatch) {
        const all = getAllElements();

        for (const el of all) {
          let score = 0;

          // 1. Text representations
          const rawText = (el.innerText || el.textContent || '').trim();
          const cleanText = stripSymbols(rawText);
          const compactText = compactNormalize(rawText);

          // Form input values (e.g. <input type="submit" value="Sign Up">)
          const valueAttr = (el.value || el.getAttribute('value') || '').trim();
          const cleanValue = stripSymbols(valueAttr);
          const compactValue = compactNormalize(valueAttr);

          // 2. Accessibility & Meta attributes
          const title = (el.getAttribute('title') || '').trim();
          const cleanTitle = stripSymbols(title);
          const compactTitle = compactNormalize(title);

          const ariaLabel = (el.getAttribute('aria-label') || '').trim();
          const cleanAria = stripSymbols(ariaLabel);
          const compactAria = compactNormalize(ariaLabel);

          const ariaRoleDesc = (el.getAttribute('aria-roledescription') || '').trim();
          const cleanAriaDesc = stripSymbols(ariaRoleDesc);

          const placeholder = (el.getAttribute('placeholder') || '').trim();
          const cleanPlaceholder = stripSymbols(placeholder);
          const compactPlaceholder = compactNormalize(placeholder);

          const alt = (el.getAttribute('alt') || '').trim();
          const cleanAlt = stripSymbols(alt);
          const compactAlt = compactNormalize(alt);

          const role = (el.getAttribute('role') || '').toLowerCase();
          const href = (el.getAttribute('href') || el.src || '').toLowerCase();
          const id = (el.id || '').toLowerCase();
          const testid = (el.getAttribute('data-testid') || '').toLowerCase();
          const classStr = (typeof el.className === 'string' ? el.className : '').toLowerCase();

          // 3. Abstract Shape & SVG Icon Discovery
          let svgIconHint = '';
          const svgChild = el.tagName === 'SVG' ? el : el.querySelector('svg, i, span[class*="icon"], [class*="icon"]');
          if (svgChild) {
            const svgClass = (typeof svgChild.className === 'string' ? svgChild.className : '').toLowerCase();
            const svgName = (svgChild.getAttribute('data-icon') || svgChild.getAttribute('data-name') || '').toLowerCase();
            const svgUse = svgChild.querySelector('use');
            const useHref = (svgUse ? (svgUse.getAttribute('href') || svgUse.getAttribute('xlink:href') || '') : '').toLowerCase();
            const svgTitle = (svgChild.querySelector('title') ? svgChild.querySelector('title').textContent : '').toLowerCase();
            svgIconHint = [svgClass, svgName, useHref, svgTitle].join(' ');
          }

          // Combined descriptor string
          const combinedClean = [cleanText, cleanValue, cleanTitle, cleanAria, cleanPlaceholder, cleanAlt, href, id, testid, classStr, svgIconHint].join(' ');
          const combinedCompact = [compactText, compactValue, compactTitle, compactAria, compactPlaceholder, compactAlt].join(' ');

          // -------------------------------------------------------------
          // STEP A: Exact & Canonical Matching (Handles Accidental Spaces!)
          // -------------------------------------------------------------
          if (compactQuery && (compactText === compactQuery || compactValue === compactQuery || compactAria === compactQuery || compactTitle === compactQuery || compactAlt === compactQuery)) {
            score += 1500; // Exact compact match (e.g. "sign   up" matches "signup" or "Sign-Up")
          } else if (cleanText === cleanQuery || cleanValue === cleanQuery || cleanTitle === cleanQuery || cleanAria === cleanQuery) {
            score += 1200;
          }

          // Substring compact match
          if (compactQuery && compactQuery.length >= 3) {
            if (compactTitle.includes(compactQuery) || compactAria.includes(compactQuery)) {
              score += 700;
            } else if (compactText.includes(compactQuery) || compactValue.includes(compactQuery)) {
              score += 550;
            }
          }

          // -------------------------------------------------------------
          // STEP B: Semantic Intent Engine & Antonym Disambiguation
          // -------------------------------------------------------------
          if (activeIntent && CLUSTERS[activeIntent]) {
            const currentCluster = CLUSTERS[activeIntent];
            const antonymClusterKey = currentCluster.antonymCluster;
            const antonymCluster = antonymClusterKey ? CLUSTERS[antonymClusterKey] : null;

            // Check if element fulfills active intent synonyms
            for (const syn of currentCluster.synonyms) {
              const compSyn = compactNormalize(syn);
              if (combinedCompact.includes(compSyn) || combinedClean.includes(syn)) {
                score += 850; // Strong semantic synonym bonus!
                break;
              }
            }

            // Check if element matches icon hints for this intent
            for (const hint of currentCluster.iconHints) {
              if (svgIconHint.includes(hint) || classStr.includes(hint)) {
                score += 450;
                break;
              }
            }

            // Check href pattern matches (e.g. href="/signup")
            for (const pattern of currentCluster.hrefPatterns) {
              if (href.includes(pattern)) {
                score += 400;
                break;
              }
            }

            // ANTONYM PROTECTION: Check if element matches the OPPOSITE intent!
            if (antonymCluster) {
              let isAntonym = false;
              for (const ant of antonymCluster.synonyms) {
                const compAnt = compactNormalize(ant);
                if (compactText === compAnt || compactAria === compAnt || compactTitle === compAnt || cleanText === ant) {
                  isAntonym = true;
                  break;
                }
              }

              if (isAntonym) {
                // If user searched for "Sign Up", DO NOT click "Sign In" / "Log In"!
                score -= 2500;
                // Track as candidate for cross-questioning if nothing else found
                if (!oppositeCandidate || (rawText && rawText.length < 30)) {
                  oppositeCandidate = {
                    element: el,
                    label: rawText || ariaLabel || title || antonymCluster.label,
                    intent: antonymClusterKey,
                    requestedIntent: activeIntent
                  };
                }
              }
            }
          }

          // -------------------------------------------------------------
          // STEP C: Multi-Token Fuzzy Proximity Coverage
          // -------------------------------------------------------------
          if (queryTokens.length > 0) {
            let matched = 0;
            for (const tok of queryTokens) {
              if (combinedClean.includes(tok) || combinedCompact.includes(tok)) matched++;
            }
            const coverage = matched / queryTokens.length;
            if (coverage >= 0.99) {
              score += 400 + (queryTokens.length * 25);
            } else if (coverage >= 0.5) {
              score += 200 + (matched * 20);
            }
          }

          // Penalize indirect references / search metadata e.g. "X is also in this group"
          if (combinedClean.includes('is also in this') || combinedClean.includes('users also searched for')) {
            score -= 1000;
          }

          if (score <= 0) continue;

          // -------------------------------------------------------------
          // STEP D: Leaf-Level Specificity vs Giant Ancestor Penalty
          // -------------------------------------------------------------
          const targetLen = cleanQuery.length;
          const textLen = cleanText.length;
          if (textLen > 0) {
            const diff = Math.abs(textLen - targetLen);
            if (diff <= 5) {
              score += 450; // Leaf-level specificity bonus!
            } else if (diff <= 15) {
              score += 200;
            } else if (textLen > 160) {
              score -= 350; // Heavily penalize giant page container blocks
            }
          }

          // -------------------------------------------------------------
          // STEP E: Clickable Context Bonus
          // -------------------------------------------------------------
          const isClickable = el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT' ||
            role === 'button' || role === 'link' || role === 'tab' || role === 'menuitem' ||
            el.hasAttribute('tabindex') || window.getComputedStyle(el).cursor === 'pointer' || el.onclick != null;
          if (isClickable) {
            score += 150;
          }

          if (score > highestScore) {
            highestScore = score;
            bestMatch = el;
          }
        }
      }

      // Check if target was found
      if (!bestMatch || highestScore < 100) {
        // Evaluate Cross-Questioning Protocol!
        if (oppositeCandidate && activeIntent) {
          const reqLabel = CLUSTERS[activeIntent]?.label || activeIntent;
          const foundLabel = oppositeCandidate.label;
          return {
            found: false,
            highestScore,
            crossQuestion: 'I found "' + foundLabel + '" on this page, but you asked for ' + reqLabel + '. Would you like me to click "' + foundLabel + '", or look for another option?',
            candidate: foundLabel,
            reason: 'OPPOSITE_INTENT_DETECTED'
          };
        }

        return { found: false, highestScore, reason: 'ELEMENT_NOT_FOUND' };
      }

      // Target Located! Scroll into view and compute coordinates
      try {
        bestMatch.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
      } catch (_) {}

      // Resolve actionable container for dual dispatch
      const clickableContainer = bestMatch.closest('div[role="button"], button, a, [role="link"], div[role="row"], div[role="listitem"], [role="gridcell"][tabindex], [tabindex="0"]') || bestMatch;
      const innerActionable = clickableContainer.querySelector('[role="button"], [role="gridcell"][tabindex="0"], button, a') || clickableContainer;
      const targetRect = (innerActionable && innerActionable.getBoundingClientRect().width > 0)
        ? innerActionable.getBoundingClientRect()
        : ((clickableContainer && clickableContainer.getBoundingClientRect().width > 0)
          ? clickableContainer.getBoundingClientRect()
          : bestMatch.getBoundingClientRect());

      const x = Math.round(targetRect.left + targetRect.width / 2);
      const y = Math.round(targetRect.top + targetRect.height / 2);
      const label = (bestMatch.getAttribute('title') || bestMatch.getAttribute('aria-label') || bestMatch.innerText || bestMatch.tagName).slice(0, 40).replace(/\\n/g, ' ');

      // Chrome DevTools Telemetry Metadata
      const cs = window.getComputedStyle(bestMatch);
      const rawClasses = Array.from(bestMatch.classList || []).filter(c => !c.startsWith('__')).slice(0, 3).map(c => '.' + c).join('');
      const dims = Math.round(targetRect.width) + ' × ' + Math.round(targetRect.height);
      const role = bestMatch.getAttribute('role') || (
        ['a', 'button', 'input', 'select', 'textarea'].includes(bestMatch.tagName.toLowerCase()) ? bestMatch.tagName.toLowerCase() : 'generic'
      );

      return {
        found: true,
        x,
        y,
        width: Math.round(targetRect.width),
        height: Math.round(targetRect.height),
        tag: bestMatch.tagName.toLowerCase(),
        classes: rawClasses,
        dimensions: dims,
        role: role,
        name: label,
        highestScore,
        intentMatched: activeIntent
      };
    })()
  `;
}

module.exports = {
  SEMANTIC_CLUSTERS,
  canonicalNormalize,
  compactNormalize,
  detectSemanticCluster,
  buildDOMGroundingScript
};
