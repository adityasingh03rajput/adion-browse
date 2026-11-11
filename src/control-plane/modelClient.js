const config = require('./config');
const { ActionType } = require('./protocol');
const ProviderRegistry = require('./providers/providerRegistry');

/**
 * Autonomous Model Client & Multi-Step LLM Function Calling Coordinator
 * Routes user intents to 3rd-party models (ChatGPT, Claude, Gemini/Antigravity, Custom)
 * or zero-cost Groq models to produce deterministic, structured JSON payloads for browser automation.
 */
class ModelClient {
  constructor() {
    this.registry = new ProviderRegistry(config);

    this.groqKey = config.groqApiKey;
    this.groqUrl = config.groqApiUrl;
    this.groqModel = config.groqModel;

    this.mercuryKey = config.mercuryApiKey;
    this.mercuryUrl = config.mercuryApiUrl;
    this.mercuryModel = config.mercuryModel;

    this.localEndpoint = config.localModelEndpoint;

    this.systemPrompt = `
You are the Autonomous Browser Execution Coordinator for Adion Browse.
Your job is to translate user natural language instructions and voice commands into a deterministic sequence of executable browser actions.

You MUST respond strictly with a valid JSON object matching this schema:
{
  "thought": "Brief 1-sentence reasoning",
  "actions": [
    {
      "type": "<ACTION_TYPE>",
      "params": { ... }
    }
  ]
}

Available Action Types and their parameters:
- "NAVIGATE": { "url": "https://example.com" } or { "query": "search term" }
- "NEW_TAB": { "url": "https://example.com" }
- "CLOSE_TAB": {}
- "GO_BACK": {}
- "GO_FORWARD": {}
- "RELOAD": {}
- "SCROLL": { "direction": "down" | "up" | "top" | "bottom", "amount": 450 }
- "CLICK_SELECTOR": { "target": "button label, link text, or selector" }
- "INPUT_TEXT": { "selector": "input or search box selector", "text": "text to type" } - ONLY use when user explicitly commands typing/inputting text (e.g. "type Hello", "input query in search box"). Conversational remarks, greetings (e.g. 'hi', 'hie', 'hello', 'hey'), or ambient words must NEVER trigger INPUT_TEXT.
- "TOGGLE_DEVTOOLS": {} - opens/toggles developer tools (the code <> button on top right)
- "SWITCH_TAB": { "target": "Wikipedia" | 1 | "tab_id" } - switches to matching tab by title, index, or query
- "DEVTOOLS_SWITCH_PANEL": { "panel": "console" | "elements" | "network" | "sources" | "application" } - switches between panel tabs in Developer Tools
- "FOCUS_PAGE": {} - focuses the active webpage content
- "FOCUS_DEVTOOLS": {} - focuses the Developer Tools console/window
- "OPEN_SETTINGS": {} - opens browser settings (the gear icon)
- "OPEN_HISTORY": {} - opens browsing history
- "OPEN_BOOKMARKS": {} - opens bookmarks
- "TOGGLE_BOOKMARK": {} - bookmarks or unbookmarks the current page (star/bookmark button)
- "OPEN_DASHBOARD": {} - opens the real-time Network Diagnostics, Latency Graph & Resource Allocation Dashboard (adion://dashboard)
- "SHOW_METRICS_OVERLAY": {} - displays the live telemetry overlay GUI with real-time performance logs and actionable suggestions
- "MODIFY_DOM": { "selector": "CSS selector or semantic query (e.g. 'Google Search button', 'header', 'h1', 'body', '#main', '.btn')", "action": "setStyle" | "setText" | "setHTML" | "setAttribute" | "hide" | "remove", "value": "value or style declaration" } - dynamically manipulates elements across ANY loaded web page or local file with real-time render verification
- "INSPECT_ELEMENT": { "selector": "CSS selector or element description" } - locates, highlights, and inspects element in Developer Tools
- "CAPTURE_VIEWPORT": {}
- "ANALYZE_IMAGES": { "criteria": "image search criteria" }
- "PLAY_VIDEO_FROM_THUMBNAIL": { "query": "video topic or thumbnail description" } - provisions zero-cost vision models (Qwen-VL / Groq Vision Free Tier) to analyze YouTube thumbnails and initiate playback
- "WHATSAPP_CHAT_SEND": { "contact": "contact name or phone number", "message": "message content", "secretCode": "optional secret code or PIN to unlock hidden or locked chat" } - Automatically searches WhatsApp Web for the specified contact name or number (unlocking hidden/locked chats with secretCode if provided), opens their chat, types the message, and sends it. Use this whenever the user intends to message, text, or say something to a contact on WhatsApp.
- "WHATSAPP_UNREAD_CLICK": {} - Automatically finds and clicks the first or next chat with unread messages on WhatsApp Web to open unseen messages.
- "PAGE_ANALYSIS_OR_QA": When the user asks a question about the shared active page (e.g. "explain...", "summarize this page", "what does this say about X", "compare X to Y"), synthesize a direct, helpful, and insightful response from the Shared Page Content in the "thought" field and return an empty actions array ([]).

Examples:
User: "Explain Adion's MCP server functionality"
Output:
{
  "thought": "Adion Browse features an embedded Model Context Protocol (MCP) server operating on port 9224 via HTTP / SSE. This allows AI assistants and developer agents to programmatically query DOM nodes, retrieve active tab states, and dispatch browser automation workflows directly.",
  "actions": []
}
User: "play the first video about space exploration" or "click on the video with thumbnail showing Mars"
Output:
{
  "thought": "Route vision task to Qwen-VL to identify and play matching video thumbnail",
  "actions": [
    { "type": "PLAY_VIDEO_FROM_THUMBNAIL", "params": { "query": "space exploration Mars" } }
  ]
}
User: "Tell Aiden browse to switch to a dashboard or overlay GUI that displays live requested data clearly. After updating the interface, run a test query to verify the new display format."
Output:
{
  "thought": "Open live telemetry dashboard and display structured performance metrics",
  "actions": [
    { "type": "OPEN_DASHBOARD", "params": {} },
    { "type": "SHOW_METRICS_OVERLAY", "params": {} }
  ]
}

User: "Change the color of the Google search button to yellow" or "make the search button yellow"
Output:
{
  "thought": "Dynamically modify search button color on active page",
  "actions": [
    { "type": "MODIFY_DOM", "params": { "selector": "Google Search button", "action": "setStyle", "value": "background: yellow; color: #000;" } }
  ]
}

User: "Make the Wikipedia header green" or "change title color to green"
Output:
{
  "thought": "Modify header text color on active page",
  "actions": [
    { "type": "MODIFY_DOM", "params": { "selector": "header, #firstHeading, h1", "action": "setStyle", "value": "color: #10b981;" } }
  ]
}

User: "Hide the sidebar" or "remove the banner"
Output:
{
  "thought": "Hide target element on active page",
  "actions": [
    { "type": "MODIFY_DOM", "params": { "selector": "sidebar, aside", "action": "hide", "value": "" } }
  ]
}

User: "Make the page background dark" or "turn on dark mode"
Output:
{
  "thought": "Apply dark theme styling to page body",
  "actions": [
    { "type": "MODIFY_DOM", "params": { "selector": "body", "action": "setStyle", "value": "background: #121212 !important; color: #f0f0f0 !important;" } }
  ]
}

User: "Change the login button text to Continue"
Output:
{
  "thought": "Change button text on active page",
  "actions": [
    { "type": "MODIFY_DOM", "params": { "selector": "Sign in button", "action": "setText", "value": "Continue" } }
  ]
}

User: "change the base frequency boost from zero to 10 decibels" or "set bass boost to 10 db"
Output:
{
  "thought": "Update bass frequency boost slider and display value to 10 dB",
  "actions": [
    { "type": "MODIFY_DOM", "params": { "selector": "#sliderBass, Bass Frequency Boost", "action": "setValue", "value": "10" } }
  ]
}

User: "Please change the color of the generate test tone." or "change test tone button color to green"
Output:
{
  "thought": "Change generate test tone button background color to green",
  "actions": [
    { "type": "MODIFY_DOM", "params": { "selector": "#btnTogglePlayback", "action": "setStyle", "value": "background: #10b981; color: #fff;" } }
  ]
}

Examples:
User: "Bookmark this page" or "add bookmark"
Output:
{
  "thought": "Bookmark current active page",
  "actions": [
    { "type": "TOGGLE_BOOKMARK", "params": {} }
  ]
}

User: "Switch to console in developer tools" or "open network tab in devtools"
Output:
{
  "thought": "Switch Developer Tools panel tab",
  "actions": [
    { "type": "DEVTOOLS_SWITCH_PANEL", "params": { "panel": "console" } }
  ]
}

User: "Switch tab to Wikipedia"
Output:
{
  "thought": "Switch active tab to Wikipedia",
  "actions": [
    { "type": "SWITCH_TAB", "params": { "target": "Wikipedia" } }
  ]
}

User: "Tap on the developer tools button" or "click on the code button"
Output:
{
  "thought": "Toggle Developer Tools console",
  "actions": [
    { "type": "TOGGLE_DEVTOOLS", "params": {} }
  ]
}

User: "Click on the shorts button"
Output:
{
  "thought": "Click on Shorts button in navigation",
  "actions": [
    { "type": "CLICK_SELECTOR", "params": { "target": "Shorts" } }
  ]
}

User: "open youtube and search for lofi music"
Output:
{
  "thought": "Open YouTube and query for lofi music",
  "actions": [
    { "type": "NAVIGATE", "params": { "url": "https://www.youtube.com/results?search_query=lofi+music" } }
  ]
}

User: "text hi to 9424831233 in whatsapp" or "say thankyou to safal in whatsapp"
Output:
{
  "thought": "Search for contact or number on WhatsApp Web, open conversation, type and send message",
  "actions": [
    { "type": "WHATSAPP_CHAT_SEND", "params": { "contact": "9424831233", "message": "hi" } }
  ]
}

User: "text pidduk i love you , secret code of hidden chat is 1512"
Output:
{
  "thought": "Unlock hidden chat with secret code 1512, open conversation with pidduk, type and send 'i love you'",
  "actions": [
    { "type": "WHATSAPP_CHAT_SEND", "params": { "contact": "pidduk", "message": "i love you", "secretCode": "1512" } }
  ]
}

User: "open unread message in whatsapp" or "check unread messages"
Output:
{
  "thought": "Open first chat with unread messages on WhatsApp Web",
  "actions": [
    { "type": "WHATSAPP_UNREAD_CLICK", "params": {} }
  ]
}

User: "scroll down"
Output:
{
  "thought": "Scroll down active page",
  "actions": [
    { "type": "SCROLL", "params": { "direction": "down", "amount": 450 } }
  ]
}

User: "hie" or "hello" or "hey jarvis"
Output:
{
  "thought": "Greetings! Standing by for your browser commands.",
  "actions": []
}

CRITICAL RULE: Conversational remarks, greetings (e.g. 'hi', 'hie', 'hello', 'hey', 'jarvis'), courtesies, or ambient words must NEVER trigger INPUT_TEXT or type into search boxes. If the user is greeting or speaking conversationally without commanding an action, return actions: [] with a courteous thought.

Do NOT wrap output in markdown fences. Output raw JSON object only.
`;
  }

  /**
   * Plan browser actions for a natural language command using Groq, Mercury, or Local model
   */
  async planActions(userInput, pageContext = {}, conversationHistory = []) {
    let elementsInfo = '';
    if (Array.isArray(pageContext.buttons) && pageContext.buttons.length > 0) {
      elementsInfo += `\n- Visible Interactive Buttons: ${pageContext.buttons.join(', ')}`;
    }
    if (Array.isArray(pageContext.headings) && pageContext.headings.length > 0) {
      elementsInfo += `\n- Key Page Headings: ${pageContext.headings.join(' | ')}`;
    }
    if (pageContext.lastDOMSelector) {
      elementsInfo += `\n- Recently Modified Element: ${pageContext.lastDOMSelector}`;
    }
    if (pageContext.pageText && pageContext.isShared !== false) {
      elementsInfo += `\n- Shared Page Content (Active Page):\n${pageContext.pageText.slice(0, 3000)}`;
    }

    let historySection = '';
    if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
      historySection = '\nRecent Conversation History:\n' +
        conversationHistory.map((item, idx) => {
          const u = item.user || item.rawPrompt || item.transcription || '';
          const a = item.agent || item.feedback || item.thought || '';
          return `Turn ${idx + 1}:\n- User: "${u}"\n- Agent: ${a}`;
        }).join('\n') + '\n';
    }

    const prompt = `
Current Active Page:
- URL: ${pageContext.url || 'adion://newtab'}
- Title: ${pageContext.title || 'New Tab'}${elementsInfo}
${historySection}
User Command: "${userInput}"

Conversational Instruction:
- Maintain conversational memory across turns. When the user says "it", "this", "that", "them", "open it", "click it", or asks a follow-up, resolve the reference using the Recent Conversation History and Current Active Page.
- Never output generic search queries for pronouns like "it". Instead, target the specific item, search result, link, or entity discussed.

JSON Action Plan:
`;

    // 1. Try Active Model Provider (OpenAI ChatGPT, Anthropic Claude, Gemini, Custom, or Groq)
    const activeProvider = this.registry ? this.registry.getActiveProvider() : null;
    if (activeProvider && activeProvider.isConfigured()) {
      try {
        console.log(`[ModelClient] Querying active provider: ${activeProvider.displayName} (${activeProvider.model})...`);
        const result = await activeProvider.plan(prompt, this.systemPrompt);
        if (result && (Array.isArray(result.actions) || result.thought)) {
          if (!Array.isArray(result.actions)) result.actions = [];
          if (result.actions.length > 0) {
            console.log(`[ModelClient] ${activeProvider.displayName} generated ${result.actions.length} action(s):`, result.thought);
          } else {
            console.log(`[ModelClient] ${activeProvider.displayName} conversational evaluation:`, result.thought);
          }
          return result;
        }
      } catch (err) {
        console.warn(`[ModelClient] Active provider "${activeProvider.name}" notice:`, err.message);
      }
    }

    // 2. Direct Groq Cloud Fallback (Ultra-Fast LPU Inference)
    if (this.groqKey) {
      try {
        console.log(`[ModelClient] Querying Groq Cloud (${this.groqModel})...`);
        const result = await this.queryGroq(prompt);
        if (result && (Array.isArray(result.actions) || result.thought)) {
          if (!Array.isArray(result.actions)) result.actions = [];
          if (result.actions.length > 0) {
            console.log(`[ModelClient] Groq generated ${result.actions.length} action(s):`, result.thought);
          } else {
            console.log(`[ModelClient] Groq conversational evaluation:`, result.thought);
          }
          return result;
        }
      } catch (err) {
        console.warn('[ModelClient] Groq API notice:', err.message);
      }
    }

    // 3. Try Mercury AI
    if (this.mercuryKey) {
      try {
        console.log(`[ModelClient] Querying Mercury AI (${this.mercuryModel})...`);
        const result = await this.queryMercury(prompt);
        if (result && result.actions && result.actions.length > 0) {
          console.log(`[ModelClient] Mercury generated ${result.actions.length} action(s):`, result.thought);
          return result;
        }
      } catch (err) {
        console.warn('[ModelClient] Mercury API call failed:', err.message);
      }
    }

    // 4. Try Local Model (Ollama / Qwen 2.5 Coder 3B / Llama 3.2 3B)
    try {
      const localResult = await this.queryLocalModel(prompt);
      if (localResult && localResult.actions && localResult.actions.length > 0) {
        console.log('[ModelClient] Local Model generated actions:', localResult.thought);
        return localResult;
      }
    } catch (e) {
      // Local model not running
    }

    return null;
  }

  /**
   * Set active AI provider (openai, anthropic, gemini, custom, groq, auto)
   */
  setActiveProvider(name) {
    return this.registry.setActiveProvider(name);
  }

  /**
   * Get active AI provider instance
   */
  getActiveProvider() {
    return this.registry.getActiveProvider();
  }

  /**
   * List all registered providers and their status
   */
  listProviders() {
    return this.registry.listProviders();
  }

  /**
   * Dynamically configure credentials for a provider
   */
  configureProvider(name, config) {
    return this.registry.configureProvider(name, config);
  }

  /**
   * Resilient Groq Cloud query with exponential backoff, jitter, and zero-cost model failover
   * Gracefully handles 503 (Service Unavailable), 429 (Rate Limit), 502/504 (Bad Gateway), 404 (Missing model), and network errors.
   */
  async queryGroq(prompt) {
    // Validated zero-cost models available on the active Groq account
    const zeroCostModelCandidates = [
      this.groqModel || 'openai/gpt-oss-120b',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'qwen/qwen3.8-27b',
      'allam-2-7b'
    ].filter((m, idx, arr) => arr.indexOf(m) === idx);

    const maxRetries = zeroCostModelCandidates.length;
    const baseDelayMs = 400;
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const candidateModel = zeroCostModelCandidates[attempt % zeroCostModelCandidates.length];

      try {
        const payload = {
          model: candidateModel,
          messages: [
            { role: 'system', content: this.systemPrompt + '\nRespond strictly with RAW JSON format. No markdown, no prose.' },
            { role: 'user', content: prompt }
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
          max_tokens: 650
        };

        let res = await fetch(this.groqUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.groqKey}`
          },
          body: JSON.stringify(payload)
        }).catch(err => {
          lastError = err;
          return null;
        });

        // If response is valid and HTTP 200 OK
        if (res && res.ok) {
          const data = await res.json();
          const rawContent = data.choices?.[0]?.message?.content || '';
          const parsed = this.parseJSONResponse(rawContent);
          if (parsed && (Array.isArray(parsed.actions) || parsed.thought)) {
            if (!Array.isArray(parsed.actions)) parsed.actions = [];
            return parsed;
          }
        }

        // Retryable conditions: 503, 429, 502, 504, 404 (unsupported model on key), or network timeout (0)
        const status = res ? res.status : 0;
        const isRetryable = status === 503 || status === 429 || status === 502 || status === 504 || status === 404 || status === 0;

        if (res && !res.ok) {
          const errBody = await res.text().catch(() => '');
          lastError = new Error(`Groq API error ${status} on model ${candidateModel}: ${errBody.slice(0, 140)}`);

          // If HTTP 400 schema constraint issue, try once unconstrained
          if (status === 400 && attempt === 0) {
            delete payload.response_format;
            const unconstrainedRes = await fetch(this.groqUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.groqKey}`
              },
              body: JSON.stringify(payload)
            }).catch(() => null);

            if (unconstrainedRes && unconstrainedRes.ok) {
              const data = await unconstrainedRes.json();
              const rawContent = data.choices?.[0]?.message?.content || '';
              const parsed = this.parseJSONResponse(rawContent);
              if (parsed && Array.isArray(parsed.actions) && parsed.actions.length > 0) {
                return parsed;
              }
            }
          }
        }

        if (!isRetryable && status !== 0) {
          // If permanent client error other than 404/429 (e.g. 401 unauthorized), break
          break;
        }
      } catch (err) {
        lastError = err;
      }

      if (attempt < maxRetries - 1) {
        // Exponential backoff with jitter (minimal delay on 404 model failover)
        const expDelay = baseDelayMs * Math.pow(1.8, attempt);
        const jitter = Math.random() * 200;
        const totalDelay = Math.min(expDelay + jitter, 2500);

        const nextModel = zeroCostModelCandidates[(attempt + 1) % zeroCostModelCandidates.length];
        console.warn(`[ModelClient Backoff] Groq retryable condition on ${candidateModel}. Failover to verified model: ${nextModel} in ${Math.round(totalDelay)}ms...`);
        await new Promise(r => setTimeout(r, totalDelay));
      }
    }

    throw lastError || new Error('Max retries exceeded for Groq API');
  }

  /**
   * Query Mercury AI chat completions
   */
  async queryMercury(prompt) {
    const res = await fetch(this.mercuryUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.mercuryKey}`
      },
      body: JSON.stringify({
        model: this.mercuryModel,
        messages: [
          { role: 'system', content: this.systemPrompt },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: 600
      })
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const cleanSummary = res.status === 503 ? 'Service Temporarily Unavailable' : text.replace(/<[^>]*>/g, '').trim().slice(0, 80);
      throw new Error(`Mercury HTTP ${res.status}: ${cleanSummary}`);
    }

    const data = await res.json();
    const rawContent = data.choices?.[0]?.message?.content || '';
    return this.parseJSONResponse(rawContent);
  }

  /**
   * Query Local Ollama (Qwen 2.5 Coder 3B / Llama 3.2 3B)
   */
  async queryLocalModel(prompt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);

    try {
      const res = await fetch(this.localEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen2.5-coder:3b',
          prompt: `${this.systemPrompt}\n\n${prompt}`,
          stream: false,
          format: 'json'
        }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (res.ok) {
        const json = await res.json();
        return this.parseJSONResponse(json.response || '');
      }
    } catch (e) {
      clearTimeout(timer);
    }
    return null;
  }

  /**
   * Extract, sanitize and normalize JSON action schema from model output
   */
  parseJSONResponse(raw) {
    if (!raw || typeof raw !== 'string') return null;

    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(json)?\n?/, '').replace(/\n?```$/, '');
    }

    let parsed = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch (err) {}
      }
    }

    if (!parsed || !Array.isArray(parsed.actions)) return null;

    // Normalize action shapes
    const normalizedActions = parsed.actions.map(act => {
      let rawType = (act.type || act.action || '').toUpperCase();
      if (rawType === 'TYPE' || rawType === 'INPUT') rawType = 'INPUT_TEXT';
      if (rawType === 'CLICK' || rawType === 'TAP') rawType = 'CLICK_SELECTOR';
      if (rawType === 'PRESS' && act.key === 'Enter') rawType = 'SCROLL'; // safe fallback

      const params = act.params || {
        url: act.url,
        query: act.query,
        direction: act.direction,
        amount: act.amount,
        target: act.target || act.selector,
        selector: act.selector,
        text: act.text
      };

      return {
        type: rawType,
        params
      };
    }).filter(act => !!act.type);

    return {
      thought: parsed.thought || 'Executing browser command',
      actions: normalizedActions
    };
  }
}

module.exports = ModelClient;
