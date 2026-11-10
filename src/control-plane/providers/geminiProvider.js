/**
 * Adion Browse - Google / Gemini / Antigravity 3rd-Party Provider
 * Supports gemini-2.0-flash, gemini-1.5-pro, gemini-1.5-flash via Gemini REST API.
 */

const BaseProvider = require('./baseProvider');

class GeminiProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      name: 'gemini',
      displayName: 'Gemini / Antigravity (Google)',
      apiKey: options.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
      apiUrl: options.apiUrl || process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta/models',
      model: options.model || process.env.GEMINI_MODEL || 'gemini-2.0-flash'
    });

    this.supportedModels = [
      'gemini-2.0-flash',
      'gemini-1.5-pro',
      'gemini-1.5-flash'
    ];
  }

  isConfigured() {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  async plan(prompt, systemPrompt, options = {}) {
    if (!this.isConfigured()) {
      throw new Error('Gemini / Antigravity API key is not configured');
    }

    const modelToUse = options.model || this.model || 'gemini-2.0-flash';
    const endpoint = `${this.apiUrl.replace(/\/$/, '')}/${modelToUse}:generateContent?key=${this.apiKey}`;

    const payload = {
      systemInstruction: {
        parts: [
          {
            text: systemPrompt + '\nYou MUST respond strictly with raw JSON matching the required schema. Do NOT include markdown code blocks or explanations.'
          }
        ]
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: 1024
      }
    };

    console.log(`[GeminiProvider] Querying ${modelToUse}...`);

    const res = await this.fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Gemini API error ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    const rawContent = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = this.parseJSONResponse(rawContent);

    if (!parsed || (!parsed.thought && !Array.isArray(parsed.actions))) {
      throw new Error(`Gemini returned invalid plan schema: ${rawContent.slice(0, 100)}`);
    }

    if (!Array.isArray(parsed.actions)) {
      parsed.actions = [];
    }

    return parsed;
  }
}

module.exports = GeminiProvider;

