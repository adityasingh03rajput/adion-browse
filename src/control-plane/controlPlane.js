const { ipcMain } = require('electron');
const CDPBridge = require('./cdpBridge');
const AgentRuntime = require('./agentRuntime');
const ContextEngine = require('./contextEngine');
const VisionGrounder = require('./visionGrounder');
const SecurityVault = require('./securityVault');
const MultiAgentPool = require('./multiAgentPool');
const DataSynthesizer = require('./dataSynthesizer');
const ZKPMesh = require('./zkpMesh');
const MCPServer = require('../mcp/mcpServer');
const TerminalBridge = require('../terminal/terminalBridge');
const store = require('../main/store');
const { IPCChannels, AgentState } = require('./protocol');

/**
 * Decoupled Control Plane Orchestrator
 * Connects the Electron Main process, TabManager, CDP Bridge, and Asynchronous Agent Runtime.
 * Sets up bidirectional IPC between the browser UI and the autonomous engine.
 */
class ControlPlane {
  constructor(mainWindow, tabManager) {
    this.mainWindow = mainWindow;
    this.tabManager = tabManager;
    this.cdp = new CDPBridge();
    this.context = new ContextEngine();
    this.vision = new VisionGrounder(this.cdp);
    this.vault = new SecurityVault();
    this.multiAgents = new MultiAgentPool(this.tabManager, this.cdp);
    this.synthesizer = new DataSynthesizer();
    this.zkpMesh = new ZKPMesh();

    // Initialize Standalone Local Terminal Bridge
    this.terminalBridge = new TerminalBridge({
      cwd: process.cwd()
    });

    this.runtime = new AgentRuntime(
      this.tabManager,
      this.cdp,
      this.context,
      this.vision,
      this.vault,
      null, // sessionManager
      this.terminalBridge
    );
    this.runtime.terminalBridge = this.terminalBridge;

    // Initialize Chromium Model Context Protocol (MCP) Server
    this.mcpServer = new MCPServer({
      controlPlane: this,
      tabManager: this.tabManager,
      runtime: this.runtime,
      cdp: this.cdp
    });

    this.init();
  }

  init() {
    this.bindRuntimeEvents();
    this.registerIPCHandlers();

    // Persist and apply continuous diagnostic logging configuration
    const isDiagEnabled = store.getSetting('diagnosticLogging') !== false;
    this.runtime.verboseAudioLogging = isDiagEnabled;
    console.log(`[Diagnostics] Continuous monitoring initialized (diagnosticLogging=${isDiagEnabled}, level=${store.getSetting('logLevel') || 'structured'})`);

    // MCP Server is an OPTIONAL component: do NOT force-launch on every startup.
    // Only launch if the user explicitly enabled it in the Jarvis GUI or Settings.
    const shouldStartMcp = Boolean(store.getSetting('mcpServerEnabled'));
    if (shouldStartMcp) {
      console.log('[ControlPlane] Launching MCP server per saved user configuration...');
      this.mcpServer.start().catch((err) => {
        console.warn('[ControlPlane] MCP server startup notice:', err.message);
      });
    } else {
      console.log('[ControlPlane] MCP server is in standby (optional component, toggle on in Jarvis GUI or Settings).');
    }

    // Terminal Bridge: Standalone PC Terminal connector (single toggle in browser)
    const shouldStartTerminal = Boolean(store.getSetting('terminalBridgeEnabled'));
    if (shouldStartTerminal) {
      console.log('[ControlPlane] Launching Local Terminal Bridge per saved user configuration...');
      this.terminalBridge.start().catch((err) => {
        console.warn('[ControlPlane] Terminal bridge startup notice:', err.message);
      });
    } else {
      console.log('[ControlPlane] Local Terminal Bridge is in standby (single toggle to connect in Jarvis GUI / Copilot).');
    }

    // Load saved AI Provider configurations and active provider
    try {
      const client = this.runtime.modelClient || this.runtime.model;
      if (client) {
        const savedConfigs = store.getSetting('aiProviderConfigs') || {};
        for (const [name, cfg] of Object.entries(savedConfigs)) {
          if (cfg && typeof cfg === 'object') {
            client.configureProvider(name, cfg);
          }
        }
        const activeProvider = store.getSetting('activeAIProvider');
        if (activeProvider) {
          client.setActiveProvider(activeProvider);
        }
      }
    } catch (err) {
      console.warn('[ControlPlane] AI provider initialization notice:', err.message);
    }
  }

  /**
   * Forward events from the asynchronous Agent Runtime to the Renderer UI
   */
  bindRuntimeEvents() {
    this.runtime.on('state-change', (data) => {
      this.sendToUI(IPCChannels.AGENT_STATE_CHANGE, data);
    });

    this.runtime.on('action-started', (data) => {
      this.sendToUI(IPCChannels.AGENT_ACTION_STARTED, data);
    });

    this.runtime.on('action-finished', (data) => {
      this.sendToUI(IPCChannels.AGENT_ACTION_FINISHED, data);
    });

    this.runtime.on('feedback', (data) => {
      this.sendToUI(IPCChannels.AGENT_FEEDBACK_MESSAGE, data);
    });

    this.runtime.on('inspector-telemetry', (data) => {
      this.sendToUI(IPCChannels.AGENT_INSPECTOR_TELEMETRY, data);
    });

    this.runtime.on('transcript', (data) => {
      this.sendToUI(IPCChannels.AGENT_VOICE_TRANSCRIPT, data);
    });

    this.runtime.on('audio-level', (data) => {
      this.sendToUI('agent:audio-level', data);
    });

    this.runtime.on('shell-action', (data) => {
      this.sendToUI('shell:action', data);
    });

    this.runtime.on('jarvis-notification', (data) => {
      this.sendToUI('jarvis:notification', data);
    });

    this.runtime.on('terminal-output', (data) => {
      this.sendToUI('agent:terminal-output', data);
    });

    if (this.terminalBridge) {
      this.terminalBridge.on('status-change', (data) => {
        this.sendToUI('terminal:status-change', data);
      });
      this.terminalBridge.on('command-completed', (data) => {
        this.sendToUI('agent:terminal-output', data);
      });
    }

    // Session Memory updates
    if (this.runtime.sessionManager) {
      this.runtime.sessionManager.on('interaction-recorded', (entry) => {
        this.sendToUI('session:updated', entry);
      });
      this.runtime.sessionManager.on('session-cleared', (data) => {
        this.sendToUI('session:cleared', data);
      });
    }

    // Multi-Agent Pool events
    this.multiAgents.on('agent-spawned', (agent) => {
      this.sendToUI('multi-agent:spawned', agent);
    });
    this.multiAgents.on('agent-updated', (agent) => {
      this.sendToUI('multi-agent:updated', agent);
    });
    this.multiAgents.on('agent-completed', (agent) => {
      this.sendToUI('multi-agent:completed', agent);
      this.runtime.emit('feedback', { message: `${agent.name} completed successfully`, level: 'success' });
    });
  }

  /**
   * Safely dispatch message to browser chrome renderer
   */
  sendToUI(channel, payload) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, payload);
    }
  }

  /**
   * Register IPC communication endpoints for the browser UI
   */
  registerIPCHandlers() {
    // Direct natural language command from UI input / omnibox
    ipcMain.handle(IPCChannels.AGENT_SEND_COMMAND, async (event, commandText) => {
      await this.runtime.processCommand(commandText);
      return { success: true, state: this.runtime.state };
    });

    // Voice stream initiated from microphone HUD
    ipcMain.on(IPCChannels.AGENT_VOICE_STREAM_START, () => {
      console.log('[ControlPlane] 🎙️ Received voice stream start signal from UI');
      this._voiceDataReceived = false;
      this.runtime.startAudioSession();
    });

    // Voice stream audio chunks transmitted from microphone
    ipcMain.on(IPCChannels.AGENT_VOICE_STREAM_DATA, (event, audioChunk) => {
      if (!this._voiceDataReceived) {
        this._voiceDataReceived = true;
        const size = audioChunk ? (audioChunk.byteLength || audioChunk.length || 'unknown') : 0;
        console.log(`[ControlPlane] 🔊 First PCM audio chunk received from renderer (size: ${size}B)`);
      }
      this.runtime.processAudioStreamChunk(audioChunk);
    });

    // Voice stream finished / speech transcript delivered
    ipcMain.handle(IPCChannels.AGENT_VOICE_STREAM_STOP, async (event, transcript) => {
      const result = await this.runtime.stopAudioSession(transcript);
      if (result && result.transcript) {
        this.sendToUI(IPCChannels.AGENT_VOICE_TRANSCRIPT, { text: result.transcript });
      }
      return { success: true, ...result };
    });

    // Cancel active agent task
    ipcMain.on(IPCChannels.AGENT_CANCEL_TASK, () => {
      this.runtime.setState(AgentState.IDLE);
      this.runtime.emit('feedback', { message: 'Agent task cancelled', level: 'warning' });
    });

    // Context-Aware Page Extraction & Page Sharing (Chrome Gemini Architecture)
    ipcMain.handle('agent:get-page-context', async () => {
      return this.runtime.getActivePageContext();
    });

    ipcMain.handle('agent:set-page-sharing', (event, isShared) => {
      this.runtime.isPageShared = Boolean(isShared);
      return { success: true, isShared: this.runtime.isPageShared };
    });

    // Query Context Engine Stats
    ipcMain.handle('agent:get-context-stats', () => {
      return this.context.getStats();
    });

    // Query Semantic Tab Clusters
    ipcMain.handle('agent:get-tab-clusters', () => {
      const allTabs = Array.from(this.tabManager.tabs.values()).map(t => ({
        id: t.id,
        url: t.url,
        title: t.title
      }));
      return this.context.clusterTabs(allTabs);
    });

    // Biometric Voice Verification flow
    ipcMain.handle('agent:verify-biometric', (event, vectorSample) => {
      return this.vault.verifyVoiceBiometrics(vectorSample);
    });

    // Multi-Agent Task Orchestration
    ipcMain.handle('multi-agent:spawn-research', async (event, topic) => {
      return this.multiAgents.executeDeepResearch(topic);
    });

    ipcMain.handle('multi-agent:spawn-shopping', async (event, { product, targets }) => {
      return this.multiAgents.executeComparativeShopping(product, targets);
    });

    ipcMain.handle('multi-agent:get-agents', () => {
      return this.multiAgents.getActiveAgentsList();
    });

    // Zero-Knowledge Proof & Ad Economy
    ipcMain.handle('zkp:get-wallet', () => {
      return this.zkpMesh.getRewardsWallet();
    });

    ipcMain.handle('zkp:generate-proof', (event, statement) => {
      return this.zkpMesh.generateZKProof(statement);
    });

    ipcMain.handle('zkp:serve-replacement-ad', (event, category) => {
      return this.zkpMesh.servePrivacyPreservingAd(category);
    });

    // Decentralized Enterprise Analytics Synthesis
    ipcMain.handle('enterprise:get-telemetry', () => {
      return this.synthesizer.exportSynthesizedTelemetry();
    });

    // Optional Model Context Protocol (MCP) Server Status & Toggle
    ipcMain.handle('mcp:get-status', () => {
      return {
        running: Boolean(this.mcpServer && this.mcpServer.isRunning),
        port: this.mcpServer ? this.mcpServer.port : 9224,
        url: this.mcpServer && this.mcpServer.isRunning ? `http://127.0.0.1:${this.mcpServer.port}` : null,
        endpoint: this.mcpServer && this.mcpServer.isRunning ? `http://127.0.0.1:${this.mcpServer.port}/mcp` : null,
        sse: this.mcpServer && this.mcpServer.isRunning ? `http://127.0.0.1:${this.mcpServer.port}/sse` : null,
        toolsCount: this.mcpServer ? this.mcpServer.tools.length : 0
      };
    });

    ipcMain.handle('mcp:toggle', async (event, requestedState) => {
      const willEnable = requestedState !== undefined ? Boolean(requestedState) : !this.mcpServer.isRunning;
      store.setSetting('mcpServerEnabled', willEnable);

      if (willEnable && !this.mcpServer.isRunning) {
        console.log('[ControlPlane] Starting MCP Server on demand via Jarvis GUI...');
        await this.mcpServer.start();
      } else if (!willEnable && this.mcpServer.isRunning) {
        console.log('[ControlPlane] Stopping MCP Server via Jarvis GUI...');
        await this.mcpServer.stop();
      }

      const status = {
        running: Boolean(this.mcpServer.isRunning),
        port: this.mcpServer.port,
        url: this.mcpServer.isRunning ? `http://127.0.0.1:${this.mcpServer.port}` : null,
        endpoint: this.mcpServer.isRunning ? `http://127.0.0.1:${this.mcpServer.port}/mcp` : null,
        sse: this.mcpServer.isRunning ? `http://127.0.0.1:${this.mcpServer.port}/sse` : null,
        toolsCount: this.mcpServer.tools.length
      };

      this.sendToUI('mcp:status-change', status);
      return status;
    });

    // Persistent Diagnostic Logging & Continuous Monitoring Configuration
    ipcMain.handle('diagnostics:get-config', () => {
      return {
        diagnosticLogging: store.getSetting('diagnosticLogging') !== false,
        logLevel: store.getSetting('logLevel') || 'structured',
        continuousMonitoring: true
      };
    });

    ipcMain.handle('diagnostics:update-config', (event, cfg) => {
      if (cfg && cfg.diagnosticLogging !== undefined) {
        const enabled = Boolean(cfg.diagnosticLogging);
        store.setSetting('diagnosticLogging', enabled);
        this.runtime.verboseAudioLogging = enabled;
        console.log(`[Diagnostics] Diagnostic logging toggled: ${enabled ? 'ENABLED' : 'DISABLED'}`);
      }
      if (cfg && cfg.logLevel) {
        store.setSetting('logLevel', cfg.logLevel);
      }
      return {
        diagnosticLogging: store.getSetting('diagnosticLogging') !== false,
        logLevel: store.getSetting('logLevel') || 'structured',
        continuousMonitoring: true
      };
    });

    // Session Memory & Interaction State Logging
    ipcMain.handle('session:get-history', () => {
      return this.runtime.sessionManager.getHistory();
    });

    ipcMain.handle('session:clear', () => {
      const res = this.runtime.sessionManager.clearSession();
      this.sendToUI('session:cleared', res);
      return res;
    });

    ipcMain.handle('session:send-chat', async (event, message) => {
      await this.runtime.processCommand(message, 'jarvis-chat');
      return this.runtime.sessionManager.getHistory();
    });

    // 3rd-Party Model Integration & Provider Management
    ipcMain.handle('ai:get-providers', () => {
      const client = this.runtime.modelClient || this.runtime.model;
      return client ? client.listProviders() : { providers: [] };
    });

    ipcMain.handle('ai:set-provider', (event, providerName) => {
      const client = this.runtime.modelClient || this.runtime.model;
      if (client) {
        store.setSetting('activeAIProvider', providerName);
        client.setActiveProvider(providerName);
        if (providerName === 'perchance') {
          try {
            const prov = client.registry ? client.registry.getProvider('perchance') : null;
            const pageUrl = (prov && prov.pageUrl) || 'https://perchance.org/lmuyx39m93';
            let target = null;
            if (this.tabManager && this.tabManager.tabs) {
              for (const t of this.tabManager.tabs.values()) {
                if (t && t.url && String(t.url).indexOf('perchance.org') !== -1) { target = t; break; }
              }
            }
            if (target) { try { this.tabManager.switchTab(target.id); } catch (e) {} }
            else { try { this.tabManager.createTab(pageUrl); } catch (e) {} }
          } catch (e) { console.warn('[ControlPlane] Perchance redirect notice:', e.message); }
        }
        return {
          success: true,
          activeProvider: providerName,
          ...client.listProviders()
        };
      }
      return { success: false, providers: [] };
    });

    ipcMain.handle('ai:configure-provider', (event, { name, apiKey, apiUrl, model, pageUrl }) => {
      const client = this.runtime.modelClient || this.runtime.model;
      if (client) {
        const configured = client.configureProvider(name, { apiKey, apiUrl, model, pageUrl });
        const savedConfigs = store.getSetting('aiProviderConfigs') || {};
        savedConfigs[name] = {
          apiKey: apiKey !== undefined ? apiKey : (savedConfigs[name]?.apiKey || ''),
          apiUrl: apiUrl !== undefined ? apiUrl : (savedConfigs[name]?.apiUrl || ''),
          model: model !== undefined ? model : (savedConfigs[name]?.model || ''),
          pageUrl: pageUrl !== undefined ? pageUrl : (savedConfigs[name]?.pageUrl || '')
        };
        store.setSetting('aiProviderConfigs', savedConfigs);
        return {
          success: true,
          configured,
          ...client.listProviders()
        };
      }
      return { success: false };
    });

    // Perchance presence: is the agent page online with `prelay on`?
    ipcMain.handle('ai:perchance-presence', () => {
      const client = this.runtime.modelClient || this.runtime.model;
      const prov = client && client.registry ? client.registry.getProvider('perchance') : null;
      if (!prov || typeof prov.isConfigured !== 'function' || !prov.isConfigured()) {
        if (this.perchancePresenceWatch) { try { this.perchancePresenceWatch.stop(); } catch (e) {} this.perchancePresenceWatch = null; this.perchancePresenceKey = ''; }
        return { configured: false, online: false, lastHelloAgeMs: -1 };
      }
      const key = prov.relayCode + '|' + prov.broker;
      if (!this.perchancePresenceWatch || this.perchancePresenceKey !== key) {
        if (this.perchancePresenceWatch) { try { this.perchancePresenceWatch.stop(); } catch (e) {} }
        const relay = require('./providers/perchanceRelay');
        const self = this;
        this.perchancePresenceKey = key;
        this.perchancePresenceAt = 0;
        this.perchancePresenceWatch = relay.startPresenceWatch({ code: prov.relayCode, broker: prov.broker, onHello: () => { self.perchancePresenceAt = Date.now(); } });
      }
      const age = this.perchancePresenceAt ? Date.now() - this.perchancePresenceAt : -1;
      return { configured: true, online: age !== -1 && age < 40000, lastHelloAgeMs: age };
    });

    // Standalone Local PC Terminal Bridge IPC Handlers
    ipcMain.handle('terminal:get-status', () => {
      return this.terminalBridge ? this.terminalBridge.getStatus() : { connected: false };
    });

    ipcMain.handle('terminal:toggle', async (event, enable) => {
      if (!this.terminalBridge) return { connected: false };
      const status = await this.terminalBridge.toggle(enable);
      const isConnected = this.terminalBridge.isConnected;
      store.setSetting('terminalBridgeEnabled', isConnected);
      this.sendToUI('terminal:status-change', this.terminalBridge.getStatus());
      return this.terminalBridge.getStatus();
    });

    ipcMain.handle('terminal:exec', async (event, { command, cwd, timeoutMs }) => {
      if (!this.terminalBridge) {
        return { success: false, stderr: 'Terminal bridge is not initialized' };
      }
      return await this.terminalBridge.executeCommand(command, { cwd, timeoutMs });
    });

    ipcMain.handle('terminal:get-history', () => {
      return this.terminalBridge ? this.terminalBridge.history : [];
    });
  }

  /**
   * Called when active tab switches to auto-attach CDP if needed
   */
  async onActiveTabChanged(tab) {
    if (tab && tab.view) {
      await this.cdp.attach(tab.view.webContents);
      if (this.context && tab.url) {
        this.context.recordNavigation(tab.id, tab.url, tab.title);
      }
    } else {
      this.cdp.detach();
    }
  }

  destroy() {
    if (this.terminalBridge) {
      try {
        this.terminalBridge.stop();
      } catch (_) {}
    }
    if (this.mcpServer) {
      try {
        this.mcpServer.stop();
      } catch (_) {}
    }
    this.cdp.detach();
  }
}

module.exports = ControlPlane;

