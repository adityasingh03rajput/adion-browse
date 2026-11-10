const { BrowserView, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const shield = require('./shield');
const store = require('./store');

const TOP_BAR_HEIGHT = 80;

class TabManager {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.tabs = new Map(); // id -> tabObject
    this.activeTabId = null;
    this.nextTabId = 1;
    this.newTabPath = path.join(__dirname, '../newtab/newtab.html');
    this.dashboardPath = path.join(__dirname, '../dashboard/dashboard.html');
    this.tabSwitchedCallback = null;

    // Handle window resize
    this.mainWindow.on('resize', () => {
      this.resizeActiveTab();
    });
  }

  getBounds() {
    const [width, height] = this.mainWindow.getContentSize();
    return {
      x: 0,
      y: TOP_BAR_HEIGHT,
      width: width,
      height: Math.max(0, height - TOP_BAR_HEIGHT)
    };
  }

  resizeActiveTab() {
    if (!this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    if (tab && tab.view) {
      tab.view.setBounds(this.getBounds());
    }
  }

  resolveUrl(input) {
    if (!input || input === 'adion://newtab' || input === 'about:blank') {
      const stats = store.get('stats');
      return `file://${this.newTabPath}?blocked=${stats.totalBlocked}&kb=${stats.estimatedBandwidthSavedKB}&sec=${stats.estimatedTimeSavedSec}&reward=14.50`;
    }

    if (input === 'adion://dashboard' || input === 'adion://metrics' || input === 'adion://telemetry') {
      return `file://${this.dashboardPath}`;
    }

    const trimmed = input.trim();

    // 1. Direct file:// protocol
    if (trimmed.startsWith('file://')) {
      return trimmed;
    }

    // 2. Windows drive absolute path (e.g. D:\Adion Browse\audio.html or D:/Adion Browse/audio.html)
    if (/^[a-zA-Z]:[\\\/]/.test(trimmed)) {
      const resolved = path.resolve(trimmed).replace(/\\/g, '/');
      return `file:///${resolved}`;
    }

    // 3. Local workspace file match (e.g. "audio.html", "audio", "./audio.html")
    const workspaceFilePath = path.resolve(process.cwd(), trimmed);
    if (fs.existsSync(workspaceFilePath) && fs.statSync(workspaceFilePath).isFile()) {
      return `file:///${workspaceFilePath.replace(/\\/g, '/')}`;
    }
    if (!trimmed.includes('.') && fs.existsSync(`${workspaceFilePath}.html`)) {
      return `file:///${(`${workspaceFilePath}.html`).replace(/\\/g, '/')}`;
    }

    // 4. Relative paths or Unix-style paths
    if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) {
      const resolved = path.resolve(trimmed);
      if (fs.existsSync(resolved)) {
        return `file:///${resolved.replace(/\\/g, '/')}`;
      }
    }

    // 5. Explicit URL with protocol (http://, https://, adion://, chrome://)
    if (/^[a-zA-Z]+:\/\//.test(trimmed)) {
      return trimmed;
    }

    // 6. Domain name (e.g. example.com, localhost:3000, wikipedia.org)
    if (/^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(:\d+)?(\/.*)?$/.test(trimmed) || /^localhost(:\d+)?(\/.*)?$/.test(trimmed)) {
      return `https://${trimmed}`;
    }

    // 7. Otherwise, treat as web search
    const engine = store.getSetting('searchEngine') || 'brave';
    const query = encodeURIComponent(trimmed);
    switch (engine) {
      case 'duckduckgo':
        return `https://duckduckgo.com/?q=${query}`;
      case 'google':
        return `https://www.google.com/search?q=${query}`;
      case 'bing':
        return `https://www.bing.com/search?q=${query}`;
      case 'brave':
      default:
        return `https://search.brave.com/search?q=${query}`;
    }
  }

  createTab(initialUrl = 'adion://newtab') {
    const id = `tab_${this.nextTabId++}`;
    const view = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        spellcheck: true
      }
    });

    view.setAutoResize({ width: true, height: true });

    const tab = {
      id,
      view,
      url: initialUrl,
      title: 'New Tab',
      favicon: '',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      webContentsId: view.webContents.id
    };

    this.tabs.set(id, tab);

    // Setup WebContents handlers
    const wc = view.webContents;
    wc.setMaxListeners(40);

    wc.setWindowOpenHandler(({ url }) => {
      this.createTab(url);
      return { action: 'deny' };
    });

    const canGoBack = (wc) => (wc.navigationHistory ? wc.navigationHistory.canGoBack() : (wc.canGoBack ? wc.canGoBack() : false));
    const canGoForward = (wc) => (wc.navigationHistory ? wc.navigationHistory.canGoForward() : (wc.canGoForward ? wc.canGoForward() : false));

    wc.on('did-start-loading', () => {
      tab.isLoading = true;
      this.sendTabUpdate(tab);
    });

    wc.on('did-stop-loading', () => {
      tab.isLoading = false;
      tab.canGoBack = canGoBack(wc);
      tab.canGoForward = canGoForward(wc);
      this.sendTabUpdate(tab);
    });

    wc.on('page-title-updated', (e, title) => {
      tab.title = title || 'Untitled';
      this.sendTabUpdate(tab);
    });

    wc.on('page-favicon-updated', (e, favicons) => {
      if (favicons && favicons.length > 0) {
        tab.favicon = favicons[0];
        this.sendTabUpdate(tab);
      }
    });

    wc.on('did-navigate', (e, url) => {
      this.handleNavigation(tab, url);
    });

    wc.on('did-navigate-in-page', (e, url) => {
      this.handleNavigation(tab, url);
    });

    // Load initial URL
    const targetUrl = this.resolveUrl(initialUrl);
    view.webContents.loadURL(targetUrl);

    // Make active
    this.switchTab(id);
    this.sendTabsList();
    return tab;
  }

  handleNavigation(tab, url) {
    const isNewTab = url.startsWith('file://') && url.includes('newtab.html');
    const isDashboard = url.startsWith('file://') && url.includes('dashboard.html');
    if (isNewTab) {
      tab.url = 'adion://newtab';
    } else if (isDashboard) {
      tab.url = 'adion://dashboard';
    } else {
      tab.url = url;
    }
    const wc = tab.view.webContents;
    tab.canGoBack = wc.navigationHistory ? wc.navigationHistory.canGoBack() : (wc.canGoBack ? wc.canGoBack() : false);
    tab.canGoForward = wc.navigationHistory ? wc.navigationHistory.canGoForward() : (wc.canGoForward ? wc.canGoForward() : false);

    let domain = '';
    try {
      if (!isNewTab) {
        domain = new URL(url).hostname;
        store.addHistory({ title: tab.title, url: tab.url });
      }
    } catch (e) {}

    shield.resetTabStats(tab.webContentsId, domain);
    this.sendTabUpdate(tab);
  }

  switchTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;

    let devToolsWasOpen = false;
    if (this.activeTabId && this.tabs.has(this.activeTabId)) {
      const prevTab = this.tabs.get(this.activeTabId);
      if (prevTab && prevTab.view) {
        try {
          devToolsWasOpen = prevTab.view.webContents.isDevToolsOpened();
          if (devToolsWasOpen) {
            prevTab.view.webContents.closeDevTools();
          }
        } catch (_) {}
        this.mainWindow.removeBrowserView(prevTab.view);
      }
    }

    this.activeTabId = id;
    this.mainWindow.setBrowserView(tab.view);
    tab.view.setBounds(this.getBounds());

    // Accurately focus the web contents of the newly active tab
    try {
      tab.view.webContents.focus();
    } catch (_) {}

    // Maintain developer tools continuity if open on the previous tab
    if (devToolsWasOpen) {
      try {
        tab.view.webContents.openDevTools({ mode: 'right', activate: false });
      } catch (_) {}
    }

    this.sendTabsList();
    this.sendTabUpdate(tab);

    // Notify shield stats for this tab
    const stats = shield.getTabStats(tab.webContentsId);
    this.mainWindow.webContents.send('shield-stats-update', {
      tabId: id,
      stats
    });

    if (this.tabSwitchedCallback) {
      this.tabSwitchedCallback(tab);
    }
  }

  closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;

    shield.cleanTab(tab.webContentsId);

    if (this.activeTabId === id) {
      this.mainWindow.removeBrowserView(tab.view);
    }

    // Destroy webContents
    try {
      tab.view.webContents.destroy();
    } catch (e) {}

    this.tabs.delete(id);

    if (this.tabs.size === 0) {
      // If no tabs left, open a new one or close app
      this.createTab();
    } else if (this.activeTabId === id) {
      // Switch to the last remaining tab
      const remainingIds = Array.from(this.tabs.keys());
      const nextId = remainingIds[remainingIds.length - 1];
      this.switchTab(nextId);
    } else {
      this.sendTabsList();
    }
  }

  navigateActiveTab(input) {
    if (!this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    if (!tab) return;

    const url = this.resolveUrl(input);
    tab.view.webContents.loadURL(url);
  }

  reloadActiveTab() {
    if (!this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    if (tab) tab.view.webContents.reload();
  }

  stopActiveTab() {
    if (!this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    if (tab) tab.view.webContents.stop();
  }

  goBackActiveTab() {
    if (!this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    if (!tab) return;
    const wc = tab.view.webContents;
    const canBack = wc.navigationHistory ? wc.navigationHistory.canGoBack() : (wc.canGoBack ? wc.canGoBack() : false);
    if (canBack) {
      if (wc.navigationHistory && wc.navigationHistory.goBack) wc.navigationHistory.goBack();
      else wc.goBack();
    }
  }

  goForwardActiveTab() {
    if (!this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    if (!tab) return;
    const wc = tab.view.webContents;
    const canFwd = wc.navigationHistory ? wc.navigationHistory.canGoForward() : (wc.canGoForward ? wc.canGoForward() : false);
    if (canFwd) {
      if (wc.navigationHistory && wc.navigationHistory.goForward) wc.navigationHistory.goForward();
      else wc.goForward();
    }
  }

  toggleDevTools(mode = 'right') {
    if (!this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    if (!tab || !tab.view) return;
    const wc = tab.view.webContents;
    try {
      if (wc.isDevToolsOpened()) {
        wc.closeDevTools();
        wc.focus();
      } else {
        wc.openDevTools({ mode, activate: true });
      }
    } catch (e) {
      console.warn('[TabManager] Error toggling DevTools:', e.message);
    }
  }

  /**
   * Accurately focus and switch between developer tools panel tabs (Console, Elements, Network, Sources, etc.)
   */
  switchDevToolsPanel(panelName = 'console') {
    if (!this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    if (!tab || !tab.view) return;
    const wc = tab.view.webContents;

    if (!wc.isDevToolsOpened()) {
      wc.openDevTools({ mode: 'right', activate: true });
    }

    const normalized = (panelName || 'console').toLowerCase().trim();
    const panelMap = {
      'console': 'console',
      'elements': 'elements',
      'inspector': 'elements',
      'network': 'network',
      'sources': 'sources',
      'debugger': 'sources',
      'application': 'resources',
      'resources': 'resources',
      'storage': 'resources',
      'performance': 'timeline',
      'timeline': 'timeline',
      'memory': 'heap_profiler',
      'security': 'security'
    };
    const targetPanel = panelMap[normalized] || normalized;

    const dispatchSwitch = () => {
      try {
        if (wc.devToolsWebContents && !wc.devToolsWebContents.isDestroyed()) {
          wc.devToolsWebContents.executeJavaScript(`
            (function(pName) {
              try {
                if (window.DevToolsAPI && window.DevToolsAPI.showPanel) {
                  window.DevToolsAPI.showPanel(pName);
                  return true;
                }
                if (window.UI && window.UI.viewManager) {
                  window.UI.viewManager.showView(pName);
                  return true;
                }
                const el = document.getElementById('tab-' + pName);
                if (el) { el.click(); return true; }
              } catch(e) {}
              return false;
            })(${JSON.stringify(targetPanel)})
          `).catch(() => {});
          wc.devToolsWebContents.focus();
        }
      } catch (err) {
        console.warn('[TabManager] DevTools switch error:', err.message);
      }
    };

    if (wc.devToolsWebContents) {
      dispatchSwitch();
    } else {
      wc.once('devtools-opened', () => {
        setTimeout(dispatchSwitch, 250);
      });
    }
  }

  /**
   * Focus developer tools window / console
   */
  focusDevTools() {
    if (!this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    if (!tab || !tab.view) return;
    const wc = tab.view.webContents;
    if (!wc.isDevToolsOpened()) {
      wc.openDevTools({ mode: 'right', activate: true });
    }
    if (wc.devToolsWebContents && !wc.devToolsWebContents.isDestroyed()) {
      wc.devToolsWebContents.focus();
    }
  }

  /**
   * Accurately focus the active webpage content
   */
  focusPage() {
    if (!this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    if (tab && tab.view) {
      tab.view.webContents.focus();
    }
  }

  /**
   * Switch tab by index, title, or query
   */
  switchTabByQuery(query) {
    if (!query) return null;
    const q = String(query).toLowerCase().trim();

    // 1. Direct index e.g. "1", "tab 2", "first"
    const indexMatch = q.match(/^(?:tab\s+)?(\d+)$/);
    if (indexMatch) {
      const idx = parseInt(indexMatch[1], 10) - 1;
      const tabList = Array.from(this.tabs.values());
      if (idx >= 0 && idx < tabList.length) {
        this.switchTab(tabList[idx].id);
        return tabList[idx];
      }
    }

    if (q === 'first' || q === 'first tab') {
      const tabList = Array.from(this.tabs.values());
      if (tabList.length > 0) {
        this.switchTab(tabList[0].id);
        return tabList[0];
      }
    }
    if (q === 'last' || q === 'last tab') {
      const tabList = Array.from(this.tabs.values());
      if (tabList.length > 0) {
        this.switchTab(tabList[tabList.length - 1].id);
        return tabList[tabList.length - 1];
      }
    }

    // 2. Title or URL matching
    for (const tab of this.tabs.values()) {
      const title = (tab.title || '').toLowerCase();
      const url = (tab.url || '').toLowerCase();
      if (title.includes(q) || url.includes(q)) {
        this.switchTab(tab.id);
        return tab;
      }
    }

    return null;
  }

  getActiveTab() {
    return this.tabs.get(this.activeTabId);
  }

  sendTabUpdate(tab) {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send('tab-updated', {
      id: tab.id,
      title: tab.title,
      url: tab.url,
      favicon: tab.favicon,
      isLoading: tab.isLoading,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      isBookmarked: store.isBookmarked(tab.url)
    });
  }

  sendTabsList() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    const list = Array.from(this.tabs.values()).map(t => ({
      id: t.id,
      title: t.title,
      url: t.url,
      favicon: t.favicon,
      isLoading: t.isLoading,
      isActive: t.id === this.activeTabId
    }));
    this.mainWindow.webContents.send('tabs-list-updated', {
      tabs: list,
      activeTabId: this.activeTabId
    });
  }
}

module.exports = TabManager;
