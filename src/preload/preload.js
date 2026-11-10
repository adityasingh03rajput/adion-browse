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
  updateSetting: (key, value) => ipcRenderer.invoke('update-setting', { key, value }),

  // AI Voice & Autonomous Control Plane API
  agent: {
    sendCommand: (commandText) => ipcRenderer.invoke('agent:send-command', commandText),
    startVoice: () => ipcRenderer.send('agent:voice-start'),
    sendVoiceChunk: (audioBuffer) => ipcRenderer.send('agent:voice-data', audioBuffer),
    stopVoice: (transcript) => ipcRenderer.invoke('agent:voice-stop', transcript),
    cancelTask: () => ipcRenderer.send('agent:cancel-task'),
    onStateChange: (callback) => ipcRenderer.on('agent:state-change', (e, data) => callback(data)),
    onTranscript: (callback) => ipcRenderer.on('agent:voice-transcript', (e, data) => callback(data)),
    onActionStarted: (callback) => ipcRenderer.on('agent:action-started', (e, data) => callback(data)),
    onActionFinished: (callback) => ipcRenderer.on('agent:action-finished', (e, data) => callback(data)),
    onFeedback: (callback) => ipcRenderer.on('agent:feedback-message', (e, data) => callback(data)),
    onAudioLevel: (callback) => ipcRenderer.on('agent:audio-level', (e, data) => callback(data)),
    onShellAction: (callback) => ipcRenderer.on('shell:action', (e, data) => callback(data)),
    getContextStats: () => ipcRenderer.invoke('agent:get-context-stats'),
    getTabClusters: () => ipcRenderer.invoke('agent:get-tab-clusters'),
    verifyBiometric: (vector) => ipcRenderer.invoke('agent:verify-biometric', vector)
  },

  // Distributed Multi-Agent Pool
  multiAgent: {
    spawnResearch: (topic) => ipcRenderer.invoke('multi-agent:spawn-research', topic),
    spawnShopping: (product, targets) => ipcRenderer.invoke('multi-agent:spawn-shopping', { product, targets }),
    getAgents: () => ipcRenderer.invoke('multi-agent:get-agents'),
    onAgentSpawned: (callback) => ipcRenderer.on('multi-agent:spawned', (e, data) => callback(data)),
    onAgentUpdated: (callback) => ipcRenderer.on('multi-agent:updated', (e, data) => callback(data)),
    onAgentCompleted: (callback) => ipcRenderer.on('multi-agent:completed', (e, data) => callback(data))
  },

  // Zero-Knowledge Proof & Privacy Ad Economy
  zkp: {
    getWallet: () => ipcRenderer.invoke('zkp:get-wallet'),
    generateProof: (statement) => ipcRenderer.invoke('zkp:generate-proof', statement),
    serveReplacementAd: (category) => ipcRenderer.invoke('zkp:serve-replacement-ad', category)
  },

  // Enterprise Decentralized Analytics
  enterprise: {
    getTelemetry: () => ipcRenderer.invoke('enterprise:get-telemetry')
  }
});
