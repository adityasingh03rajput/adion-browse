/**
 * Diagnose: does the Win+X system menu appear in UIA? Opens it, checks, closes with Esc.
 * Transient + harmless (menu opens, Esc closes, nothing launches).
 * Usage on PC (run from "D:\Adion Browse"): node "tool scan\diag-menu.js"
 */
'use strict';
const { createSidecar } = require('../src/pc/sidecarClient');
const { createScreenWatch } = require('../src/pc/screenWatch');
const { createDesktopActions } = require('../src/pc/desktopActions');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const probe = createSidecar({ name: 'probe.ps1', log: () => {} });
  probe.start();
  let ok = false;
  for (let i = 0; i < 200 && !ok; i++) { await sleep(150); ok = probe.available === true; }
  if (!ok) throw new Error('probe up nahi hua');
  const input = createSidecar({ name: 'input.ps1', log: () => {} });
  input.start();
  let iok = false;
  for (let i = 0; i < 40 && !iok; i++) { await sleep(150); iok = input.available === true; }
  if (!iok) throw new Error('input up nahi hua');

  const watch = createScreenWatch({ probe, log: () => {} });
  const { actions } = createDesktopActions({ probe, input, launchApp: null, log: () => {}, watch });

  const before = await watch.foreground().catch(() => null);
  console.log('FG-BEFORE: ' + JSON.stringify(before && { process: before.process, title: (before.title || '').slice(0, 60) }));

  const p = await actions.press({ keys: 'win+x' });
  console.log('PRESS win+x: ok=' + p.ok + ' report=' + p.report);
  await sleep(900);

  const wins = await watch.windows().catch(() => []);
  console.log('WINDOWS n=' + wins.length);
  wins.slice(0, 8).forEach((w) => console.log('  win: ' + w.process + ' — ' + String(w.title || '').slice(0, 70)));

  const fg = await watch.foreground().catch(() => null);
  console.log('FG-AFTER: ' + JSON.stringify(fg && { hwnd: fg.hwnd, process: fg.process, title: (fg.title || '').slice(0, 80), rect: fg.rect }));

  if (fg && fg.hwnd) {
    try {
      const r = await probe.request('uia.list', { hwnd: fg.hwnd, max: 150, budgetMs: 1500 }, 12000);
      const els = (r && r.elements) || [];
      console.log('UIA n=' + els.length + ' truncated=' + Boolean(r && r.truncated));
      const hits = els.filter((e) => /event viewer/i.test(String((e && e.name) || '')));
      console.log('EVENT-VIEWER-HITS n=' + hits.length);
      hits.slice(0, 5).forEach((e) => console.log('  hit: ' + JSON.stringify({ name: e.name, type: e.type, rect: e.rect })));
      console.log('NAMES: ' + els.slice(0, 25).map((e) => JSON.stringify(String((e && e.name) || '').slice(0, 40))).join(' | '));
    } catch (e) { console.log('UIA-ERROR: ' + e.message); }
  }

  const esc = await actions.press({ keys: 'esc' }).catch((e) => ({ ok: false, report: e.message }));
  console.log('ESC: ok=' + esc.ok);
  await sleep(400);
  const fg2 = await watch.foreground().catch(() => null);
  console.log('FG-CLOSED: ' + JSON.stringify(fg2 && { process: fg2.process, title: (fg2.title || '').slice(0, 60) }));

  probe.stop();
  try { input.stop(); } catch (_) {}
  console.log('DIAG-MENU DONE');
}

main().catch((e) => { console.error('DIAG-MENU FAILED:', e.message); process.exit(1); });
