/**
 * Adion Browse - Groq Zero-Cost Default Provider
 * High-speed LPU inference with resilient exponential backoff and rotation across verified models:
 * openai/gpt-oss-120b, openai/gpt-oss-20b, qwen/qwen3.8-27b, allam-2-7b.
 */

const BaseProvider = require('./baseProvider');

class GroqProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      name: 'groq',
      displayName: 'Groq Cloud (Default Zero-Cost)',
      apiKey: options.apiKey || process.env.GROQ_API_KEY || '',
      apiUrl: options.apiUrl || process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions',
      model: options.model || process.env.GROQ_MODEL || 'openai/gpt-oss-120b'
    });

    this.zeroCostCandidates = [
      this.model || 'openai/gpt-oss-120b',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'qwen/qwen3.8-27b',
      'allam-2-7b'
    ].filter((m, idx, arr) => arr.indexOf(m) === idx);
  }

  isConfigured() {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  async plan(prompt, systemPrompt, options = {}) {
    if (!this.isConfigured()) {
      throw new Error('Groq API key is not configured');
    }

    const candidates = [
      options.model || this.model,
      ...this.zeroCostCandidates
    ].filter(Boolean).filter((m, idx, arr) => arr.indexOf(m) === idx);

    const maxRetries = candidates.length;
    const baseDelayMs = 400;
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const candidateModel = candidates[attempt % candidates.length];

      try {
        const payload = {
          model: candidateModel,
          messages: [
            { role: 'system', content: systemPrompt + '\nRespond strictly with RAW JSON format. No markdown, no prose.' },
            { role: 'user', content: prompt }
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
          max_tokens: 650
        };

        const res = await this.fetchFn(this.apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`
          },
          body: JSON.stringify(payload)
        }).catch(err => {
          lastError = err;
          return null;
        });

        if (res && res.ok) {
          const data = await res.json();
          const rawContent = data.choices?.[0]?.message?.content || '';
          const parsed = this.parseJSONResponse(rawContent);
          // If model returned a refusal (e.g. "I'm sorry, but I can't help with that") with 0 actions, failover to next candidate model
          const thoughtLower = (parsed?.thought || '').toLowerCase();
          const isRefusal = thoughtLower.includes("can't help") || thoughtLower.includes("cannot help") || thoughtLower.includes("i'm sorry");
          if (parsed && !isRefusal && (Array.isArray(parsed.actions) || parsed.thought)) {
            if (!Array.isArray(parsed.actions)) parsed.actions = [];
            return parsed;
          }
          if (isRefusal) {
            console.warn(`[GroqProvider Backoff] Model ${candidateModel} emitted safety refusal. Failing over to next candidate...`);
          }
        }

        const status = res ? res.status : 0;
        const errText = res ? await res.text().catch(() => '') : (lastError?.message || 'Network failure');
        lastError = new Error(`Groq API error ${status} on model ${candidateModel}: ${errText.slice(0, 120)}`);

        // If retryable condition or refusal
        if ([503, 502, 504, 429, 404, 400, 200].includes(status) || !res) {
          const nextModel = candidates[(attempt + 1) % candidates.length];
          const delay = Math.round(baseDelayMs * Math.pow(1.5, attempt) + Math.random() * 200);
          console.warn(`[GroqProvider Backoff] Retryable condition on ${candidateModel}. Failover to candidate: ${nextModel} in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        break;
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error('Max retries exceeded for Groq API');
  }
}

module.exports = GroqProvider;

