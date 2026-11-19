/**
 * Order execution: user bola "ctrl+shift+esc press karo" (Task Manager khulta hai — harmless).
 * Full Adion chain: user text -> planByRules -> actions.run('press') -> verify Task Manager.
 * Usage on PC (run from "D:\Adion Browse"): node "tool scan\order-press.js"
 */
'use strict';
const { createSidecar } = require('../src/pc/sidecarClient');
const { createScreenWatch } = require('../src/pc/screenWatch');
const { createDesktopActions } = require('../src/pc/desktopActions');
const engine = require('../src/pc/index');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const userCmd = 'press ctrl+shift+esc';
  // 1. Adion plans the user command
  const planned = engine.planByRules(userCmd);
  console.log('PLAN: "' + userCmd + '" -> ' + JSON.stringify(planned && planned.action));
  if (!planned || !planned.action || planned.action.name !== 'press') {
    throw new Error('planner ne press me convert nahi kiya: ' + JSON.stringify(planned));
  }

  // 2. Sidecars up
  const probe = createSidecar({ name: 'probe.ps1', log: () => {} });
  probe.start();
  let ok = false;
  for (let i = 0; i < 200 && !ok; i++) { await sleep(150); ok = probe.available === true; }
  if (!ok) throw new Error('probe sidecar up nahi hua');
  console.log('OK probe up');

  const input = createSidecar({ name: 'input.ps1', log: () => {} });
  input.start();
  let iok = false;
  for (let i = 0; i < 40 && !iok; i++) { await sleep(150); iok = input.available === true; }
  if (!iok) throw new Error('input sidecar up nahi hua (real press ke bina verify nahi hoga)');
  console.log('OK input up');

  // 3. Adion executes the press
  const watch = createScreenWatch({ probe, log: () => {} });
  const actions = createDesktopActions({ probe, input, launchApp: null, log: () => {}, watch });
  const r = await actions.run(planned.action.name, planned.action.args, {});
  console.log('EXEC: ok=' + r.ok + ' report=' + r.report);
  if (!r.ok) throw new Error('press fail: ' + r.report);

  // 4. Audit: Task Manager dikha?
  await sleep(1500);
  let found = null;
  try { found = await watch.findWindow({ name: 'Task Manager' }); } catch (_) {}
  if (!found || !found.found) {
    try { found = await watch.findWindow({ process: 'Taskmgr' }); } catch (_) {}
  }
  console.log('VERIFY: ' + JSON.stringify(found && { found: found.found, title: found.title, process: found.process }));
  if (!found || !found.found) throw new Error('Task Manager window confirm nahi hui');

  probe.stop();
  try { input.stop(); } catch (_) {}
  console.log('ORDER DONE: ctrl+shift+esc pressed, Task Manager khula hai');
}

main().catch((e) => { console.error('ORDER FAILED:', e.message); process.exit(1); });
