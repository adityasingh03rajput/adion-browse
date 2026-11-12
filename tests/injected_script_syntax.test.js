/**
 * Guards the page scripts injected by the agent runtime.
 *
 * These scripts live inside template literals, so a malformed regex or stray
 * token inside them passes `node --check` on the host file while failing at
 * runtime with Electron's generic "Script failed to execute" - which surfaces
 * as a phantom "field not found" during grounding. This test rebuilds the
 * injected text (interpolations replaced by a valid placeholder) and compiles
 * it, so such errors fail here instead of in a live browser session.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'control-plane', 'agentRuntime.js'), 'utf8');
const START = 'const pageScript = `';
const END = 'try { new Function(pageScript); }';

function extractScript() {
  const start = source.indexOf(START);
  assert.ok(start >= 0, `missing start marker: ${START}`);
  const bodyStart = start + START.length;
  const end = source.indexOf(END, bodyStart);
  assert.ok(end >= 0, `missing end marker: ${END}`);
  return source.slice(bodyStart, end).replace(/`;\s*$/, '');
}

function compile(script, label) {
  const neutralized = script.replace(/\$\{[^}]*\}/g, 'null');
  assert.doesNotThrow(() => new Function(neutralized), `${label} must be valid JavaScript`);
}

console.log('injected_script_syntax');

compile(extractScript(), 'autonomousTypeIntoElement page script');

console.log('  ✓ typing page script compiles');
console.log('\n1 injected-script syntax test passed');
