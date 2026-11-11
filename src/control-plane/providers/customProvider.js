/**
 * Adion Browse - Custom / OpenAI-Compatible 3rd-Party Provider
 * Enables integration with any custom OpenAI-compatible endpoint:
 * DeepSeek, OpenRouter, Together AI, Perplexity, local Ollama / vLLM, etc.
 */

const BaseProvider = require('./baseProvider');

class CustomProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      name: 'custom',
      displayName: options.displayName || 'Custom OpenAI-Compatible Endpoint',
      apiKey: options.apiKey || process.env.CUSTOM_API_KEY || '',
      apiUrl: options.apiUrl || process.env.CUSTOM_API_URL || '',
      model: options.model || process.env.CUSTOM_MODEL || 'default'
    });
  }

  isConfigured() {
    return Boolean(this.apiUrl && this.apiUrl.trim().length > 0);
  }

  async plan(prompt, systemPrompt, options = {}) {
    if (!this.isConfigured()) {
      throw new Error('Custom API endpoint URL is not configured');
    }

    const modelToUse = options.model || this.model || 'default';
    const payload = {
      model: modelToUse,
      messages: [
        { role: 'system', content: systemPrompt + '\nRespond strictly with RAW JSON format. No markdown, no prose.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 800
    };

    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    let targetUrl = (this.apiUrl || '').trim();
    if (targetUrl && !targetUrl.endsWith('/chat/completions') && !targetUrl.endsWith('/completions')) {
      targetUrl = targetUrl.replace(/\/+$/, '') + '/chat/completions';
    }

    console.log(`[CustomProvider] Querying ${modelToUse} at ${targetUrl}...`);

    const res = await this.fetchFn(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Custom API endpoint error ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    const rawContent = data.choices?.[0]?.message?.content || data.response || '';
    const parsed = this.parseJSONResponse(rawContent);

    if (!parsed || (!parsed.thought && !Array.isArray(parsed.actions))) {
      throw new Error(`Custom endpoint returned invalid plan schema: ${rawContent.slice(0, 100)}`);
    }

    if (!Array.isArray(parsed.actions)) {
      parsed.actions = [];
    }

    return parsed;
  }
}

module.exports = CustomProvider;

