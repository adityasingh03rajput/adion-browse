/**
 * Adion Browse — screenWatch: the whole-screen scanner wired into the PC engine.
 *
 * Takes the proven tool-scan operations (whole virtual-screen screenshot,
 * top-level window enumeration, control lookup, OCR, vision description) and
 * exposes them as one dependency-injected object the PC engine owns — no CLI,
 * no Electron, no new processes beyond the existing probe sidecar.
 *
 * Real gaps this kills (verified: no other caller exists today):
 *   1. win.list — nothing enumerates open windows (open_app only win.finds to
 *      verify a launch). The planner cannot answer "what's open?" or pick a
 *      non-foreground window.
 *   2. Whole-screen OCR — src/pc/ocr.js recognizeText has ZERO callers, so the
 *      read action fails outright on canvas apps ("exposes no readable text").
 *   3. Vision orientation — the planner "does NOT see pixels" and nothing ever
 *      asks the vision model what the native screen shows; describe_screen is
 *      the recovery path when the UIA control list is empty.
 *   4. Whole virtual-screen capture — screenCapture.js is per-display Electron
 *      desktopCapturer (downscaled 1280px); screenshots here are full-res PNG
 *      files of the entire virtual screen via screen-shot.ps1.
 *
 * Every method degrades to an explained refusal, never a hang: probe calls
 * carry timeouts, the sidecar may be unavailable, Groq may be unconfigured.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { recognizeText, recognizeWords } = require('./ocr');

function firstExisting(list) {
  for (const p of list) {
    try { if (p && fs.existsSync(p)) return p; } catch (_) { /* next */ }
  }
  return null;
}

function resolveShotScript(explicit) {
  const cands = [];
  if (explicit) cands.push(path.resolve(explicit));
  cands.push(path.join(__dirname, 'screen-shot.ps1'));
  try { cands.push(path.join(__dirname, '..', '..', 'tool scan', 'screen-shot.ps1')); } catch (_) { /* next */ }
  return firstExisting(cands);
}

function groqFromEnv(over = {}) {
  return {
    url: over.url || process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions',
    key: over.key || process.env.GROQ_API_KEY || '',
    model: over.model || process.env.GROQ_VISION_MODEL || process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',
  };
}

function runPowerShellFile(script, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, timeoutMs || 30000);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out, err: String((e && e.message) || e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out, err }); });
  });
}

async function groqVision(groq, imagePath, prompt) {
  let buf;
  try { buf = fs.readFileSync(imagePath); }
  catch (e) { return { ok: false, text: '', note: 'cannot read image: ' + e.message }; }
  if (buf.length > 8 * 1024 * 1024) return { ok: false, text: '', note: 'image too large for vision (' + buf.length + ' bytes)' };
  const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
  let res;
  try {
    res = await fetch(groq.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + groq.key },
      body: JSON.stringify({
        model: groq.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }],
        max_tokens: 800,
        temperature: 0.2,
      }),
    });
  } catch (e) { return { ok: false, text: '', note: 'vision request failed: ' + e.message }; }
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 300); } catch (_) {}
    // If rate limited (HTTP 429) or unavailable, degrade gracefully to local WinRT OCR instead of breaking task
    try {
      const ocrText = await recognizeText(imagePath);
      if (ocrText && ocrText.trim()) {
        return {
          ok: true,
          text: `Screen text detected via local WinRT OCR:\n${ocrText.slice(0, 3000)}`,
          note: `Vision API HTTP ${res.status} rate limit; gracefully degraded to local OCR`
        };
      }
    } catch (_) {}
    return { ok: false, text: '', note: 'vision HTTP ' + res.status + ': ' + body };
  }
  const j = await res.json();
  const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  return { ok: Boolean(text), text: String(text || ''), note: text ? '' : 'empty vision reply' };
}

function shortWindow(w) {
  return {
    hwnd: w.hwnd,
    process: String(w.process || ''),
    title: String(w.title || '').slice(0, 120),
    rect: w.rect || null,
  };
}

/**
 * createScreenWatch({ probe, log, workDir, shotScript, groq, selfPid })
 * probe: sidecar client with .available and .request(op, params, timeoutMs).
 */
function createScreenWatch(deps = {}) {
  const probe = deps.probe || null;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const workDir = deps.workDir || os.tmpdir();
  const shotScript = resolveShotScript(deps.shotScript);
  const groq = groqFromEnv(deps.groq);
  const selfPid = deps.selfPid != null ? deps.selfPid : -1;
  // ignorePid must be omitted (not -1): probe.ps1 casts it to UInt32.
  const pidParam = () => (selfPid != null && selfPid >= 0 ? { ignorePid: selfPid } : {});

  function needProbe() {
    if (!probe || probe.available !== true) throw new Error('probe sidecar not available');
  }

  function shotFile(tag) {
    try { fs.mkdirSync(workDir, { recursive: true }); } catch (_) {}
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(workDir, `${tag || 'adion-screen'}-${ts}.png`);
  }

  async function windows() {
    needProbe();
    const r = await probe.request('win.list', {}, 8000);
    return ((r && r.windows) || []).map(shortWindow);
  }

  async function foreground() {
    needProbe();
    return probe.request('fg', pidParam(), 5000);
  }

  async function findWindow({ name, process } = {}) {
    needProbe();
    const params = {};
    if (name) params.name = name;
    if (process) params.process = process;
    return probe.request('win.find', params, 5000);
  }

  async function elementAt(x, y) {
    needProbe();
    const r = await probe.request('uia.frompoint', { x: Math.round(x), y: Math.round(y), ...pidParam() }, 3000);
    return (r && r.element) || null;
  }

  async function controls(hwnd, max = 150) {
    needProbe();
    const r = await probe.request('uia.list', { hwnd, max, budgetMs: 1500 }, 12000);
    return { elements: (r && r.elements) || [], truncated: Boolean(r && r.truncated) };
  }

  async function windowText(hwnd, max = 60000) {
    needProbe();
    const r = await probe.request('uia.text', { hwnd, max, budgetMs: 2500, ...pidParam() }, 12000);
    return { text: String((r && r.text) || ''), from: r && r.from, truncated: Boolean(r && r.truncated) };
  }

  async function screenshot(tag) {
    if (!shotScript) return { ok: false, file: null, note: 'screen-shot.ps1 not found (looked in src\\pc and tool scan)' };
    const out = shotFile(tag);
    const r = await runPowerShellFile(shotScript, ['-Out', out], 30000);
    if (!r.ok) return { ok: false, file: null, note: 'screenshot failed: ' + (r.err || 'exit code').slice(0, 200) };
    try {
      const j = JSON.parse(r.out.trim());
      if (j && j.ok) return { ok: true, file: j.file || out, virtualScreen: j.virtualScreen || null, monitors: j.monitors || null };
    } catch (_) { /* fall through to existence check */ }
    if (fs.existsSync(out)) return { ok: true, file: out, virtualScreen: null, monitors: null };
    return { ok: false, file: null, note: 'screenshot produced no file' };
  }

  async function readScreen(opts = {}) {
    const shot = await screenshot('adion-ocr');
    if (!shot.ok) return { ok: false, file: null, text: '', lines: [], words: [], note: shot.note };
    let parsed = null;
    try {
      parsed = await recognizeWords(shot.file);
    } catch (_) {}
    const text = (parsed && parsed.text) || (await recognizeText(shot.file));
    return {
      ok: true, file: shot.file, text: String(text || '').slice(0, opts.max || 20000),
      lines: (parsed && parsed.lines) || [],
      words: (parsed && parsed.words) || [],
      chars: String(text || '').length, source: 'winrt-ocr', virtualScreen: shot.virtualScreen,
    };
  }

  async function describeScreen(prompt, opts = {}) {
    const shot = await screenshot('adion-describe');
    if (!shot.ok) return { ok: false, file: null, text: '', note: shot.note };

    if (!groq.key) {
      try {
        const text = await recognizeText(shot.file);
        if (text && text.trim()) {
          return { ok: true, file: shot.file, text: `Screen text detected via local WinRT OCR:\n${text.slice(0, 3000)}`, note: 'local WinRT OCR' };
        }
      } catch (_) {}
      return { ok: false, file: null, text: '', note: 'no GROQ_API_KEY and OCR detected no text' };
    }

    const r = await groqVision(groq, shot.file,
      prompt || 'Describe this screenshot: what app is visible, what is the main content, and list the key controls.');
    if (!r.ok) {
      try {
        const text = await recognizeText(shot.file);
        if (text && text.trim()) {
          return { ok: true, file: shot.file, text: `Screen text detected via local WinRT OCR:\n${text.slice(0, 3000)}`, note: 'graceful OCR fallback' };
        }
      } catch (_) {}
      if (!opts.keepFile) { try { fs.unlinkSync(shot.file); } catch (_) {} }
    }
    return { ok: r.ok, file: r.ok ? shot.file : null, text: r.text, note: r.note || '' };
  }

  async function scan(opts = {}) {
    const out = { when: new Date().toISOString(), tool: 'adion-screenwatch/1.0.0' };
    const want = {
      shot: opts.shot !== false,
      windows: opts.windows !== false,
      elements: opts.elements === true,
      windowText: opts.windowText === true,
      ocr: opts.ocr === true,
      describe: opts.describe === true,
    };
    if (want.shot) {
      try { out.shot = await screenshot('adion-scan'); }
      catch (e) { out.shot = { ok: false, note: String((e && e.message) || e).slice(0, 200) }; }
    }
    try {
      if (want.windows) out.windows = await windows();
      const fg = await foreground();
      out.foreground = { hwnd: fg.hwnd, process: fg.process || '', title: (fg.title || '').slice(0, 120), rect: fg.rect || null };
      if (want.elements && fg.hwnd) {
        try { const c = await controls(fg.hwnd, opts.max || 120); out.elements = c.elements; out.elementsTruncated = c.truncated; }
        catch (e) { out.elementsError = String((e && e.message) || e).slice(0, 200); }
      }
      if (want.windowText && fg.hwnd) {
        try { out.windowText = (await windowText(fg.hwnd)).text.slice(0, 20000); }
        catch (e) { out.windowTextError = String((e && e.message) || e).slice(0, 200); }
      }
    } catch (e) { out.probeError = String((e && e.message) || e).slice(0, 200); }
    if (want.ocr) {
      try {
        const o = await readScreen();
        out.ocr = { ok: o.ok, file: o.file, chars: o.chars, text: (o.text || '').slice(0, 8000) };
      } catch (e) { out.ocr = { ok: false, note: String((e && e.message) || e).slice(0, 200) }; }
    }
    if (want.describe) {
      try {
        const d = await describeScreen(opts.describePrompt);
        out.description = { ok: d.ok, file: d.file, text: d.text, note: d.note || '' };
      } catch (e) { out.description = { ok: false, note: String((e && e.message) || e).slice(0, 200) }; }
    }
    return out;
  }

  return {
    available: () => !!probe && probe.available === true,
    windows, foreground, findWindow, elementAt, controls, windowText,
    screenshot, readScreen, describeScreen, scan,
  };
}

module.exports = { createScreenWatch };
