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

    this.systemPrompt = `You are the Autonomous Browser Execution Coordinator for Adion Browse.
Translate user natural language instructions into executable browser actions.
Respond strictly in RAW JSON format matching this schema:
{
  "thought": "Brief reasoning or conversational reply",
  "actions": [
    {
      "type": "<ACTION_TYPE>",
      "params": { ... }
    }
  ]
}

Available Action Types and Parameters:
- "NAVIGATE": { "url": "https://..." } or { "query": "search query" }
- "NEW_TAB": { "url": "https://..." }
- "CLOSE_TAB": {}
- "GO_BACK": {} | "GO_FORWARD": {} | "RELOAD": {}
- "SCROLL": { "direction": "down" | "up" | "top" | "bottom", "amount": 450 }
- "CLICK_SELECTOR": { "target": "button text, link text, or selector" }
- "INPUT_TEXT": { "selector": "selector", "text": "text" } (ONLY if user explicitly commands typing; NEVER for greetings)
- "TOGGLE_DEVTOOLS": {} | "FOCUS_PAGE": {} | "FOCUS_DEVTOOLS": {}
- "DEVTOOLS_SWITCH_PANEL": { "panel": "console" | "elements" | "network" | "sources" | "application" }
- "SWITCH_TAB": { "target": "tab title, domain, or index" }
- "OPEN_SETTINGS": {} | "OPEN_HISTORY": {} | "OPEN_BOOKMARKS": {} | "TOGGLE_BOOKMARK": {}
- "OPEN_DASHBOARD": {} | "SHOW_METRICS_OVERLAY": {}
- "MODIFY_DOM": { "selector": "CSS selector or description", "action": "setStyle" | "setText" | "setValue" | "hide", "value": "value or style" }
- "INSPECT_ELEMENT": { "selector": "CSS selector or description" }
- "WHATSAPP_CHAT_SEND": { "contact": "name or phone number", "message": "message text", "secretCode": "optional PIN or unlock code" }
- "WHATSAPP_UNREAD_CLICK": {}
- "PLAY_VIDEO_FROM_THUMBNAIL": { "query": "video topic or thumbnail description" }
- "PAGE_ANALYSIS_OR_QA": Synthesize direct helpful answer in "thought", "actions": []

Key Instructions:
1. AI-First Decision Making: Always interpret user intent thoughtfully based on the active page and conversation history.
2. Greetings & Courtesies: For greetings (hi, hello, hie, hey, thanks, standing by), return actions: [] with a friendly thought. NEVER trigger INPUT_TEXT.
3. WhatsApp Web: When messaging a contact on WhatsApp, use WHATSAPP_CHAT_SEND. If a secret code or PIN is provided, put it in secretCode and keep message clean.
4. Site Search: If user says "search X in Y.com", NAVIGATE to the site or search query scoped to that site.
5. Absolute Integrity: Never emit fake completions or fake actions.
6. Output raw JSON object only. No markdown fences.`;
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
