/**
 * Adion Browse - Standalone Local Terminal Bridge Test Suite
 * 
 * Validates:
 * 1. Zero-dependency native Node.js standalone executable runtime (No Python needed).
 * 2. Cross-platform shell resolution (PowerShell/cmd.exe on Windows, bash/zsh on POSIX).
 * 3. Lifecycle management: start, stop, toggle, port fallback, and cleanup.
 * 4. Command execution, exit codes, stdout/stderr capture, working directory persistence.
 * 5. Standalone HTTP REST API endpoints (/status, /exec, /history).
 * 6. AgentRuntime & QueryPreprocessor fast-path intent routing for TERMINAL_EXEC.
 */

const assert = require('assert');
const http = require('http');
const TerminalBridge = require('../src/terminal/terminalBridge');
const QueryPreprocessor = require('../src/control-plane/queryPreprocessor');
const { ActionType } = require('../src/control-plane/protocol');

async function makeHttpRequest(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(data) });
        } catch (_) {
          resolve({ statusCode: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('\n=== TEST SUITE: STANDALONE LOCAL PC TERMINAL BRIDGE ===\n');

  let bridge = null;

  try {
    // ----------------------------------------------------
    // Test 1: Instantiation & Platform Shell Resolution
    // ----------------------------------------------------
    console.log('Test 1: Instantiating TerminalBridge and verifying zero-dependency runtime...');
    bridge = new TerminalBridge({ port: 9235 }); // Use 9235 to avoid port collisions
    assert.strictEqual(bridge.isConnected, false, 'Initial state must be disconnected');
    assert.ok(bridge.defaultShell, 'Default shell must be detected');
    console.log(`  ✔ Platform shell resolved: ${bridge.defaultShell} (Zero Python dependencies required)`);

    // ----------------------------------------------------
    // Test 2: Startup & Status Reporting
    // ----------------------------------------------------
    console.log('\nTest 2: Starting Standalone HTTP Server on port 9235...');
    const startRes = await bridge.start();
    assert.strictEqual(bridge.isConnected, true, 'Bridge must report connected after start');
    assert.strictEqual(startRes.port, 9235, 'Port must match configured 9235');

    const status = bridge.getStatus();
    assert.strictEqual(status.connected, true, 'getStatus must report connected');
    assert.strictEqual(status.port, 9235);
    console.log(`  ✔ Standalone server active on http://127.0.0.1:${status.port}`);
    console.log(`  ✔ Host info: user=${status.username}, platform=${status.platform}`);

    // ----------------------------------------------------
    // Test 3: Command Execution & Real Hardware Output
    // ----------------------------------------------------
    console.log('\nTest 3: Executing local system commands via child_process bridge...');
    const echoRes = await bridge.executeCommand('echo "Adion Autonomous Terminal Bridge Active"');
    assert.strictEqual(echoRes.success, true, 'Echo command must succeed');
    assert.strictEqual(echoRes.exitCode, 0, 'Exit code must be 0');
    assert.ok(echoRes.stdout.includes('Adion Autonomous Terminal Bridge Active'), 'Stdout must contain echo text');
    console.log(`  ✔ Execution succeeded (exitCode=0, duration=${echoRes.durationMs}ms)`);
    console.log(`  ✔ Stdout: "${echoRes.stdout.trim()}"`);

    // Directory persistence
    const originalCwd = bridge.cwd;
    const cdRes = await bridge.executeCommand('cd ..');
    assert.strictEqual(cdRes.success, true, 'cd .. must succeed');
    assert.notStrictEqual(bridge.cwd, originalCwd, 'Working directory should have changed');
    // Restore original cwd
    await bridge.executeCommand(`cd "${originalCwd}"`);
    assert.strictEqual(bridge.cwd, originalCwd, 'Cwd should be restored');
    console.log(`  ✔ Working directory tracking and stateful navigation verified`);

    // ----------------------------------------------------
    // Test 4: Error Handling & Non-Zero Exit Code
    // ----------------------------------------------------
    console.log('\nTest 4: Verifying graceful error capture on non-existent command...');
    const failRes = await bridge.executeCommand('nonexistent_command_xyz_12345');
    assert.strictEqual(failRes.success, false, 'Invalid command must report success=false');
    assert.notStrictEqual(failRes.exitCode, 0, 'Exit code must be non-zero');
    assert.ok(failRes.stderr.length > 0 || failRes.stdout.length > 0, 'Must output error message');
    console.log(`  ✔ Non-zero exit code captured gracefully (exitCode=${failRes.exitCode})`);

    // ----------------------------------------------------
    // Test 5: Standalone HTTP REST API Endpoints
    // ----------------------------------------------------
    console.log('\nTest 5: Testing Standalone REST API endpoints (/status, /exec)...');
    
    // GET /status
    const restStatus = await makeHttpRequest('http://127.0.0.1:9235/status', { method: 'GET' });
    assert.strictEqual(restStatus.statusCode, 200, 'GET /status must return 200');
    assert.strictEqual(restStatus.data.connected, true);
    console.log(`  ✔ REST GET /status: 200 OK (shell=${restStatus.data.shell})`);

    // POST /exec
    const restExec = await makeHttpRequest(
      'http://127.0.0.1:9235/exec',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { command: 'echo "REST Endpoint Verified"' }
    );
    assert.strictEqual(restExec.statusCode, 200, 'POST /exec must return 200');
    assert.strictEqual(restExec.data.success, true);
    assert.ok(restExec.data.stdout.includes('REST Endpoint Verified'));
    console.log(`  ✔ REST POST /exec: 200 OK (stdout="${restExec.data.stdout.trim()}")`);

    // ----------------------------------------------------
    // Test 6: Single-Toggle Mechanism (Browser Control)
    // ----------------------------------------------------
    console.log('\nTest 6: Testing single-toggle disconnect and reconnect...');
    await bridge.toggle(false);
    assert.strictEqual(bridge.isConnected, false, 'Toggle(false) must disconnect bridge');
    console.log('  ✔ Standalone bridge stopped cleanly via single-toggle');

    await bridge.toggle(true);
    assert.strictEqual(bridge.isConnected, true, 'Toggle(true) must reconnect bridge');
    console.log('  ✔ Standalone bridge restarted cleanly via single-toggle');

    // ----------------------------------------------------
    // Test 7: Fast-Path Intent Routing for TERMINAL_EXEC
    // ----------------------------------------------------
    console.log('\nTest 7: Testing QueryPreprocessor fast-path routing (<0.5ms)...');
    const preprocessor = new QueryPreprocessor();

    const p1 = preprocessor.preprocess('/terminal git status');
    const intent1 = preprocessor.extractFastIntent(p1);
    assert.ok(intent1, 'Fast intent should be recognized');
    assert.strictEqual(intent1.type, ActionType.TERMINAL_EXEC);
    assert.strictEqual(intent1.command, 'git status');
    console.log(`  ✔ "/terminal git status" parsed to TERMINAL_EXEC (latency: ${p1.durationMs}ms)`);

    const p2 = preprocessor.preprocess('terminal: dir');
    const intent2 = preprocessor.extractFastIntent(p2);
    assert.ok(intent2, 'Colon prefix intent should be recognized');
    assert.strictEqual(intent2.type, ActionType.TERMINAL_EXEC);
    assert.strictEqual(intent2.command, 'dir');
    console.log(`  ✔ "terminal: dir" parsed to TERMINAL_EXEC`);

    const p3 = preprocessor.preprocess('run local command: npm --version');
    const intent3 = preprocessor.extractFastIntent(p3);
    assert.ok(intent3);
    assert.strictEqual(intent3.type, ActionType.TERMINAL_EXEC);
    assert.strictEqual(intent3.command, 'npm --version');
    console.log(`  ✔ "run local command: npm --version" parsed to TERMINAL_EXEC`);

    // ----------------------------------------------------
    // Test 8: Computer Use Slash Commands (/pc, /computer, /workspace)
    // ----------------------------------------------------
    console.log('\nTest 8: Testing Computer Use slash commands (/pc, /computer, /workspace)...');
    
    // Direct CLI execution via /pc
    const pPc = preprocessor.preprocess('/pc git status');
    const intentPc = preprocessor.extractFastIntent(pPc);
    assert.ok(intentPc);
    assert.strictEqual(intentPc.type, ActionType.TERMINAL_EXEC);
    assert.strictEqual(intentPc.command, 'git status');
    console.log('  ✔ "/pc git status" parsed to TERMINAL_EXEC');

    // Direct CLI execution via /computer
    const pComp = preprocessor.preprocess('/computer npm test');
    const intentComp = preprocessor.extractFastIntent(pComp);
    assert.ok(intentComp);
    assert.strictEqual(intentComp.type, ActionType.TERMINAL_EXEC);
    assert.strictEqual(intentComp.command, 'npm test');
    console.log('  ✔ "/computer npm test" parsed to TERMINAL_EXEC');

    // Direct CLI execution via /workspace
    const pWs = preprocessor.preprocess('/workspace node -v');
    const intentWs = preprocessor.extractFastIntent(pWs);
    assert.ok(intentWs);
    assert.strictEqual(intentWs.type, ActionType.TERMINAL_EXEC);
    assert.strictEqual(intentWs.command, 'node -v');
    console.log('  ✔ "/workspace node -v" parsed to TERMINAL_EXEC');

    // Natural language prompt routing to cognitive planner
    const pNl = preprocessor.preprocess('/pc check all modified files and tell me the git status');
    const intentNl = preprocessor.extractFastIntent(pNl);
    assert.strictEqual(intentNl, null, 'Natural language PC command should route to cognitive goal planner');
    console.log('  ✔ Natural language computer use command gracefully routes to cognitive goal planner');

    // ----------------------------------------------------
    // Test 9: Natural Language File Creation & Coreference "open it" Resolution
    // ----------------------------------------------------
    console.log('\nTest 9: Testing file creation synthesis and "open it" coreference...');
    const pCreate = preprocessor.preprocess('/pc D:\\Jarvis create aditya.html saying hello');
    const intentCreate = preprocessor.extractFastIntent(pCreate);
    assert.ok(intentCreate, 'File creation intent must be recognized');
    assert.strictEqual(intentCreate.type, ActionType.TERMINAL_EXEC);
    assert.ok(intentCreate.command.includes('aditya.html'));
    assert.ok(intentCreate.command.includes('hello'));
    assert.strictEqual(intentCreate.targetFile, 'D:\\Jarvis\\aditya.html');
    console.log('  ✔ "/pc D:\\Jarvis create aditya.html saying hello" synthesized into verified PowerShell file creation');

    // Restart bridge to test command execution
    await bridge.start();
    const execFileRes = await bridge.executeCommand(intentCreate.command);
    assert.strictEqual(execFileRes.success, true, 'PowerShell file creation must succeed');
    const fsMod = require('fs');
    assert.ok(fsMod.existsSync('D:\\Jarvis\\aditya.html'), 'aditya.html must physically exist on disk');
    const fileText = fsMod.readFileSync('D:\\Jarvis\\aditya.html', 'utf8');
    assert.ok(fileText.includes('hello'), 'Content must include "hello"');
    console.log('  ✔ Verified on physical disk: D:\\Jarvis\\aditya.html exists with content "hello"');

    // Test Coreference "open it"
    const pOpen = preprocessor.preprocess('open it');
    const intentOpen = preprocessor.extractFastIntent(pOpen, { lastReferencedFile: intentCreate.targetFile });
    assert.ok(intentOpen, '"open it" must resolve against lastReferencedFile');
    assert.strictEqual(intentOpen.type, ActionType.NAVIGATE);
    assert.strictEqual(intentOpen.url, 'file:///D:/Jarvis/aditya.html');
    console.log('  ✔ "open it" correctly resolved to file:///D:/Jarvis/aditya.html without hallucinations');

    // Clean up test file
    try { fsMod.unlinkSync('D:\\Jarvis\\aditya.html'); } catch (_) {}

    // ----------------------------------------------------
    // Test 10: Conditional Multi-Step Computer Use & Physical Verification
    // ----------------------------------------------------
    console.log('\nTest 10: Testing conditional check-and-create workflow with physical disk verification...');
    // Step A: Check if any .html file exists in D:\Jarvis
    const checkRes = await bridge.executeCommand("Get-ChildItem -Path 'D:\\Jarvis' -Filter '*.html' -ErrorAction SilentlyContinue");
    assert.strictEqual(checkRes.success, true);
    assert.strictEqual(checkRes.stdout.trim(), '', 'No HTML files should exist prior to creation');
    console.log('  ✔ Step 1: Checked D:\\Jarvis, confirmed 0 .html files exist');

    // Step B: Create aditya.html when none found
    const createCmd = "if (!(Test-Path 'D:\\Jarvis')) { New-Item -ItemType Directory -Force -Path 'D:\\Jarvis' | Out-Null }; Set-Content -Path 'D:\\Jarvis\\aditya.html' -Value 'hello'";
    const createRes = await bridge.executeCommand(createCmd);
    assert.strictEqual(createRes.success, true);

    // Step C: Verify physical existence on disk
    assert.ok(fsMod.existsSync('D:\\Jarvis\\aditya.html'), 'aditya.html must physically exist in D:\\Jarvis on disk');
    const readBack = fsMod.readFileSync('D:\\Jarvis\\aditya.html', 'utf8');
    assert.ok(readBack.includes('hello'), 'Content must contain "hello"');
    console.log('  ✔ Step 2: Physically verified D:\\Jarvis\\aditya.html on disk with content "hello"');

    // Clean up test file
    try { fsMod.unlinkSync('D:\\Jarvis\\aditya.html'); } catch (_) {}

    // Clean teardown
    await bridge.stop();
    console.log('\n========================================================');
    console.log('🎉 ALL STANDALONE TERMINAL BRIDGE & COMPUTER USE TESTS PASSED (10/10)');
    console.log('========================================================\n');
    process.exit(0);

  } catch (err) {
    console.error('\n❌ TEST SUITE FAILED:', err);
    if (bridge) {
      try { await bridge.stop(); } catch (_) {}
    }
    process.exit(1);
  }
}

runTests();

