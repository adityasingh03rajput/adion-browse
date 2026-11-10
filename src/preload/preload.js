const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('adionAPI', {
  // Tabs & Navigation
  newTab: (url) => ipcRenderer.send('tab-new', url),
  closeTab: (id) => ipcRenderer.send('tab-close', id),
  switchTab: (id) => ipcRenderer.send('tab-switch', id),
  navigate: (url) => ipcRenderer.send('navigate', url),
  reload: () => ipcRenderer.send('reload'),
  stop: () => ipcRenderer.send('stop'),
  goBack: () => ipcRenderer.send('go-back'),
  goForward: () => ipcRenderer.send('go-forward'),
  toggleDevTools: () => ipcRenderer.send('toggle-devtools'),

  // Event Listeners from Main
  onTabUpdated: (callback) => {
    ipcRenderer.on('tab-updated', (event, data) => callback(data));
  },
  onTabsListUpdated: (callback) => {
    ipcRenderer.on('tabs-list-updated', (event, data) => callback(data));
  },
  onShieldStatsUpdate: (callback) => {
    ipcRenderer.on('shield-stats-update', (event, data) => callback(data));
  },

  // Shields
  getShieldsState: (domain) => ipcRenderer.invoke('get-shields-state', domain),
  toggleSiteShield: (domain, enabled) => ipcRenderer.invoke('toggle-site-shield', { domain, enabled }),
  toggleSiteScripts: (domain, blockScripts) => ipcRenderer.invoke('toggle-site-scripts', { domain, blockScripts }),
  getShieldsStats: () => ipcRenderer.invoke('get-shields-stats'),

  // Bookmarks
  getBookmarks: () => ipcRenderer.invoke('get-bookmarks'),
  toggleBookmark: (title, url) => ipcRenderer.invoke('toggle-bookmark', { title, url }),

  // History
  getHistory: () => ipcRenderer.invoke('get-history'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSetting: (key, value) => ipcRenderer.invoke('update-setting', { key, value })
});

