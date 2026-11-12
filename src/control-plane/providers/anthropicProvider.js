/**
 * Adion Browse - Anthropic / Claude 3rd-Party Provider
 * Supports claude-3-5-sonnet, claude-3-5-haiku, claude-3-opus via Anthropic Messages API.
 */

const BaseProvider = require('./baseProvider');

class AnthropicProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      name: 'anthropic',
      displayName: 'Claude / Anthropic',
      apiKey: options.apiKey || process.env.ANTHROPIC_API_KEY || '',
      apiUrl: options.apiUrl || process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages',
      model: options.model || process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022'
    });

    this.supportedModels = [
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229'
    ];
  }

  isConfigured() {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  async plan(prompt, systemPrompt, options = {}) {
    if (!this.isConfigured()) {
      throw new Error('Anthropic API key is not configured');
    }

    const modelToUse = options.model || this.model || 'claude-3-5-sonnet-20241022';

    const payload = {
      model: modelToUse,
      max_tokens: 1600,
      system: systemPrompt + '\nYou MUST respond strictly with raw JSON matching the required schema. Do NOT include markdown code blocks or explanations.',
      messages: [
        ...this.coalesceMessages(options.history).map((turn) => ({
          role: turn.role === 'assistant' ? 'assistant' : 'user',
          content: turn.content
        })),
        {
          role: 'user',
          content: prompt + '\n\nOutput strictly valid JSON only.'
        }
      ],
      temperature: 0.1
    };

    console.log(`[AnthropicProvider] Querying ${modelToUse}...`);

    const res = await this.fetchFn(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Anthropic API error ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    const rawContent = data.content?.[0]?.text || '';
    const parsed = this.parseJSONResponse(rawContent);

    if (!parsed || (!parsed.thought && !Array.isArray(parsed.actions))) {
      throw new Error(`Claude returned invalid plan schema: ${rawContent.slice(0, 100)}`);
    }

    if (!Array.isArray(parsed.actions)) {
      parsed.actions = [];
    }

    return parsed;
  }
}

module.exports = AnthropicProvider;

