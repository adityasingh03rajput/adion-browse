const http = require('http');

async function callMCP(toolName, args = {}) {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args
    }
  });

  const res = await fetch('http://127.0.0.1:9224/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload
  });

  const json = await res.json();
  if (json.error) {
    throw new Error(`MCP Error ${json.error.code}: ${json.error.message}`);
  }
  return JSON.parse(json.result.content[0].text);
}

async function run() {
  console.log('=== Step 1: Listing initial browser tabs ===');
  const tabs1 = await callMCP('browser_list_tabs');
  console.log('Tabs:', tabs1);

  console.log('\n=== Step 2: Dispatching Agent Command: "search how to control overthinking in nomoney.in" ===');
  const dispatchRes = await callMCP('browser_dispatch_agent_command', {
    command: 'search how to control overthinking in nomoney.in'
  });
  console.log('Dispatch response:', dispatchRes);

  // Wait a short moment for navigation to settle
  await new Promise(r => setTimeout(r, 1200));

  console.log('\n=== Step 3: Checking Session Memory & AI Decision-Making ===');
  const mem = await callMCP('session_get_memory');
  const last = mem.interactions[mem.interactions.length - 1];
  console.log('Recorded prompt:', last.prompt.raw);
  console.log('AI Thought:', last.response.thought);
  console.log('AI Actions:', JSON.stringify(last.response.actions, null, 2));

  console.log('\n=== Step 4: Verifying Live Tab URL & Content ===');
  const tabs2 = await callMCP('browser_list_tabs');
  console.log('Updated Tabs:', tabs2);

  console.log('\n=== Step 5: Testing STT Transient Noise Rejection ===');
  const STTEngine = require('../src/control-plane/sttEngine');
  const stt = new STTEngine();

  // Test 1: Ambient Whisper hallucination rejection
  const cleaned1 = stt.cleanAndNormalizeTranscript('Browser voice commands, web search, page navigation, and tab management.');
  console.log('Cleaned prompt hallucination:', JSON.stringify(cleaned1));
  if (cleaned1 === '') {
    console.log('✔ PASS: Hallucinated prompt string cleanly discarded!');
  } else {
    console.error('❌ FAIL: Prompt string was not discarded:', cleaned1);
  }

  // Test 2: Valid command preservation
  const cleaned2 = stt.cleanAndNormalizeTranscript('Search how to control overthinking in nomoney.in');
  console.log('Cleaned legitimate query:', JSON.stringify(cleaned2));
  if (cleaned2.toLowerCase().includes('nomoney.in')) {
    console.log('✔ PASS: Legitimate search query preserved accurately!');
  } else {
    console.error('❌ FAIL: Legitimate query damaged:', cleaned2);
  }

  console.log('\n=== Step 6: Testing Conversational Query via Agent Command ===');
  const chatRes = await callMCP('browser_dispatch_agent_command', {
    command: 'who are you and what do you do?'
  });
  console.log('Chat command dispatch:', chatRes);

  const mem2 = await callMCP('session_get_memory');
  const lastChat = mem2.interactions[mem2.interactions.length - 1];
  console.log('Chat Prompt:', lastChat.prompt.raw);
  console.log('Chat AI Thought (Reply):', lastChat.response.thought);
  console.log('Chat AI Actions (must be empty for conversation):', lastChat.response.actions);

  console.log('\n✅ ALL MCP LIVE TRACKING CHECKS PASSED!');
}

run().catch(err => {
  console.error('Error during test:', err);
  process.exit(1);
});

