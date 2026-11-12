const { app, BrowserWindow, ipcMain, session, Menu } = require('electron');
const path = require('path');
const shield = require('./shield');
const store = require('./store');
const TabManager = require('./tabManager');
const ControlPlane = require('../control-plane/controlPlane');

// Single instance lock to prevent multi-process database and cache lock conflicts
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('[Adion Process] Another instance of Adion Browse is already active. Quitting duplicate process...');
  app.quit();
  process.exit(0);
}

// Standard modern Google Chrome User-Agent (prevents web apps like WhatsApp Web, Slack, etc. from rejecting Electron)
const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
app.userAgentFallback = CHROME_USER_AGENT;

// Silence non-critical Chromium C++ net warnings and grant continuous media streams
app.commandLine.appendSwitch('log-level', '3');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');

// Main Electron process
let mainWindow = null;
let tabManager = null;
let controlPlane = null;
let isShuttingDown = false;

/**
 * Graceful process termination and flush handler
 */
function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[Adion Process] Intercepted ${signal}. Performing clean shutdown and flushing profile data...`);
  try {
    store.flush();
  } catch (err) {
    console.error('[Adion Process] Error flushing profile on shutdown:', err.message);
  }
  if (controlPlane) {
    try {
      controlPlane.destroy();
    } catch (_) {}
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }
  app.quit();
  setTimeout(() => process.exit(0), 400);
}

// Process signal & error management
let sigintCount = 0;
let sigintResetTimer = null;

process.on('SIGINT', () => {
  sigintCount++;
  console.log(`[Adion Process] Intercepted SIGINT (${sigintCount}/2). Auto-flushed profile data to disk.`);
  try { store.flush(); } catch (_) {}

  // If browser window is already closed or destroyed, shut down immediately
  if (!mainWindow || mainWindow.isDestroyed()) {
    return gracefulShutdown('SIGINT');
  }

  // Require consecutive double SIGINT within 1.5s to shut down an active GUI browser from terminal
  if (sigintCount >= 2) {
    gracefulShutdown('SIGINT (Confirmed)');
  } else {
    if (sigintResetTimer) clearTimeout(sigintResetTimer);
    sigintResetTimer = setTimeout(() => {
      sigintCount = 0;
    }, 1500);
  }
});

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('[Adion Process] Uncaught Exception caught by process manager:', err);
  try { store.flush(); } catch (_) {}
});

process.on('unhandledRejection', (reason, promise) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  if (msg.includes('Script failed to execute') || msg.includes('Execution context was destroyed')) {
    return; // Normal transient page-level script error during navigation
  }
  console.error('[Adion Process] Unhandled Rejection at:', promise, 'reason:', reason);
});

// Chromium child process stability monitors
app.on('render-process-gone', (event, webContents, details) => {
  console.warn(`[Adion Process] Render process exited: ${details.reason} (exitCode: ${details.exitCode})`);
});

app.on('child-process-gone', (event, details) => {
  console.warn(`[Adion Process] Chromium child process exited: ${details.type} (${details.reason}, exitCode: ${details.exitCode})`);
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    frame: true, // Native title bar + controls
    title: 'Adion Browse',
    backgroundColor: '#16181d',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  // Native keyboard shortcuts for DevTools (F12 / Ctrl+Shift+I)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown') {
      if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
        event.preventDefault();
        if (tabManager) tabManager.toggleDevTools('detach');
      }
    }
  });

  // Initialize Adion Shield engine
  await shield.init(session.defaultSession);

  // Apply standard Chrome 100+ User-Agent across session and web requests
  session.defaultSession.setUserAgent(CHROME_USER_AGENT);
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    requestHeaders['User-Agent'] = CHROME_USER_AGENT;
    requestHeaders['sec-ch-ua'] = '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"';
    requestHeaders['sec-ch-ua-mobile'] = '?0';
    requestHeaders['sec-ch-ua-platform'] = '"Windows"';
    callback({ requestHeaders });
  });

  // Microphone access belongs to the browser's own chrome renderer (Voice HUD),
  // never to arbitrary web content. Websites must not inherit this grant.
  const MEDIA_PERMISSIONS = ['media', 'microphone', 'audio-capture'];
  const isOwnChrome = (webContents) => Boolean(
    mainWindow && !mainWindow.isDestroyed() && webContents && webContents === mainWindow.webContents
  );

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = isOwnChrome(webContents) && MEDIA_PERMISSIONS.includes(permission);
    if (!allowed) {
      console.warn(`[Permissions] Denied "${permission}" for non-browser content`);
    }
    callback(allowed);
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return isOwnChrome(webContents) && MEDIA_PERMISSIONS.includes(permission);
  });

  // Initialize Tab Manager
  tabManager = new TabManager(mainWindow);

  // Resolve per-site shield policy against the tab's top-level page, not the
  // subresource host (a tracker is served from a third-party domain).
  shield.setSiteResolver((webContentsId) => {
    if (!tabManager) return '';
    for (const tab of tabManager.tabs.values()) {
      if (tab.webContentsId === webContentsId) return tab.url || '';
    }
    return '';
  });

  // Initialize Decoupled AI Voice & Autonomous Control Plane
  controlPlane = new ControlPlane(mainWindow, tabManager);
  tabManager.tabSwitchedCallback = (tab) => {
    controlPlane.onActiveTabChanged(tab);
  };

  // Renderer diagnostic relay — receives explicit log() IPC calls from renderer for terminal visibility
  ipcMain.on('renderer:log', (event, msg) => {
    console.log(`[Renderer] ${msg}`);
  });

  // Forward renderer console messages to terminal (Electron 45+ compatible)
  mainWindow.webContents.on('console-message', (...args) => {
    // Electron 45+: single Event object with .message property
    // Legacy: (event, level, message, line, sourceId)
    let rawMsg = '';
    for (const a of args) {
      if (a && typeof a.message === 'string') { rawMsg = a.message; break; }
      if (typeof a === 'string' && a.length > 0) { rawMsg = a; break; }
    }
    if (!rawMsg) return;
    if (rawMsg.includes('Electron Security Warning') || rawMsg.includes('Autofill.')) return;
    // Forward errors and all renderer logs that are prefixed with our tags
    if (rawMsg.includes('Error') || rawMsg.includes('error') || rawMsg.includes('Uncaught') ||
        rawMsg.includes('[Voice') || rawMsg.includes('[Microphone') || rawMsg.includes('[Mic') ||
        rawMsg.includes('Speech') || rawMsg.includes('[AgentRuntime') || rawMsg.includes('Heard:') ||
        rawMsg.includes('[STT') || rawMsg.includes('[Nav]') || rawMsg.includes('[Renderer]')) {
      console.log(`[Renderer] ${rawMsg}`);
    }
  });

  // Load the browser chrome UI after all IPC handlers are actively listening
  await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Create initial tab
  tabManager.createTab('adion://newtab');

  // Listen for blocked requests to notify renderer
  shield.onBlocked((tabWebContentsId, stats) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const activeTab = tabManager.getActiveTab();
    if (activeTab && activeTab.webContentsId === tabWebContentsId) {
      mainWindow.webContents.send('shield-stats-update', {
        tabId: activeTab.id,
        stats
      });
    }
  });

  mainWindow.on('closed', () => {
    if (controlPlane) controlPlane.destroy();
    controlPlane = null;
    mainWindow = null;
    tabManager = null;
  });
}

// Setup IPC handlers
function setupIPC() {
  // Navigation & Tabs
  ipcMain.on('tab-new', (e, url) => {
    tabManager.createTab(url || 'adion://newtab');
  });

  ipcMain.on('tab-close', (e, id) => {
    tabManager.closeTab(id);
  });

  ipcMain.on('tab-switch', (e, id) => {
    tabManager.switchTab(id);
  });

  ipcMain.on('navigate', (e, url) => {
    tabManager.navigateActiveTab(url);
  });

  ipcMain.on('reload', () => {
    tabManager.reloadActiveTab();
  });

  ipcMain.on('stop', () => {
    tabManager.stopActiveTab();
  });

  ipcMain.on('go-back', () => {
    tabManager.goBackActiveTab();
  });

  ipcMain.on('go-forward', () => {
    tabManager.goForwardActiveTab();
  });

  ipcMain.on('toggle-devtools', () => {
    tabManager.toggleDevTools();
  });

  ipcMain.on('set-overlay-active', (e, active) => {
    if (tabManager) {
      tabManager.setOverlayActive(Boolean(active));
    }
  });

  ipcMain.on('set-side-panel-open', (e, isOpen) => {
    if (tabManager) {
      tabManager.setSidePanelOpen(Boolean(isOpen));
    }
  });

  ipcMain.on('devtools-switch-panel', (e, panel) => {
    tabManager.switchDevToolsPanel(panel);
  });

  ipcMain.on('devtools-focus', () => {
    tabManager.focusDevTools();
  });

  ipcMain.on('page-focus', () => {
    tabManager.focusPage();
  });

  ipcMain.on('tab-switch-query', (e, query) => {
    tabManager.switchTabByQuery(query);
  });

  // Adion Shields IPC
  ipcMain.handle('get-shields-state', (e, domain) => {
    return {
      siteShield: store.getSiteShield(domain),
      globalSettings: {
        shieldsEnabled: store.getSetting('shieldsEnabled'),
        blockScripts: store.getSetting('blockScripts'),
        upgradeHttps: store.getSetting('upgradeHttps')
      },
      stats: store.get('stats')
    };
  });

  ipcMain.handle('toggle-site-shield', (e, { domain, enabled }) => {
    store.setSiteShield(domain, { enabled });
    // Reload active tab to apply change
    tabManager.reloadActiveTab();
    return store.getSiteShield(domain);
  });

  ipcMain.handle('toggle-site-scripts', (e, { domain, blockScripts }) => {
    store.setSiteShield(domain, { blockScripts });
    tabManager.reloadActiveTab();
    return store.getSiteShield(domain);
  });

  ipcMain.handle('get-shields-stats', () => {
    return store.get('stats');
  });

  // Bookmarks
  ipcMain.handle('get-bookmarks', () => {
    try {
      return store.get('bookmarks') || [];
    } catch (err) {
      console.error('[Store IPC] Error reading bookmarks:', err.message);
      return [];
    }
  });

  ipcMain.handle('toggle-bookmark', (e, payload) => {
    try {
      if (!payload || !payload.url) {
        return { isBookmarked: false, bookmarks: store.get('bookmarks') || [] };
      }
      const { title, url } = payload;
      if (store.isBookmarked(url)) {
        store.removeBookmark(url);
        return { isBookmarked: false, bookmarks: store.get('bookmarks') || [] };
      } else {
        store.addBookmark({ title, url });
        return { isBookmarked: true, bookmarks: store.get('bookmarks') || [] };
      }
    } catch (err) {
      console.error('[Store IPC] Error toggling bookmark:', err.message);
      return { isBookmarked: false, bookmarks: store.get('bookmarks') || [], error: err.message };
    }
  });

  // History
  ipcMain.handle('get-history', () => {
    return store.get('history');
  });

  ipcMain.handle('clear-history', () => {
    store.clearHistory();
    return [];
  });

  // Settings
  ipcMain.handle('get-settings', () => {
    return store.get('settings');
  });

  ipcMain.handle('update-setting', (e, { key, value }) => {
    store.setSetting(key, value);
    return store.get('settings');
  });

  // Window Controls (if custom framing used)
  ipcMain.on('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.on('window-maximize', () => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
  });

  ipcMain.on('window-close', () => {
    if (mainWindow) mainWindow.close();
  });
}

app.whenReady().then(async () => {
  if (Menu && Menu.setApplicationMenu) {
    Menu.setApplicationMenu(null);
  }
  setupIPC();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
