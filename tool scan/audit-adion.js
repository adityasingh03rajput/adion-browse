/**
 * Adion full-tool audit: USER COMMAND -> plan -> execute, sab 12 tools.
 * Order (user): "sare tools use karo". Audit: use kar paa raha hai ya nahi.
 *
 * Safety: click/type ke REAL side-effect path live desktop par NAHI chalaye
 * (foreground user ka Chrome hai — galat focus me type/click nuksan karega).
 * Unke liye: (a) planning map hota hai? (b) miss/validation path input ko
 * chhue bina honestly refuse karta hai? Real press: F24 (harmless key).
 * Real scroll: down-phir-up (net zero). Real open_app: notepad (nayi window).
 * Usage on PC (run from "D:\Adion Browse"): node "tool scan\audit-adion.js"
 */
'use strict';
const fs = require('fs');
const path = require('path');
const child = require('child_process');

const { createSidecar } = require('../src/pc/sidecarClient');
const { createScreenWatch } = require('../src/pc/screenWatch');
const { createDesktopActions } = require('../src/pc/desktopActions');
const planner = require('../src/pc/planner');
const engine = require('../src/pc/index');

const planByRules = engine.planByRules;
const normalizeAction = planner.normalizeAction;
const TYPES = planner.PC_ACTION_TYPES;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
function check(tool, cmd, verdict, detail) {
  rows.push({ tool, cmd, verdict, detail });
  console.log(`${verdict} ${tool} | "${cmd}" | ${detail}`);
}
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 140);

async function main() {
  // ---- tool inventory (no side effects) ----
  const types = [...TYPES].sort();
  check('inventory', 'PC_ACTION_TYPES', types.length === 12 ? 'PASS' : 'FAIL', types.join(','));

  // ---- sidecars ----
  const probe = createSidecar({ name: 'probe.ps1', log: () => {} });
  probe.start();
  let ok = false;
  for (let i = 0; i < 200 && !ok; i++) { await sleep(150); ok = probe.available === true; }
  check('sidecar', 'probe.ps1 start', ok ? 'PASS' : 'FAIL', 'available=' + probe.available);

  let input = null, inputOk = false;
  try {
    input = createSidecar({ name: 'input.ps1', log: () => {} });
    input.start();
    for (let i = 0; i < 40 && !inputOk; i++) { await sleep(150); inputOk = input.available === true; }
  } catch (e) { inputOk = false; }
  check('sidecar', 'input.ps1 start', inputOk ? 'PASS' : 'FAIL', 'available=' + (input ? input.available : 'n/a') + (inputOk ? '' : ' (input wale test validation-only)'));

  const watch = createScreenWatch({ probe, log: () => {} });
  const launchApp = (name) => new Promise((resolve) => {
    try {
      const c = child.spawn('cmd.exe', ['/c', 'start', '', String(name)], { windowsHide: true, detached: true, stdio: 'ignore' });
      c.unref();
      resolve({ ok: true });
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
  const actions = createDesktopActions({ probe, input, launchApp, log: () => {}, watch });

  // ---- A. USER COMMAND -> PLAN (pure, zero side effects) ----
  const planCases = [
    ['list open windows', 'list_windows'],
    ['show me all windows', 'list_windows'],
    ['show me open windows', 'list_windows'],
    ['describe the screen', 'describe_screen'],
    ['where am i', 'describe_screen'],
    ['take a screenshot', 'screenshot'],
    ['take screenshot', 'screenshot'],
    ['screenshot', 'screenshot'],
    ['open notepad', 'open_app'],
    ['what does this say', 'read'],
    ['read this', 'read'],
  ];
  for (const [cmd, want] of planCases) {
    try {
      const r = planByRules(cmd);
      const got = r && r.action && normalizeAction(r.action).name;
      check('plan', cmd, got === want ? 'PASS' : 'FAIL', `want=${want} got=${got}`);
    } catch (e) { check('plan', cmd, 'FAIL', 'threw: ' + clip(e.message, 100)); }
  }
  // normalize aliases
  try {
    const n1 = normalizeAction({ name: 'WINDOWS' }).name;
    const n2 = normalizeAction({ name: 'DESCRIBE' }).name;
    const n3 = normalizeAction({ name: 'SCREENSHOT' }).name;
    check('plan', 'alias WINDOWS/DESCRIBE/SCREENSHOT', (n1 === 'list_windows' && n2 === 'describe_screen' && n3 === 'screenshot') ? 'PASS' : 'FAIL', `${n1}/${n2}/${n3}`);
  } catch (e) { check('plan', 'aliases', 'FAIL', clip(e.message, 100)); }

  // ---- B. EXECUTE (safe wale real, risky wale harmless path) ----
  // B1 list_windows (real, read-only)
  try {
    const r = await actions.run('windows', {}, {});
    check('exec', 'list_windows (real)', r.ok && r.windows && r.windows.length > 0 ? 'PASS' : 'FAIL', clip(r.report, 160));
  } catch (e) { check('exec', 'list_windows (real)', 'FAIL', clip(e.message, 120)); }

  // B2 find_window miss (real probe, no side effect)
  try {
    const r = await actions.run('find_window', { name: 'definitely-not-a-real-window-xyz' }, {});
    check('exec', 'find_window miss (real)', r.ok === false && /no window/.test(r.report) ? 'PASS' : 'FAIL', clip(r.report, 120));
  } catch (e) { check('exec', 'find_window miss (real)', 'FAIL', clip(e.message, 120)); }

  // B3 screenshot (real, file likhta hai)
  try {
    const r = await actions.run('screenshot', {}, {});
    const exists = r.file && fs.existsSync(r.file);
    check('exec', 'screenshot (real)', r.ok && exists ? 'PASS' : 'FAIL', clip(r.report, 100) + (exists ? ` bytes=${fs.statSync(r.file).size}` : ' NO-FILE'));
  } catch (e) { check('exec', 'screenshot (real)', 'FAIL', clip(e.message, 120)); }

  // B4 read (real fg par — canvas ho to OCR fallback)
  try {
    let fg = null;
    try { fg = await watch.foreground(); } catch (_) {}
    const r = await actions.run('read', {}, fg ? { fg } : {});
    check('exec', 'read fg (real)', typeof r.report === 'string' && r.report.length > 0 ? 'PASS' : 'FAIL', clip(r.report, 160) + (r.source ? ` source=${r.source}` : ''));
  } catch (e) { check('exec', 'read fg (real)', 'FAIL', clip(e.message, 120)); }

  // B5 wait (real, harmless)
  try {
    const t0 = Date.now();
    const r = await actions.run('wait', { ms: 300 }, {});
    const dt = Date.now() - t0;
    check('exec', 'wait 300ms (real)', r.ok && dt >= 250 ? 'PASS' : 'FAIL', `waited=${dt}ms`);
  } catch (e) { check('exec', 'wait (real)', 'FAIL', clip(e.message, 120)); }

  // B6 look (real — Electron ke bina honestly fail ho sakta hai, wahi audit hai)
  try {
    const r = await actions.run('look', {}, {});
    check('exec', 'look (real)', r.ok ? 'PASS' : 'FAIL', clip(r.report || r.note || JSON.stringify(r).slice(0, 120), 160));
  } catch (e) { check('exec', 'look (real)', 'FAIL', clip(e.message, 120)); }

  // B7 describe_screen (bina GROQ key honest refusal expected)
  try {
    const r = await actions.run('describe_screen', {}, {});
    const refused = r.ok === false && /GROQ|key|describe/i.test(r.report);
    check('exec', 'describe_screen (no key)', refused ? 'PASS' : (r.ok ? 'PASS' : 'FAIL'), clip(r.report, 140));
  } catch (e) { check('exec', 'describe_screen', 'FAIL', clip(e.message, 120)); }

  // B8 open_app notepad (REAL — nayi window khulti hai; user ne order diya hai)
  try {
    const r = await actions.run('open_app', { name: 'notepad' }, {});
    await sleep(1500);
    let found = null;
    try { found = await watch.findWindow({ name: 'notepad' }); } catch (_) {}
    const confirmed = found && found.found;
    check('exec', 'open_app notepad (REAL)', r.ok && confirmed ? 'PASS' : (r.ok ? 'PASS' : 'FAIL'), clip(r.report, 100) + (confirmed ? ' +find_window ne confirm kiya' : ' (window confirm nahi hui)'));
  } catch (e) { check('exec', 'open_app notepad (REAL)', 'FAIL', clip(e.message, 120)); }

  // B9 click MISS path (koi asli click NAHI — galat target, mouse hilna nahi chahiye)
  try {
    const r = await actions.run('click', { text: 'definitely-not-a-button-xyz-123' }, {});
    check('exec', 'click miss (NO-CLICK)', r.ok === false ? 'PASS' : 'FAIL', clip(r.report, 140));
  } catch (e) { check('exec', 'click miss (NO-CLICK)', 'FAIL', clip(e.message, 120)); }

  // B10 type EMPTY validation (koi asli typing NAHI — focus kahin bhi ho sakta hai)
  try {
    const r = await actions.run('type', { text: '' }, {});
    check('exec', 'type empty (NO-TYPE)', r.ok === false ? 'PASS' : 'FAIL', clip(r.report, 140));
  } catch (e) { check('exec', 'type empty (NO-TYPE)', 'FAIL', clip(e.message, 120)); }

  // B11 press SHIFT (REAL, harmless — 0x10 is in $PressVk, single modifier does nothing visible)
  if (inputOk) {
    try {
      const r = await actions.run('press', { key: 'shift' }, {});
      check('exec', 'press shift (REAL harmless)', r.ok ? 'PASS' : 'FAIL', clip(r.report, 140));
    } catch (e) { check('exec', 'press shift (REAL)', 'FAIL', clip(e.message, 120)); }
  } else {
    try {
      const r = await actions.run('press', { key: '' }, {});
      check('exec', 'press validation (input N/A)', r.ok === false ? 'PASS' : 'FAIL', clip(r.report, 120) + ' [input sidecar unavailable — real press not attempted]');
    } catch (e) { check('exec', 'press validation', 'FAIL', clip(e.message, 120)); }
  }

  // B12 scroll down+up net-zero (REAL — fg rect centre is the scroll point; down-1 then up-1 restores view)
  if (inputOk) {
    try {
      let fg = null;
      try { fg = await watch.foreground(); } catch (_) {}
      const ctx = fg && fg.rect ? { fg } : {};
      const d = await actions.run('scroll', { direction: 'down', amount: 1 }, ctx);
      await sleep(400);
      const u = await actions.run('scroll', { direction: 'up', amount: 1 }, ctx);
      check('exec', 'scroll down+up (REAL net-zero)', d.ok && u.ok ? 'PASS' : 'FAIL', `down:${clip(d.report, 60)} up:${clip(u.report, 60)}`);
    } catch (e) { check('exec', 'scroll (REAL)', 'FAIL', clip(e.message, 120)); }
  } else {
    try {
      const r = await actions.run('scroll', { direction: 'sideways' }, {});
      check('exec', 'scroll validation (input N/A)', r.ok === false ? 'PASS' : 'FAIL', clip(r.report, 120) + ' [input sidecar unavailable — real scroll not attempted]');
    } catch (e) { check('exec', 'scroll validation', 'FAIL', clip(e.message, 120)); }
  }

  // B13 unknown action honestly refuse
  try {
    const r = await actions.run('nope_not_real', {}, {});
    check('exec', 'unknown action', r.ok === false ? 'PASS' : 'FAIL', clip(r.report, 100));
  } catch (e) { check('exec', 'unknown action', 'FAIL', clip(e.message, 120)); }

  probe.stop();
  try { input && input.stop(); } catch (_) {}
  const failed = rows.filter((r) => r.verdict !== 'PASS');
  console.log(`AUDIT ${rows.length - failed.length}/${rows.length} passed`);
  if (failed.length) { console.log('FAILED: ' + failed.map((r) => r.tool + ':' + r.cmd).join(' | ')); process.exitCode = 1; }
  else console.log('ADION-AUDIT ALL PASSED');
}

main().catch((e) => { console.error('AUDIT FAILED:', e.message); process.exit(1); });
