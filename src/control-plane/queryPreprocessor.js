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

    // 2. Direct platform query search: e.g. "search on google for music", "search youtube for cats"
    const googleQueryMatch = lower.match(/search\s+(?:on\s+)?google\s+for\s+(.+)/i);
    if (googleQueryMatch) {
      const q = googleQueryMatch[1].trim();
      return {
        type: ActionType.NAVIGATE,
        url: `https://www.google.com/search?q=${encodeURIComponent(q)}`,
        thought: `Search Google for "${q}"`
      };
    }

    // 3. General Search Queries: e.g. "search for wireless mouse", "search weather in tokyo"
    const generalSearchMatch = lower.match(/^(?:search\s+for|search)\s+(.+)$/i);
    if (generalSearchMatch) {
      const target = generalSearchMatch[1].trim();

      // Cognitive Query Guard: If the query involves reasoning, questions ("how to", "why", "what is"),
      // or domain-specific scoping ("in nomoney.in", "on reddit.com"), do NOT hijack with rigid regex.
      // Allow Tier 3 (Groq LLM) to apply true cognitive planning and domain understanding!
      const isCognitiveQuery = /^(?:how|why|what|when|where|who|explain|tell|is|can|should|which)\b/i.test(target) ||
        /\b(?:in|on|at|from)\s+[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/i.test(target) ||
        /\bsite:/i.test(target);
      if (isCognitiveQuery) {
        return null;
      }

      if (target === 'youtube' || target === 'youtube.com') {
        return { type: ActionType.NAVIGATE, url: 'https://www.youtube.com', thought: 'Navigate to https://www.youtube.com' };
      }
      // If user said domain name, navigate directly to that domain
      if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}/.test(target)) {
        return {
          type: ActionType.NAVIGATE,
          url: `https://${target}`,
          thought: `Navigate to https://${target}`
        };
      }
      return {
        type: ActionType.NAVIGATE,
        url: `https://search.brave.com/search?q=${encodeURIComponent(target)}`,
        thought: `Search for "${target}"`
      };
    }

    // 3.5. Local File Coreference ("open it", "view it", "show it")
    if (/^(?:open\s+(?:it|this|that|file)|show\s+(?:it|this)|view\s+(?:it|this))$/i.test(lower)) {
      if (pageContext && pageContext.lastReferencedFile) {
        const filePath = pageContext.lastReferencedFile;
        const fileUrl = filePath.startsWith('file://') ? filePath : `file:///${filePath.replace(/\\/g, '/')}`;
        return {
          type: ActionType.NAVIGATE,
          url: fileUrl,
          thought: `Open local file in browser: ${filePath}`
        };
      }
    }

    // 3.5. Local File Coreference ("open it", "view it", "show it")
    if (/^(?:open\s+(?:it|this|that|file)|show\s+(?:it|this)|view\s+(?:it|this))$/i.test(lower)) {
      if (pageContext && pageContext.lastReferencedFile) {
        const filePath = pageContext.lastReferencedFile;
        const fileUrl = filePath.startsWith('file://') ? filePath : `file:///${filePath.replace(/\\/g, '/')}`;
        return {
          type: ActionType.NAVIGATE,
          url: fileUrl,
          thought: `Open local file in browser: ${filePath}`
        };
      }
    }

    // 4. Standard URL / Domain Navigation: "navigate to example.com", "open github.com"
    const navMatch = lower.match(/(?:navigate\s+to|go\s+to|open)\s+(?:the\s+)?([a-z0-9\.\-_:\/]+)(?:\s+(?:website|page|site|homepage))?$/i);
    if (navMatch && !/(console|network|tab|history|bookmark)/i.test(navMatch[1])) {
      let target = navMatch[1].trim();
      const isCoreference = /^(?:it|this|that|them|one|first|second|third|last|next|previous|link|result|tab|item|video|article|page)$/i.test(target);

      // Do NOT hijack conversational pronouns/coreferences (e.g. "open it", "open this") into literal Brave search queries
      if (!isCoreference) {
        let url = target;
        if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://') && !url.startsWith('adion://')) {
          if (target === 'youtube' || target === 'youtube.com' || target === 'www.youtube.com') {
            url = 'https://www.youtube.com';
          } else if (target === 'whatsapp' || target === 'whatsapp.com' || target === 'web.whatsapp.com') {
            url = 'https://web.whatsapp.com';
          } else if (target === 'chatgpt' || target === 'chatgpt.com') {
            url = 'https://chatgpt.com';
          } else if (target === 'github' || target === 'github.com') {
            url = 'https://github.com';
          } else if (target === 'google' || target === 'google.com') {
            url = 'https://www.google.com';
          } else if (target === 'reddit' || target === 'reddit.com') {
            url = 'https://reddit.com';
          } else if (target === 'twitter' || target === 'x' || target === 'x.com' || target === 'twitter.com') {
            url = 'https://x.com';
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
    }

    // D. Context-Aware WhatsApp Contact Messaging & Direct Dispatch
    const isWhatsAppContext = (pageContext && pageContext.url && pageContext.url.includes('whatsapp.com')) || 
      /(?:on|in|via)\s+whatsapp/i.test(lower) || 
      /(?:hidden|locked)\s+chat|secret\s+code|passcode|lock\s+code|\bpin\s+is\b/i.test(lower);

    if (isWhatsAppContext) {
      let cleaned = lower.trim().replace(/\s+(?:on|in|via)\s+whatsapp(?:\s*[\.\?!])?$/i, '');
      cleaned = cleaned.replace(/[\.\?!]+$/, '').trim();

      // Extract secret code / passcode / PIN if specified (e.g. "secret code of hidden chat is 1512", "passcode is 1234", "with secret code 1512")
      let secretCode = null;
      const secretCodeRegex = /(?:,|and|\s+with|\s+using)?\s*(?:the\s+)?(?:secret\s+code|passcode|pin|lock\s+code|hidden\s+(?:chat\s+)?code|locked\s+(?:chat\s+)?code|code|password)(?:\s+(?:of|for)\s+(?:the\s+)?(?:hidden|locked)?\s*(?:chat|folder|conversation))?\s*(?:is|:|=)?\s*([a-zA-Z0-9_\-]+)/i;
      const secretMatch = cleaned.match(secretCodeRegex);
      if (secretMatch) {
        secretCode = secretMatch[1].trim();
        cleaned = cleaned.replace(secretMatch[0], '').trim();
      }

      let contact = null;
      let msg = null;

      // 1. "say/send/tell/text/message/write/type <message> to <contact>"
      const mTo = cleaned.match(/^(?:say|send(?:\s+a)?(?:\s+message)?|tell|text|message|write|type)\s+(.+?)\s+to\s+(.+)$/i);
      if (mTo) {
        msg = mTo[1].trim();
        contact = mTo[2].trim();
        if (msg === 'message' || msg === 'a message') {
          const parts = contact.split(/\s+/);
          contact = parts[0];
          msg = parts.slice(1).join(' ');
        }
      } else {
        // 2. "say/send/tell to <contact> <message>"
        const mSayTo = cleaned.match(/^(?:say|send|tell|write|type)\s+to\s+([a-zA-Z0-9_\+\-]+)\s+(.+)$/i);
        if (mSayTo) {
          contact = mSayTo[1].trim();
          msg = mSayTo[2].trim();
        } else {
          // 3. "text/message/tell <contact> <message>"
          const mVerb = cleaned.match(/^(?:text|message|tell)\s+([a-zA-Z0-9_\+\-]+)\s+(.+)$/i);
          if (mVerb) {
            contact = mVerb[1].trim();
            msg = mVerb[2].trim();
          }
        }
      }

      if (contact && msg) {
        // Strip conversational lead-ins like "saying" or "that"
        msg = msg.replace(/^(saying|that)\s+/i, '').trim().replace(/^["']|["']$/g, '');
        contact = contact.replace(/^["']|["']$/g, '');
        const cleanPhone = contact.replace(/[^0-9]/g, '');
        const isNumericPhone = cleanPhone.length >= 7 && cleanPhone.length <= 15 && !/[a-zA-Z]/.test(contact);

        // Clean msg from any leftover punctuation or connectors
        msg = msg.replace(/^[,;:\s]+|[,;:\s]+$/g, '').trim();

        // If numeric phone and not on WhatsApp Web, use WHATSAPP_SEND direct link
        if (isNumericPhone && (!pageContext?.url || !pageContext.url.includes('whatsapp.com')) && !secretCode) {
          return {
            type: 'WHATSAPP_SEND',
            phone: cleanPhone,
            contact: contact,
            message: msg,
            url: `https://web.whatsapp.com/send/?phone=${cleanPhone}&text=${encodeURIComponent(msg)}`,
            thought: `Send WhatsApp message "${msg}" to +${cleanPhone}`
          };
        }

        // Context-aware or named contact search on WhatsApp Web (supports hidden/locked chats with secret code)
        return {
          type: 'WHATSAPP_CHAT_SEND',
          contact: contact,
          phone: isNumericPhone ? cleanPhone : null,
          message: msg,
          secretCode: secretCode || null,
          thought: secretCode
            ? `Search for hidden contact "${contact}" using secret code "${secretCode}" in WhatsApp and send "${msg}"`
            : `Search for contact "${contact}" in WhatsApp and send "${msg}"`
        };
      }

      // Unread messages workflow on WhatsApp Web
      if (/(?:open|click|view|show|check|read)\s+(?:the\s+)?(?:first\s+|next\s+|another\s+)?unread\s+(?:messages?|chats?)/i.test(lower) || /unread\s+messages?/i.test(lower)) {
        return {
          type: 'WHATSAPP_UNREAD_CLICK',
          thought: 'Click on the first chat with unread messages on WhatsApp Web'
        };
      }

      // Hide / Dismiss notification banner on WhatsApp Web
      if (/(?:hide|close|dismiss|remove)\s+(?:the\s+)?(?:message\s+and\s+call\s+)?notification\s*(?:pop\s*up|banner|bar|alert)?/i.test(lower)) {
        return {
          type: ActionType.MODIFY_DOM,
          selector: 'message and call notification',
          action: 'hide',
          value: 'none',
          thought: 'Hide the message and call notification pop-up on WhatsApp Web'
        };
      }
    }

    // E. Standalone Local PC Terminal Bridge & Computer Use Commands
    const terminalMatch = text.match(/^(?:\/terminal\s+|terminal:\s*|run\s+(?:local\s+|pc\s+)?(?:terminal\s+|system\s+)?command:\s*|exec:\s*)(.+)$/i);
    if (terminalMatch) {
      const command = terminalMatch[1].trim();
      return {
        type: ActionType.TERMINAL_EXEC,
        command,
        thought: `Execute local terminal command: ${command}`
      };
    }

    // Computer Use Slash Commands: /pc, /computer, /workspace
    const computerUseMatch = text.match(/^(?:\/pc\s+|\/computer\s+|\/workspace\s+)(.+)$/i);
    if (computerUseMatch) {
      const sub = computerUseMatch[1].trim();
      // If direct CLI command invocation, fast-path execute in <0.5ms
      const isDirectShellCmd = /^(?:dir|ls|git|npm|npx|node|python|py|pip|echo|cat|curl|cd|powershell|Get-|Set-|pnpm|yarn|docker|code|which|where|findstr|grep|hostname|whoami|tasklist|netstat|ipconfig|ifconfig|cls|clear)\b/i.test(sub);
      if (isDirectShellCmd) {
        return {
          type: ActionType.TERMINAL_EXEC,
          command: sub,
          thought: `Computer Use (PC): Execute \`${sub}\``
        };
      }

      // Check for file creation commands (e.g. "D:\\Jarvis create aditya.html saying hello", "create aditya.html saying hello")
      let targetDir = null;
      let targetFile = null;
      let targetContent = '';

      // Pattern 1: Directory + create file + content (e.g. "D:\\Jarvis create aditya.html saying hello")
      const m1 = sub.match(/^(?:in\s+)?([a-zA-Z]:[\\\/][^\s]*)\s+(?:create|make|write)\s+(?:file\s+)?([^\s]+)(?:\s+(?:saying|with\s+(?:content|text)?)\s+(.+))?$/i);
      if (m1) {
        targetDir = m1[1];
        targetFile = m1[2];
        targetContent = (m1[3] || '').trim();
      } else {
        // Pattern 2: Absolute file path in create (e.g. "create D:\\Jarvis\\aditya.html saying hello")
        const m2 = sub.match(/^(?:create|make|write)\s+(?:file\s+)?([a-zA-Z]:[\\\/][^\s]+)(?:\s+(?:saying|with\s+(?:content|text)?)\s+(.+))?$/i);
        if (m2) {
          const full = m2[1];
          const lastSlash = Math.max(full.lastIndexOf('\\'), full.lastIndexOf('/'));
          targetDir = full.slice(0, lastSlash);
          targetFile = full.slice(lastSlash + 1);
          targetContent = (m2[2] || '').trim();
        } else {
          // Pattern 3: Relative file path in create (e.g. "create aditya.html saying hello")
          const m3 = sub.match(/^(?:create|make|write)\s+(?:file\s+)?([a-zA-Z0-9_\-\.\/]+)(?:\s+(?:saying|with\s+(?:content|text)?)\s+(.+))?$/i);
          if (m3 && !/^(?:folder|directory|dir|branch|tab|window)$/i.test(m3[1])) {
            targetFile = m3[1];
            targetContent = (m3[2] || '').trim();
          }
        }
      }

      if (targetFile) {
        const fullTarget = targetDir ? `${targetDir.replace(/[\\\/]$/, '')}\\${targetFile}` : targetFile;
        let cleanContent = targetContent.replace(/^["']|["']$/g, '');
        if (fullTarget.endsWith('.html') && !cleanContent.includes('<') && cleanContent) {
          cleanContent = `<!DOCTYPE html>\n<html>\n<head><title>${targetFile}</title></head>\n<body>\n<h1>${cleanContent}</h1>\n</body>\n</html>`;
        }

        const psCmd = targetDir
          ? `if (!(Test-Path "${targetDir}")) { New-Item -ItemType Directory -Force -Path "${targetDir}" | Out-Null }; Set-Content -Path "${fullTarget}" -Value @"\n${cleanContent}\n"@; if (Test-Path "${fullTarget}") { Write-Output "Successfully created: ${fullTarget}" } else { Write-Error "Failed to create: ${fullTarget}" }`
          : `Set-Content -Path "${fullTarget}" -Value @"\n${cleanContent}\n"@; if (Test-Path "${fullTarget}") { Write-Output "Successfully created: ${fullTarget}" } else { Write-Error "Failed to create: ${fullTarget}" }`;

        return {
          type: ActionType.TERMINAL_EXEC,
          command: psCmd,
          targetFile: fullTarget,
          thought: `Created ${fullTarget} on local PC`
        };
      }

      // Higher-level natural language instructions flow to Cognitive Goal Planner
      return null;
    }

    // F. Browser Tabs & History (including "shut down this", "close this tab")
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

    // H. Live Inspect & Click Fast-Path: e.g. "click on it 2017 imdb website", "can you click on it 2017 imdb website", "click Mummy", "inspect and click Mummy"
    const clickMatch = lower.match(/^(?:please\s+)?(?:can\s+you\s+)?(?:use\s+(?:the\s+)?inspect\s+tool\s+to\s+click|inspect\s+and\s+click|click\s+on|click|tap\s+on|tap)\s+(?:the\s+)?(.+?)$/i);
    if (clickMatch) {
      const rawTarget = clickMatch[1].replace(/[\?\!\.,]+$/, '').trim();
      const isBareCoreference = /^(?:it|this|that|them|one)$/i.test(rawTarget);
      if (rawTarget && !isBareCoreference) {
        return {
          type: ActionType.CLICK_SELECTOR,
          target: rawTarget,
          thought: `Inspect and click element matching "${rawTarget}"`
        };
      }
    }

    // I. Conversational Courtesy & Ambient Speech Fast-Path (STRICT STANDALONE CHECK ONLY)
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
