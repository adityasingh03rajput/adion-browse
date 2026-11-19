/**
 * Wire tool-scan into Adion Browse (src/pc/*) — kills 4 real gaps:
 *  G1 win.list: nothing enumerates open windows (open_app only win.finds).
 *  G2 OCR: src/pc/ocr.js recognizeText has ZERO callers; read dies on canvas.
 *  G3 describe: planner "does NOT see pixels"; no vision orientation path.
 *  G4 whole virtual-screen PNG (Electron capture is per-display, downscaled).
 *
 *  Edits (all idempotent, sentinel-first):
 *   src/pc/index.js — create + expose screenWatch, pass to desktopActions.
 *   src/pc/desktopActions.js — read() OCR fallback; new actions windows,
 *     find_window, screenshot, describe_screen.
 *   src/pc/planner.js — vocabulary/TYPE_MAP/normalize/SYSTEM_PROMPT/rules.
 * Requires src/pc/screen-shot.ps1 (copy from tool scan BEFORE running).
 * Usage on PC: node patch-watch.js (run from "D:\Adion Browse")
 */
'use strict';
const fs = require('fs');
const path = require('path');
const child = require('child_process');

const ROOT = process.cwd();
const IDX = path.join(ROOT, 'src', 'pc', 'index.js');
const ACT = path.join(ROOT, 'src', 'pc', 'desktopActions.js');
const PLN = path.join(ROOT, 'src', 'pc', 'planner.js');
const SHOT = path.join(ROOT, 'src', 'pc', 'screen-shot.ps1');

function rep(file, label, oldStr, newStr, sentinel) {
  let s = fs.readFileSync(file, 'utf8');
  if (sentinel && s.includes(sentinel)) { console.log(`SKIP ${label}: already patched`); return; }
  const count = s.split(oldStr).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 occurrence, found ${count}`);
  fs.writeFileSync(file, s.split(oldStr).join(newStr));
  console.log(`OK ${label}`);
}

async function main() {
  for (const f of [IDX, ACT, PLN]) if (!fs.existsSync(f)) throw new Error('missing: ' + f);
  if (!fs.existsSync(SHOT)) throw new Error('missing src\\pc\\screen-shot.ps1 — copy it from "tool scan" first');

  // Backups (once).
  for (const f of [IDX, ACT, PLN]) {
    if (!fs.existsSync(f + '.bak-watch')) { fs.copyFileSync(f, f + '.bak-watch'); console.log('OK backup: ' + path.basename(f) + '.bak-watch'); }
  }

  // ---- index.js ----
  rep(IDX, 'engine require watch',
`const { createDesktopActions } = require('./desktopActions');`,
`const { createDesktopActions } = require('./desktopActions');
const { createScreenWatch } = require('./screenWatch');`,
`require('./screenWatch')`);

  rep(IDX, 'engine create watch',
`  const desktopActions = createDesktopActions({ probe, input, launchApp, log, selfPid });`,
`  // screenWatch: the tool-scan scanner wired in — win.list, whole-screen
  // shots, OCR reads and vision descriptions that the planner actions use.
  const watch = createScreenWatch({ probe, log, workDir: userDataPath || undefined, selfPid });
  const desktopActions = createDesktopActions({ probe, input, launchApp, log, selfPid, watch });`,
`createScreenWatch({ probe, log`);

  rep(IDX, 'engine expose watch',
`    runbooks,
    actions,
    sidecars: { probe, input },`,
`    runbooks,
    actions,
    watch,
    sidecars: { probe, input },`,
`\n    watch,`);

  // ---- desktopActions.js ----
  rep(ACT, 'actions accept watch',
`  const { probe, input } = deps;`,
`  const { probe, input } = deps;
  const watch = deps.watch || null; // screenWatch (tool-scan wiring); null-safe everywhere`,
`deps.watch || null; // screenWatch`);

  rep(ACT, 'read OCR fallback',
`      if (!text) {
        return {
          ok: false,
          report: \`"\${where}" exposes no readable text — it may be a canvas, or an app whose accessibility tree is off (Chrome/Electron need it enabled)\`
        };
      }`,
`      if (!text && watch) {
        // Real gap: canvas apps expose no UIA text, so read the screen with
        // OCR (tool-scan wiring) instead of failing outright.
        try {
          const snap = await watch.readScreen();
          const otext = String((snap && snap.text) || '').trim();
          if (otext) {
            return {
              ok: true,
              report: \`read the screen with OCR (\${otext.length} chars — the window exposes no accessible text)\`,
              text: otext.slice(0, 60000), chars: otext.length, source: 'ocr', file: snap.file, settle: 0
            };
          }
        } catch (_) { /* fall through to the honest failure below */ }
      }
      if (!text) {
        return {
          ok: false,
          report: \`"\${where}" exposes no readable text — it may be a canvas, or an app whose accessibility tree is off (Chrome/Electron need it enabled)\`
        };
      }`,
`read the screen with OCR`);

  rep(ACT, 'new watch actions',
`    async wait(args) {`,
`    async windows() {
      if (!watch) return { ok: false, report: 'window list is not available (screenWatch missing)' };
      const list = await watch.windows();
      if (!list.length) return { ok: true, report: 'no top-level windows reported', windows: [], settle: 0 };
      const shown = list.slice(0, 12).map((w) => \`"\${(w.title || '(no title)').slice(0, 50)}" (\${w.process || '?'})\`).join('; ');
      return {
        ok: true,
        report: \`\${list.length} windows: \${shown}\${list.length > 12 ? \` (+\${list.length - 12} more)\` : ''}\`,
        windows: list, settle: 0
      };
    },

    async find_window(args) {
      if (!watch) return { ok: false, report: 'window search is not available (screenWatch missing)' };
      const name = String(args.name || args.text || args.window || '').trim();
      const proc = String(args.process || '').trim();
      if (!name && !proc) return { ok: false, report: 'find_window needs a name or process' };
      const hit = await watch.findWindow({ name: name || undefined, process: proc || undefined });
      if (!hit || !hit.found) return { ok: false, report: \`no window matching "\${clip(name || proc, 60)}"\`, settle: 0 };
      return {
        ok: true,
        report: \`found "\${String(hit.title || hit.process || name).slice(0, 60)}"\`,
        window: { hwnd: hit.hwnd, process: hit.process, title: hit.title, rect: hit.rect || null }, settle: 0
      };
    },

    async screenshot() {
      if (!watch) return { ok: false, report: 'screenshots are not available (screenWatch missing)' };
      const shot = await watch.screenshot();
      if (!shot.ok) return { ok: false, report: \`screenshot failed: \${shot.note || 'unknown'}\`, settle: 0 };
      return { ok: true, report: \`saved whole-screen shot to \${shot.file}\`, file: shot.file, virtualScreen: shot.virtualScreen || null, settle: 0 };
    },

    async describe_screen(args) {
      if (!watch) return { ok: false, report: 'screen description is not available (screenWatch missing)' };
      const d = await watch.describeScreen(args.prompt || args.text || '');
      if (!d.ok) return { ok: false, report: \`describe failed: \${d.note || 'unknown'}\`, settle: 0 };
      return { ok: true, report: 'described the screen', description: d.text, file: d.file, settle: 0 };
    },

    async wait(args) {`,
`async describe_screen(args)`);

  // ---- planner.js ----
  rep(PLN, 'planner action types',
`const PC_ACTION_TYPES = new Set(['click', 'type', 'press', 'scroll', 'open_app', 'read', 'wait', 'look']);`,
`const PC_ACTION_TYPES = new Set(['click', 'type', 'press', 'scroll', 'open_app', 'read', 'wait', 'look', 'list_windows', 'find_window', 'screenshot', 'describe_screen']);`,
`'list_windows', 'find_window'`);

  rep(PLN, 'planner type map',
`  LOOK: 'look', SCREENSHOT: 'look'
};`,
`  LOOK: 'look', SCREENSHOT: 'screenshot',
  LIST_WINDOWS: 'list_windows', WINDOWS: 'list_windows', LIST: 'list_windows',
  FIND_WINDOW: 'find_window', FIND: 'find_window',
  DESCRIBE: 'describe_screen', DESCRIBE_SCREEN: 'describe_screen', WHAT_AM_I_LOOKING_AT: 'describe_screen',
  READ_SCREEN: 'read', OCR: 'read'
};`,
`DESCRIBE_SCREEN: 'describe_screen'`);

  rep(PLN, 'planner normalize new',
`  if (name === 'scroll') args.direction = String(args.direction || 'down').toLowerCase();`,
`  if (name === 'scroll') args.direction = String(args.direction || 'down').toLowerCase();
  if (name === 'find_window') args.name = args.name || args.text || args.window || '';
  if (name === 'describe_screen') args.prompt = args.prompt || args.text || '';`,
`if (name === 'find_window')`);

  rep(PLN, 'planner mission pixels',
`  'Drive the FOREGROUND WINDOW on a real Windows PC. You see the window and its interactive controls; you do NOT see pixels. Your architecture prioritizes RELIABILITY, SAFETY, and COST-EFFICIENCY.',`,
`  'Drive the FOREGROUND WINDOW on a real Windows PC. You see the window and its interactive controls; you do NOT see pixels directly — use describe_screen for a visual description when the control list is empty. Your architecture prioritizes RELIABILITY, SAFETY, and COST-EFFICIENCY.',`,
`describe_screen for a visual description`);

  rep(PLN, 'planner vocabulary',
`  '6. read() — read window text for Q&A tasks',
  '7. wait(ms) — brief pause for async updates',`,
`  '6. read() — read window text for Q&A tasks (falls back to screen OCR when the app exposes no text)',
  '7. wait(ms) — brief pause for async updates',
  '8. list_windows() — list open windows when the target is not the foreground window',
  '9. find_window(name) — check a window by app/title (e.g. {"name": "find_window", "args": {"name": "notepad"}})',
  '10. screenshot() — save a whole-screen PNG, returns its file path',
  '11. describe_screen() — ask the vision model what the screen shows (recovery when controls are empty)',`,
`'11. describe_screen()`);

  rep(IDX, 'engine rules watch',
`  if (/^(?:read|summari[sz]e|what does this (?:say|do)|read this)/i.test(text)) {`,
`  match = text.match(/^(?:(?:list|show)\\s+(?:open\\s+|all\\s+)?windows|what\\s+windows\\s+are\\s+open)$/i);
  if (match) return { action: { name: 'list_windows', args: {} }, instruction: 'List open windows' };

  match = text.match(/^(?:describe|what).*(?:screen|showing|display)|^where am i$/i);
  if (match && !/what does this (?:say|do)/i.test(text)) {
    return { action: { name: 'describe_screen', args: {} }, instruction: 'Describe the screen' };
  }

  if (/^(?:read|summari[sz]e|what does this (?:say|do)|read this)/i.test(text)) {`,
`instruction: 'Describe the screen'`);

  // ---- checks ----
  for (const f of [IDX, ACT, PLN]) {
    child.execSync(`node --check "${f}"`, { stdio: 'pipe' });
    console.log('OK node --check ' + path.basename(f));
  }
  // headless load (no Electron on this box needed)
  child.execSync(`node -e "require('./src/pc/index.js');require('./src/pc/desktopActions.js');require('./src/pc/planner.js');require('./src/pc/screenWatch.js');console.log('LOAD_OK')"`, { stdio: 'pipe', cwd: ROOT });
  console.log('OK headless load');
  {
    const a = fs.readFileSync(ACT, 'utf8');
    const c = (t) => a.split(t).length - 1;
    const markers = { watchDep: c('deps.watch || null'), ocrFb: c('read the screen with OCR'), wActs: c('async windows() {'), fwActs: c('async find_window(args) {'), shotActs: c('async screenshot() {'), descActs: c('async describe_screen(args) {') };
    console.log(JSON.stringify(markers));
    if (Object.values(markers).some((v) => v !== 1)) throw new Error('desktopActions marker mismatch');
    const p = fs.readFileSync(PLN, 'utf8');
    const pc = (t) => p.split(t).length - 1;
    const pm = { types: pc("'list_windows', 'find_window'"), map: pc("DESCRIBE_SCREEN: 'describe_screen'"), norm: pc("if (name === 'find_window')"), vocab: pc("'11. describe_screen()") };
    console.log(JSON.stringify(pm));
    if (Object.values(pm).some((v) => v !== 1)) throw new Error('planner marker mismatch');
    const i = fs.readFileSync(IDX, 'utf8');
    const ic = (t) => i.split(t).length - 1;
    const im = { req: ic("require('./screenWatch')"), create: ic('createScreenWatch({ probe, log'), expose: ic('\n    watch,'), rules: ic("instruction: 'Describe the screen'") };
    console.log(JSON.stringify(im));
    if (Object.values(im).some((v) => v !== 1)) throw new Error('index marker mismatch');
  }
  console.log('WATCH DONE');
}

main().catch((e) => { console.error('WATCH FAILED:', e.message); process.exit(1); });
