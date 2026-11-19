/**
 * Adion Browse — PC action vocabulary
 *
 * Adapted from nus-companion's hands/actions.js (Apache-2.0,
 * potlakai/nus-companion v0.1.21), renamed and reduced to what Adion drives:
 * resolve the target from the control list or the screenshot, act through the
 * input sidecar, and report honestly.
 *
 * Every action returns { ok, report, refused?, settle?, lookAfter?, unverified? }
 * and never throws for an ordinary failure: the report goes back to the planner,
 * which tries another way or stops and says so.
 */

'use strict';

const { chooseElement, tokenOverlap, rectCentre } = require('./grounding');
const { evaluateAction } = require('../control-plane/actionConsent');

const VK = {
  enter: 0x0d, return: 0x0d, escape: 0x1b, esc: 0x1b, tab: 0x09, backspace: 0x08,
  delete: 0x2e, del: 0x2e, space: 0x20, home: 0x24, end: 0x23, pageup: 0x21,
  pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27, ctrl: 0x11,
  control: 0x11, shift: 0x10, alt: 0x12, insert: 0x2d,
  win: 0x5b, windows: 0x5b, meta: 0x5b, super: 0x5b, // left-Windows (allowed by sidecar $PressVk; alone still refused below)
};
for (let i = 1; i <= 12; i++) VK[`f${i}`] = 0x6f + i;
for (let c = 0; c < 26; c++) VK[String.fromCharCode(97 + c)] = 0x41 + c;
for (let d = 0; d < 10; d++) VK[String(d)] = 0x30 + d;
Object.assign(VK, { '=': 0xbb, '-': 0xbd, ',': 0xbc, '.': 0xbe, '/': 0xbf, '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde });

const MAX_TYPE_CHARS = 1500;
const MAX_WAIT_MS = 10000;

function clip(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** "ctrl+s" -> [0x11, 0x53]; unknown names -> null. */
function parseKeys(keys) {
  const parts = String(keys || '').toLowerCase().replace(/\s+/g, '').split('+').filter(Boolean);
  if (!parts.length || parts.length > 4) return null;
  const codes = parts.map((part) => VK[part]);
  if (codes.some((code) => code == null)) return null;
  if (codes.length === 1 && codes[0] === 0x5b) return null; // never the Windows key alone
  return codes;
}

/** The element the planner meant: by id, else by text with an optional anchor. */
function findElement(args, elements) {
  const list = elements || [];
  if (args.id != null) {
    const byId = list.find((element) => Number(element.id) === Number(args.id));
    if (byId) return byId;
  }
  const text = String(args.text || args.target || '').trim();
  if (!text) return null;
  let named = list.filter((element) => tokenOverlap(text, element.name) >= 0.5);
  if (!named.length) {
    const pattern = new RegExp(`(?:^|[^a-z0-9])${text.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'i');
    const loose = list.filter((element) => pattern.test(String(element.name || '')));
    if (loose.length === 1 || (loose.length > 1 && args.near)) named = loose;
  }
  if (!named.length) return null;
  // "Save as" must beat "Save" for the label "Save as", and the other way
  // round: words alone treat both as a hit, so rank name shape too.
  const wanted = text.toLowerCase();
  const ranked = named
    .map((element) => {
      const name = String(element.name || '').trim().toLowerCase();
      let score = tokenOverlap(text, element.name);
      if (name === wanted) score += 2;
      else if (name.startsWith(wanted)) score += 0.6;
      else if (wanted.startsWith(name)) score += 0.3;
      return { element, score };
    })
    .sort((a, b) => b.score - a.score);
  const top = ranked[0];
  if (!top) return null;
  if (ranked.length === 1 || !args.near) return top.element;
  named = ranked.map((entry) => entry.element);
  if (named.length === 1) return named[0];
  const anchor = list.find((element) => tokenOverlap(String(args.near), element.name) >= 0.5);
  if (!anchor) return named[0];
  const centre = rectCentre(anchor.rect);
  return named
    .slice()
    .sort((a, b) => {
      const ca = rectCentre(a.rect);
      const cb = rectCentre(b.rect);
      return Math.hypot(ca.x - centre.x, ca.y - centre.y) - Math.hypot(cb.x - centre.x, cb.y - centre.y);
    })[0];
}

function fractionToPhysical(args, capture, originPhys) {
  const x = Number(args.x);
  const y = Number(args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !capture) return null;
  if (x < 0 || y < 0 || x > 1 || y > 1) return null;
  return {
    x: Math.round(originPhys.x + x * capture.pxWidth),
    y: Math.round(originPhys.y + y * capture.pxHeight)
  };
}

/**
 * Mouse power: explicit coordinates the model can emit.
 * hasCoords(args): absolute {x,y} pixels or 0-1000 {x1000,y1000}.
 * coordsToPhysical(args, bounds): map to pixels, or null when unusable.
 * physFromArgs(args): 'none' (no coords given) | null (unusable) | {x,y}.
 * Virtual-screen bounds are cached from a single screenshot.
 */
function hasCoords(args) {
  if (!args) return false;
  const ax = Number(args.x), ay = Number(args.y);
  if (Number.isFinite(ax) && Number.isFinite(ay)) return true;
  const tx = Number(args.x1000), ty = Number(args.y1000);
  return Number.isFinite(tx) && Number.isFinite(ty);
}

function coordsToPhysical(args, b) {
  if (!b) return null;
  const ax = Number(args.x), ay = Number(args.y);
  if (Number.isFinite(ax) && Number.isFinite(ay)) {
    if (ax < b.x || ay < b.y || ax > b.x + b.w || ay > b.y + b.h) return null;
    return { x: Math.round(ax), y: Math.round(ay) };
  }
  const tx = Number(args.x1000), ty = Number(args.y1000);
  if (Number.isFinite(tx) && Number.isFinite(ty)) {
    if (tx < 0 || ty < 0 || tx > 1000 || ty > 1000) return null;
    return { x: Math.round(b.x + (tx / 1000) * b.w), y: Math.round(b.y + (ty / 1000) * b.h) };
  }
  return null;
}

/**
 * createDesktopActions({ probe, input, consentPrompt, launchApp, log, sleep, selfPid })
 * probe / input: sidecars from sidecarClient; consentPrompt is resolved per run.
 */
function createDesktopActions(deps = {}) {
  const { probe, input } = deps;
  const watch = deps.watch || null; // screenWatch (tool-scan wiring); null-safe everywhere
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const sleep = typeof deps.sleep === 'function' ? deps.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const selfPid = deps.selfPid != null ? deps.selfPid : -1;
  const openVerifyMs = deps.openVerifyMs != null ? Number(deps.openVerifyMs) : 5000;
  const launchApp = typeof deps.launchApp === 'function' ? deps.launchApp : null;

  let vsCache = null;
  async function virtualBounds() {
    if (vsCache) return vsCache;
    if (!watch) return null;
    try {
      const shot = await watch.screenshot('coord-bounds');
      if (shot && shot.ok && shot.virtualScreen) { vsCache = shot.virtualScreen; return vsCache; }
    } catch (_) { /* fall through */ }
    return null;
  }

  async function physFromArgs(args) {
    if (!hasCoords(args)) return 'none';
    const b = await virtualBounds();
    if (!b) return null;
    return coordsToPhysical(args, b);
  }

  async function resolvePoint(args, ctx = {}) {
    const element = findElement(args, ctx && ctx.elements);
    if (element && element.rect) {
      return { point: rectCentre(element.rect), rect: element.rect, name: element.name || '', type: element.type || '', element };
    }
    const explicit = await physFromArgs(args);
    if (explicit && explicit.x != null) {
      let under = null;
      if (probe && probe.available) {
        try {
          const reply = await probe.request('uia.frompoint', { x: Math.round(explicit.x), y: Math.round(explicit.y), ignorePid: selfPid }, 1200);
          under = reply && reply.element;
        } catch (_) { under = null; }
      }
      return {
        point: explicit,
        rect: (under && under.rect) || { x: explicit.x - 4, y: explicit.y - 4, w: 8, h: 8 },
        name: (under && under.name) || args.text || args.target || '',
        type: (under && under.type) || '',
        element: under,
        coordGuess: !under
      };
    }
    if (explicit === null) return { badCoords: true };
    const point = fractionToPhysical(args, ctx && ctx.capture, ctx && ctx.originPhys);
    if (!point) return null;
    // A point on the screenshot: ask Windows what sits there so the report survives.
    let under = null;
    if (probe && probe.available) {
      try {
        const reply = await probe.request('uia.frompoint', { x: point.x, y: point.y, ignorePid: selfPid }, 1200);
        under = reply && reply.element;
      } catch (_) {
        under = null;
      }
    }
    return {
      point,
      rect: (under && under.rect) || { x: point.x - 4, y: point.y - 4, w: 8, h: 8 },
      name: under ? under.name || '' : '',
      type: under ? under.type || '' : '',
      element: under
    };
  }

  async function focusedField() {
    if (!probe || !probe.available) return null;
    try {
      const reply = await probe.request('uia.focused', { ignorePid: selfPid }, 900);
      return reply && reply.element ? reply.element : null;
    } catch (_) {
      return null;
    }
  }

  const actions = {
    async click(args, ctx = {}) {
      let target = await resolvePoint(args, ctx);
      if (target && target.badCoords) return { ok: false, report: 'coordinates unusable: give x/y pixels inside the screen, or x1000/y1000 within 0-1000' };
      if (!target && watch && probe && probe.available) {
        // Popup fallback: system menus/dialogs (Win+X PopupHost, context
        // menus, autocomplete popups) live in their own top-level windows,
        // never in ctx.elements. Scan them before honestly failing.
        try {
          const wins = await watch.windows();
          const selfHwnd = ctx.fg ? ctx.fg.hwnd : null;
          const cands = wins
            .filter((w) => w && w.hwnd && w.hwnd !== selfHwnd)
            .sort((a, b) => String(a.title || '').length - String(b.title || '').length)
            .slice(0, 8);
          for (const w of cands) {
            let list = null;
            try { list = await probe.request('uia.list', { hwnd: w.hwnd, max: 40, budgetMs: 800 }, 4000); }
            catch (_) { continue; }
            const els = (list && list.elements) || [];
            if (!els.length) continue;
            const hit = findElement(args, els);
            if (hit && hit.rect) {
              target = { point: rectCentre(hit.rect), rect: hit.rect, name: hit.name || '', type: hit.type || '', element: hit };
              break;
            }
          }
        } catch (_) { /* fall through to honest failure */ }
      }

      // Local WinRT OCR fallback for non-UIA desktop windows and custom canvas apps
      if (!target && (args.text || args.target)) {
        try {
          const { findTextInBase64 } = require('./ocr');
          const { captureDisplay } = require('./screenCapture');
          const cap = await captureDisplay();
          if (cap && cap.dataUrl) {
            const b64 = cap.dataUrl.replace(/^data:image\/\w+;base64,/, '');
            const query = args.text || args.target;
            const ocrHit = await findTextInBase64(b64, query);
            if (ocrHit && ocrHit.found) {
              const scaleX = cap.pxWidth && cap.width ? cap.pxWidth / cap.width : 1;
              const scaleY = cap.pxHeight && cap.height ? cap.pxHeight / cap.height : 1;
              const realX = Math.round(ocrHit.x * scaleX);
              const realY = Math.round(ocrHit.y * scaleY);
              target = {
                point: { x: realX, y: realY },
                rect: { x: realX - ocrHit.width / 2, y: realY - ocrHit.height / 2, w: ocrHit.width, h: ocrHit.height },
                name: ocrHit.label,
                type: 'ocr-text'
              };
              console.log(`[DesktopActions] 🎯 Resolved desktop text "${query}" via local WinRT OCR at (${realX}, ${realY}) [0 cloud tokens]`);
            }
          }
        } catch (ocrErr) {
          /* fall through to honest failure */
        }
      }

      if (!target) return { ok: false, report: 'no element id and no screen point to click' };
      const label = target.name || args.text || args.target || '';
      const gate = evaluateAction({ kind: 'page', label }, ctx.prompt || '');
      if (!gate.allowed) return { ok: false, refused: gate.reason, report: gate.message };

      const reply = await input.request('mouse.click', {
        x: target.point.x,
        y: target.point.y,
        button: args.button || 'left',
        twice: Boolean(args.twice),
        hwnd: ctx.fg ? ctx.fg.hwnd : undefined
      }, 4000);
      if (!reply || reply.ok === false) {
        return { ok: false, refused: reply && reply.refused, report: `click did not land: ${(reply && (reply.refused || reply.error)) || 'no answer'}` };
      }
      return {
        ok: true,
        report: `clicked ${target.name ? `"${clip(target.name, 40)}"` : `(${target.point.x}, ${target.point.y})`}`,
        target: { name: target.name, type: target.type, rect: target.rect },
        settle: 1600,
        lookAfter: 250
      };
    },

    async move(args, ctx = {}) {
      if (!input) return { ok: false, report: 'mouse is not available (input sidecar missing)' };
      const explicit = await physFromArgs(args);
      if (explicit === null) return { ok: false, report: 'coordinates unusable: give x/y pixels inside the screen, or x1000/y1000 within 0-1000' };
      const point = (explicit && explicit.x != null)
        ? explicit
        : fractionToPhysical(args, ctx && ctx.capture, ctx && ctx.originPhys);
      if (!point) return { ok: false, report: 'move needs coordinates: x/y pixels or x1000/y1000 (0-1000)' };
      const px = { x: Math.round(point.x), y: Math.round(point.y) };
      const reply = await input.request('mouse.move', px, 4000);
      if (!reply || reply.ok === false) {
        return { ok: false, report: `move failed: ${(reply && reply.error) || 'no answer'}` };
      }
      return { ok: true, report: `moved to (${px.x}, ${px.y})`, settle: 300 };
    },

    async type(args, ctx = {}) {
      const text = String(args.text || '');
      if (!text.trim()) return { ok: false, report: 'nothing to type' };

      // Focus target field first if explicitly provided
      if (args.id != null || args.target || args.text_target) {
        try {
          const target = await resolvePoint({ id: args.id, text: args.target || args.text_target }, ctx);
          if (target && target.point) {
            await input.request('mouse.click', { x: target.point.x, y: target.point.y, button: 'left' }, 3000);
            await sleep(250);
          }
        } catch (_) {}
      }

      const field = await focusedField();
      if (field && field.isPassword) {
        return { ok: false, refused: 'password field', report: 'refused: the focused field is a password box' };
      }
      const gate = evaluateAction(
        { kind: 'page', fieldName: field && field.name ? field.name : '', submit: Boolean(args.enter) },
        ctx.prompt || ''
      );
      if (!gate.allowed) return { ok: false, refused: gate.reason, report: gate.message };

      const payload = text.slice(0, MAX_TYPE_CHARS);
      const reply = await input.request('keys.text', {
        text: payload,
        enter: Boolean(args.enter),
        hwnd: ctx.fg ? ctx.fg.hwnd : undefined
      }, 8000);
      if (!reply || reply.ok === false) {
        return { ok: false, refused: reply && reply.refused, report: `typing failed: ${(reply && (reply.refused || reply.error)) || 'no answer'}` };
      }
      const where = reply.focus ? ` into "${clip(reply.focus, 40)}"` : '';
      const verified = reply.verified === true;
      return {
        ok: true,
        unverified: !verified,
        report: `typed ${Math.min(payload.length, MAX_TYPE_CHARS)} characters${where}${args.enter ? ' and pressed Enter' : ''}${verified ? '' : ' (the field could not confirm it)'}`,
        settle: args.enter ? 2200 : 900,
        lookAfter: 250
      };
    },

    async press(args, ctx = {}) {
      const keys = parseKeys(args.keys || args.key);
      if (!keys) return { ok: false, report: `unknown key combination: ${clip(args.keys || args.key, 30)}` };
      const reply = await input.request('keys.chord', { keys, hwnd: ctx.fg ? ctx.fg.hwnd : undefined }, 4000);
      if (!reply || reply.ok === false) {
        return { ok: false, report: `key press failed: ${(reply && (reply.refused || reply.error)) || 'no answer'}` };
      }
      return { ok: true, report: `pressed ${clip(args.keys || args.key, 30)}`, settle: 1200, lookAfter: 200 };
    },

    async scroll(args, ctx = {}) {
      const point = fractionToPhysical(args, ctx.capture, ctx.originPhys) ||
        (ctx.fg && ctx.fg.rect ? rectCentre(ctx.fg.rect) : null);
      if (!point) return { ok: false, report: 'no place to scroll' };
      const direction = String(args.direction || 'down').toLowerCase();
      const ticks = Math.max(1, Math.min(10, Number(args.amount) || 3));
      const dy = direction === 'up' ? ticks : -ticks;
      const reply = await input.request('mouse.scroll', { x: Math.round(point.x), y: Math.round(point.y), dy, dx: 0 }, 4000);
      if (!reply || reply.ok === false) return { ok: false, report: 'scroll failed' };
      return { ok: true, report: `scrolled ${direction} ${ticks}`, settle: 1200, lookAfter: 150 };
    },

    async read(args, ctx = {}) {
      if (!probe || !probe.available) return { ok: false, report: 'the read-only probe is not available' };
      const reply = await probe.request('uia.text', {
        hwnd: ctx.fg ? ctx.fg.hwnd : undefined,
        max: Math.min(Number(args.max) || 60000, 200000),
        budgetMs: 2500,
        ignorePid: selfPid
      }, 6000);
      if (!reply || reply.error) return { ok: false, report: `could not read the window: ${(reply && reply.error) || 'no answer'}` };
      const text = String(reply.text || '').trim();
      const where = clip((ctx.fg && ctx.fg.title) || 'this window', 50);
      if (!text && watch) {
        // Real gap: canvas apps expose no UIA text, so read the screen with
        // OCR (tool-scan wiring) instead of failing outright.
        try {
          const snap = await watch.readScreen();
          const otext = String((snap && snap.text) || '').trim();
          if (otext) {
            return {
              ok: true,
              report: `read the screen with OCR (${otext.length} chars — the window exposes no accessible text)`,
              text: otext.slice(0, 60000), chars: otext.length, source: 'ocr', file: snap.file, settle: 0
            };
          }
        } catch (_) { /* fall through to the honest failure below */ }
      }
      if (!text) {
        return {
          ok: false,
          report: `"${where}" exposes no readable text — it may be a canvas, or an app whose accessibility tree is off (Chrome/Electron need it enabled)`
        };
      }
      return { ok: true, report: 'read the window', text, chars: text.length, truncated: Boolean(reply.truncated), settle: 0 };
    },

    async open_app(args) {
      const name = String(args.name || args.app || '').trim();
      if (!name) return { ok: false, report: 'no app name' };
      // "open whatsapp and text her" is not an app name; launching it would
      // start nothing and report success, which is exactly what we must not do.
      if (name.split(/\s+/).length > 5 || /[,;]|\b(and|then|also)\b/i.test(name)) {
        return {
          ok: false,
          report: `"${clip(name, 60)}" is not an app name — that looks like several steps. Ask one step at a time, or configure a model.`
        };
      }
      if (!launchApp) return { ok: false, report: 'app launching is not available here' };
      const landed = await launchApp(name);
      if (!landed || landed.ok === false) {
        return { ok: false, report: `could not open "${clip(name, 40)}": ${(landed && landed.report) || 'no answer'}` };
      }

      // Spawning a launcher proves nothing. Wait for a window that matches the
      // name, and say so plainly when none appears.
      let found = null;
      const deadline = Date.now() + openVerifyMs;
      while (Date.now() < deadline) {
        if (probe && probe.available) {
          try {
            const reply = await probe.request('win.find', { name }, 1500);
            if (reply && reply.found) { found = reply; break; }
          } catch (_) {
            /* the probe may be restarting; keep waiting */
          }
        }
        await sleep(400);
      }
      if (!found) {
        return {
          ok: false,
          report: `I started the launcher for "${clip(name, 40)}" but no window for it appeared, so I am not calling it open.`
        };
      }
      const landedTitle = String(found.title || found.process || '').slice(0, 60);
      return {
        ok: true,
        report: `opened "${clip(name, 40)}"${landedTitle ? ` (${landedTitle})` : ''}`,
        opened: name,
        settle: 2500,
        lookAfter: 600
      };
    },

    async windows() {
      if (!watch) return { ok: false, report: 'window list is not available (screenWatch missing)' };
      const list = await watch.windows();
      if (!list.length) return { ok: true, report: 'no top-level windows reported', windows: [], settle: 0 };
      const shown = list.slice(0, 12).map((w) => `"${(w.title || '(no title)').slice(0, 50)}" (${w.process || '?'})`).join('; ');
      return {
        ok: true,
        report: `${list.length} windows: ${shown}${list.length > 12 ? ` (+${list.length - 12} more)` : ''}`,
        windows: list, settle: 0
      };
    },

    async find_window(args) {
      if (!watch) return { ok: false, report: 'window search is not available (screenWatch missing)' };
      const name = String(args.name || args.text || args.window || '').trim();
      const proc = String(args.process || '').trim();
      if (!name && !proc) return { ok: false, report: 'find_window needs a name or process' };
      const hit = await watch.findWindow({ name: name || undefined, process: proc || undefined });
      if (!hit || !hit.found) return { ok: false, report: `no window matching "${clip(name || proc, 60)}"`, settle: 0 };
      return {
        ok: true,
        report: `found "${String(hit.title || hit.process || name).slice(0, 60)}"`,
        window: { hwnd: hit.hwnd, process: hit.process, title: hit.title, rect: hit.rect || null }, settle: 0
      };
    },

    async screenshot() {
      if (!watch) return { ok: false, report: 'screenshots are not available (screenWatch missing)' };
      const shot = await watch.screenshot();
      if (!shot.ok) return { ok: false, report: `screenshot failed: ${shot.note || 'unknown'}`, settle: 0 };
      return { ok: true, report: `saved whole-screen shot to ${shot.file}`, file: shot.file, virtualScreen: shot.virtualScreen || null, settle: 0 };
    },

    async describe_screen(args) {
      if (!watch) return { ok: false, report: 'screen description is not available (screenWatch missing)' };
      const d = await watch.describeScreen(args.prompt || args.text || '');
      if (!d.ok) return { ok: false, report: `describe failed: ${d.note || 'unknown'}`, settle: 0 };
      return { ok: true, report: 'described the screen', description: d.text, file: d.file, settle: 0 };
    },

    async wait(args) {
      const ms = Math.min(MAX_WAIT_MS, Math.max(100, Number(args.ms) || 1000));
      await sleep(ms);
      return { ok: true, report: `waited ${ms}ms`, settle: 0 };
    },

    async look() {
      return { ok: true, report: 'took a fresh look', settle: 0, lookAfter: 0 };
    }
  };

  async function run(name, args = {}, ctx = {}) {
    const handler = actions[String(name || '').toLowerCase()];
    if (!handler) return { ok: false, report: `unknown action "${name}"` };
    try {
      const result = await handler(args, ctx);
      log(`[pc action] ${name} ${JSON.stringify(args).slice(0, 100)} -> ${result.ok ? 'ok' : 'FAILED'}${result.report ? `: ${clip(result.report, 120)}` : ''}`);
      return result;
    } catch (error) {
      log(`[pc action] ${name} threw: ${error.message}`);
      return { ok: false, report: `${name} failed: ${error.message}` };
    }
  }

  return { run, actions, resolvePoint, focusedField };
}

module.exports = { createDesktopActions, findElement, parseKeys, fractionToPhysical, coordsToPhysical, hasCoords, VK };
