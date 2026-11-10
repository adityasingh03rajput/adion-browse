const assert = require('assert');
const OpenAIProvider = require('../src/control-plane/providers/openaiProvider');
const AnthropicProvider = require('../src/control-plane/providers/anthropicProvider');
const GeminiProvider = require('../src/control-plane/providers/geminiProvider');
const CustomProvider = require('../src/control-plane/providers/customProvider');
const ProviderRegistry = require('../src/control-plane/providers/providerRegistry');
const ModelClient = require('../src/control-plane/modelClient');
const { ActionType } = require('../src/control-plane/protocol');

async function testThirdPartyProviders() {
  console.log('=== TEST SUITE: 3RD-PARTY AI MODEL PROVIDERS (CHATGPT, CLAUDE, GEMINI/ANTIGRAVITY) ===\n');

  // Test 1: OpenAI / ChatGPT Provider Execution
  console.log('Test 1: OpenAI ChatGPT Provider (gpt-4o)...');
  const openai = new OpenAIProvider({
    apiKey: 'sk-mock-openai-key-test',
    model: 'gpt-4o'
  });

  assert.strictEqual(openai.isConfigured(), true);
  assert.strictEqual(openai.name, 'openai');

  let interceptedOpenAiRequest = null;
  openai.fetchFn = async (url, opts) => {
    interceptedOpenAiRequest = { url, opts, body: JSON.parse(opts.body) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                thought: 'Navigate to ChatGPT OpenAI and search documentation',
                actions: [
                  { type: 'NAVIGATE', params: { url: 'https://chatgpt.com' } }
                ]
              })
            }
          }
        ]
      })
    };
  };

  const openAiPlan = await openai.plan('open chatgpt.com', 'System instruction');
  assert.ok(openAiPlan !== null);
  assert.strictEqual(openAiPlan.actions.length, 1);
  assert.strictEqual(openAiPlan.actions[0].type, 'NAVIGATE');
  assert.strictEqual(openAiPlan.actions[0].params.url, 'https://chatgpt.com');
  assert.strictEqual(interceptedOpenAiRequest.opts.headers['Authorization'], 'Bearer sk-mock-openai-key-test');
  assert.strictEqual(interceptedOpenAiRequest.body.model, 'gpt-4o');
  assert.strictEqual(interceptedOpenAiRequest.body.response_format.type, 'json_object');
  console.log('  ✔ OpenAI / ChatGPT provider successfully generated structured action plan with gpt-4o.');

  // Test 2: Anthropic / Claude Provider Execution
  console.log('\nTest 2: Anthropic Claude Provider (claude-3-5-sonnet)...');
  const anthropic = new AnthropicProvider({
    apiKey: 'sk-ant-mock-key-test',
    model: 'claude-3-5-sonnet-20241022'
  });

  assert.strictEqual(anthropic.isConfigured(), true);
  assert.strictEqual(anthropic.name, 'anthropic');

  let interceptedAnthropicRequest = null;
  anthropic.fetchFn = async (url, opts) => {
    interceptedAnthropicRequest = { url, opts, body: JSON.parse(opts.body) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              thought: 'Dynamically style navigation element',
              actions: [
                { type: 'MODIFY_DOM', params: { selector: '#nav', action: 'setStyle', value: 'background: #000;' } }
              ]
            })
          }
        ]
      })
    };
  };

  const claudePlan = await anthropic.plan('make the navbar dark', 'System instruction');
  assert.ok(claudePlan !== null);
  assert.strictEqual(claudePlan.actions.length, 1);
  assert.strictEqual(claudePlan.actions[0].type, 'MODIFY_DOM');
  assert.strictEqual(interceptedAnthropicRequest.opts.headers['x-api-key'], 'sk-ant-mock-key-test');
  assert.strictEqual(interceptedAnthropicRequest.opts.headers['anthropic-version'], '2023-06-01');
  assert.strictEqual(interceptedAnthropicRequest.body.model, 'claude-3-5-sonnet-20241022');
  assert.ok(interceptedAnthropicRequest.body.system.includes('System instruction'));
  console.log('  ✔ Anthropic / Claude provider successfully generated structured action plan with claude-3-5-sonnet.');

  // Test 3: Google / Gemini / Antigravity Provider Execution
  console.log('\nTest 3: Gemini / Antigravity Provider (gemini-2.0-flash)...');
  const gemini = new GeminiProvider({
    apiKey: 'mock-gemini-key-test',
    model: 'gemini-2.0-flash'
  });

  assert.strictEqual(gemini.isConfigured(), true);
  assert.strictEqual(gemini.name, 'gemini');

  let interceptedGeminiRequest = null;
  gemini.fetchFn = async (url, opts) => {
    interceptedGeminiRequest = { url, opts, body: JSON.parse(opts.body) };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    thought: 'Adjust voice activity detection threshold',
                    actions: [
                      { type: 'MODIFY_DOM', params: { selector: '#sliderVad', action: 'setValue', value: '0.03' } }
                    ]
                  })
                }
              ]
            }
          }
        ]
      })
    };
  };

  const geminiPlan = await gemini.plan('set vad threshold to 0.03', 'System instruction');
  assert.ok(geminiPlan !== null);
  assert.strictEqual(geminiPlan.actions.length, 1);
  assert.strictEqual(geminiPlan.actions[0].params.value, '0.03');
  assert.ok(interceptedGeminiRequest.url.includes('gemini-2.0-flash:generateContent'));
  assert.ok(interceptedGeminiRequest.url.includes('key=mock-gemini-key-test'));
  assert.strictEqual(interceptedGeminiRequest.body.generationConfig.responseMimeType, 'application/json');
  console.log('  ✔ Gemini / Antigravity provider successfully generated structured action plan with gemini-2.0-flash.');

  // Test 4: Custom OpenAI-Compatible Provider (e.g. DeepSeek / Local Ollama / vLLM)
  console.log('\nTest 4: Custom OpenAI-Compatible Endpoint Provider...');
  const custom = new CustomProvider({
    apiUrl: 'http://localhost:11434/v1/chat/completions',
    apiKey: 'sk-custom-test',
    model: 'deepseek-coder'
  });

  assert.strictEqual(custom.isConfigured(), true);
  assert.strictEqual(custom.name, 'custom');

  custom.fetchFn = async (url, opts) => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ thought: 'Execute custom model plan', actions: [] }) } }]
    })
  });

  const customPlan = await custom.plan('test custom model', 'System instruction');
  assert.ok(customPlan !== null);
  assert.strictEqual(customPlan.thought, 'Execute custom model plan');
  console.log('  ✔ Custom endpoint provider successfully verified.');

  // Test 5: Dynamic Provider Replacement in ModelClient & Operating Adion Browse
  console.log('\nTest 5: Dynamic Provider Replacement in ModelClient & Registry...');
  const modelClient = new ModelClient();

  // Initially auto/groq
  const initialList = modelClient.listProviders();
  assert.ok(initialList.providers.length >= 5);
  console.log(`  Registered providers: ${initialList.providers.map(p => p.name).join(', ')}`);

  // Dynamically activate ChatGPT (OpenAI)
  modelClient.configureProvider('openai', { apiKey: 'sk-test-live-key', model: 'gpt-4o' });
  modelClient.setActiveProvider('openai');
  assert.strictEqual(modelClient.getActiveProvider().name, 'openai');
  assert.strictEqual(modelClient.getActiveProvider().model, 'gpt-4o');
  console.log('  ✔ ModelClient dynamically switched to ChatGPT (gpt-4o) as primary operator.');

  // Dynamically activate Claude (Anthropic)
  modelClient.configureProvider('anthropic', { apiKey: 'sk-ant-test-live-key', model: 'claude-3-5-sonnet-20241022' });
  modelClient.setActiveProvider('anthropic');
  assert.strictEqual(modelClient.getActiveProvider().name, 'anthropic');
  assert.strictEqual(modelClient.getActiveProvider().model, 'claude-3-5-sonnet-20241022');
  console.log('  ✔ ModelClient dynamically switched to Claude (claude-3-5-sonnet) as primary operator.');

  // Dynamically activate Antigravity / Gemini
  modelClient.configureProvider('gemini', { apiKey: 'gemini-live-key', model: 'gemini-2.0-flash' });
  modelClient.setActiveProvider('gemini');
  assert.strictEqual(modelClient.getActiveProvider().name, 'gemini');
  assert.strictEqual(modelClient.getActiveProvider().model, 'gemini-2.0-flash');
  console.log('  ✔ ModelClient dynamically switched to Gemini / Antigravity as primary operator.');

  // Verify planActions routes to active provider
  let mockClaudeDispatched = false;
  modelClient.getActiveProvider().fetchFn = async (url, opts) => {
    mockClaudeDispatched = true;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                thought: 'Antigravity / Gemini operating Adion Browse directly',
                actions: [{ type: 'RELOAD', params: {} }]
              })
            }]
          }
        }]
      })
    };
  };

  const liveResult = await modelClient.planActions('refresh page', { url: 'https://example.com' });
  assert.ok(mockClaudeDispatched);
  assert.strictEqual(liveResult.actions[0].type, 'RELOAD');
  console.log('  ✔ ModelClient directly operated Adion Browse actions via active 3rd-party provider.');

  console.log('\n✅ ALL 3RD-PARTY AI MODEL INTEGRATION TESTS PASSED!');
}

testThirdPartyProviders().catch((err) => {
  console.error('Provider test failed:', err);
  process.exit(1);
});
