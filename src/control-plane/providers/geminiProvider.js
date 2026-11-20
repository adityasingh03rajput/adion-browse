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

    const userParts = [];
    if (options.imageDataUrl && typeof options.imageDataUrl === 'string') {
      const parts = options.imageDataUrl.split(',');
      const mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
      const base64Data = parts[1] || parts[0];
      if (base64Data) {
        userParts.push({
          inlineData: {
            mimeType: mime,
            data: base64Data
          }
        });
      }
    }
    userParts.push({ text: prompt });

    const payload = {
      systemInstruction: {
        parts: [
          {
            text: systemPrompt + '\nYou MUST respond strictly with raw JSON matching the required schema. Do NOT include markdown code blocks or explanations.'
          }
        ]
      },
      contents: [
        ...this.coalesceMessages(options.history).map((turn) => ({
          role: turn.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: turn.content }]
        })),
        {
          role: 'user',
          parts: userParts
        }
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: 1600
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

  async chat(prompt, systemPrompt = 'You are Adion Copilot, the intelligent AI assistant in Adion Browse. Communicate directly, warmly, and helpfully with the user in natural language.', options = {}) {
    if (!this.isConfigured()) {
      throw new Error('Gemini API key is not configured');
    }

    const modelToUse = options.model || this.model || 'gemini-1.5-pro';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent?key=${this.apiKey}`;

    const rawHistory = Array.isArray(options.history) ? options.history : [];
    const formattedHistory = rawHistory.map(h => {
      if (h.role && h.content) return h;
      return [
        h.user ? { role: 'user', content: h.user } : null,
        h.agent ? { role: 'assistant', content: h.agent } : null
      ].filter(Boolean);
    }).flat();

    const payload = {
      systemInstruction: {
        parts: [
          {
            text: systemPrompt
          }
        ]
      },
      contents: [
        ...this.coalesceMessages(formattedHistory).map((turn) => ({
          role: turn.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: turn.content }]
        })),
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxTokens || 1000
      }
    };

    console.log(`[GeminiProvider] Conversational chat querying ${modelToUse}...`);

    const res = await this.fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Gemini chat error ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    const rawContent = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return rawContent.trim();
  }
}

module.exports = GeminiProvider;

