/**
 * Adion Browse - Mercury AI Provider (Inception Labs)
 * Ultra low-latency diffusion-based LLM with 1M context window and reasoning tokens.
 */

const BaseProvider = require('./baseProvider');

class MercuryProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      name: 'mercury',
      displayName: options.displayName || 'Mercury AI (Inception Labs)',
      apiKey: options.apiKey || process.env.MERCURY_API_KEY || '',
      apiUrl: options.apiUrl || process.env.MERCURY_API_URL || 'https://api.inceptionlabs.ai/v1/chat/completions',
      model: options.model || process.env.MERCURY_MODEL || 'mercury-3'
    });
    this.supportedModels = ['mercury-3', 'mercury-decide'];
  }

  isConfigured() {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  async plan(prompt, systemPrompt, options = {}) {
    if (!this.isConfigured()) {
      throw new Error('Mercury API key is not configured');
    }

    const modelToUse = options.model || this.model || 'mercury-3';
    let targetUrl = (this.apiUrl || '').trim();
    if (targetUrl && !targetUrl.endsWith('/chat/completions') && !targetUrl.endsWith('/completions')) {
      targetUrl = targetUrl.replace(/\/+$/, '') + '/chat/completions';
    }

    let maxTokens = options.max_tokens || parseInt(process.env.MERCURY_MAX_TOKENS, 10) || 4096;

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`
    };

    console.log(`[MercuryProvider] Querying ${modelToUse} at ${targetUrl} (max_tokens: ${maxTokens})...`);

    let res = await this.fetchFn(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelToUse,
        messages: this.conversationMessages(systemPrompt, prompt, options.history),
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: maxTokens
      })
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Mercury API error ${res.status}: ${errBody.slice(0, 120)}`);
    }

    let data = await res.json();
    let choice = data.choices?.[0];

    // If truncated due to max_tokens limit while reasoning, retry with extended budget
    if (choice?.finish_reason === 'length' && maxTokens < 8192) {
      console.warn(`[MercuryProvider] Response hit length limit (${maxTokens} tokens). Auto-retrying with extended budget (8192 tokens)...`);
      maxTokens = 8192;
      res = await this.fetchFn(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: modelToUse,
          messages: this.conversationMessages(systemPrompt, prompt, options.history),
          response_format: { type: 'json_object' },
          temperature: 0.1,
          max_tokens: maxTokens
        })
      });
      if (res.ok) {
        data = await res.json();
        choice = data.choices?.[0];
      }
    }

    const rawContent = choice?.message?.content || '';
    const parsed = this.parseJSONResponse(rawContent);

    if (!parsed || (!parsed.thought && !Array.isArray(parsed.actions))) {
      throw new Error(`Mercury returned invalid plan schema: ${rawContent.slice(0, 100)}`);
    }

    if (!Array.isArray(parsed.actions)) {
      parsed.actions = [];
    }

    return parsed;
  }
}

module.exports = MercuryProvider;
