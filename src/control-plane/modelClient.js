const config = require('./config');
const { ActionType } = require('./protocol');

/**
 * Autonomous Model Client & Multi-Step LLM Function Calling Coordinator
 * Routes user intents to Groq (LPU accelerated), Mercury, or Local Model (Qwen 2.5 Coder / Llama 3.2)
 * to produce deterministic, structured JSON payloads for browser automation.
 */
class ModelClient {
  constructor() {
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
- "INPUT_TEXT": { "selector": "input or search box selector", "text": "text to type" }
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

Examples:
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

User: "scroll down"
Output:
{
  "thought": "Scroll down active page",
  "actions": [
    { "type": "SCROLL", "params": { "direction": "down", "amount": 450 } }
  ]
}

Do NOT wrap output in markdown fences. Output raw JSON object only.
`;
  }

  /**
   * Plan browser actions for a natural language command using Groq, Mercury, or Local model
   */
  async planActions(userInput, pageContext = {}) {
    let elementsInfo = '';
    if (Array.isArray(pageContext.buttons) && pageContext.buttons.length > 0) {
      elementsInfo += `\n- Visible Interactive Buttons: ${pageContext.buttons.join(', ')}`;
    }
    if (Array.isArray(pageContext.headings) && pageContext.headings.length > 0) {
      elementsInfo += `\n- Key Page Headings: ${pageContext.headings.join(' | ')}`;
    }

    const prompt = `
Current Active Page:
- URL: ${pageContext.url || 'adion://newtab'}
- Title: ${pageContext.title || 'New Tab'}${elementsInfo}

User Command: "${userInput}"

JSON Action Plan:
`;

    // 1. Try Groq Cloud (Ultra-Fast LPU Inference)
    if (this.groqKey) {
      try {
        console.log(`[ModelClient] Querying Groq Cloud (${this.groqModel})...`);
        const result = await this.queryGroq(prompt);
        if (result && result.actions && result.actions.length > 0) {
          console.log(`[ModelClient] Groq generated ${result.actions.length} action(s):`, result.thought);
          return result;
        }
      } catch (err) {
        console.warn('[ModelClient] Groq API call failed:', err.message);
      }
    }

    // 2. Try Mercury AI
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

    // 3. Try Local Model (Ollama / Qwen 2.5 Coder 3B / Llama 3.2 3B)
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
   * Query Groq Cloud chat completions
   */
  async queryGroq(prompt) {
    let res = null;
    try {
      res = await fetch(this.groqUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.groqKey}`
        },
        body: JSON.stringify({
          model: this.groqModel,
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: prompt }
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
          max_tokens: 600
        })
      });
    } catch (e) {
      // Network retry
    }

    // If HTTP 400 json_validate_failed or empty response, fallback to direct unconstrained JSON with gpt-oss-120b
    if (!res || !res.ok) {
      console.warn('[ModelClient] Retrying Groq with direct unconstrained JSON payload on 120b...');
      res = await fetch(this.groqUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.groqKey}`
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          messages: [
            { role: 'system', content: this.systemPrompt + '\nIMPORTANT: Respond with RAW JSON ONLY. No markdown.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.1,
          max_tokens: 600
        })
      });
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Groq API error ${res.status}: ${text}`);
    }

    const data = await res.json();
    const rawContent = data.choices?.[0]?.message?.content || '';
    return this.parseJSONResponse(rawContent);
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
      const text = await res.text();
      throw new Error(`Mercury API error ${res.status}: ${text}`);
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
