/**
 * Adion Browse - OpenAI / ChatGPT 3rd-Party Provider
 * Supports gpt-4o, gpt-4o-mini, gpt-4-turbo, o1, o3-mini and custom OpenAI-compatible endpoints.
 */

const BaseProvider = require('./baseProvider');

class OpenAIProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      name: 'openai',
      displayName: 'ChatGPT / OpenAI',
      apiKey: options.apiKey || process.env.OPENAI_API_KEY || '',
      apiUrl: options.apiUrl || process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions',
      model: options.model || process.env.OPENAI_MODEL || 'gpt-4o'
    });

    this.supportedModels = [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'o1',
      'o1-mini',
      'o3-mini'
    ];
  }

  isConfigured() {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  async plan(prompt, systemPrompt, options = {}) {
    if (!this.isConfigured()) {
      throw new Error('OpenAI API key is not configured');
    }

    const modelToUse = options.model || this.model || 'gpt-4o';
    const isReasoningModel = modelToUse.startsWith('o1') || modelToUse.startsWith('o3');

    // Reasoning models (o1, o3-mini) do not accept custom system messages or response_format in earlier revisions
    const messages = isReasoningModel ? [
      { role: 'user', content: `${systemPrompt}\n\nTask:\n${prompt}` }
    ] : [
      { role: 'system', content: systemPrompt + '\nRespond strictly with RAW JSON format. No markdown, no prose.' },
      { role: 'user', content: prompt }
    ];

    const payload = {
      model: modelToUse,
      messages
    };

    if (!isReasoningModel) {
      payload.response_format = { type: 'json_object' };
      payload.temperature = 0.1;
      payload.max_tokens = 800;
    }

    console.log(`[OpenAIProvider] Querying ${modelToUse} at ${this.apiUrl}...`);

    const res = await this.fetchFn(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`OpenAI API error ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    const rawContent = data.choices?.[0]?.message?.content || '';
    const parsed = this.parseJSONResponse(rawContent);

    if (!parsed || (!parsed.thought && !Array.isArray(parsed.actions))) {
      throw new Error(`OpenAI returned invalid plan schema: ${rawContent.slice(0, 100)}`);
    }

    if (!Array.isArray(parsed.actions)) {
      parsed.actions = [];
    }

    return parsed;
  }
}

module.exports = OpenAIProvider;

