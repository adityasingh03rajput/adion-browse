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
      sandbox: false
    }
  });

  // Initialize Adion Shield engine
  await shield.init(session.defaultSession);

  // Grant audio/microphone capture permissions for the AI Voice Control Plane
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'microphone' || permission === 'audio-capture') {
      return callback(true);
    }
    callback(false);
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return permission === 'media' || permission === 'microphone' || permission === 'audio-capture';
  });

  // Load the browser chrome UI
  await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Initialize Tab Manager
  tabManager = new TabManager(mainWindow);

  // Initialize Decoupled AI Voice & Autonomous Control Plane
  controlPlane = new ControlPlane(mainWindow, tabManager);
  tabManager.tabSwitchedCallback = (tab) => {
    controlPlane.onActiveTabChanged(tab);
  };

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
