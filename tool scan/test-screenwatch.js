/**
 * Headless end-to-end test for the tool-scan -> Adion wiring (no Electron).
 * Spins the REAL probe sidecar, drives screenWatch + the new planner actions,
 * and proves the 4 gaps are closed on this machine.
 * Usage on PC: node test-screenwatch.js (run from "D:\Adion Browse")
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const { createSidecar } = require('../src/pc/sidecarClient');
const { createScreenWatch } = require('../src/pc/screenWatch');
const { createDesktopActions } = require('../src/pc/desktopActions');
const { planByRules, normalizeAction, PC_ACTION_TYPES } = (() => {
  const planner = require('../src/pc/planner');
  const engine = require('../src/pc/index');
  return { planByRules: engine.planByRules, normalizeAction: planner.normalizeAction, PC_ACTION_TYPES: planner.PC_ACTION_TYPES };
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, cond, extra) {
  results.push([name, cond ? 'PASS' : 'FAIL' + (extra ? ' ' + extra : '')]);
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra && !cond ? ' ' + extra : ''));
}

async function main() {
  // 0. planner vocabulary + rules (pure, no sidecar)
  check('T0 types', PC_ACTION_TYPES.has('list_windows') && PC_ACTION_TYPES.has('describe_screen')
    && PC_ACTION_TYPES.has('find_window') && PC_ACTION_TYPES.has('screenshot'));
  check('T0 normalize', (normalizeAction({ name: 'SCREENSHOT' }) || {}).name === 'screenshot'
    && (normalizeAction({ name: 'DESCRIBE' }) || {}).name === 'describe_screen'
    && (normalizeAction({ name: 'WINDOWS' }) || {}).name === 'list_windows');
  const r1 = planByRules('list open windows');
  check('T0 rule windows', r1 && r1.action && r1.action.name === 'list_windows', JSON.stringify(r1));
  const r2 = planByRules('describe the screen');
  check('T0 rule describe', r2 && r2.action && r2.action.name === 'describe_screen', JSON.stringify(r2));
  const r3 = planByRules('what does this say');
  check('T0 rule read intact', r3 && r3.action && r3.action.name === 'read', JSON.stringify(r3));

  // 1. real probe sidecar
  const probe = createSidecar({ name: 'probe.ps1', log: () => {} });
  probe.start();
  let ok = false;
  for (let i = 0; i < 200 && !ok; i++) { await sleep(150); ok = probe.available === true; }
  check('T1 probe available', ok);
  if (!ok) throw new Error('probe sidecar did not become available');

  const watch = createScreenWatch({ probe, log: () => {} });
  check('T1 watch available', watch.available());

  // 2. G1: window enumeration
  const wins = await watch.windows();
  check('T2 win.list', Array.isArray(wins) && wins.length > 0 && wins[0].hwnd != null,
    `n=${Array.isArray(wins) ? wins.length : '?'}`);
  console.log('  fg-sample: ' + JSON.stringify(wins.slice(0, 3).map((w) => `${w.process} — ${String(w.title).slice(0, 40)}`)));

  // 3. G4: whole virtual-screen screenshot
  const shot = await watch.screenshot('test-watch');
  check('T3 screenshot', shot.ok && shot.file && fs.existsSync(shot.file),
    JSON.stringify({ ok: shot.ok, file: shot.file, note: shot.note }));
  if (shot.ok) console.log('  shot bytes: ' + fs.statSync(shot.file).size);

  // 4. element under cursor point (probe self-check)
  const el = await watch.elementAt(20, 20);
  check('T4 frompoint shape', el === null || typeof el === 'object');

  // 5. G2: OCR read (recognizeText now has a caller)
  const ocr = await watch.readScreen();
  check('T5 readScreen', ocr.ok && typeof ocr.text === 'string' && fs.existsSync(ocr.file),
    JSON.stringify({ ok: ocr.ok, chars: ocr.chars, note: ocr.note }));
  if (ocr.ok) console.log('  ocr first 120: ' + JSON.stringify(String(ocr.text).slice(0, 120)));

  // 6. G3: vision description (needs GROQ_API_KEY in .env)
  const desc = await watch.describeScreen('One sentence: what app window is in front?');
  if (!process.env.GROQ_API_KEY) {
    check('T6 describe skipped (no key)', desc.ok === false && /GROQ/.test(desc.note || ''));
  } else {
    check('T6 describe', desc.ok && desc.text.length > 10, JSON.stringify({ ok: desc.ok, note: desc.note }));
    if (desc.ok) console.log('  describe: ' + desc.text.slice(0, 200));
  }

  // 7. combined scan
  const rep = await watch.scan({ elements: false, windowText: false, ocr: false, describe: false });
  check('T7 scan', Array.isArray(rep.windows) && rep.shot && rep.shot.ok && rep.foreground && rep.foreground.hwnd != null,
    `wins=${(rep.windows || []).length} shot=${rep.shot && rep.shot.ok}`);

  // 8. desktopActions wiring (headless; input stub — these paths never touch it)
  const actions = createDesktopActions({ probe, input: null, launchApp: null, log: () => {}, watch });
  const w = await actions.run('windows', {}, {});
  check('T8 action windows', w.ok && Array.isArray(w.windows) && w.windows.length > 0, w.report);
  const s = await actions.run('screenshot', {}, {});
  check('T8 action screenshot', s.ok && s.file && fs.existsSync(s.file), s.report);
  // read fallback: force empty UIA text via a bogus hwnd? uia.text on hwnd 0 may error or return ''.
  // Either way the action must not crash and must report honestly.
  const rd = await actions.run('read', {}, { fg: { hwnd: 0, title: 'bogus' } });
  check('T8 action read honest', typeof rd.report === 'string' && rd.report.length > 0, rd.report);
  const fw = await actions.run('find_window', { name: 'definitely-not-a-real-window-xyz' }, {});
  check('T8 action find_window miss', fw.ok === false && /no window/.test(fw.report), fw.report);
  const unk = await actions.run('nope_not_real', {}, {});
  check('T8 unknown action', unk.ok === false, unk.report);

  probe.stop();
  const failed = results.filter(([, r]) => !r.startsWith('PASS'));
  console.log(failed.length ? `SCREENWATCH ${results.length - failed.length}/${results.length} passed` : `SCREENWATCH ALL ${results.length} PASSED`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error('SCREENWATCH FAILED:', e.message); process.exitCode = 1; });
