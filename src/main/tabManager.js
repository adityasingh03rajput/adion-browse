const { BrowserView, app, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const shield = require('./shield');
const store = require('./store');

const TOP_BAR_HEIGHT = 80;
const { CHROME_USER_AGENT } = require('./userAgent');

class TabManager {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.tabs = new Map(); // id -> tabObject
    this.activeTabId = null;
    this.nextTabId = 1;
    this.newTabPath = path.join(__dirname, '../newtab/newtab.html');
    this.dashboardPath = path.join(__dirname, '../dashboard/dashboard.html');
    this.tabSwitchedCallback = null;
    this.isOverlayActive = false;
    this.isSidePanelOpen = false;
    this.sidePanelWidth = 380;
    this.getProfilePartition = null; // () => partition string, set by main process

    // Handle window resize & state transitions (maximize, unmaximize, restore, fullscreen)
    const updateBounds = () => {
      setImmediate(() => {
        this.resizeActiveTab();
      });
    };
    this.mainWindow.on('resize', updateBounds);
    this.mainWindow.on('maximize', updateBounds);
    this.mainWindow.on('unmaximize', updateBounds);
    this.mainWindow.on('restore', updateBounds);
    this.mainWindow.on('enter-full-screen', updateBounds);
    this.mainWindow.on('leave-full-screen', updateBounds);
  }

  getBounds() {
    if (!this.mainWindow || (typeof this.mainWindow.isDestroyed === 'function' && this.mainWindow.isDestroyed())) {
      return { x: 0, y: TOP_BAR_HEIGHT, width: 1280, height: 720 };
    }
    let width = 1280;
    let height = 800;
    try {
      if (typeof this.mainWindow.getContentBounds === 'function') {
        const cb = this.mainWindow.getContentBounds();
        width = cb.width;
        height = cb.height;
      } else if (typeof this.mainWindow.getContentSize === 'function') {
        const size = this.mainWindow.getContentSize();
        width = size[0];
        height = size[1];
      }
    } catch (_) {}

    const sidePanelOffset = this.isSidePanelOpen ? this.sidePanelWidth : 0;
    return {
      x: 0,
      y: TOP_BAR_HEIGHT,
      width: Math.max(300, width - sidePanelOffset),
      height: Math.max(200, height - TOP_BAR_HEIGHT)
    };
  }

  setSidePanelOpen(isOpen, panelWidth = 380) {
    this.isSidePanelOpen = Boolean(isOpen);
    this.sidePanelWidth = panelWidth;
    this.resizeActiveTab();
  }

  setOverlayActive(active) {
    this.isOverlayActive = Boolean(active);
    if (!this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    if (!tab || !tab.view) return;

    if (this.isOverlayActive) {
      try {
        this.mainWindow.removeBrowserView(tab.view);
      } catch (_) {}
    } else {
      try {
        this.mainWindow.setBrowserView(tab.view);
        tab.view.setBounds(this.getBounds());
        try { tab.view.webContents.focus(); } catch (_) {}
      } catch (_) {}
    }
  }

  resizeActiveTab() {
    if (!this.activeTabId || this.isOverlayActive) return;
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

    // Opaque/script-capable schemes must never become a top-level document.
    if (/^(?:javascript|data|vbscript|blob):/i.test(trimmed)) {
      console.warn('[TabManager] Blocked unsafe navigation scheme');
      return this.buildSearchUrl(trimmed);
    }

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

    // 5. Explicit URL with a supported protocol. Unknown schemes are never
    // handed to the OS (they can launch external applications).
    const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):/);
    if (schemeMatch) {
      const scheme = schemeMatch[1].toLowerCase();
      const remainder = trimmed.slice(schemeMatch[0].length);
      // "localhost:3000" and "example.com:8080" are hosts with ports, not schemes.
      const isHostPort = /^\d+(?:\/|$)/.test(remainder);
      if (!isHostPort) {
        if (scheme === 'http' || scheme === 'https' || scheme === 'file') return trimmed;
        if (scheme === 'about' && /^about:blank$/i.test(trimmed)) return 'about:blank';
        console.warn('[TabManager] Blocked unhandled navigation scheme:', scheme);
        return this.buildSearchUrl(trimmed);
      }
    }

    // 6. Domain name (e.g. example.com, localhost:3000, wikipedia.org)
    if (/^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(:\d+)?(\/.*)?$/.test(trimmed) || /^localhost(:\d+)?(\/.*)?$/.test(trimmed)) {
      return `https://${trimmed}`;
    }

    // 7. Otherwise, treat as web search
    return this.buildSearchUrl(trimmed);
  }

  /** Build the configured search-engine URL for arbitrary text. */
  buildSearchUrl(text) {
    const engine = store.getSetting('searchEngine') || 'brave';
    const query = encodeURIComponent(String(text || ''));
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

  createTab(initialUrl = 'adion://newtab', options = {}) {
    const id = `tab_${this.nextTabId++}`;
    const partition = typeof this.getProfilePartition === 'function' ? this.getProfilePartition() : null;
    const view = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        spellcheck: true,
        ...(partition ? { partition } : {})
      }
    });

    try {
      view.webContents.setUserAgent(CHROME_USER_AGENT);
    } catch (_) {}

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
    
    // Store handler references for proper cleanup
    if (!wc.__adionHandlersAttached) {
      wc.__adionHandlersAttached = true;
      wc.__adionHandlerRefs = {};
    } else {
      // Remove existing handlers before re-attaching
      for (const __ev of ["did-start-loading", "did-stop-loading", "page-title-updated", "page-favicon-updated", "did-navigate", "did-navigate-in-page", "before-input-event"]) {
        try { 
          if (wc.__adionHandlerRefs && wc.__adionHandlerRefs[__ev]) {
            wc.removeListener(__ev, wc.__adionHandlerRefs[__ev]);
          } else {
            wc.removeAllListeners(__ev);
          }
        } catch (_) {} 
      }
    }

    wc.setWindowOpenHandler(({ url, disposition }) => {
      const trimmed = (url || '').trim();

      // Block empty or blank popup window hijacking
      if (!trimmed || trimmed === 'about:blank' || trimmed === 'javascript:void(0);' || /^javascript:/i.test(trimmed)) {
        console.warn('[TabManager] Blocked unsolicited blank popup from:', tab.url);
        return { action: 'deny' };
      }

      // Check with shield engine if blocker is active
      if (shield && shield.blocker) {
        try {
          const { Request } = require('@ghostery/adblocker');
          const req = Request.fromRawDetails({ url: trimmed, type: 'popup', sourceUrl: tab.url });
          const match = shield.blocker.match(req);
          if (match && match.match) {
            console.log('[TabManager] Shield blocked ad popup window:', trimmed);
            try { shield.recordBlocked(tab.webContentsId, new URL(trimmed).hostname, trimmed); } catch (_) {}
            return { action: 'deny' };
          }
        } catch (_) {}
      }

      // General-purpose popup focus protection:
      // Third-party / cross-origin popups must never hijack active focus from the user or the agent.
      let isSameOrigin = false;
      try {
        if (tab.url && trimmed && !trimmed.startsWith('adion://') && !tab.url.startsWith('adion://')) {
          const tabHost = new URL(tab.url).hostname;
          const targetHost = new URL(trimmed).hostname;
          isSameOrigin = tabHost === targetHost || targetHost.endsWith('.' + tabHost);
        }
      } catch (_) {}

      const shouldActivate = isSameOrigin && disposition !== 'background-tab';
      this.createTab(trimmed, { activate: shouldActivate });
      return { action: 'deny' };
    });

    // Keyboard shortcut handler for DevTools from within page webContents
    const beforeInputHandler = (event, input) => {
      if (input.type === 'keyDown') {
        if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
          event.preventDefault();
          this.toggleDevTools('detach');
        }
      }
    };
    wc.on('before-input-event', beforeInputHandler);
    wc.__adionHandlerRefs['before-input-event'] = beforeInputHandler;

    const canGoBack = (wc) => (wc.navigationHistory ? wc.navigationHistory.canGoBack() : (wc.canGoBack ? wc.canGoBack() : false));
    const canGoForward = (wc) => (wc.navigationHistory ? wc.navigationHistory.canGoForward() : (wc.canGoForward ? wc.canGoForward() : false));

    const startLoadingHandler = () => {
      tab.isLoading = true;
      this.sendTabUpdate(tab);
    };
    wc.on('did-start-loading', startLoadingHandler);
    wc.__adionHandlerRefs['did-start-loading'] = startLoadingHandler;

    const stopLoadingHandler = () => {
      tab.isLoading = false;
      tab.canGoBack = canGoBack(wc);
      tab.canGoForward = canGoForward(wc);
      this.sendTabUpdate(tab);
    };
    wc.on('did-stop-loading', stopLoadingHandler);
    wc.__adionHandlerRefs['did-stop-loading'] = stopLoadingHandler;

    const titleUpdateHandler = (e, title) => {
      tab.title = title || 'Untitled';
      this.sendTabUpdate(tab);
    };
    wc.on('page-title-updated', titleUpdateHandler);
    wc.__adionHandlerRefs['page-title-updated'] = titleUpdateHandler;

    const faviconUpdateHandler = (e, favicons) => {
      if (favicons && favicons.length > 0) {
        tab.favicon = favicons[0];
        this.sendTabUpdate(tab);
      }
    };
    wc.on('page-favicon-updated', faviconUpdateHandler);
    wc.__adionHandlerRefs['page-favicon-updated'] = faviconUpdateHandler;

    wc.on('did-navigate', (e, url) => {
      this.handleNavigation(tab, url);
    });

    wc.on('did-navigate-in-page', (e, url) => {
      this.handleNavigation(tab, url);
    });

    // Load initial URL
    const targetUrl = this.resolveUrl(initialUrl);
    view.webContents.loadURL(targetUrl);

    // Make active unless explicitly backgrounded
    if (options.activate !== false) {
      this.switchTab(id);
    }
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
      if (!isNewTab && !isDashboard) {
        domain = new URL(url).hostname;
        store.addHistory({ title: tab.title, url: tab.url });
      }
    } catch (e) {}

    shield.resetTabStats(tab.webContentsId, domain);
    this.sendTabUpdate(tab);
    this.resizeActiveTab();
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

    this.resizeActiveTab();
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

  toggleDevTools(mode = 'detach') {
    const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
    const targetWc = (tab && tab.view && !tab.view.webContents.isDestroyed())
      ? tab.view.webContents
      : (this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow.webContents : null);

    if (!targetWc) return;
    try {
      if (targetWc.isDevToolsOpened()) {
        targetWc.closeDevTools();
      } else {
        targetWc.openDevTools({ mode, activate: true });
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
    if (query === undefined || query === null || query === '') return null;

    // Handle numeric index directly
    if (typeof query === 'number') {
      const tabList = Array.from(this.tabs.values());
      const idx1 = query - 1; // 1-based index (e.g. 2 -> second tab)
      if (idx1 >= 0 && idx1 < tabList.length) {
        this.switchTab(tabList[idx1].id);
        return tabList[idx1];
      }
      if (query >= 0 && query < tabList.length) {
        this.switchTab(tabList[query].id);
        return tabList[query];
      }
    }

    const q = String(query).toLowerCase().trim();

    // 1. Direct index e.g. "1", "2", "tab 2", "tab #2", "#2"
    const indexMatch = q.match(/^(?:tab\s+)?#?(\d+)$/i);
    if (indexMatch) {
      const num = parseInt(indexMatch[1], 10);
      const tabList = Array.from(this.tabs.values());
      // 1-based index (e.g. Tab #1 is first tab)
      if (num >= 1 && num <= tabList.length) {
        this.switchTab(tabList[num - 1].id);
        return tabList[num - 1];
      }
      // 0-based index fallback
      if (num >= 0 && num < tabList.length) {
        this.switchTab(tabList[num].id);
        return tabList[num];
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
    if (q === 'prev' || q === 'previous' || q === 'previous tab') {
      const tabList = Array.from(this.tabs.values());
      const curIdx = tabList.findIndex(t => t.id === this.activeTabId);
      if (curIdx > 0) {
        this.switchTab(tabList[curIdx - 1].id);
        return tabList[curIdx - 1];
      }
    }

    // 2. Direct tab ID match (e.g. "tab_1")
    if (this.tabs.has(query)) {
      this.switchTab(query);
      return this.tabs.get(query);
    }

    // 3. Title or URL matching
    for (const tab of this.tabs.values()) {
      const title = (tab.title || '').toLowerCase();
      const url = (tab.url || '').toLowerCase();
      if (title.includes(q) || url.includes(q)) {
        this.switchTab(tab.id);
        return tab;
      }
    }

    // 4. Token coverage matching (e.g. "BooksByMohit" or "nomoney" or "overthinking")
    const tokens = q.split(/\s+/).filter(t => t.length > 2);
    if (tokens.length > 0) {
      for (const tab of this.tabs.values()) {
        const title = (tab.title || '').toLowerCase();
        const url = (tab.url || '').toLowerCase();
        const matchesAny = tokens.some(tok => title.includes(tok) || url.includes(tok));
        if (matchesAny) {
          this.switchTab(tab.id);
          return tab;
        }
      }
    }

    return null;
  }

  getActiveTab() {
    return this.tabs.get(this.activeTabId);
  }

  /** Close every tab (used when switching browser profiles). */
  closeAllTabs() {
    for (const id of Array.from(this.tabs.keys())) {
      const tab = this.tabs.get(id);
      if (tab) {
        try { shield.cleanTab(tab.webContentsId); } catch (_) {}
        try { tab.view.webContents.destroy(); } catch (_) {}
        this.tabs.delete(id);
      }
    }
    this.activeTabId = null;
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
