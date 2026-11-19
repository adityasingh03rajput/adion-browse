/**
 * Adion Browse - 3rd-Party Model Provider Registry & Coordinator
 * 
 * Manages 3rd-party model integrations:
 * - OpenAI / ChatGPT (gpt-4o, gpt-4o-mini, o1, o3-mini)
 * - Anthropic / Claude (claude-3-5-sonnet, claude-3-5-haiku, claude-3-opus)
 * - Google / Gemini / Antigravity (gemini-2.0-flash, gemini-1.5-pro)
 * - Custom OpenAI-Compatible (DeepSeek, OpenRouter, Perplexity, Ollama, vLLM)
 * - Groq Cloud Zero-Cost Default
 * 
 * Allows users and external agents to dynamically replace default models
 * and operate Adion Browse directly.
 */

const OpenAIProvider = require('./openaiProvider');
const AnthropicProvider = require('./anthropicProvider');
const GeminiProvider = require('./geminiProvider');
const CustomProvider = require('./customProvider');
const GroqProvider = require('./groqProvider');
const FreeModelProvider = require('./freemodelProvider');
const MercuryProvider = require('./mercuryProvider');

class ProviderRegistry {
  constructor(config = {}) {
    this.providers = new Map();
    this.activeProviderName = config.aiProvider || process.env.AI_PROVIDER || 'auto';

    // Register supported providers
    this.register(new OpenAIProvider({
      apiKey: config.openaiApiKey,
      apiUrl: config.openaiApiUrl,
      model: config.openaiModel
    }));

    this.register(new AnthropicProvider({
      apiKey: config.anthropicApiKey,
      apiUrl: config.anthropicApiUrl,
      model: config.anthropicModel
    }));

    this.register(new GeminiProvider({
      apiKey: config.geminiApiKey,
      apiUrl: config.geminiApiUrl,
      model: config.geminiModel
    }));

    this.register(new CustomProvider({
      apiKey: config.customApiKey,
      apiUrl: config.customApiUrl,
      model: config.customModel
    }));

    this.register(new GroqProvider({
      apiKey: config.groqApiKey,
      apiUrl: config.groqApiUrl,
      model: config.groqModel
    }));

    this.register(new FreeModelProvider({
      apiKey: config.freemodelApiKey,
      apiUrl: config.freemodelApiUrl,
      model: config.freemodelModel
    }));

    this.register(new MercuryProvider({
      apiKey: config.mercuryApiKey,
      apiUrl: config.mercuryApiUrl,
      model: config.mercuryModel
    }));
  }

  register(provider) {
    this.providers.set(provider.name, provider);
  }

  getProvider(name) {
    return this.providers.get(name) || null;
  }

  /**
   * Set active provider dynamically at runtime
   */
  setActiveProvider(name) {
    if (name !== 'auto' && !this.providers.has(name)) {
      throw new Error(`Unknown provider: ${name}. Available: ${Array.from(this.providers.keys()).join(', ')}`);
    }
    this.activeProviderName = name;
    console.log(`[ProviderRegistry] Active AI provider set to: ${name}`);
    return this.getActiveProvider();
  }

  /**
   * Resolve active provider based on configuration or auto-prioritization
   */
  getActiveProvider() {
    // 1. Explicit provider chosen by user (always honor explicit selection)
    if (this.activeProviderName && this.activeProviderName !== 'auto') {
      const explicit = this.providers.get(this.activeProviderName);
      if (explicit) {
        return explicit;
      }
    }

    // 2. Auto-prioritize configured 3rd-party models over default
    const priority = ['mercury', 'freemodel', 'openai', 'anthropic', 'gemini', 'custom', 'groq'];
    for (const name of priority) {
      const p = this.providers.get(name);
      if (p && p.isConfigured()) {
        return p;
      }
    }

    // Fall back to groq
    return this.providers.get('groq');
  }

  /**
   * List all providers with their configuration and status
   */
  listProviders() {
    const active = this.getActiveProvider();
    const result = [];
    for (const [name, p] of this.providers.entries()) {
      const key = p.apiKey ? String(p.apiKey).trim() : '';
      const masked = key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : (key ? '••••••••' : '');
      result.push({
        name: p.name,
        displayName: p.displayName,
        isConfigured: p.isConfigured(),
        isActive: (this.activeProviderName === name) || (this.activeProviderName === 'auto' && active?.name === p.name),
        currentModel: p.model,
        apiUrl: p.apiUrl || '',
        pageUrl: p.pageUrl || '',
        hasApiKey: Boolean(key.length > 0),
        maskedApiKey: masked,
        supportedModels: p.supportedModels || [p.model]
      });
    }
    return {
      activeProvider: active?.name || (this.activeProviderName !== 'auto' ? this.activeProviderName : 'groq'),
      mode: this.activeProviderName || 'auto',
      providers: result
    };
  }

  /**
   * Configure a provider's credentials and model dynamically
   */
  configureProvider(name, { apiKey, apiUrl, model, pageUrl } = {}) {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Provider not found: ${name}`);
    }

    if (apiKey !== undefined) provider.setApiKey(apiKey);
    if (apiUrl !== undefined) provider.setApiUrl(apiUrl);
    if (model !== undefined) provider.setModel(model);
    if (pageUrl !== undefined && typeof provider.setPageUrl === 'function') provider.setPageUrl(pageUrl);

    return {
      name: provider.name,
      displayName: provider.displayName,
      isConfigured: provider.isConfigured(),
      model: provider.model,
      apiUrl: provider.apiUrl,
      pageUrl: provider.pageUrl || ''
    };
  }
}

module.exports = ProviderRegistry;

