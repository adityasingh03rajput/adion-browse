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
const { createPcEngine } = require('../pc');
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
    this.runtime.multiAgents = this.multiAgents;
    this.runtime.synthesizer = this.synthesizer;

    // PC control (Windows): a read-only UI Automation probe plus a separate
    // input sidecar gated by actionConsent. Off until the user enables it.
    let userDataPath = '';
    try {
      userDataPath = require('electron').app.getPath('userData');
    } catch (_) {
      userDataPath = '';
    }
    this.pcEngine = createPcEngine({
      userDataPath,
      modelClient: this.runtime.model,
      send: (channel, payload) => this.sendToUI(channel, payload),
      log: (...args) => console.log('[PcEngine]', ...args)
    });
    this.runtime.pcEngine = this.pcEngine;

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
    // Only launch if the user explicitly enabled it in the Adion GUI or Settings.
    const shouldStartMcp = Boolean(store.getSetting('mcpServerEnabled'));
    if (shouldStartMcp) {
      console.log('[ControlPlane] Launching MCP server per saved user configuration...');
      this.mcpServer.start().catch((err) => {
        console.warn('[ControlPlane] MCP server startup notice:', err.message);
      });
    } else {
      console.log('[ControlPlane] MCP server is in standby (optional component, toggle on in Adion GUI or Settings).');
    }

    // PC control (Windows): the sidecars take a moment to answer a ping, so
    // this is kicked off only when the user left the toggle on.
    if (store.getSetting('pcControlEnabled')) {
      this.pcEngine.start().catch((err) => console.warn('[ControlPlane] PC engine startup notice:', err.message));
    }

    // Terminal Bridge: Standalone PC Terminal connector (single toggle in browser)
    const shouldStartTerminal = Boolean(store.getSetting('terminalBridgeEnabled'));
    if (shouldStartTerminal) {
      console.log('[ControlPlane] Launching Local Terminal Bridge per saved user configuration...');
      this.terminalBridge.start().catch((err) => {
        console.warn('[ControlPlane] Terminal bridge startup notice:', err.message);
      });
    } else {
      console.log('[ControlPlane] Local Terminal Bridge is in standby (single toggle to connect in Adion GUI / Copilot).');
    }

    // Gemini Task Mode: Stateful observable execution loop with work panel and takeover
    const taskModeInit = store.getSetting('taskModeEnabled') !== false;
    this.runtime.taskModeEnabled = taskModeInit;
    console.log(`[ControlPlane] Gemini Task Mode initialized: ${taskModeInit ? 'ENABLED' : 'DISABLED'}`);

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

    this.runtime.on('adion-notification', (data) => {
      this.sendToUI('adion:notification', data);
    });

    if (this.runtime.skillManager) {
      this.runtime.skillManager.on('updated', (skills) => {
        this.sendToUI(IPCChannels.SKILLS_UPDATED, skills);
      });
    }

    this.runtime.on('terminal-output', (data) => {
      this.sendToUI('agent:terminal-output', data);
    });

    // Gemini Task Mode Events
    this.runtime.on('task-mode:update', (data) => {
      this.sendToUI('task-mode:update', data);
    });
    this.runtime.on('task-mode:paused', (data) => {
      this.sendToUI('task-mode:paused', data);
    });
    this.runtime.on('task-mode:resumed', (data) => {
      this.sendToUI('task-mode:resumed', data);
    });
    this.runtime.on('task-mode:completed', (data) => {
      this.sendToUI('task-mode:completed', data);
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
      await this.runtime.processCommand(commandText, 'text');
      return { success: true, state: this.runtime.state };
    });

    // Voice stream initiated from microphone HUD
    ipcMain.on(IPCChannels.AGENT_VOICE_STREAM_START, (event, mode) => {
      console.log(`[ControlPlane] 🎙️ Received voice stream start signal from UI (mode: ${mode || 'talk'})`);
      this._voiceDataReceived = false;
      this.runtime.startAudioSession(mode);
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

    ipcMain.handle('agent:set-shared-tabs', (event, tabIds) => {
      this.runtime.sharedTabIds = Array.isArray(tabIds) ? tabIds : null;
      return { success: true, sharedTabIds: this.runtime.sharedTabIds };
    });

    ipcMain.handle('agent:get-shared-tabs', () => {
      return { sharedTabIds: this.runtime.sharedTabIds || null };
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
        console.log('[ControlPlane] Starting MCP Server on demand via Adion GUI...');
        await this.mcpServer.start();
      } else if (!willEnable && this.mcpServer.isRunning) {
        console.log('[ControlPlane] Stopping MCP Server via Adion GUI...');
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
      await this.runtime.processCommand(message, 'adion-chat');
      return this.runtime.sessionManager.getHistory();
    });

    // Gemini Task Mode (Stateful Observable Execution Loop, Work Panel, & Takeover)
    ipcMain.handle('task-mode:get-status', () => {
      return {
        enabled: Boolean(this.runtime.taskModeEnabled),
        activeTask: this.runtime.currentTask || null
      };
    });

    ipcMain.handle('task-mode:toggle', (event, requestedState) => {
      const willEnable = requestedState !== undefined ? Boolean(requestedState) : !this.runtime.taskModeEnabled;
      store.setSetting('taskModeEnabled', willEnable);
      this.runtime.taskModeEnabled = willEnable;
      console.log(`[ControlPlane] ⚡ Gemini Task Mode toggled: ${willEnable ? 'ENABLED' : 'DISABLED'}`);
      const status = {
        enabled: willEnable,
        activeTask: this.runtime.currentTask || null
      };
      this.sendToUI('task-mode:status-change', status);
      return status;
    });

    ipcMain.handle('task-mode:user-action', async (event, { action, data }) => {
      console.log(`[ControlPlane] ⚡ Task Mode user action: "${action}"`, data);
      return this.runtime.handleTaskModeUserAction(action, data);
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

    // Standalone Local PC Terminal Bridge IPC Handlers
    ipcMain.handle('terminal:get-status', () => {
      return this.terminalBridge ? this.terminalBridge.getStatus() : { connected: false };
    });

    // Jarvis Session IPC Handlers
    ipcMain.handle('jarvis:get-session-info', () => {
      return this.runtime.jarvisSession ? this.runtime.jarvisSession.getSessionInfo() : { error: 'Jarvis session not initialized' };
    });

    ipcMain.handle('jarvis:clear-session', () => {
      if (this.runtime.jarvisSession) {
        this.runtime.jarvisSession.clearSession();
        return { success: true, message: 'Jarvis session cleared' };
      }
      return { success: false, message: 'Jarvis session not initialized' };
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

    ipcMain.handle('pc:get-status', () => (this.pcEngine ? this.pcEngine.status() : { available: false }));

    ipcMain.handle('pc:toggle', async (event, enable) => {
      if (!this.pcEngine) return { available: false };
      if (enable) await this.pcEngine.start();
      else this.pcEngine.stop();
      const status = this.pcEngine.status();
      store.setSetting('pcControlEnabled', Boolean(enable));
      this.sendToUI('pc:status-change', status);
      return status;
    });

    ipcMain.handle('pc:run', async (event, goal) => {
      if (!this.pcEngine) return { outcome: 'error', report: 'PC control is not available' };
      return this.pcEngine.run(goal);
    });

    ipcMain.handle('pc:stop', () => (this.pcEngine ? this.pcEngine.stopRun('asked') : false));

    ipcMain.handle('terminal:get-history', () => {
      return this.terminalBridge ? this.terminalBridge.history : [];
    });

    // Extensible AI Skills System (Claude / Antigravity Style)
    ipcMain.handle(IPCChannels.SKILLS_LIST, () => {
      return this.runtime.skillManager ? this.runtime.skillManager.getAllSkills() : [];
    });

    ipcMain.handle(IPCChannels.SKILLS_GET, (event, id) => {
      return this.runtime.skillManager ? this.runtime.skillManager.getSkill(id) : null;
    });

    ipcMain.handle(IPCChannels.SKILLS_ADD, (event, skillData) => {
      if (!this.runtime.skillManager) return { error: 'Skill manager not initialized' };
      try {
        const created = this.runtime.skillManager.createSkill(skillData);
        return { success: true, skill: created };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle(IPCChannels.SKILLS_UPDATE, (event, { id, updates }) => {
      if (!this.runtime.skillManager) return { error: 'Skill manager not initialized' };
      try {
        const updated = this.runtime.skillManager.updateSkill(id, updates);
        return { success: true, skill: updated };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle(IPCChannels.SKILLS_DELETE, (event, id) => {
      if (!this.runtime.skillManager) return { error: 'Skill manager not initialized' };
      try {
        return this.runtime.skillManager.deleteSkill(id);
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle(IPCChannels.SKILLS_TOGGLE, (event, { id, enabled }) => {
      if (!this.runtime.skillManager) return { error: 'Skill manager not initialized' };
      try {
        return this.runtime.skillManager.toggleSkill(id, enabled);
      } catch (err) {
        return { success: false, error: err.message };
      }
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
    if (this.runtime && this.runtime.skillManager) {
      try {
        this.runtime.skillManager.destroy();
      } catch (_) {}
    }
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

