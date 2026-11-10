const assert = require('assert');
const path = require('path');
const fs = require('fs');
const store = require('../src/main/store');
const MCPServer = require('../src/mcp/mcpServer');

async function testMcpOptionalAndDiagnostics() {
  console.log('=== TEST SUITE: OPTIONAL MCP SERVER TOGGLE & PERSISTENT DIAGNOSTICS ===\n');

  // Test 1: Verify MCP server default setting is optional (false)
  console.log('Test 1: Verifying default optional configuration in Store...');
  const defaults = store.getDefaults();
  assert.strictEqual(defaults.settings.mcpServerEnabled, false, 'MCP Server must default to false (optional component)');
  assert.strictEqual(defaults.settings.diagnosticLogging, true, 'Diagnostic logging must default to true for continuous monitoring');
  assert.strictEqual(defaults.settings.logLevel, 'structured', 'Log level must default to structured');
  console.log('  ✔ Store defaults confirm MCP server is optional and diagnostic logging is enabled.');

  // Test 2: Verifying persistent store getSetting and setSetting
  console.log('Test 2: Testing persistence of MCP toggle and diagnostic configurations...');
  store.setSetting('mcpServerEnabled', false);
  assert.strictEqual(store.getSetting('mcpServerEnabled'), false);

  store.setSetting('diagnosticLogging', true);
  assert.strictEqual(store.getSetting('diagnosticLogging'), true);

  store.setSetting('logLevel', 'verbose');
  assert.strictEqual(store.getSetting('logLevel'), 'verbose');

  // Restore to standard structured
  store.setSetting('logLevel', 'structured');
  console.log('  ✔ Configuration persistence verified in .data/adion-profile.json.');

  // Test 3: Standby behavior of MCPServer when not started
  console.log('Test 3: Verifying MCPServer standby behavior (no ports bound on startup)...');
  const mockTab = { id: 'tab_test', url: 'https://example.com', view: { webContents: { id: 1 } } };
  const mockTabManager = {
    activeTabId: 'tab_test',
    tabs: new Map([['tab_test', mockTab]]),
    getActiveTab: () => mockTab
  };

  const mcp = new MCPServer({
    controlPlane: {},
    tabManager: mockTabManager,
    runtime: {},
    cdp: { isAttached: true }
  });

  assert.strictEqual(mcp.isRunning, false, 'MCP server must be offline in standby');
  console.log('  ✔ MCPServer instantiated in standby without listening on network.');

  // Test 4: Dynamic On/Off Toggle
  console.log('Test 4: Testing dynamic ON toggle (starting server on demand)...');
  const testPort = 9299;
  const activePort = await mcp.start(testPort);
  assert.strictEqual(mcp.isRunning, true, 'MCP server must be running after toggle ON');
  assert.strictEqual(activePort, testPort);
  console.log(`  ✔ MCP server successfully launched dynamically on port ${activePort}.`);

  // Verify discovery file shows online
  const discPath = path.resolve(__dirname, '../.data/mcp_server.json');
  assert.ok(fs.existsSync(discPath), 'Discovery file must exist while server is running');
  const onlineData = JSON.parse(fs.readFileSync(discPath, 'utf8'));
  assert.strictEqual(onlineData.status, 'online');
  console.log('  ✔ Discovery file reflects online status.');

  // Test 5: Dynamic OFF Toggle
  console.log('Test 5: Testing dynamic OFF toggle (stopping server on demand)...');
  await mcp.stop();
  assert.strictEqual(mcp.isRunning, false, 'MCP server must be stopped after toggle OFF');
  assert.strictEqual(mcp.server, null, 'Server instance must be cleared after stop');

  const offlineData = JSON.parse(fs.readFileSync(discPath, 'utf8'));
  assert.strictEqual(offlineData.status, 'offline', 'Discovery file must indicate offline status');
  console.log('  ✔ MCP server cleanly stopped and port released.');

  console.log('\n✅ ALL OPTIONAL MCP & PERSISTENT DIAGNOSTIC TESTS PASSED SUCCESSFULLY!');
}

testMcpOptionalAndDiagnostics().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});

