const { app, BrowserWindow, ipcMain, session, Menu } = require('electron');
const path = require('path');
const shield = require('./shield');
const store = require('./store');
const TabManager = require('./tabManager');
const ControlPlane = require('../control-plane/controlPlane');

// Silence non-critical Chromium C++ net warnings
app.commandLine.appendSwitch('log-level', '3');

// Main Electron process
let mainWindow = null;
let tabManager = null;
let controlPlane = null;

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
    return store.get('bookmarks');
  });

  ipcMain.handle('toggle-bookmark', (e, { title, url }) => {
    if (store.isBookmarked(url)) {
      store.removeBookmark(url);
      return { isBookmarked: false, bookmarks: store.get('bookmarks') };
    } else {
      store.addBookmark({ title, url });
      return { isBookmarked: true, bookmarks: store.get('bookmarks') };
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
