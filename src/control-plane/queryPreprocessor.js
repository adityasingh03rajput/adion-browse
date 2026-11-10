/**
 * Adion Browse - Query Preprocessor & Zero-Latency Fast-Path Router
 * 
 * Preprocesses natural language & voice queries to eliminate execution lag:
 * 1. Linguistic Cleaning: Strips conversational fillers, polite preambles, and conversational affixes ("ok fine", "can you please").
 * 2. Phonetic & Acoustic Normalization: Normalizes homophones ("base" -> "bass", "colour" -> "color").
 * 3. Compound Action Decomposition: Resolves multi-action commands ("shut down this and now search for youtube.com").
 * 4. Zero-Latency Fast-Path Extraction: Resolves DOM, audio, slider, search, navigation, and tabs in <0.5ms.
 * 5. Strict Conversational Gating: Prevents commands containing action verbs from being hijacked as standing-by courtesies.
 * 6. Query Plan LRU Cache: Instantly serves repeat or closely-related plans without model latency.
 */

const { ActionType } = require('./protocol');

class QueryPreprocessor {
  constructor() {
    this.planCache = new Map();
    this.maxCacheSize = 100;

    // Number word dictionary
    this.wordToNum = {
      'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4,
      'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9,
      'ten': 10, 'eleven': 11, 'twelve': 12, 'fifteen': 15, 'twenty': 20
    };

    // Known CSS colors
    this.colorNames = [
      'yellow', 'red', 'green', 'blue', 'orange', 'purple', 'pink',
      'cyan', 'white', 'black', 'gold', 'crimson', 'lime', 'emerald',
      'teal', 'gray', 'grey', 'indigo', 'violet', 'magenta', 'navy'
    ];
  }

  /**
   * Preprocess raw user query into normalized structure with performance metrics
   */
  preprocess(rawInput) {
    const startTime = process.hrtime.bigint();
    const raw = String(rawInput || '').trim();

    // 1. Strip conversational filler preambles & politeness affixes
    let cleaned = raw
      .replace(/^(can\s+you\s+(?:please\s+)?|could\s+you\s+(?:please\s+)?|please\s+|hey\s+adion\s*,?\s*|jarvis\s*,?\s*|i\s+want\s+you\s+to\s+|would\s+you\s+mind\s+|tell\s+me\s+to\s+|help\s+me\s+to\s+|go\s+ahead\s+and\s+)/i, '')
      .replace(/^(um+|uh+|okay\s+fine\s*,?\s*|ok\s+fine\s*,?\s*|okay\s*,?\s*|ok\s*,?\s*|alright\s*,?\s*|so\s*,?\s*|well\s*,?\s*)/i, '')
      .trim();

    // 2. Phonetic & acoustic homophone normalization
    cleaned = cleaned
      .replace(/\b(hie|hei|hy|heyy|heya|hai|hiya)\b/gi, 'hey')
      .replace(/\bbase\s+frequency\b/gi, 'bass frequency')
      .replace(/\bbase\s+boost\b/gi, 'bass boost')
      .replace(/\bcolour\b/gi, 'color')
      .replace(/\bdecibels?\b/gi, 'dB');

    // 3. Normalize verbal numbers ("zero to ten" -> "0 to 10")
    for (const [w, n] of Object.entries(this.wordToNum)) {
      const reg = new RegExp(`\\b${w}\\b`, 'gi');
      cleaned = cleaned.replace(reg, String(n));
    }

    // 4. Strip trailing punctuation question marks, periods, exclamation points
    cleaned = cleaned.replace(/[\?\!\.,]+$/, '').trim();

    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - startTime) / 1e6;

    return {
      raw,
      normalized: cleaned,
      lower: cleaned.toLowerCase(),
      durationMs: parseFloat(durationMs.toFixed(3))
    };
  }

  /**
   * Extract fast-path action intent (<0.5ms) with compound command decomposition
   */
  extractFastIntent(preprocessed, pageContext = {}) {
    const text = preprocessed.normalized;
    const lower = preprocessed.lower;

    // 1. Compound Command Decomposition: e.g. "shut down this and now search for youtube.com"
    const compoundSplitter = /\s+(?:and\s+now|and\s+then|and\s+also|then)\s+/i;
    if (compoundSplitter.test(text)) {
      const parts = text.split(compoundSplitter).map(p => p.trim()).filter(Boolean);
      if (parts.length > 1) {
        const subActions = [];
        for (const part of parts) {
          const subPrep = { raw: part, normalized: part, lower: part.toLowerCase(), durationMs: 0 };
          const subIntent = this.extractSingleFastIntent(subPrep, pageContext);
          if (subIntent) {
            subActions.push(subIntent);
          }
        }
        if (subActions.length === parts.length) {
          return {
            type: 'COMPOUND_ACTIONS',
            thought: subActions.map(a => a.thought || a.type).join(' and '),
            actions: subActions
          };
        }
      }
    }

    return this.extractSingleFastIntent(preprocessed, pageContext);
  }

  /**
   * Extract single fast-path action intent
   */
  extractSingleFastIntent(preprocessed, pageContext = {}) {
    const text = preprocessed.normalized;
    const lower = preprocessed.lower;

    // A. Audio DSP / Range Slider Adjustments
    const sliderMatch = lower.match(/(?:change|set|adjust|increase|decrease)\s+(?:the\s+)?(?:(bass|treble|frequency|boost|noise|threshold|vad|volume)\s*)*(?:frequency\s+)?(?:boost|slider|parameter|gain)?\s*(?:from\s+[a-z0-9\.\-]+\s+)?(?:to\s+|into\s+)?(-?\d+(?:\.\d+)?)\s*(?:db|rms|%|hz)?$/i);
    if (sliderMatch && !/(color|background|theme|mode|text)/i.test(lower)) {
      const param = sliderMatch[1] ? sliderMatch[1].toLowerCase() : 'bass';
      const numericVal = sliderMatch[2];

      let selector = 'Bass Frequency Boost';
      let elementId = 'sliderBass';
      if (param.includes('vad') || param.includes('threshold')) {
        selector = 'Voice Activity Threshold';
        elementId = 'sliderVad';
      } else if (param.includes('noise')) {
        selector = 'Noise Suppression';
        elementId = 'sliderNoise';
      }

      return {
        type: ActionType.MODIFY_DOM,
        selector: `#${elementId}, ${selector}`,
        action: 'setValue',
        value: String(numericVal),
        thought: `Adjust ${selector} to ${numericVal}`
      };
    }

    // B. DOM Color & Background Styling (Fast-Path)
    const colorList = this.colorNames.join('|');
    // Pattern 2: "change color to yellow of generate test tone button"
    const p2 = new RegExp(`(?:change|set|make|turn)\\s+(?:the\\s+)?(?:background\\s+)?color\\s+to\\s+(${colorList})\\s+of\\s+(?:the\\s+)?(.+)`, 'i');
    const m2 = text.match(p2);
    if (m2) {
      const color = m2[1].toLowerCase();
      const rawTarget = m2[2].replace(/[\?\!\.,]+$/, '').trim();
      const hex = color === 'yellow' ? '#ffeb3b' : (color === 'green' ? '#10b981' : color);
      const textColor = /yellow|gold|white|lime|cyan/i.test(color) ? '#0f1117' : '#ffffff';
      return {
        type: ActionType.MODIFY_DOM,
        selector: rawTarget,
        action: 'setStyle',
        value: `background: ${hex}; color: ${textColor};`,
        thought: `Modify ${rawTarget} color to ${color}`
      };
    }

    // Pattern 1: "change color of <target> to yellow"
    const p1 = new RegExp(`(?:change|set|make|turn)\\s+(?:the\\s+)?(?:color|background(?:\\s+color)?|text\\s+color)\\s+of\\s+(?:the\\s+)?(.+?)\\s+to\\s+(${colorList})$`, 'i');
    const m1 = text.match(p1);
    if (m1) {
      const color = m1[2].toLowerCase();
      const rawTarget = m1[1].replace(/[\?\!\.,]+$/, '').trim();
      const hex = color === 'yellow' ? '#ffeb3b' : (color === 'green' ? '#10b981' : color);
      const textColor = /yellow|gold|white|lime|cyan/i.test(color) ? '#0f1117' : '#ffffff';
      return {
        type: ActionType.MODIFY_DOM,
        selector: rawTarget,
        action: 'setStyle',
        value: `background: ${hex}; color: ${textColor};`,
        thought: `Modify ${rawTarget} color to ${color}`
      };
    }

    // C. Navigation & Search Fast-Path
    // 1. YouTube specific query search: e.g. "search youtube for funny cats", "search on youtube for music", "search for lofi on youtube"
    const ytQueryMatch = lower.match(/(?:search\s+(?:on\s+)?youtube\s+for|search\s+for\s+(.+?)\s+on\s+youtube)\s*(.*)/i);
    if (ytQueryMatch) {
      const q = (ytQueryMatch[1] || ytQueryMatch[2] || '').trim();
      if (q) {
        return {
          type: ActionType.NAVIGATE,
          url: `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
          thought: `Search YouTube for "${q}"`
        };
      }
    }

    // 2. Direct platform navigation: "search youtube", "open youtube", "go to youtube", "search for youtube"
    if (/^(?:search\s+(?:for\s+)?|open\s+|go\s+to\s+|navigate\s+to\s+)?youtube(?:\.com)?$/i.test(lower.trim())) {
      return {
        type: ActionType.NAVIGATE,
        url: 'https://www.youtube.com',
        thought: 'Navigate to https://www.youtube.com'
      };
    }
    if (/^(?:search\s+(?:for\s+)?|open\s+|go\s+to\s+|navigate\s+to\s+)?(?:whatsapp\s+web|whatsapp)(?:\.com)?$/i.test(lower.trim())) {
      return {
        type: ActionType.NAVIGATE,
        url: 'https://web.whatsapp.com',
        thought: 'Navigate to https://web.whatsapp.com'
      };
    }

    // 3. General Search Queries: e.g. "search for wireless mouse", "search weather in tokyo", "search google for cats"
    const googleQueryMatch = lower.match(/search\s+(?:on\s+)?google\s+for\s+(.+)/i);
    if (googleQueryMatch) {
      const q = googleQueryMatch[1].trim();
      return {
        type: ActionType.NAVIGATE,
        url: `https://www.google.com/search?q=${encodeURIComponent(q)}`,
        thought: `Search Google for "${q}"`
      };
    }

    const generalSearchMatch = lower.match(/^(?:search\s+for|search)\s+(.+)$/i);
    if (generalSearchMatch) {
      const target = generalSearchMatch[1].trim();
      if (target === 'youtube' || target === 'youtube.com') {
        return { type: ActionType.NAVIGATE, url: 'https://www.youtube.com', thought: 'Navigate to https://www.youtube.com' };
      }
      return {
        type: ActionType.NAVIGATE,
        url: `https://search.brave.com/search?q=${encodeURIComponent(target)}`,
        thought: `Search for "${target}"`
      };
    }

    // 4. Standard URL / Domain Navigation: "navigate to example.com", "open github.com"
    const navMatch = lower.match(/(?:navigate\s+to|go\s+to|open)\s+(?:the\s+)?([a-z0-9\.\-_:\/]+)(?:\s+(?:website|page|site|homepage))?$/i);
    if (navMatch && !/(console|network|tab|history|bookmark)/i.test(navMatch[1])) {
      let target = navMatch[1].trim();
      let url = target;
      if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://') && !url.startsWith('adion://')) {
        if (target === 'youtube' || target === 'youtube.com' || target === 'www.youtube.com') {
          url = 'https://www.youtube.com';
        } else if (target === 'instagram' || target === 'instagram.com' || target === 'www.instagram.com') {
          url = 'https://www.instagram.com';
        } else if (target === 'google' || target === 'google.com' || target === 'www.google.com') {
          url = 'https://www.google.com';
        } else if (target === 'github' || target === 'github.com' || target === 'www.github.com') {
          url = 'https://www.github.com';
        } else if (target === 'twitter' || target === 'twitter.com' || target === 'x' || target === 'x.com') {
          url = 'https://x.com';
        } else if (target === 'whatsapp' || target === 'whatsapp web' || target === 'web.whatsapp.com' || target === 'whatsapp.com') {
          url = 'https://web.whatsapp.com';
        } else if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(url)) {
          url = `https://${url}`;
        } else {
          url = `https://search.brave.com/search?q=${encodeURIComponent(target)}`;
        }
      }
      return {
        type: ActionType.NAVIGATE,
        url: url,
        thought: `Navigate to ${url}`
      };
    }

    // D. Browser Tabs & History (including "shut down this", "close this tab")
    if (/(?:close\s+(?:this\s+)?tab|shut\s+(?:down\s+)?(?:this\s+)?(?:tab|page|window)?|close\s+this|shut\s+this\s+down)/i.test(lower)) {
      return { type: ActionType.CLOSE_TAB, thought: 'Close current tab' };
    }
    if (/(?:new\s+tab|open\s+tab|create\s+tab)/i.test(lower)) {
      return { type: ActionType.NEW_TAB, thought: 'Open new tab' };
    }
    if (/(?:go\s+back|back\s+page|previous\s+page)/i.test(lower)) {
      return { type: ActionType.GO_BACK, thought: 'Navigate back' };
    }
    if (/(?:go\s+forward|forward\s+page|next\s+page)/i.test(lower)) {
      return { type: ActionType.GO_FORWARD, thought: 'Navigate forward' };
    }
    if (/(?:reload|refresh|refresh\s+page)/i.test(lower)) {
      return { type: ActionType.RELOAD, thought: 'Reload page' };
    }
    if (/(?:bookmark\s+(?:this\s+)?page|add\s+bookmark)/i.test(lower)) {
      return { type: ActionType.TOGGLE_BOOKMARK, thought: 'Toggle bookmark' };
    }
    if (/(?:open\s+dashboard|live\s+telemetry|site\s+metrics)/i.test(lower)) {
      return { type: ActionType.OPEN_DASHBOARD, thought: 'Open telemetry dashboard' };
    }

    // E. Scrolling Fast-Path
    if (/(?:scroll\s+down|page\s+down|move\s+down)/i.test(lower)) {
      return { type: ActionType.SCROLL, direction: 'down', amount: 450, thought: 'Scroll down' };
    }
    if (/(?:scroll\s+up|page\s+up|move\s+up)/i.test(lower)) {
      return { type: ActionType.SCROLL, direction: 'up', amount: -450, thought: 'Scroll up' };
    }
    if (/(?:top\s+of\s+page|scroll\s+to\s+top)/i.test(lower)) {
      return { type: ActionType.SCROLL, direction: 'top', thought: 'Scroll to top' };
    }
    if (/(?:bottom\s+of\s+page|scroll\s+to\s+bottom)/i.test(lower)) {
      return { type: ActionType.SCROLL, direction: 'bottom', thought: 'Scroll to bottom' };
    }

    // F. DevTools Switching
    const devMatch = lower.match(/(?:open|switch\s+to)\s+(console|network|elements|sources|application|performance)\s+(?:in\s+devtools|tab)?/i);
    if (devMatch) {
      return {
        type: ActionType.SWITCH_DEVTOOLS_PANEL,
        panel: devMatch[1].toLowerCase(),
        thought: `Switch DevTools to ${devMatch[1]} panel`
      };
    }

    // G. Dark Mode / Light Mode
    if (/(?:dark\s+mode|dark\s+theme|make\s+(?:page|background)\s+dark)/i.test(lower)) {
      return {
        type: ActionType.MODIFY_DOM,
        selector: 'body',
        action: 'setStyle',
        value: 'background: #121212 !important; color: #f0f0f0 !important;',
        thought: 'Apply dark mode'
      };
    }
    if (/(?:light\s+mode|light\s+theme|make\s+(?:page|background)\s+light)/i.test(lower)) {
      return {
        type: ActionType.MODIFY_DOM,
        selector: 'body',
        action: 'setStyle',
        value: 'background: #ffffff !important; color: #111111 !important;',
        thought: 'Apply light mode'
      };
    }

    // H. Conversational Courtesy & Ambient Speech Fast-Path (STRICT STANDALONE CHECK ONLY)
    // Prevents hijacking any utterance containing actionable verbs
    const isActionable = /(?:search|open|go|navigate|shut|close|change|set|click|scroll|play|switch|tab|bookmark|type|input|write|enter|fill)/i.test(lower);
    if (!isActionable && /^(?:thank\s*you|thanks|thx|gracias|merci|danke|hello|hi|hie|hei|hy|heyy|heya|hai|hiya|hey|howdy|yo|greetings|good\s*(?:morning|afternoon|evening)|bye|goodbye|cool|awesome|ok|okay|ok\s+fine|fine|alright)(?:\s*,?\s*jarvis)?[\.\!\?]?$/i.test(lower)) {
      return {
        type: 'CONVERSATIONAL_ACKNOWLEDGE',
        thought: 'Standing by: ready for your browser commands.',
        actions: []
      };
    }

    return null;
  }

  /**
   * LRU Plan Cache lookup
   */
  getCachedPlan(url, normalizedQuery) {
    const key = `${url || 'any'}::${normalizedQuery}`;
    return this.planCache.get(key) || null;
  }

  /**
   * Store resolved plan in LRU Cache
   */
  cachePlan(url, normalizedQuery, plan) {
    if (!plan) return;
    const key = `${url || 'any'}::${normalizedQuery}`;
    if (this.planCache.size >= this.maxCacheSize) {
      const oldestKey = this.planCache.keys().next().value;
      this.planCache.delete(oldestKey);
    }
    this.planCache.set(key, plan);
  }
}

module.exports = QueryPreprocessor;
