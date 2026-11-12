/* Adion Browse — theme module (ink-bleed port).
 * Drives `data-theme` on <html> ("dark" default, "light" optional) with an
 * ink-style circular reveal (View Transitions API, Chromium 111+) and a CSS
 * cross-fade fallback. Persists to localStorage instantly and to the main-process
 * store best-effort via window.adionAPI (method names probed defensively).
 * Plain classic script: exposes window.AdionTheme. No dependencies.
 */
(function () {
  'use strict';

  var THEME_KEY = 'adion-theme';
  var DARK = 'dark', LIGHT = 'light';
  var vtActive = false;

  function isLight() {
    return document.documentElement.dataset.theme === LIGHT;
  }

  function current() {
    return isLight() ? LIGHT : DARK;
  }

  function remember(t) {
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* storage blocked */ }
  }

  function persistToStore(t) {
    try {
      var api = window.adionAPI;
      if (!api || typeof api !== 'object') return;
      var v =
        (typeof api.updateSetting === 'function' && api.updateSetting('theme', t)) ||
        (typeof api.setSetting === 'function' && api.setSetting('theme', t)) ||
        (typeof api.set === 'function' && api.set('theme', t)) ||
        (typeof api.invoke === 'function' && api.invoke('update-setting', 'theme', t)) ||
        null;
      if (v && typeof v.catch === 'function') v.catch(function () {});
    } catch (e) { /* preload bridge unavailable (e.g. sandbox view) */ }
  }

  /** Reconcile with the main-process store once it is reachable (store wins). */
  function reconcileFromStore() {
    try {
      var api = window.adionAPI;
      if (!api || typeof api !== 'object') return;
      var p =
        (typeof api.getSettings === 'function' && api.getSettings()) ||
        (typeof api.getSetting === 'function' && api.getSetting('theme')) ||
        (typeof api.get === 'function' && api.get('theme')) ||
        (typeof api.invoke === 'function' && api.invoke('get-settings')) ||
        null;
      if (!p || typeof p.then !== 'function') return;
      p.then(function (res) {
        var t = res && typeof res === 'object' && !Array.isArray(res) ? res.theme : res;
        if ((t === LIGHT || t === DARK) && t !== current()) apply(t, null);
      }).catch(function () {});
    } catch (e) { /* ignore */ }
  }

  function apply(t, btn) {
    document.documentElement.dataset.theme = t;
    remember(t);
    persistToStore(t);
    syncButton(btn || document.getElementById('btnThemeToggle'));
    try {
      window.dispatchEvent(new CustomEvent('adion:theme', { detail: { theme: t } }));
    } catch (e) { /* ignore */ }
  }

  function setRevealOrigin(x, y) {
    var root = document.documentElement;
    var cx = typeof x === 'number' ? x : Math.round(window.innerWidth - 60);
    var cy = typeof y === 'number' ? y : Math.round(40);
    root.style.setProperty('--theme-cx', cx + 'px');
    root.style.setProperty('--theme-cy', cy + 'px');
  }

  function instantSet(t) {
    apply(t, null);
  }

  function set(t, x, y) {
    if (t !== LIGHT && t !== DARK) return current();
    if (t === current() || vtActive) {
      if (t !== current()) { /* transition running: queue not supported, apply after */ }
      else return t;
    }
    var reduce = false;
    try {
      reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) { /* ignore */ }
    var canVT = !reduce &&
      typeof document.startViewTransition === 'function';
    if (!canVT) {
      var root = document.documentElement;
      root.classList.add('theme-fade');
      apply(t, null);
      window.setTimeout(function () { root.classList.remove('theme-fade'); }, 500);
      return t;
    }
    setRevealOrigin(x, y);
    vtActive = true;
    try {
      var vt = document.startViewTransition(function () { apply(t, null); });
      var done = function () { vtActive = false; };
      if (vt && typeof vt.finished !== 'undefined') {
        if (typeof vt.finished.catch === 'function') vt.finished.then(done, done);
        else if (typeof vt.finished.then === 'function') vt.finished.then(done);
        else window.setTimeout(done, 800);
      } else {
        window.setTimeout(done, 800);
      }
    } catch (e) {
      vtActive = false;
      apply(t, null);
    }
    return t;
  }

  function toggle(x, y) {
    return set(isLight() ? DARK : LIGHT, x, y);
  }

  /** Accepts agent/voice commands: "theme dark" | "theme light" | "theme toggle". */
  function onCommand(cmd) {
    var s = String(cmd == null ? '' : (typeof cmd === 'object' ? (cmd.action || cmd.theme || '') : cmd)).toLowerCase();
    if (s.indexOf('light') !== -1 && s.indexOf('dark') === -1) return set(LIGHT);
    if (s.indexOf('dark') !== -1 && s.indexOf('light') === -1) return set(DARK);
    if (s.indexOf('toggle') !== -1 || s.indexOf('switch') !== -1) return toggle();
    return current();
  }

  // ---------- toggle button ----------

  var SUN_SVG =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" class="theme-ic theme-ic-sun">' +
    '<circle cx="12" cy="12" r="4.4" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
    '<g stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
    '<line x1="12" y1="2.5" x2="12" y2="5.2"/><line x1="12" y1="18.8" x2="12" y2="21.5"/>' +
    '<line x1="2.5" y1="12" x2="5.2" y2="12"/><line x1="18.8" y1="12" x2="21.5" y2="12"/>' +
    '<line x1="5" y1="5" x2="6.9" y2="6.9"/><line x1="17.1" y1="17.1" x2="19" y2="19"/>' +
    '<line x1="5" y1="19" x2="6.9" y2="17.1"/><line x1="17.1" y1="6.9" x2="19" y2="5"/>' +
    '</g></svg>';
  var MOON_SVG =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" class="theme-ic theme-ic-moon">' +
    '<path d="M20.2 13.4A8.2 8.2 0 1 1 10.6 3.8a6.9 6.9 0 0 0 9.6 9.6z" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';

  function ensureButton() {
    var btn = document.getElementById('btnThemeToggle');
    if (btn) { syncButton(btn); return btn; }
    var bar = document.querySelector('.menu-controls');
    if (!bar) return null;
    btn = document.createElement('button');
    btn.id = 'btnThemeToggle';
    btn.className = 'icon-btn theme-toggle';
    btn.title = 'Toggle light / dark theme (Ctrl+Shift+L)';
    btn.setAttribute('aria-label', 'Toggle light / dark theme');
    btn.innerHTML = SUN_SVG + MOON_SVG;
    var anchor = document.getElementById('btnSettings');
    if (anchor && anchor.parentNode === bar) bar.insertBefore(btn, anchor);
    else bar.appendChild(btn);
    syncButton(btn);
    btn.addEventListener('click', function (e) {
      var x = (e && typeof e.clientX === 'number') ? e.clientX : undefined;
      var y = (e && typeof e.clientY === 'number') ? e.clientY : undefined;
      toggle(x, y);
    });
    return btn;
  }

  function syncButton(btn) {
    if (!btn) return;
    var light = isLight();
    btn.setAttribute('aria-pressed', String(light));
    btn.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
    btn.title = light ? 'Switch to dark theme (Ctrl+Shift+L)' : 'Switch to light theme (Ctrl+Shift+L)';
    // Icon swap is CSS-driven ([data-theme] shows sun vs moon); keep DOM stable.
  }

  // ---------- settings-modal segmented control (runtime injection) ----------

  var settingsWired = false;

  function buildSeg() {
    var wrap = document.createElement('div');
    wrap.className = 'theme-seg';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Appearance');
    var bDark = document.createElement('button');
    bDark.type = 'button';
    bDark.className = 'theme-seg-btn';
    bDark.textContent = 'Dark';
    bDark.dataset.themeValue = DARK;
    var bLight = document.createElement('button');
    bLight.type = 'button';
    bLight.className = 'theme-seg-btn';
    bLight.textContent = 'Light';
    bLight.dataset.themeValue = LIGHT;
    function paint() {
      var c = current();
      bDark.classList.toggle('is-active', c === DARK);
      bLight.classList.toggle('is-active', c === LIGHT);
      bDark.setAttribute('aria-pressed', String(c === DARK));
      bLight.setAttribute('aria-pressed', String(c === LIGHT));
    }
    bDark.addEventListener('click', function () { set(DARK); paint(); });
    bLight.addEventListener('click', function () { set(LIGHT); paint(); });
    wrap.appendChild(bDark);
    wrap.appendChild(bLight);
    wrap._paint = paint;
    paint();
    window.addEventListener('adion:theme', paint);
    return wrap;
  }

  function injectSettingsUI() {
    // Find the static "Dark Cyber Theme" row and upgrade it in place.
    var els = document.querySelectorAll('body *');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.children.length !== 0) continue;
      var txt = (el.textContent || '').trim();
      if (txt === 'Dark Cyber Theme' || txt === 'Dark Cyber Theme — Active' || txt === 'Dark Cyber Theme - Active') {
        var row = el.parentElement;
        if (!row || row.querySelector('.theme-seg')) return;
        // Replace a trailing "— Active" style badge if present.
        var badge = null;
        var sib = el.nextElementSibling;
        if (sib && /active/i.test(sib.textContent || '')) badge = sib;
        var seg = buildSeg();
        if (badge) row.replaceChild(seg, badge);
        else row.appendChild(seg);
        el.textContent = 'Appearance';
        return;
      }
    }
  }

  function wireSettings() {
    if (settingsWired) return;
    settingsWired = true;
    var opener = document.getElementById('btnSettings');
    if (opener) opener.addEventListener('click', function () {
      window.setTimeout(injectSettingsUI, 60);
      window.setTimeout(injectSettingsUI, 400);
    });
    try {
      var mo = new MutationObserver(function () { injectSettingsUI(); });
      mo.observe(document.body, { childList: true, subtree: true });
      window.setTimeout(function () { mo.disconnect(); }, 30000);
    } catch (e) { /* ignore */ }
    injectSettingsUI();
  }

  // ---------- boot ----------

  function init() {
    ensureButton();
    wireSettings();
    reconcileFromStore();
    // Agent/voice bridge: preload hook (if patched) or DOM event.
    try {
      var api = window.adionAPI;
      if (api && typeof api.onThemeCommand === 'function') {
        api.onThemeCommand(function (cmd) { onCommand(cmd); });
      }
    } catch (e) { /* ignore */ }
    window.addEventListener('adion:theme-command', function (e) {
      onCommand(e && e.detail);
    });
    // Self-contained shortcut (app.js keydown chain untouched).
    window.addEventListener('keydown', function (e) {
      if (!e || e.repeat) return;
      if ((e.key === 'L' || e.key === 'l' || e.code === 'KeyL') && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        toggle();
      }
    }, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.AdionTheme = {
    get: current,
    set: set,
    toggle: toggle,
    apply: instantSet,
    onCommand: onCommand,
    syncButton: function () { syncButton(document.getElementById('btnThemeToggle')); }
  };
})();
