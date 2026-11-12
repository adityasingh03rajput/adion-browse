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
