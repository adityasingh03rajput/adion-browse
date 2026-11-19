/**
 * Adion Browse - FreeModel Provider
 * Enables integration with FreeModel (freemodel.in) for cost-effective AI inference.
 */

const BaseProvider = require('./baseProvider');

class FreeModelProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      name: 'freemodel',
      displayName: options.displayName || 'FreeModel',
      apiKey: options.apiKey || process.env.FREEMODEL_API_KEY || '',
      apiUrl: options.apiUrl || process.env.FREEMODEL_API_URL || 'https://freemodel.in/v1',
      model: options.model || process.env.FREEMODEL_MODEL || 'deepseek-v4.1-flash'
    });
    this.pageUrl = options.pageUrl || 'https://freemodel.in';
  }

  isConfigured() {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  setPageUrl(url) {
    this.pageUrl = String(url || '').trim();
  }

  async plan(prompt, systemPrompt, options = {}) {
    if (!this.isConfigured()) {
      throw new Error('FreeModel API key is not configured');
    }

    const modelToUse = options.model || this.model || 'deepseek-v4.1-flash';
    const payload = {
      model: modelToUse,
      messages: this.conversationMessages(systemPrompt, prompt, options.history),
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 1400
    };

    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    let targetUrl = (this.apiUrl || '').trim();
    if (targetUrl && !targetUrl.endsWith('/chat/completions') && !targetUrl.endsWith('/completions')) {
      targetUrl = targetUrl.replace(/\/+$/, '') + '/chat/completions';
    }

    console.log(`[FreeModelProvider] Querying ${modelToUse} at ${targetUrl}...`);

    const res = await this.fetchFn(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`FreeModel API error ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    const rawContent = data.choices?.[0]?.message?.content || data.response || '';
    const parsed = this.parseJSONResponse(rawContent);

    if (!parsed || (!parsed.thought && !Array.isArray(parsed.actions))) {
      throw new Error(`FreeModel returned invalid plan schema: ${rawContent.slice(0, 100)}`);
    }

    if (!Array.isArray(parsed.actions)) {
      parsed.actions = [];
    }

    return parsed;
  }
}

module.exports = FreeModelProvider;
