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

    this.runtime = new AgentRuntime(
      this.tabManager,
      this.cdp,
      this.context,
      this.vision,
      this.vault
    );

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

    // Start Model Context Protocol server on local loopback
    this.mcpServer.start().catch((err) => {
      console.warn('[ControlPlane] MCP server startup notice:', err.message);
    });
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
      this.runtime.startAudioSession();
    });

    // Voice stream audio chunks transmitted from microphone
    ipcMain.on(IPCChannels.AGENT_VOICE_STREAM_DATA, (event, audioChunk) => {
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
    if (this.mcpServer) {
      try {
        this.mcpServer.stop();
      } catch (_) {}
    }
    this.cdp.detach();
  }
}

module.exports = ControlPlane;

