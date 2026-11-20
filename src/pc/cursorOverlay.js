'use strict';

/**
 * Adion Browse — Animated AI Virtual Cursor Overlay
 *
 * Provides a dedicated, visible, animated mouse cursor for the AI agent on desktop.
 * - Always on top, frameless, transparent.
 * - 100% click-through (setIgnoreMouseEvents true) so it never intercepts user clicks.
 * - Glides fluidly with easing to target coordinates.
 * - Triggers visual ripple waves on click.
 * - Preserves the user's physical mouse cursor (no hijacking).
 */

function createCursorOverlay(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  let overlayWin = null;
  let isReady = false;
  let queue = [];
  let hideTimer = null;

  function ensureWindow() {
    if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;

    try {
      const electron = require('electron');
      const { BrowserWindow, screen } = electron;
      if (!BrowserWindow || !screen) return null;

      const primary = screen.getPrimaryDisplay();
      const bounds = primary ? primary.bounds : { x: 0, y: 0, width: 1920, height: 1080 };

      overlayWin = new BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: false,
        hasShadow: false,
        resizable: false,
        movable: false,
        enableLargerThanScreen: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true
        }
      });

      overlayWin.setIgnoreMouseEvents(true, { forward: true });
      try {
        overlayWin.setAlwaysOnTop(true, 'screen-saver');
      } catch (_) {
        overlayWin.setAlwaysOnTop(true, 'floating');
      }

      const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    background: transparent;
    pointer-events: none;
    user-select: none;
  }
  #ai-pointer {
    position: absolute;
    top: 0;
    left: 0;
    width: 32px;
    height: 32px;
    pointer-events: none;
    transform: translate3d(-100px, -100px, 0);
    transition: transform 0.28s cubic-bezier(0.2, 0.9, 0.2, 1), opacity 0.25s ease;
    z-index: 2147483647;
    opacity: 0;
  }
  #ai-pointer.active {
    opacity: 1;
  }
  .cursor-svg {
    filter: drop-shadow(0 3px 10px rgba(0, 242, 254, 0.55)) drop-shadow(0 1px 3px rgba(0,0,0,0.8));
    transform-origin: 3px 3px;
    transition: transform 0.12s ease;
  }
  #ai-pointer.clicking .cursor-svg {
    transform: scale(0.82);
  }
  .ai-badge {
    position: absolute;
    left: 20px;
    top: 14px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: rgba(15, 23, 42, 0.88);
    backdrop-filter: blur(8px);
    border: 1px solid rgba(56, 189, 248, 0.45);
    color: #e0f2fe;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 999px;
    white-space: nowrap;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
    pointer-events: none;
    transition: all 0.2s ease;
  }
  .pulse-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #10b981;
    box-shadow: 0 0 8px #10b981;
    animation: dot-pulse 1.4s infinite ease-in-out;
  }
  @keyframes dot-pulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.4); opacity: 0.6; }
  }
  .cursor-ripple {
    position: absolute;
    border-radius: 50%;
    pointer-events: none;
    border: 2px solid #00f2fe;
    box-shadow: 0 0 16px rgba(0, 242, 254, 0.7);
    animation: ripple-expand 0.65s cubic-bezier(0.1, 0.8, 0.3, 1) forwards;
  }
  @keyframes ripple-expand {
    0% {
      width: 8px;
      height: 8px;
      margin-left: -4px;
      margin-top: -4px;
      opacity: 1;
      transform: scale(1);
    }
    100% {
      width: 68px;
      height: 68px;
      margin-left: -34px;
      margin-top: -34px;
      opacity: 0;
      transform: scale(1.8);
    }
  }
</style>
</head>
<body>
  <div id="ai-pointer">
    <svg class="cursor-svg" width="28" height="28" viewBox="0 0 24 24" fill="none">
      <path d="M3 3L10.5 21L14 13.5L21.5 10L3 3Z" fill="url(#grad)" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>
      <defs>
        <linearGradient id="grad" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
          <stop stop-color="#00f2fe"/>
          <stop offset="1" stop-color="#3b82f6"/>
        </linearGradient>
      </defs>
    </svg>
    <div class="ai-badge" id="ai-badge">
      <span class="pulse-dot"></span>
      <span id="badge-label">Adion</span>
    </div>
  </div>
  <div id="ripple-layer"></div>
  <script>
    const pointer = document.getElementById('ai-pointer');
    const badgeLabel = document.getElementById('badge-label');
    const rippleLayer = document.getElementById('ripple-layer');
    let fadeTimeout = null;

    window.animateCursor = function(x, y, action, label) {
      if (fadeTimeout) clearTimeout(fadeTimeout);
      pointer.classList.add('active');
      pointer.style.transform = 'translate3d(' + x + 'px, ' + y + 'px, 0)';
      if (label) badgeLabel.textContent = label;

      if (action === 'click') {
        pointer.classList.add('clicking');
        setTimeout(() => pointer.classList.remove('clicking'), 150);

        const rip = document.createElement('div');
        rip.className = 'cursor-ripple';
        rip.style.left = x + 'px';
        rip.style.top = y + 'px';
        rippleLayer.appendChild(rip);
        setTimeout(() => rip.remove(), 700);
      } else if (action === 'type') {
        badgeLabel.textContent = label ? 'Typing: ' + label : 'Typing...';
      }

      fadeTimeout = setTimeout(() => {
        pointer.classList.remove('active');
      }, 3500);
    };

    window.hideCursor = function() {
      pointer.classList.remove('active');
    };
  </script>
</body>
</html>`;

      overlayWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

      overlayWin.webContents.once('did-finish-load', () => {
        isReady = true;
        if (overlayWin && !overlayWin.isDestroyed()) {
          overlayWin.showInactive();
        }
        while (queue.length > 0) {
          const item = queue.shift();
          sendToOverlay(item.x, item.y, item.action, item.label);
        }
      });

      overlayWin.on('closed', () => {
        overlayWin = null;
        isReady = false;
      });

      return overlayWin;
    } catch (err) {
      log(`cursor overlay notice: ${err.message}`);
      return null;
    }
  }

  function sendToOverlay(x, y, action = 'move', label = 'Adion') {
    if (!overlayWin || overlayWin.isDestroyed() || !isReady) {
      queue.push({ x, y, action, label });
      ensureWindow();
      return;
    }

    const js = `window.animateCursor(${Number(x) || 0}, ${Number(y) || 0}, ${JSON.stringify(action)}, ${JSON.stringify(label)});`;
    overlayWin.webContents.executeJavaScript(js).catch(() => {});
  }

  return {
    clickAt(x, y, label = 'Adion') {
      sendToOverlay(x, y, 'click', label);
    },
    moveTo(x, y, label = 'Adion') {
      sendToOverlay(x, y, 'move', label);
    },
    typeAt(x, y, label = '') {
      sendToOverlay(x, y, 'type', label ? String(label).slice(0, 20) : 'Typing...');
    },
    hide() {
      if (overlayWin && !overlayWin.isDestroyed() && isReady) {
        overlayWin.webContents.executeJavaScript('window.hideCursor();').catch(() => {});
      }
    },
    destroy() {
      if (overlayWin && !overlayWin.isDestroyed()) {
        try { overlayWin.close(); } catch (_) {}
      }
      overlayWin = null;
      isReady = false;
    }
  };
}

module.exports = { createCursorOverlay };
