/**
 * Adion Browse - Query Preprocessor & Zero-Latency Fast-Path Router
 * 
 * Preprocesses natural language & voice queries to eliminate execution lag:
 * 1. Linguistic Cleaning: Strips conversational fillers, polite preambles, and speech artifacts.
 * 2. Phonetic & Acoustic Normalization: Normalizes homophones ("base" -> "bass", "colour" -> "color").
 * 3. Number Stemming: Converts verbal numbers ("zero to ten" -> "0 to 10").
 * 4. Zero-Latency Fast-Path Extraction: Resolves DOM, audio, slider, and browser actions in <0.5ms.
 * 5. Query Plan LRU Cache: Instantly serves repeat or closely-related plans without model latency.
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
      .replace(/^(um+|uh+|okay\s*,?\s*|so\s*,?\s*)/i, '')
      .trim();

    // 2. Phonetic & acoustic homophone normalization
    cleaned = cleaned
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
   * Extract fast-path action intent (<0.5ms) without waiting for remote LLM inference
   */
  extractFastIntent(preprocessed, pageContext = {}) {
    const text = preprocessed.normalized;
    const lower = preprocessed.lower;

    // A. Audio DSP / Range Slider Adjustments
    // e.g. "change color to yellow of generate test tone button", "change bass frequency boost from 0 to 10 dB"
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
    // Pattern 1: "change color of <target> to <color>"
    // Pattern 2: "change the color to <color> of <target>" (e.g. "change the color to yellow of generate test tone button")
    for (const color of this.colorNames) {
      // Pattern 2: "change color to yellow of generate test tone button"
      const p2 = new RegExp(`(?:change|set|make|turn)\\s+(?:the\\s+)?(?:background\\s+)?color\\s+to\\s+${color}\\s+of\\s+(?:the\\s+)?(.+)`, 'i');
      const m2 = text.match(p2);
      if (m2) {
        const rawTarget = m2[1].replace(/[\?\!\.,]+$/, '').trim();
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
      const p1 = new RegExp(`(?:change|set|make|turn)\\s+(?:the\\s+)?(?:color|background(?:\\s+color)?|text\\s+color)\\s+of\\s+(?:the\\s+)?(.+?)\\s+to\\s+${color}$`, 'i');
      const m1 = text.match(p1);
      if (m1) {
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
    }

    // C. Dark Mode / Light Mode
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

    // D. Static Text Editing
    const textMatch = text.match(/(?:change|set|update)\s+(?:the\s+)?text\s+of\s+(?:the\s+)?(.+?)\s+to\s+["']?(.+?)["']?$/i);
    if (textMatch) {
      return {
        type: ActionType.MODIFY_DOM,
        selector: textMatch[1].trim(),
        action: 'setText',
        value: textMatch[2].trim(),
        thought: `Change text of ${textMatch[1].trim()} to "${textMatch[2].trim()}"`
      };
    }

    // E. Navigation & Scrolling Fast-Path
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

    // F. Browser Tabs & History
    if (/(?:go\s+back|back\s+page|previous\s+page)/i.test(lower)) {
      return { type: ActionType.GO_BACK, thought: 'Navigate back' };
    }
    if (/(?:go\s+forward|forward\s+page|next\s+page)/i.test(lower)) {
      return { type: ActionType.GO_FORWARD, thought: 'Navigate forward' };
    }
    if (/(?:reload|refresh|refresh\s+page)/i.test(lower)) {
      return { type: ActionType.RELOAD, thought: 'Reload page' };
    }
    if (/(?:close\s+(?:this\s+)?tab|shut\s+tab)/i.test(lower)) {
      return { type: ActionType.CLOSE_TAB, thought: 'Close tab' };
    }
    if (/(?:bookmark\s+(?:this\s+)?page|add\s+bookmark)/i.test(lower)) {
      return { type: ActionType.TOGGLE_BOOKMARK, thought: 'Toggle bookmark' };
    }
    if (/(?:open\s+dashboard|live\s+telemetry|site\s+metrics)/i.test(lower)) {
      return { type: ActionType.OPEN_DASHBOARD, thought: 'Open telemetry dashboard' };
    }

    // G. DevTools Switching
    const devMatch = lower.match(/(?:open|switch\s+to)\s+(console|network|elements|sources|application|performance)\s+(?:in\s+devtools|tab)?/i);
    if (devMatch) {
      return {
        type: ActionType.SWITCH_DEVTOOLS_PANEL,
        panel: devMatch[1].toLowerCase(),
        thought: `Switch DevTools to ${devMatch[1]} panel`
      };
    }

    // H. Conversational Courtesy & Ambient Speech Fast-Path
    // Gracefully handles conversational speech, thanks, greetings, and video outro audio without API failure
    if (/(?:thank\s*you|thanks|thx|gracias|merci|danke|hello|hi|hey|good\s*(morning|afternoon|evening)|bye|goodbye|cool|awesome|ok|okay)/i.test(lower)) {
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
