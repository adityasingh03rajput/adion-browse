/**
 * Diagnose PopupHost UIA content. Opens Win+X, dumps uia.list for every
 * untitled/small top window, closes with Esc. Harmless + transient.
 * Usage on PC (run from "D:\Adion Browse"): node "tool scan\diag-popup.js"
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

  await actions.press({ keys: 'win+x' });
  await sleep(1000);
  const wins = await watch.windows();
  const cands = wins.filter((w) => w && w.hwnd).sort((a, b) => String(a.title || '').length - String(b.title || '').length).slice(0, 10);
  for (const w of cands) {
    const r = String(w.rect ? `${w.rect.x},${w.rect.y} ${w.rect.w}x${w.rect.h}` : 'n/a');
    console.log(`WIN hwnd=${w.hwnd} proc=${w.process} title=${JSON.stringify(String(w.title || '').slice(0, 40))} rect=${r}`);
    try {
      const l = await probe.request('uia.list', { hwnd: w.hwnd, max: 60, budgetMs: 1500 }, 8000);
      const els = (l && l.elements) || [];
      console.log(`  UIA n=${els.length} trunc=${Boolean(l && l.truncated)}`);
      const hits = els.filter((e) => /event/i.test(String((e && e.name) || '')));
      hits.slice(0, 8).forEach((e) => console.log(`  HIT name=${JSON.stringify(String(e.name || '').slice(0, 60))} type=${e.type}`));
      if (!hits.length) console.log('  names: ' + els.slice(0, 12).map((e) => JSON.stringify(String((e && e.name) || '').slice(0, 30))).join(' | '));
    } catch (e) { console.log('  UIA-ERR: ' + e.message); }
  }
  await actions.press({ keys: 'esc' }).catch(() => {});
  probe.stop();
  try { input.stop(); } catch (_) {}
  console.log('DIAG-POPUP DONE');
}

main().catch((e) => { console.error('DIAG-POPUP FAILED:', e.message); process.exit(1); });
