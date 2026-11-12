const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AnySearchClient = require('../src/control-plane/anySearchClient');
const AgentRuntime = require('../src/control-plane/agentRuntime');
const ModelClient = require('../src/control-plane/modelClient');
const SessionManager = require('../src/control-plane/sessionManager');
const {
  isExplicitWebResearchRequest,
  isInformationalRequest,
  shouldSearchForContext,
  shouldSearchAfterUncertainty,
  isInsufficientContextThought,
  buildSearchQuery
} = require('../src/control-plane/anySearchPolicy');

async function testAnySearchClient() {
  const requests = [];
  const fakeFetch = async (url, options) => {
    const message = JSON.parse(options.body);
    requests.push({ url, options, message });

    let body;
    let status = 200;
    if (message.method === 'initialize') {
      body = {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'anysearch-test', version: 'test' }
        }
      };
    } else if (message.method === 'notifications/initialized') {
      status = 202;
      body = null;
    } else if (message.method === 'tools/list') {
      body = { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'search' }] } };
    } else if (message.method === 'tools/call') {
      body = {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: 'Result one: https://example.com/source' }],
          isError: false
        }
      };
    } else {
      throw new Error(`Unexpected MCP method: ${message.method}`);
    }

    const contentType = message.method === 'tools/call' ? 'text/event-stream' : 'application/json';
    const responseText = body === null ? '' : JSON.stringify(body);
    const response = {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get(name) {
          return name.toLowerCase() === 'mcp-session-id' ? 'session-test' :
            (name.toLowerCase() === 'content-type' ? contentType : null);
        }
      },
      text: async () => responseText
    };
    if (contentType === 'text/event-stream') {
      const sse = `event: message\ndata: ${responseText}\n\n`;
      response.body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse));
          // Intentionally leave the stream open to verify the MCP client exits on the matching id.
        }
      });
    }
    return response;
  };

  const client = new AnySearchClient({ apiKey: 'test-only-key', fetchFn: fakeFetch });
  const result = await client.search('  weather\nin Tokyo  ', 99);

  assert.ok(result.includes('https://example.com/source'));
  assert.strictEqual(requests.length, 4, 'Should initialize, send initialized notification, list tools, then search');
  assert.strictEqual(requests[0].message.method, 'initialize');
  assert.strictEqual(requests[1].message.method, 'notifications/initialized');
  assert.strictEqual(requests[2].message.method, 'tools/list');
  assert.strictEqual(requests[3].message.method, 'tools/call');
  assert.deepStrictEqual(requests[3].message.params.arguments, {
    query: 'weather in Tokyo',
    max_results: 10
  });
  assert.strictEqual(requests[0].options.headers.Authorization, 'Bearer test-only-key');
  assert.strictEqual(requests[0].options.headers['X-Anysearch-Client'], 'mcp/1.0.0');
  assert.strictEqual(requests[3].options.headers['MCP-Protocol-Version'], '2025-03-26');
  assert.strictEqual(requests[3].options.headers['Mcp-Session-Id'], 'session-test');
  console.log('  ✔ AnySearch Streamable HTTP handshake, auth headers, bounds, and search tool call verified.');
}

async function testSearchPolicyAndJarvisFallback() {
  assert.strictEqual(isExplicitWebResearchRequest('Please search the web for current Node versions'), true);
  assert.strictEqual(isInformationalRequest('Who maintains the project?'), true);
  assert.strictEqual(isInformationalRequest('Open github.com'), false);
  assert.strictEqual(isInformationalRequest('How do I open a new tab?'), false);
  assert.strictEqual(shouldSearchForContext('Who maintains this project?', {}), true);
  assert.strictEqual(shouldSearchForContext('What does this page say about licensing?', {
    isShared: true,
    pageText: 'Readable page content '.repeat(30)
  }), false);
  assert.strictEqual(shouldSearchForContext('What is the current API version?', {
    isShared: true,
    pageText: 'Readable page content '.repeat(30)
  }), true);
  assert.strictEqual(shouldSearchForContext('What does this page say?', { isShared: false }), false);
  assert.strictEqual(shouldSearchForContext('What does this page say?', {}), false);
  assert.strictEqual(shouldSearchAfterUncertainty('Who created this project?', { isShared: true }), true);
  assert.strictEqual(shouldSearchAfterUncertainty('What does this page say?', { isShared: true }), false);
  assert.strictEqual(isInsufficientContextThought("I don't have enough information to verify that."), true);
  assert.strictEqual(buildSearchQuery('Jarvis, please search the web for MCP transport'), 'MCP transport');

  const modelClient = new ModelClient();
  let capturedPrompt = '';
  let capturedSystemPrompt = '';
  modelClient.registry = {
    getActiveProvider: () => ({
      name: 'mock',
      displayName: 'Mock provider',
      model: 'test-model',
      isConfigured: () => true,
      async plan(prompt, systemPrompt) {
        capturedPrompt = prompt;
        capturedSystemPrompt = systemPrompt;
        return { thought: 'Answer from retrieved evidence.', actions: [] };
      }
    })
  };
  await modelClient.planActions('Who maintains this project?', {
    url: 'adion://newtab',
    webSearchContext: 'Maintainer listing: https://example.com/maintainers'
  });
  assert.ok(capturedPrompt.includes('Maintainer listing'));
  assert.ok(capturedPrompt.includes('https://example.com/maintainers'));
  assert.ok(capturedSystemPrompt.includes('untrusted external data'));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adion-anysearch-test-'));
  const sessionManager = new SessionManager(tempDir);
  try {
    const runtime = new AgentRuntime(null, null, null, null, null, sessionManager);
    runtime.isAnySearchEnabled = () => true;
    const searchQueries = [];
    runtime.anySearchClient = {
      async search(query) {
        searchQueries.push(query);
        return 'Official result: https://example.com/docs\nThe requested fact is available here.';
      }
    };

    let receivedContext = null;
    runtime.model = {
      async planActions(_text, pageContext) {
        receivedContext = pageContext.webSearchContext || '';
        return { thought: 'The answer is supported by the retrieved source.', actions: [] };
      }
    };

    await runtime.processCommand('Who maintains this project?', 'jarvis-chat');
    assert.strictEqual(searchQueries.length, 1, 'Opted-in informational Ask Jarvis requests should search when page context is absent');
    assert.ok(receivedContext.includes('https://example.com/docs'));

    // Respect the browser's page-sharing opt-out for page-specific prompts.
    const privatePageRuntime = new AgentRuntime(null, null, null, null, null, sessionManager);
    privatePageRuntime.isPageShared = false;
    privatePageRuntime.isAnySearchEnabled = () => true;
    privatePageRuntime.tabManager = {
      getActiveTab: () => ({ url: 'https://example.com/private', title: 'Private Page', view: { webContents: {} } })
    };
    privatePageRuntime.getActivePageContext = async () => {
      throw new Error('Page context should not be read when sharing is disabled.');
    };
    let privateSearchCount = 0;
    privatePageRuntime.anySearchClient = {
      async search() { privateSearchCount++; return 'must not be used'; }
    };
    privatePageRuntime.model = {
      async planActions() { return { thought: 'I cannot answer without page context.', actions: [] }; }
    };
    await privatePageRuntime.processCommand('What does this page say about licensing?', 'jarvis-chat');
    assert.strictEqual(privateSearchCount, 0, 'A page-sharing opt-out must prevent implicit external lookup for page-specific questions');

    // A page-grounded answer gets one uncertainty-triggered lookup, then a model retry.
    const pageRuntime = new AgentRuntime(null, null, null, null, null, sessionManager);
    pageRuntime.isAnySearchEnabled = () => true;
    pageRuntime.tabManager = {
      getActiveTab: () => ({
        id: 'test-tab',
        url: 'https://example.com/article',
        title: 'Example Article',
        view: { webContents: {} }
      })
    };
    pageRuntime.getActivePageContext = async () => ({
      url: 'https://example.com/article',
      title: 'Example Article',
      pageText: 'Page content '.repeat(40),
      isShared: true
    });
    let pageSearchCount = 0;
    pageRuntime.anySearchClient = {
      async search() {
        pageSearchCount++;
        return 'Supplemental source: https://example.com/supplement';
      }
    };
    const planningContexts = [];
    pageRuntime.model = {
      async planActions(_text, pageContext) {
        planningContexts.push(pageContext.webSearchContext || '');
        if (planningContexts.length === 1) {
          return { thought: 'I do not have enough information to answer from the page.', actions: [] };
        }
        return { thought: 'The page plus the supplemental source provides the answer.', actions: [] };
      }
    };

    await pageRuntime.processCommand('Who created this project?', 'jarvis-chat');
    assert.strictEqual(pageSearchCount, 1, 'A single uncertain informational answer may trigger one retrieval retry');
    assert.strictEqual(planningContexts.length, 2, 'Jarvis should re-plan once with retrieved context');
    assert.ok(planningContexts[1].includes('https://example.com/supplement'));

    // The same preference must not send voice/action commands to the external search provider.
    let voiceSearchCount = 0;
    runtime.anySearchClient = { async search() { voiceSearchCount++; return 'unused'; } };
    runtime.model = { async planActions() { return { thought: 'No action needed.', actions: [] }; } };
    await runtime.processCommand('Who maintains this project?', 'voice');
    assert.strictEqual(voiceSearchCount, 0, 'External lookup is scoped to Ask Jarvis chat requests');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('  ✔ Opt-in Ask Jarvis search, page-context gating, and uncertainty retry verified.');
}

async function main() {
  console.log('=== TEST SUITE: ANYSEARCH WEB CONTEXT FALLBACK ===\n');
  await testAnySearchClient();
  await testSearchPolicyAndJarvisFallback();
  console.log('\n✅ ANYSEARCH FALLBACK TESTS PASSED.');
}

main().catch((err) => {
  console.error('AnySearch test suite failed:', err);
  process.exit(1);
});
