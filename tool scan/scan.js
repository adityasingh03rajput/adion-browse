/**
 * Adion Browse — tool scan: whole-screen scanner.
 *
 * One CLI that asks the OS what it put on screen:
 *   screenshot (whole virtual screen) -> PNG
 *   windows    (Win32 top-level list)  -> hwnd/title/process/rect
 *   elements   (UI Automation tree)    -> name/type/rect per control
 *   text       (UIA TextPattern)        -> readable text of a window
 *   ocr        (WinRT OCR, local)       -> text seen in the screenshot
 *   describe   (Groq vision model)      -> "what is this image about"
 *
 * No npm dependencies. Windows only. Reuses Adion's tested sidecars:
 *   ..\src\pc\probe.ps1  (win.list, uia.list, uia.frompoint, uia.text, fg, cursor)
 *   ..\src\pc\ocr.ps1    (Windows.Media.Ocr, free, ~300ms)
 * Keys come from Adion's .env (never embedded here).
 *
 *   node scan.js --all
 *   node scan.js --shot --windows --uia --ocr
 *   node scan.js --find "Save" --describe "What dialog is this? Answer in one paragraph."
 *   node scan.js --at 960,540 --describe "What is under the cursor?"
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TOOL_DIR = __dirname;
const ADION_ROOT = path.resolve(TOOL_DIR, '..'); // "tool scan" sits inside D:\Adion Browse
const PROBE_CANDIDATES = [
  path.join(ADION_ROOT, 'src', 'pc', 'probe.ps1'),
  path.join(TOOL_DIR, 'probe.ps1'),
];
const OCR_CANDIDATES = [
  path.join(ADION_ROOT, 'src', 'pc', 'ocr.ps1'),
  path.join(TOOL_DIR, 'ocr.ps1'),
];
const SHOT_CANDIDATES = [path.join(TOOL_DIR, 'screen-shot.ps1')];
const ENV_CANDIDATES = [
  path.join(ADION_ROOT, '.env'),
  path.join(TOOL_DIR, '.env'),
  path.join(process.cwd(), '.env'),
];

// ---------- tiny helpers ----------

function firstExisting(list) {
  for (const p of list) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

function loadEnvFiles() {
  const out = {};
  for (const f of ENV_CANDIDATES) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(m[1] in out)) out[m[1]] = v;
    }
  }
  return out;
}

function parseArgs(argv) {
  const o = {
    shot: null, windows: false, uia: false, text: false, ocr: null,
    find: null, at: null, describe: null, image: null,
    all: false, hwnd: null, max: 150, out: null, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => (i + 1 < argv.length ? argv[++i] : null);
    switch (a) {
      case '--shot': { const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? next() : 'screen.png'; o.shot = v; break; }
      case '--windows': o.windows = true; break;
      case '--uia': o.uia = true; break;
      case '--text': o.text = true; break;
      case '--ocr': { const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? next() : 'auto'; o.ocr = v; break; }
      case '--find': o.find = next(); break;
      case '--at': o.at = next(); break;
      case '--describe': o.describe = next() || 'Describe this screenshot: what app is visible, what is the main content, and list the key controls.'; break;
      case '--image': o.image = next(); break;
      case '--all': o.all = true; break;
      case '--hwnd': o.hwnd = Number(next()); break;
      case '--max': o.max = Math.max(10, Math.min(1000, Number(next()) || 150)); break;
      case '--out': o.out = next(); break;
      case '--help': case '-h': o.help = true; break;
      default:
        if (!a.startsWith('--')) { o.find = o.find || a; }
        else { console.error('unknown flag: ' + a); o.help = true; }
    }
  }
  if (o.all && o.shot === null && o.ocr === null && !o.windows && !o.uia && !o.text) {
    o.shot = 'screen.png'; o.windows = true; o.uia = true; o.text = true; o.ocr = 'auto';
  }
  return o;
}

function help() {
  console.log([
    'tool scan — whole-screen scanner (Windows, no dependencies)',
    '',
    '  node scan.js --all                                   full scan: shot + windows + elements + text + ocr',
    '  node scan.js --shot [file] --windows --uia --ocr    pick what to collect',
    '  node scan.js --find "Save"                           find a control by name (foreground window)',
    '  node scan.js --at 960,540                            element under a screen point',
    '  node scan.js --describe "prompt" [--image file]     ask the vision model about a screenshot',
    '  node scan.js --all --describe "What is this?"       full scan + vision description',
    '',
    '  --hwnd N     target window (default: foreground)   --max N  cap UI elements (default 150)',
    '  --out out.json  save the JSON report                --text  window text via UIA',
    '',
    'Output is human text + one JSON block. Positions are physical screen pixels',
    '(virtual-screen origin) plus 0-1000 normalized coordinates.',
  ].join('\n'));
}

// Run powershell with array args (safe for spaces), capture stdout.
function runPowershell(args, opts = {}) {
  return new Promise((resolve) => {
    const ps = opts.powershell || 'powershell.exe';
    const child = spawn(ps, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, opts.timeoutMs || 60000);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: -1, out, err: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, out, err }); });
  });
}

// ---------- screenshot (whole virtual screen, no Electron needed) ----------

async function takeScreenshot(outFile) {
  const full = path.resolve(outFile);
  const script = firstExisting(SHOT_CANDIDATES);
  if (script) {
    const r = await runPowershell(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Out', full], { timeoutMs: 30000 });
    if (r.ok) {
      try { return JSON.parse(r.out.trim()); } catch (_) {}
      return { ok: true, file: full };
    }
    // fall through to inline version
  }
  const inline = [
    'Add-Type -AssemblyName System.Drawing,System.Windows.Forms;',
    '$vs=[System.Windows.Forms.SystemInformation]::VirtualScreen;',
    '$b=New-Object System.Drawing.Bitmap($vs.Width,$vs.Height);',
    '$g=[System.Drawing.Graphics]::FromImage($b);',
    '$g.CopyFromScreen($vs.X,$vs.Y,0,0,$b.Size);$g.Dispose();',
    `$b.Save('${full.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png);$b.Dispose();`,
    '"SAVED "+$vs.X+","+$vs.Y+" "+$vs.Width+"x"+$vs.Height;',
  ].join('');
  const r = await runPowershell(['-NoProfile', '-NonInteractive', '-Command', inline], { timeoutMs: 30000 });
  const m = /SAVED (-?\d+),(-?\d+) (\d+)x(\d+)/.exec(r.out);
  return {
    ok: r.ok && fs.existsSync(full),
    file: full,
    virtualScreen: m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4] } : null,
  };
}

// ---------- probe.ps1 sidecar (JSON lines over stdio) ----------

function startProbe() {
  const script = firstExisting(PROBE_CANDIDATES);
  if (!script) throw new Error('probe.ps1 not found (looked in src\\pc and tool dir)');
  const child = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg && msg.ev) continue; // 'ready' etc.
      if (msg && msg.id != null && pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(String(msg.error)));
        else resolve(msg);
      }
    }
  });
  const failAll = (reason) => {
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error(reason)); pending.delete(id); }
  };
  child.on('exit', () => failAll('probe exited'));
  child.on('error', (e) => failAll('probe spawn failed: ' + e.message));
  // wait for ready, then ping
  return {
    child,
    request(op, params = {}, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(op + ' timed out')); } }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { child.stdin.write(JSON.stringify({ id, op, ...params }) + '\n'); }
        catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
      });
    },
    stop() { try { child.stdin.end(); } catch (_) {} try { child.kill(); } catch (_) {} },
  };
}

// ---------- OCR (local WinRT, zero network) ----------

async function ocrImage(imagePath) {
  const script = firstExisting(OCR_CANDIDATES);
  if (!script) return { ok: false, text: '', note: 'ocr.ps1 not found' };
  const r = await runPowershell(
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', path.resolve(imagePath)],
    { timeoutMs: 30000 });
  return { ok: r.ok, text: (r.out || '').trim(), note: r.ok ? '' : (r.err || '').slice(0, 300) };
}

// ---------- vision description (Groq OpenAI-compatible endpoint) ----------

async function describeImage(imagePath, prompt, env) {
  const url = env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
  const key = env.GROQ_API_KEY;
  const model = env.GROQ_VISION_MODEL || env.GROQ_MODEL || 'qwen/qwen3.8-27b';
  if (!key) return { ok: false, text: '', note: 'no GROQ_API_KEY in .env — screenshot/positions/OCR above still work without it' };
  let buf;
  try { buf = fs.readFileSync(imagePath); }
  catch (e) { return { ok: false, text: '', note: 'cannot read image: ' + e.message }; }
  if (buf.length > 8 * 1024 * 1024) return { ok: false, text: '', note: 'image too large for vision (' + buf.length + ' bytes)' };
  const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }],
        max_tokens: 800,
        temperature: 0.2,
      }),
    });
  } catch (e) { return { ok: false, text: '', note: 'vision request failed: ' + e.message }; }
  if (!res.ok) return { ok: false, text: '', note: 'vision HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300) };
  const j = await res.json();
  const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  return { ok: Boolean(text), text: String(text || ''), note: text ? '' : 'empty vision reply' };
}

// ---------- element helpers ----------

function norm(rect, vs) {
  if (!rect || !vs || !vs.w || !vs.h) return null;
  const nx = (v) => Math.round(v * 1000);
  return { x: nx((rect.x - vs.x) / vs.w), y: nx((rect.y - vs.y) / vs.h), w: nx(rect.w / vs.w), h: nx(rect.h / vs.h) };
}

function shortElement(e, vs) {
  return {
    name: (e.name || '').slice(0, 90),
    type: e.type || '',
    rect: e.rect || null,
    norm1000: e.rect ? norm(e.rect, vs) : null,
  };
}

// ---------- main ----------

async function main() {
  if (process.platform !== 'win32') {
    console.error('Windows only (uses Win32 screenshot + UI Automation).');
    process.exitCode = 1;
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { help(); return; }
  const env = { ...loadEnvFiles(), ...process.env };
  const report = { tool: 'adion-tool-scan/1.0.1', when: new Date().toISOString(), args: process.argv.slice(2) };

  // 1) screenshot
  let shotFile = args.shot || args.image || (args.all || args.ocr || args.describe ? 'screen.png' : null);
  if (args.image && !args.shot && !args.all) shotFile = args.image; // describe an existing file, no new shot
  let vs = { x: 0, y: 0, w: 0, h: 0 };
  if (args.shot || args.all) {
    console.log('shot: capturing whole screen -> ' + path.resolve(args.shot || 'screen.png'));
    const s = await takeScreenshot(args.shot || 'screen.png');
    report.screenshot = s;
    if (s.virtualScreen) vs = s.virtualScreen;
    if (!s.ok) console.log('shot: FAILED — is the desktop locked?');
    else { shotFile = s.file || path.resolve(args.shot || 'screen.png'); console.log('shot: saved ' + shotFile); }
  } else if (shotFile) {
    report.screenshot = { ok: fs.existsSync(shotFile), file: path.resolve(shotFile) };
  }

  // 2) probe sidecar for everything OS-level
  const needProbe = args.windows || args.uia || args.text || args.find || args.at || args.all;
  let probe = null;
  if (needProbe) {
    try {
      probe = startProbe();
      await probe.request('ping', {}, 20000);
    } catch (e) {
      console.log('probe: FAILED to start — ' + e.message);
      probe = null;
    }
  }

  if (probe) {
    try {
      if (args.windows || args.all) {
        try {
          const wins = await probe.request('win.list', {}, 10000);
          report.windows = wins.windows || [];
          console.log(`windows: ${report.windows.length} visible top-level`);
          for (const w of report.windows.slice(0, 25)) {
            const r = w.rect || {};
            console.log(`  [${w.hwnd}] ${w.process || '?'} — ${(w.title || '').slice(0, 70)}  @ ${r.x},${r.y} ${r.w}x${r.h}`);
          }
          if (report.windows.length > 25) console.log(`  ... +${report.windows.length - 25} more (see JSON)`);
          if (report.windows[0] && report.windows[0].rect && !vs.w) {
            // fallback virtual screen estimate from window extents
            let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
            for (const w of report.windows) {
              const r = w.rect; if (!r) continue;
              x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
              x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
            }
            if (x2 > x1) vs = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
          }
        } catch (e) {
          report.windowsError = String(e.message || e).slice(0, 300);
          console.log('windows: FAILED — ' + report.windowsError);
        }
      }
      report.virtualScreen = vs.w ? vs : null;

      let fgHwnd = args.hwnd || null;
      if (!fgHwnd && (args.uia || args.text || args.find || args.all)) {
        try {
          const fg = await probe.request('fg', {}, 5000);
          fgHwnd = fg.hwnd;
          report.foreground = { hwnd: fg.hwnd, title: fg.title, process: fg.process, rect: fg.rect || null };
          console.log(`foreground: [${fg.hwnd}] ${fg.process || ''} — ${(fg.title || '').slice(0, 80)}`);
        } catch (_) {}
      } else if (fgHwnd) report.foreground = { hwnd: fgHwnd };

      if (args.uia || args.all) {
        try {
          const list = await probe.request('uia.list', { hwnd: fgHwnd, max: args.max, budgetMs: 1500 }, 12000);
          report.elements = (list.elements || []).map((e) => shortElement(e, vs));
          report.elementsTruncated = !!list.truncated;
          console.log(`elements: ${report.elements.length} controls in foreground window${report.elementsTruncated ? ' (truncated)' : ''}`);
          for (const e of report.elements.slice(0, 40)) {
            const r = e.rect ? ` @ ${e.rect.x},${e.rect.y} ${e.rect.w}x${e.rect.h}` : '';
            console.log(`  ${e.type || '?'} "${e.name || ''}"${r}`);
          }
          if (report.elements.length > 40) console.log(`  ... +${report.elements.length - 40} more (see JSON)`);
        } catch (e) {
          report.elementsError = String(e.message || e).slice(0, 300);
          console.log('elements: FAILED for this window (' + report.elementsError + ') — shot/windows/ocr/describe still work');
        }
      }

      if (args.text) {
        try {
          const t = await probe.request('uia.text', { hwnd: fgHwnd, max: 20000, budgetMs: 2500 }, 12000);
          report.windowText = (t.text || '').slice(0, 20000);
          console.log(`text: ${(report.windowText || '').length} chars from window (source: ${t.from || 'uia'})`);
          if (report.windowText) console.log('--- window text (first 800 chars) ---\n' + report.windowText.slice(0, 800));
        } catch (e) {
          report.windowTextError = String(e.message || e).slice(0, 300);
          console.log('text: FAILED — ' + report.windowTextError);
        }
      }

      if (args.find) {
        try {
          const r = await probe.request('uia.find', { hwnd: fgHwnd, name: args.find }, 12000);
          report.find = { query: args.find, score: r.score, searched: r.searched, element: r.element ? shortElement(r.element, vs) : null };
          if (r.element) {
            const e = r.element;
            console.log(`find "${args.find}": ${e.type} "${e.name}" @ ${e.rect.x},${e.rect.y} ${e.rect.w}x${e.rect.h} (score ${r.score})`);
          } else console.log(`find "${args.find}": no match in ${r.searched || 0} controls`);
        } catch (e) {
          report.find = { query: args.find, error: String(e.message || e).slice(0, 300) };
          console.log(`find "${args.find}": FAILED — ` + report.find.error);
        }
      }

      if (args.at) {
        const m = /(-?\d+)\s*,\s*(-?\d+)/.exec(args.at);
        if (!m) console.log('--at needs X,Y e.g. --at 960,540');
        else {
          try {
            const r = await probe.request('uia.frompoint', { x: +m[1], y: +m[2] }, 12000);
            report.at = { x: +m[1], y: +m[2], element: r.element ? shortElement(r.element, vs) : null, window: r.window || null };
            if (r.element) {
              const e = r.element;
              console.log(`at ${m[1]},${m[2]}: ${e.type} "${e.name}" @ ${e.rect.x},${e.rect.y} ${e.rect.w}x${e.rect.h}`);
            } else console.log(`at ${m[1]},${m[2]}: no interactive control`);
          } catch (e) {
            report.at = { x: +m[1], y: +m[2], error: String(e.message || e).slice(0, 300) };
            console.log(`at ${m[1]},${m[2]}: FAILED — ` + report.at.error);
          }
        }
      }
    } finally {
      probe.stop();
    }
  }

  // 3) OCR on the screenshot (local, free)
  if (args.ocr && shotFile) {
    const img = args.ocr === 'auto' ? shotFile : (args.image || args.ocr);
    console.log('ocr: reading text in ' + img + ' ...');
    const r = await ocrImage(img);
    report.ocr = { file: path.resolve(img), ok: r.ok, text: (r.text || '').slice(0, 20000), note: r.note || '' };
    console.log(`ocr: ${report.ocr.text.length} chars${r.ok ? '' : ' (FAILED: ' + (r.note || 'ocr error') + ')'}`);
    if (report.ocr.text) console.log('--- ocr (first 800 chars) ---\n' + report.ocr.text.slice(0, 800));
  }

  // 4) vision description ("what is this image about")
  if (args.describe && shotFile) {
    const img = args.image || shotFile;
    console.log('describe: asking vision model about ' + img + ' ...');
    const r = await describeImage(img, args.describe, env);
    report.describe = { file: path.resolve(img), prompt: args.describe, ok: r.ok, text: r.text, note: r.note || '' };
    if (r.ok) console.log('--- vision ---\n' + r.text);
    else console.log('describe: unavailable — ' + (r.note || 'error'));
  }

  console.log('--- REPORT_JSON ---');
  console.log(JSON.stringify(report, null, 2));
  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
    console.log('saved: ' + path.resolve(args.out));
  }
}

main().catch((e) => { console.error('scan failed: ' + (e && e.message ? e.message : e)); process.exitCode = 1; });
