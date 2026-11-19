const { app, BrowserWindow, ipcMain, session, Menu } = require('electron');
const { CHROME_USER_AGENT, SEC_CH_UA, CHROME_MAJOR } = require('./userAgent');
const path = require('path');
const shield = require('./shield');
const store = require('./store');
const TabManager = require('./tabManager');
const ControlPlane = require('../control-plane/controlPlane');
const profiles = require('./profiles');

// Single instance lock to prevent multi-process database and cache lock conflicts
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('[Adion Process] Another instance of Adion Browse is already active. Quitting duplicate process...');
  app.quit();
  process.exit(0);
}

app.userAgentFallback = CHROME_USER_AGENT;

// Silence non-critical Chromium C++ net warnings and grant continuous media streams
app.commandLine.appendSwitch('log-level', '3');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');

// OAuth workaround: hide automation indicators and disable features that fingerprint Electron
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors,BlockInsecurePrivateNetworkRequests');
app.commandLine.appendSwitch('disable-web-security', false);
app.commandLine.appendSwitch('disable-site-isolation-trials', true);

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

// Google OAuth blocks embedded browsers partly because Electron lacks the
// window.chrome object real Chrome exposes. Inject a minimal shim on Google
// pages so the sign-in flow sees a consistent browser fingerprint.
app.on('web-contents-created', (event, contents) => {
  contents.on('dom-ready', () => {
    try {
      const url = contents.getURL() || '';
      if (!/google\.(com|co\.in|co\.uk|ca|com\.au)/i.test(url)) return;
      contents.executeJavaScript(`(() => {
        if (window.chrome && window.chrome.app && window.chrome.runtime && navigator.userAgentData) return;
        const now = () => Date.now() / 1000;
        const loadTimes = () => ({ commitLoadTime: now(), finishDocumentLoadTime: now(), finishLoadTime: now(), firstPaintTime: now(), firstPaintAfterLoadTime: 0, navigationType: 'Other', wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2' });
        const csi = () => ({ onloadT: Date.now(), pageT: performance.now(), startE: performance.timeOrigin, tran: 15 });
        window.chrome = window.chrome || {};
        window.chrome.app = window.chrome.app || { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } };
        window.chrome.runtime = window.chrome.runtime || { OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' }, OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' }, PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' }, PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' }, PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' }, RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' } };
        window.chrome.csi = window.chrome.csi || csi;
        window.chrome.loadTimes = window.chrome.loadTimes || loadTimes;
        // Client Hints JS API — real Chrome exposes navigator.userAgentData
        if (!navigator.userAgentData) {
          const brands = [
            { brand: 'Not_A Brand', version: '99' },
            { brand: 'Chromium', version: '${CHROME_MAJOR}' },
            { brand: 'Google Chrome', version: '${CHROME_MAJOR}' }
          ];
          const uaData = {
            brands, mobile: false, platform: 'Windows',
            getHighEntropyValues: (hints) => Promise.resolve(Object.assign({
              architecture: 'x86', bitness: '64', brands,
              fullVersionList: brands.map(b => ({ brand: b.brand, version: b.version + '.0.0.0' })),
              mobile: false, model: '', platform: 'Windows', platformVersion: '15.0.0',
              uaFullVersion: '${CHROME_MAJOR}.0.0.0', wow64: false
            }, hints && hints.includes ? {} : {})),
            toJSON: () => ({ brands, mobile: false, platform: 'Windows' })
          };
          try { Object.defineProperty(navigator, 'userAgentData', { get: () => uaData, configurable: true }); } catch (_) { navigator.userAgentData = uaData; }
        }
        // Chrome ships built-in PDF viewer plugins; Electron reports an empty list
        try {
          if (!navigator.plugins || navigator.plugins.length === 0) {
            const makePlugin = (name, filename, desc) => ({ name, filename, description: desc, length: 1, 0: { type: 'application/pdf', suffixes: 'pdf', description: desc } });
            const arr = [
              makePlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
              makePlugin('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
              makePlugin('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
              makePlugin('Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
              makePlugin('WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format')
            ];
            arr.item = (i) => arr[i];
            arr.namedItem = (n) => arr.find(p => p.name === n);
            arr.refresh = () => {};
            Object.defineProperty(navigator, 'plugins', { get: () => arr, configurable: true });
          }
        } catch (_) {}
        // NetworkInformation API — Chrome exposes connection info, Electron often lacks it
        try {
          if (!navigator.connection) {
            const conn = {
              effectiveType: '4g', downlink: 10, downlinkMax: 10, rtt: 50, saveData: false,
              type: 'unknown',
              addEventListener: () => {}, removeEventListener: () => {},
              dispatchEvent: () => true, onchange: null
            };
            Object.defineProperty(navigator, 'connection', { get: () => conn, configurable: true });
          }
        } catch (_) {}
        // speechSynthesis voices — Chrome ships OS voices; Electron returns empty list
        try {
          if (window.speechSynthesis && (!speechSynthesis.getVoices || speechSynthesis.getVoices().length === 0)) {
            const mk = (name, lang) => Object.assign(new SpeechSynthesisVoice(), { name, lang, localService: true, default: false, voiceURI: name });
            const voices = [mk('Microsoft David - English (United States)', 'en-US'), mk('Microsoft Zira - English (United States)', 'en-US'), mk('Google US English', 'en-US')];
            speechSynthesis.getVoices = () => voices;
          }
        } catch (_) {}
        // Real Chrome has non-zero outer dimensions; some embedded contexts report 0
        try {
          if (window.outerWidth === 0 || window.outerHeight === 0) {
            Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth, configurable: true });
            Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 88, configurable: true });
          }
        } catch (_) {}
      })();`).catch(() => {});
    } catch (_) {}
  });
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

  mainWindow.setMaxListeners(50);

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
    requestHeaders['sec-ch-ua'] = SEC_CH_UA;
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
  const configuredSessions = new Set([session.defaultSession]);
  const configureProfileSession = (sess) => {
    if (!sess || configuredSessions.has(sess)) return;
    configuredSessions.add(sess);
    try { sess.setUserAgent(CHROME_USER_AGENT); } catch (_) {}
    try {
      sess.webRequest.onBeforeSendHeaders((details, callback) => {
        const requestHeaders = { ...details.requestHeaders };
        requestHeaders['User-Agent'] = CHROME_USER_AGENT;
        requestHeaders['sec-ch-ua'] = SEC_CH_UA;
        requestHeaders['sec-ch-ua-mobile'] = '?0';
        requestHeaders['sec-ch-ua-platform'] = '"Windows"';
        callback({ requestHeaders });
      });
    } catch (_) {}
    try { shield.init(sess); } catch (_) {}
  };
  tabManager.getProfilePartition = () => {
    const partition = profiles.partitionFor();
    try { configureProfileSession(session.fromPartition(partition)); } catch (_) {}
    return partition;
  };

  // Profile management IPC
  const sendProfiles = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('profile-updated', profiles.list());
    }
  };
  ipcMain.handle('profile:list', () => profiles.list());
  ipcMain.handle('profile:create', (e, name) => {
    const p = profiles.create(name || 'New Profile');
    sendProfiles();
    return p;
  });
  ipcMain.handle('profile:switch', (e, id) => {
    const p = profiles.switch(id);
    if (p && tabManager) {
      tabManager.closeAllTabs();
      tabManager.createTab('adion://newtab');
      controlPlane && controlPlane.onActiveTabChanged && controlPlane.onActiveTabChanged(tabManager.getActiveTab());
    }
    sendProfiles();
    return p;
  });
  ipcMain.handle('profile:delete', (e, id) => {
    const ok = profiles.remove(id);
    sendProfiles();
    return ok;
  });

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

  ipcMain.handle('update-setting', (e, payload, maybeVal) => {
    let key, value;
    if (typeof payload === 'string') {
      key = payload;
      value = maybeVal;
    } else if (payload && typeof payload === 'object') {
      key = payload.key;
      value = payload.value;
    }
    if (key !== undefined) {
      store.setSetting(key, value);
    }
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
