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
  switchDevToolsPanel: (panel) => ipcRenderer.send('devtools-switch-panel', panel),
  focusDevTools: () => ipcRenderer.send('devtools-focus'),
  focusPage: () => ipcRenderer.send('page-focus'),
  switchTabByQuery: (query) => ipcRenderer.send('tab-switch-query', query),
  setOverlayActive: (active) => ipcRenderer.send('set-overlay-active', active),
  setSidePanelOpen: (isOpen) => ipcRenderer.send('set-side-panel-open', isOpen),

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

  // Diagnostic terminal relay — sends renderer-side logs straight to main process stdout
  log: (msg) => ipcRenderer.send('renderer:log', msg),

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
    onInspectorTelemetry: (callback) => ipcRenderer.on('agent:inspector-telemetry', (e, data) => callback(data)),
    onAudioLevel: (callback) => ipcRenderer.on('agent:audio-level', (e, data) => callback(data)),
    onShellAction: (callback) => ipcRenderer.on('shell:action', (e, data) => callback(data)),
    onTerminalOutput: (callback) => ipcRenderer.on('agent:terminal-output', (e, data) => callback(data)),
    getContextStats: () => ipcRenderer.invoke('agent:get-context-stats'),
    getTabClusters: () => ipcRenderer.invoke('agent:get-tab-clusters'),
    verifyBiometric: (vector) => ipcRenderer.invoke('agent:verify-biometric', vector),
    getPageContext: () => ipcRenderer.invoke('agent:get-page-context'),
    setPageSharing: (isShared) => ipcRenderer.invoke('agent:set-page-sharing', isShared)
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
  },

  // JARVIS Interactive Assistant & Session Memory
  session: {
    getHistory: () => ipcRenderer.invoke('session:get-history'),
    clearSession: () => ipcRenderer.invoke('session:clear'),
    sendChat: (message) => ipcRenderer.invoke('session:send-chat', message),
    onUpdated: (callback) => ipcRenderer.on('session:updated', (e, data) => callback(data)),
    onCleared: (callback) => ipcRenderer.on('session:cleared', (e, data) => callback(data)),
    onNotification: (callback) => ipcRenderer.on('jarvis:notification', (e, data) => callback(data))
  },

  // Optional Model Context Protocol (MCP) Server Control
  mcp: {
    getStatus: () => ipcRenderer.invoke('mcp:get-status'),
    toggle: (enable) => ipcRenderer.invoke('mcp:toggle', enable),
    onStatusChange: (callback) => ipcRenderer.on('mcp:status-change', (e, data) => callback(data))
  },

  // Standalone Local PC Terminal Bridge Control
  terminal: {
    getStatus: () => ipcRenderer.invoke('terminal:get-status'),
    toggle: (enable) => ipcRenderer.invoke('terminal:toggle', enable),
    exec: (command, options) => ipcRenderer.invoke('terminal:exec', { command, ...(options || {}) }),
    getHistory: () => ipcRenderer.invoke('terminal:get-history'),
    onStatusChange: (callback) => ipcRenderer.on('terminal:status-change', (e, data) => callback(data))
  },

  // Continuous Diagnostic Logging & Telemetry Configuration
  diagnostics: {
    getConfig: () => ipcRenderer.invoke('diagnostics:get-config'),
    updateConfig: (cfg) => ipcRenderer.invoke('diagnostics:update-config', cfg)
  }
});
