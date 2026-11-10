/**
 * Adion Browse - Abstract Base AI Model Provider
 */

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
   * Robust JSON response parser with markdown fence stripping
   */
  parseJSONResponse(rawContent) {
    if (!rawContent || typeof rawContent !== 'string') return null;

    let text = rawContent.trim();
    // Strip markdown fences
    text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/g, '').trim();

    try {
      return JSON.parse(text);
    } catch (_) {
      // Extract first valid JSON object substring
      const startIdx = text.indexOf('{');
      const endIdx = text.lastIndexOf('}');
      if (startIdx !== -1 && endIdx > startIdx) {
        try {
          const candidate = text.substring(startIdx, endIdx + 1);
          return JSON.parse(candidate);
        } catch (_) {}
      }
    }
    return null;
  }
}

module.exports = BaseProvider;
