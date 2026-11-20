/**
 * Adion Browse - Abstract Base AI Model Provider
 */

const { parsePlanResponse } = require('../actionPlan');
const { coalesceMessages } = require('../conversationWindow');

class BaseProvider {
  constructor(options = {}) {
    this.name = options.name || 'base';
    this.displayName = options.displayName || 'Base Provider';
    this.apiKey = options.apiKey || '';
    this.apiUrl = options.apiUrl || '';
    this.model = options.model || '';
    this.fetchFn = globalThis.fetch || (typeof require !== 'undefined' ? require('cross-fetch') : null);
  }

  isConfigured() {
    return Boolean(this.apiKey && this.apiUrl);
  }

  setApiKey(key) {
    this.apiKey = String(key || '').trim();
  }

  setModel(model) {
    this.model = String(model || '').trim();
  }

  setApiUrl(url) {
    this.apiUrl = String(url || '').trim();
  }

  /**
   * Plan browser actions using this provider
   * Subclasses must implement this.
   */
  async plan(prompt, systemPrompt, options = {}) {
    throw new Error(`Provider ${this.name} must implement plan() method`);
  }

  /**
   * Conversational chat completion without JSON action schemas.
   * Direct human-facing dialogue between user and assistant.
   * Default implementation supports standard OpenAI-compatible endpoints.
   */
  async chat(prompt, systemPrompt = 'You are Adion Copilot, the intelligent AI assistant in Adion Browse. Communicate directly, warmly, and helpfully with the user in natural language.', options = {}) {
    if (!this.isConfigured()) {
      throw new Error(`Provider ${this.displayName} is not configured`);
    }

    const modelToUse = options.model || this.model;
    const rawHistory = Array.isArray(options.history) ? options.history : [];
    const formattedHistory = rawHistory.map(h => {
      if (h.role && h.content) return h;
      return [
        h.user ? { role: 'user', content: h.user } : null,
        h.agent ? { role: 'assistant', content: h.agent } : null
      ].filter(Boolean);
    }).flat();

    const messages = [
      { role: 'system', content: systemPrompt },
      ...this.coalesceMessages(formattedHistory),
      { role: 'user', content: prompt }
    ];

    const payload = {
      model: modelToUse,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens || 1000
    };

    console.log(`[${this.displayName}] Conversational chat querying ${modelToUse}...`);

    const headers = {
      'Content-Type': 'application/json'
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const res = await this.fetchFn(this.apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`${this.displayName} chat error ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    const rawContent = data.choices?.[0]?.message?.content || data.response || '';
    return rawContent.trim();
  }

  /**
   * Merge consecutive same-role turns so the history stays valid for
   * providers that require strict user/assistant alternation.
   */
  coalesceMessages(messages) {
    return coalesceMessages(messages);
  }

  /**
   * OpenAI-style message list: system, prior conversation turns, current task.
   */
  conversationMessages(systemPrompt, prompt, history = []) {
    return [
      { role: 'system', content: systemPrompt + '\nRespond strictly with RAW JSON format. No markdown, no prose.' },
      ...this.coalesceMessages(history),
      { role: 'user', content: prompt }
    ];
  }

  /**
   * Flatten prior turns into text for single-prompt endpoints
   * (reasoning models, local completion endpoints).
   */
  historyTranscript(history = []) {
    const turns = this.coalesceMessages(history);
    if (turns.length === 0) return '(no earlier turns)';
    return turns.map(turn => `${turn.role === 'assistant' ? 'Assistant' : 'User'}: ${turn.content}`).join('\n');
  }

  /**
   * Robust JSON response parser with repair and plan normalization.
   */
  parseJSONResponse(rawContent) {
    return parsePlanResponse(rawContent);
  }
}

module.exports = BaseProvider;
