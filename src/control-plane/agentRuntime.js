const EventEmitter = require('events');
const { AgentState, ActionType } = require('./protocol');
const STTEngine = require('./sttEngine');
const ModelClient = require('./modelClient');

/**
 * Asynchronous Agent Runtime
 * Decoupled execution engine that interprets natural language and speech intents,
 * grounds them against the DOM/CDP pipeline, and dispatches actions to Chromium.
 */
class AgentRuntime extends EventEmitter {
  constructor(tabManager, cdpBridge, contextEngine, visionGrounder, securityVault) {
    super();
    this.tabManager = tabManager;
    this.cdp = cdpBridge;
    this.context = contextEngine;
    this.vision = visionGrounder;
    this.vault = securityVault;
    this.stt = new STTEngine();
    this.model = new ModelClient();
    this.state = AgentState.IDLE;
    this.currentTask = null;
    this.actionHistory = [];
    this.continuousVoice = false;

    // Audio stream session state & VAD tracking
    this.audioSession = {
      active: false,
      chunks: [],
      totalBytes: 0,
      startTime: null,
      chunkCount: 0,
      peakEnergy: 0,
      speechDetected: false,
      consecutiveSilenceFrames: 0,
      isSegmenting: false
    };
  }

  setState(newState, metadata = {}) {
    this.state = newState;
    this.emit('state-change', {
      state: this.state,
      timestamp: Date.now(),
      ...metadata
    });
  }

  /**
   * Start a streaming audio session (Continuous Hands-Free Voice Mode)
   */
  startAudioSession() {
    this.continuousVoice = true;
    this.audioSession = {
      active: true,
      chunks: [],
      totalBytes: 0,
      startTime: Date.now(),
      chunkCount: 0,
      peakEnergy: 0,
      speechDetected: false,
      consecutiveSilenceFrames: 0,
      isSegmenting: false
    };
    this.setState(AgentState.LISTENING);
    console.log('[AgentRuntime Audio] Continuous voice stream session initialized');
    this.emit('feedback', { message: 'Microphone stream open - capturing audio frames...', level: 'info' });
  }

  /**
   * Re-arm the audio session for continuous hands-free voice interaction
   * Cleans accumulated frames and silence tracking to receive subsequent commands
   */
  rearmAudioSession() {
    if (!this.continuousVoice) return;
    this.audioSession = {
      active: true,
      chunks: [],
      totalBytes: 0,
      startTime: Date.now(),
      chunkCount: 0,
      peakEnergy: 0,
      speechDetected: false,
      consecutiveSilenceFrames: 0,
      isSegmenting: false
    };
    this.setState(AgentState.LISTENING);
    console.log('[AgentRuntime Audio] Voice session re-armed: ready for next speech command');
    this.emit('feedback', { message: 'Ready for next voice command... (listening)', level: 'info' });
  }

  /**
   * Ingest and process a streaming PCM audio chunk from the IPC bridge
   * Computes acoustic RMS energy and evaluates Voice Activity Detection (VAD)
   */
  processAudioStreamChunk(audioChunk) {
    if (!this.audioSession.active || this.audioSession.isSegmenting) return;

    let buffer;
    if (Buffer.isBuffer(audioChunk)) {
      buffer = audioChunk;
    } else if (audioChunk instanceof ArrayBuffer) {
      buffer = Buffer.from(audioChunk);
    } else if (ArrayBuffer.isView(audioChunk)) {
      buffer = Buffer.from(audioChunk.buffer, audioChunk.byteOffset, audioChunk.byteLength);
    } else if (typeof audioChunk === 'string') {
      buffer = Buffer.from(audioChunk, 'base64');
    } else {
      return;
    }

    this.audioSession.chunks.push(buffer);
    this.audioSession.totalBytes += buffer.length;
    this.audioSession.chunkCount++;

    // Calculate acoustic RMS energy
    let sumSquares = 0;
    const sampleCount = Math.floor(buffer.length / 2);
    for (let i = 0; i < buffer.length - 1; i += 2) {
      const sample = buffer.readInt16LE(i) / 32768.0;
      sumSquares += sample * sample;
    }
    const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
    if (rms > this.audioSession.peakEnergy) {
      this.audioSession.peakEnergy = rms;
    }

    // Voice Activity Detection (VAD) threshold
    const isSpeechActive = rms > 0.012;

    // Log audio frame telemetry to stdout
    if (this.audioSession.chunkCount % 5 === 1 || isSpeechActive) {
      console.log(`[AgentRuntime Audio] Frame #${this.audioSession.chunkCount} | Size: ${buffer.length}B | RMS: ${rms.toFixed(4)} | Speech: ${isSpeechActive}`);
    }

    // VAD Auto-Segmentation & Endpointing State Machine
    if (isSpeechActive) {
      this.audioSession.speechDetected = true;
      this.audioSession.consecutiveSilenceFrames = 0;
    } else if (this.audioSession.speechDetected && !this.audioSession.isSegmenting) {
      this.audioSession.consecutiveSilenceFrames++;
      // If speech was previously active and followed by ~6 silence frames (~750ms of post-speech pause)
      if (this.audioSession.consecutiveSilenceFrames >= 6) {
        console.log(`[AgentRuntime VAD] Auto-segmentation triggered: End of utterance detected after pause (${this.audioSession.totalBytes} bytes accumulated)`);
        this.audioSession.isSegmenting = true;
        this.triggerAutoEndpoint();
      }
    }

    // Emit live audio level for UI visualizer
    this.emit('audio-level', {
      rms: rms,
      isSpeechActive: isSpeechActive,
      chunkCount: this.audioSession.chunkCount,
      totalBytes: this.audioSession.totalBytes
    });
  }

  /**
   * Automatically segment speech buffer, run STT transcription, and dispatch parsed intent
   */
  async triggerAutoEndpoint() {
    if (this.audioSession.chunks.length === 0) {
      this.audioSession.isSegmenting = false;
      return;
    }

    const fullPcm = Buffer.concat(this.audioSession.chunks);
    this.audioSession.active = false;
    this.audioSession.isSegmenting = false;

    this.setState(AgentState.PARSING_INTENT);
    this.emit('feedback', { message: 'Transcribing speech audio with local STT...', level: 'info' });

    try {
      const transcript = await this.stt.transcribePCM(fullPcm);
      console.log(`[AgentRuntime Pipeline] Auto-transcribed speech command: "${transcript}"`);

      if (transcript && transcript.trim()) {
        this.emit('transcript', { text: transcript });
        await this.processCommand(transcript);
      } else {
        this.emit('feedback', { message: 'No clear voice command identified', level: 'warning' });
      }
    } catch (err) {
      console.error('[AgentRuntime Pipeline] STT Error:', err);
      this.emit('feedback', { message: `STT error: ${err.message}`, level: 'error' });
    } finally {
      // Hands-free continuous loop: Automatically re-arm microphone session for next command
      if (this.continuousVoice) {
        this.rearmAudioSession();
      } else {
        this.setState(AgentState.IDLE);
      }
    }
  }

  /**
   * Finalize the audio stream session and route accumulated speech to model / intent parser
   */
  async stopAudioSession(providedTranscript = null) {
    this.continuousVoice = false;
    if (!this.audioSession.active && !providedTranscript) {
      this.setState(AgentState.IDLE);
      return { transcript: '' };
    }

    const durationMs = Date.now() - (this.audioSession.startTime || Date.now());
    const totalBytes = this.audioSession.totalBytes;
    const peakEnergy = this.audioSession.peakEnergy;
    const chunkCount = this.audioSession.chunkCount;

    console.log(`[AgentRuntime Audio] Stream closed. Duration: ${durationMs}ms, Chunks: ${chunkCount}, Total Bytes: ${totalBytes}, Peak Energy: ${peakEnergy.toFixed(4)}`);

    const fullPcm = this.audioSession.chunks.length > 0 ? Buffer.concat(this.audioSession.chunks) : Buffer.alloc(0);
    this.audioSession.active = false;

    let finalTranscript = (providedTranscript || '').trim();

    // If no external transcript was provided, run local STT engine on accumulated PCM
    if (!finalTranscript && fullPcm.length > 0) {
      console.log(`[AgentRuntime Audio] Transmitting ${fullPcm.length} bytes of audio data to Local STT engine`);
      if (peakEnergy < 0.005) {
        this.emit('feedback', { message: 'Silence detected (no vocal speech audio recorded)', level: 'warning' });
        this.setState(AgentState.IDLE);
        return { transcript: '' };
      }

      this.setState(AgentState.PARSING_INTENT);
      finalTranscript = await this.stt.transcribePCM(fullPcm);
      console.log(`[AgentRuntime STT] Local STT transcribed: "${finalTranscript}"`);
    }

    if (finalTranscript) {
      this.emit('transcript', { text: finalTranscript });
      await this.processCommand(finalTranscript);
      return { transcript: finalTranscript };
    } else {
      this.setState(AgentState.IDLE);
      return { transcript: '' };
    }
  }

  /**
   * Process incoming voice or natural language text command
   */
  async processCommand(rawInput) {
    if (!rawInput || typeof rawInput !== 'string') return;
    const text = rawInput.trim();
    if (!text) return;

    // Hands-free voice stop command
    if (/(stop listening|turn off (mic|microphone|voice)|exit voice|stop voice|cancel voice|shut down voice)/i.test(text)) {
      this.continuousVoice = false;
      this.audioSession.active = false;
      this.emit('shell-action', { action: 'STOP_VOICE' });
      this.setState(AgentState.IDLE);
      this.emit('feedback', { message: 'Voice agent stopped listening', level: 'info' });
      return;
    }

    this.setState(AgentState.PARSING_INTENT, { input: text });
    this.emit('feedback', { message: `Autonomous Agent coordinating: "${text}"`, level: 'info' });

    try {
      const activeTab = this.tabManager ? this.tabManager.getActiveTab() : null;
      const pageContext = activeTab ? { url: activeTab.url, title: activeTab.title } : {};

      // 1. Query Grok / Mercury / Local Model for high-level reasoning and function calling
      let plan = null;
      try {
        plan = await this.model.planActions(text, pageContext);
      } catch (err) {
        console.warn('[AgentRuntime] Model planning notice:', err.message);
      }

      if (plan && Array.isArray(plan.actions) && plan.actions.length > 0) {
        this.emit('feedback', { message: `AI Plan: ${plan.thought || 'Executing actions'}`, level: 'success' });
        console.log(`[AgentRuntime Plan] Executing ${plan.actions.length} action(s):`, plan.thought);

        for (let i = 0; i < plan.actions.length; i++) {
          const act = plan.actions[i];
          const intent = { type: act.type, ...(act.params || {}) };
          await this.executeIntent(intent);
          if (i < plan.actions.length - 1) {
            await new Promise(r => setTimeout(r, 350));
          }
        }
        return;
      }

      // 2. Fallback to Local Edge Rule Parser for offline or simple commands
      const intent = await this.parseIntent(text);

      if (!intent) {
        this.setState(AgentState.IDLE);
        this.emit('feedback', { message: `Could not determine action for: "${text}"`, level: 'warning' });
        return;
      }

      // 3. Execute parsed intent
      await this.executeIntent(intent);
    } catch (err) {
      console.error('[AgentRuntime] Execution error:', err);
      this.setState(AgentState.ERROR, { error: err.message });
      this.emit('feedback', { message: `Execution failed: ${err.message}`, level: 'error' });
      if (!this.continuousVoice) {
        setTimeout(() => this.setState(AgentState.IDLE), 2500);
      }
    }
  }

  /**
   * Local Edge Intent Parser
   * Evaluates natural language commands using fast acoustic-semantic rule sets and regex patterns.
   * Can be augmented with local small LLM (e.g. Phi-3 / Qwen-2.5 / llama.cpp) or Grok/Mercury APIs.
   */
  async parseIntent(text) {
    const lower = text.toLowerCase().trim();

    // Scroll operations
    if (/(scroll down|page down|move down)/i.test(lower)) {
      return { type: ActionType.SCROLL, direction: 'down', amount: 450 };
    }
    if (/(scroll up|page up|move up)/i.test(lower)) {
      return { type: ActionType.SCROLL, direction: 'up', amount: -450 };
    }
    if (/(scroll to top|go to top|top of page)/i.test(lower)) {
      return { type: ActionType.SCROLL, direction: 'top' };
    }
    if (/(scroll to bottom|go to bottom)/i.test(lower)) {
      return { type: ActionType.SCROLL, direction: 'bottom' };
    }

    // Navigation controls
    if (/(go back|navigate back|previous page)/i.test(lower)) {
      return { type: ActionType.GO_BACK };
    }
    if (/(go forward|forward page)/i.test(lower)) {
      return { type: ActionType.GO_FORWARD };
    }
    if (/(reload|refresh|reload page)/i.test(lower)) {
      return { type: ActionType.RELOAD };
    }

    // Tab Management
    if (/(close this tab|close tab|shut tab)/i.test(lower)) {
      return { type: ActionType.CLOSE_TAB };
    }

    // Dashboard & Live Telemetry Overlay
    if (/(dashboard|site metrics|network diagnostics|live requested data|live telemetry)/i.test(lower)) {
      return { type: ActionType.OPEN_DASHBOARD };
    }
    if (/(overlay gui|show overlay|live metrics overlay|telemetry overlay|test query)/i.test(lower)) {
      return { type: ActionType.SHOW_METRICS_OVERLAY };
    }

    // DOM Inspection & Modification in Local Files / Pages
    const domModMatch = lower.match(/(?:modify dom|change dom|edit dom|update dom)\s+(?:selector\s+)?([#\.\w\-_]+)?\s*(?:action\s+)?(\w+)?\s*(?:value\s+)?(["'].+?["']|.+)?/i);
    if (domModMatch) {
      return {
        type: ActionType.MODIFY_DOM,
        selector: domModMatch[1] || '#audioTitle',
        action: domModMatch[2] || 'setText',
        value: (domModMatch[3] || 'Enhanced Live Acoustic Stream Matrix').replace(/^["']|["']$/g, '')
      };
    }
    if (/(inspect element|inspect dom)/i.test(lower)) {
      const inspectMatch = lower.match(/(?:inspect element|inspect dom)\s+([#\.\w\-_]+)/i);
      return {
        type: ActionType.INSPECT_ELEMENT,
        selector: inspectMatch ? inspectMatch[1] : '#visualizerCanvas'
      };
    }

    // Developer Tools Panel Switching & Focus
    const devtoolsPanelMatch = lower.match(/(?:switch to|open|show|inspect)\s+(console|elements|network|sources|debugger|application|storage|performance|security)\s*(?:tab|panel|view)?\s*(?:in|on)?\s*(?:devtools|developer tools)?/i) ||
      lower.match(/(?:devtools|developer tools)\s+(console|elements|network|sources|application|performance)/i);
    if (devtoolsPanelMatch) {
      const panel = devtoolsPanelMatch[1].toLowerCase();
      return { type: ActionType.DEVTOOLS_SWITCH_PANEL, panel };
    }

    if (/(focus devtools|focus developer tools|focus console)/i.test(lower)) {
      return { type: ActionType.FOCUS_DEVTOOLS };
    }
    if (/(focus page|focus web|focus content)/i.test(lower)) {
      return { type: ActionType.FOCUS_PAGE };
    }

    // Switch Tab by title or number (e.g. "switch tab to Wikipedia", "switch to tab 2", "go to tab 1")
    const switchTabMatch = lower.match(/(?:switch\s+(?:tab\s+to|to\s+tab|to)|go\s+to\s+tab|select\s+tab)\s+([a-z0-9\s\.\-_]+?)(?:\s+tab)?$/i);
    if (switchTabMatch && !/(next|previous|new|close|devtools|console|settings)/i.test(switchTabMatch[1])) {
      const target = switchTabMatch[1].trim();
      if (target) {
        return { type: ActionType.SWITCH_TAB, target };
      }
    }

    // Browser Chrome Controls
    if (/(developer tools|devtools|dev tools|code button|developer button|inspect)/i.test(lower)) {
      return { type: ActionType.TOGGLE_DEVTOOLS };
    }
    if (/(open settings|show settings|settings button|gear icon)/i.test(lower)) {
      return { type: ActionType.OPEN_SETTINGS };
    }
    if (/(bookmark this page|add bookmark|bookmark page|save bookmark|star page|bookmark current)/i.test(lower)) {
      return { type: ActionType.TOGGLE_BOOKMARK };
    }
    if (/(open bookmarks|show bookmarks|view bookmarks|bookmarks menu|bookmarks list)/i.test(lower)) {
      return { type: ActionType.OPEN_BOOKMARKS };
    }
    if (/(open history|show history|history)/i.test(lower)) {
      return { type: ActionType.OPEN_HISTORY };
    }

    const openMatch = lower.match(/(open|launch|navigate to|go to)\s+(https?:\/\/[^\s]+|[a-z0-9\-]+\.[a-z]{2,}[^\s]*|youtube|google|reddit|github|wikipedia|twitter|x\.com)/i);
    if (openMatch) {
      let target = openMatch[2];
      if (target === 'youtube') target = 'https://www.youtube.com';
      else if (target === 'google') target = 'https://www.google.com';
      else if (target === 'reddit') target = 'https://www.reddit.com';
      else if (target === 'github') target = 'https://www.github.com';
      else if (target === 'wikipedia') target = 'https://www.wikipedia.org';
      else if (target === 'x.com' || target === 'twitter') target = 'https://x.com';
      return { type: ActionType.NEW_TAB, url: target };
    }
    if (/(new tab|open new tab|create tab)/i.test(lower)) {
      return { type: ActionType.NEW_TAB, url: 'adion://newtab' };
    }

    // Search intent
    const searchMatch = lower.match(/(search for|search|look up|google|find)\s+(.+)/i);
    if (searchMatch && !lower.startsWith('find image')) {
      const query = searchMatch[2];
      return { type: ActionType.NAVIGATE, query };
    }

    // Click / Element targeting
    const clickMatch = lower.match(/(click on|click|tap on|tap|press)\s+(.+)/i);
    if (clickMatch) {
      const targetQuery = clickMatch[2].replace(/button|link|icon|input/gi, '').trim();
      return { type: ActionType.CLICK_SELECTOR, target: targetQuery || clickMatch[2] };
    }

    // Screenshot capture
    if (/(screenshot|capture screen|capture page|take snapshot)/i.test(lower)) {
      return { type: ActionType.CAPTURE_VIEWPORT };
    }

    // Semantic Image Search / Filter
    const imageMatch = lower.match(/(find images? of|show images? of|download images? of)\s+(.+)/i);
    if (imageMatch) {
      return { type: ActionType.ANALYZE_IMAGES, criteria: imageMatch[2] };
    }

    return null;
  }

  /**
   * Execute parsed intent against Chromium TabManager & CDP Bridge
   */
  async executeIntent(intent) {
    this.setState(AgentState.EXECUTING_ACTION, { action: intent });
    this.emit('action-started', intent);

    const activeTab = this.tabManager ? this.tabManager.getActiveTab() : null;
    if (!activeTab && intent.type !== ActionType.NEW_TAB) {
      throw new Error('No active browser tab found');
    }

    // Ensure CDP is attached to active tab if needed for DOM actions
    if (activeTab && activeTab.view && [
      ActionType.SCROLL,
      ActionType.CLICK_SELECTOR,
      ActionType.CLICK_COORDINATE,
      ActionType.CAPTURE_VIEWPORT,
      ActionType.ANALYZE_IMAGES
    ].includes(intent.type)) {
      await this.cdp.attach(activeTab.view.webContents);
    }

    switch (intent.type) {
      case ActionType.SCROLL: {
        if (intent.direction === 'top') {
          await this.cdp.evaluate('window.scrollTo({ top: 0, behavior: "smooth" })');
        } else if (intent.direction === 'bottom') {
          await this.cdp.evaluate('window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })');
        } else {
          await this.cdp.dispatchScroll(intent.amount);
        }
        this.emit('feedback', { message: `Scrolled ${intent.direction}`, level: 'success' });
        break;
      }

      case ActionType.NEW_TAB: {
        this.tabManager.createTab(intent.url || 'adion://newtab');
        this.emit('feedback', { message: `Opened new tab: ${intent.url}`, level: 'success' });
        break;
      }

      case ActionType.CLOSE_TAB: {
        if (activeTab) {
          this.tabManager.closeTab(activeTab.id);
          this.emit('feedback', { message: 'Closed active tab', level: 'success' });
        }
        break;
      }

      case ActionType.GO_BACK: {
        this.tabManager.goBackActiveTab();
        this.emit('feedback', { message: 'Navigated back', level: 'success' });
        break;
      }

      case ActionType.GO_FORWARD: {
        this.tabManager.goForwardActiveTab();
        this.emit('feedback', { message: 'Navigated forward', level: 'success' });
        break;
      }

      case ActionType.RELOAD: {
        this.tabManager.reloadActiveTab();
        this.emit('feedback', { message: 'Reloaded page', level: 'success' });
        break;
      }

      case ActionType.NAVIGATE: {
        const destination = intent.url || intent.query || '';
        this.tabManager.navigateActiveTab(destination);
        this.emit('feedback', { message: `Navigating to: ${destination}`, level: 'success' });
        break;
      }

      case ActionType.TOGGLE_DEVTOOLS: {
        this.tabManager.toggleDevTools();
        this.emit('feedback', { message: 'Toggled Developer Tools', level: 'success' });
        break;
      }

      case ActionType.DEVTOOLS_SWITCH_PANEL: {
        const panel = intent.panel || 'console';
        this.tabManager.switchDevToolsPanel(panel);
        this.emit('feedback', { message: `Switched Developer Tools to "${panel}" panel`, level: 'success' });
        break;
      }

      case ActionType.FOCUS_DEVTOOLS: {
        this.tabManager.focusDevTools();
        this.emit('feedback', { message: 'Focused Developer Tools', level: 'success' });
        break;
      }

      case ActionType.FOCUS_PAGE: {
        this.tabManager.focusPage();
        this.emit('feedback', { message: 'Focused webpage content', level: 'success' });
        break;
      }

      case ActionType.SWITCH_TAB: {
        const target = intent.target || intent.query || intent.id;
        const switched = this.tabManager.switchTabByQuery(target);
        if (switched) {
          this.emit('feedback', { message: `Switched to tab: ${switched.title || switched.url}`, level: 'success' });
        } else {
          this.emit('feedback', { message: `Could not find tab matching: "${target}"`, level: 'warning' });
        }
        break;
      }

      case ActionType.OPEN_DASHBOARD: {
        this.tabManager.createTab('adion://dashboard');
        this.emit('feedback', { message: 'Opened live Telemetry & Diagnostics Dashboard', level: 'success' });
        break;
      }

      case ActionType.SHOW_METRICS_OVERLAY: {
        this.emit('shell-action', { action: 'SHOW_METRICS_OVERLAY' });
        this.emit('feedback', { message: 'Active: Telemetry & Live Diagnostics Overlay GUI', level: 'success' });
        break;
      }

      case ActionType.MODIFY_DOM: {
        const selector = intent.selector || '#audioTitle';
        const action = intent.action || 'setText';
        const value = intent.value || '⚡ Enhanced Live Acoustic Stream Matrix';
        const attribute = intent.attribute || '';
        if (activeTab && activeTab.view) {
          await this.cdp.attach(activeTab.view.webContents);
          const res = await this.cdp.modifyDOM(selector, action, value, attribute);
          if (res && res.success) {
            this.emit('feedback', {
              message: `DOM Updated: "${selector}" -> "${res.current}". Render verified!`,
              level: 'success'
            });
          } else {
            this.emit('feedback', {
              message: `DOM modification notice: ${res?.error || 'Element not found on active page'}`,
              level: 'warning'
            });
          }
        }
        break;
      }

      case ActionType.INSPECT_ELEMENT: {
        const selector = intent.selector || intent.target || 'body';
        if (activeTab && activeTab.view) {
          await this.cdp.attach(activeTab.view.webContents);
          const res = await this.cdp.inspectElement(selector);
          this.tabManager.switchDevToolsPanel('elements');
          if (res && res.found) {
            this.emit('feedback', {
              message: `Inspected <${res.tagName.toLowerCase()}> in Developer Tools Elements panel`,
              level: 'success'
            });
          } else {
            this.emit('feedback', { message: `Element not found: "${selector}"`, level: 'warning' });
          }
        }
        break;
      }

      case ActionType.OPEN_SETTINGS: {
        this.emit('shell-action', { action: 'OPEN_SETTINGS' });
        this.emit('feedback', { message: 'Opened Settings', level: 'success' });
        break;
      }

      case ActionType.OPEN_BOOKMARKS: {
        this.emit('shell-action', { action: 'OPEN_BOOKMARKS' });
        this.emit('feedback', { message: 'Opened Bookmarks', level: 'success' });
        break;
      }

      case ActionType.TOGGLE_BOOKMARK: {
        const store = require('../main/store');
        if (activeTab && activeTab.url && !activeTab.url.startsWith('adion://')) {
          const isBm = store.isBookmarked(activeTab.url);
          if (isBm) {
            store.removeBookmark(activeTab.url);
            this.emit('feedback', { message: `Removed bookmark for: ${activeTab.title || activeTab.url}`, level: 'info' });
          } else {
            store.addBookmark({ title: activeTab.title || activeTab.url, url: activeTab.url });
            this.emit('feedback', { message: `Bookmarked: ${activeTab.title || activeTab.url}`, level: 'success' });
          }
          this.emit('shell-action', { action: 'BOOKMARK_TOGGLED', isBookmarked: !isBm, url: activeTab.url });
        } else {
          this.emit('feedback', { message: 'Cannot bookmark internal or empty page', level: 'warning' });
        }
        break;
      }

      case ActionType.OPEN_HISTORY: {
        this.emit('shell-action', { action: 'OPEN_HISTORY' });
        this.emit('feedback', { message: 'Opened History', level: 'success' });
        break;
      }

      case ActionType.CLICK_SELECTOR: {
        const targetLower = (intent.target || '').toLowerCase();
        // Check if referring to Chrome shell buttons
        if (/(developer tools|devtools|dev tools|code button|developer button)/i.test(targetLower)) {
          this.tabManager.toggleDevTools();
          this.emit('feedback', { message: 'Toggled Developer Tools', level: 'success' });
          break;
        }
        if (/(settings|gear)/i.test(targetLower)) {
          this.emit('shell-action', { action: 'OPEN_SETTINGS' });
          this.emit('feedback', { message: 'Opened Settings', level: 'success' });
          break;
        }
        if (/(bookmark button|star button|toggle bookmark|add bookmark)/i.test(targetLower)) {
          return this.executeIntent({ type: ActionType.TOGGLE_BOOKMARK });
        }
        if (/(bookmark menu|bookmarks list|open bookmarks|show bookmarks)/i.test(targetLower)) {
          this.emit('shell-action', { action: 'OPEN_BOOKMARKS' });
          this.emit('feedback', { message: 'Opened Bookmarks', level: 'success' });
          break;
        }
        if (/(history)/i.test(targetLower)) {
          this.emit('shell-action', { action: 'OPEN_HISTORY' });
          this.emit('feedback', { message: 'Opened History', level: 'success' });
          break;
        }

        this.setState(AgentState.GROUNDING_UI, { target: intent.target });
        this.emit('feedback', { message: `Grounding target: "${intent.target}"...`, level: 'info' });

        const match = this.vision ? await this.vision.groundElement(intent.target) : await this.cdp.findElementCoordinates(intent.target);
        if (match && (match.found || match.success)) {
          // Highlight target visual box first
          await this.cdp.highlightElement(match.x, match.y, match.width, match.height, `Target: ${intent.target}`);
          await new Promise((r) => setTimeout(r, 150));

          // Dispatch synthetic click at exact hardware coordinates
          await this.cdp.dispatchClick(match.x, match.y);
          this.emit('feedback', { message: `Clicked "${match.label || match.text || intent.target}" at (${match.x}, ${match.y})`, level: 'success' });
        } else {
          this.emit('feedback', { message: `Could not locate element matching: "${intent.target}"`, level: 'warning' });
        }
        break;
      }

      case ActionType.CAPTURE_VIEWPORT: {
        const screenshotData = this.vision ? await this.vision.captureViewportFrame() : await this.cdp.captureScreenshot();
        this.emit('feedback', { message: 'Viewport captured for visual grounding', level: 'success' });
        this.emit('action-finished', { type: ActionType.CAPTURE_VIEWPORT, screenshot: screenshotData });
        break;
      }

      case ActionType.ANALYZE_IMAGES: {
        this.setState(AgentState.GROUNDING_UI, { criteria: intent.criteria });
        this.emit('feedback', { message: `Analyzing page images for: "${intent.criteria}"...`, level: 'info' });

        const images = this.vision ? await this.vision.extractSemanticImages(intent.criteria) : [];
        if (images && images.length > 0) {
          await this.vision.highlightCandidates(images.slice(0, 4));
          this.emit('feedback', { message: `Found ${images.length} matching visual elements on page`, level: 'success' });
          this.emit('action-finished', { type: ActionType.ANALYZE_IMAGES, count: images.length, candidates: images });
        } else {
          this.emit('feedback', { message: `No images matched criteria: "${intent.criteria}"`, level: 'warning' });
        }
        break;
      }

      case ActionType.INPUT_TEXT: {
        const selector = intent.selector || 'input[type="text"], input[type="search"], textarea, [contenteditable="true"]';
        const textVal = intent.text || intent.value || '';
        await this.cdp.evaluate(`
          (() => {
            const el = document.querySelector(${JSON.stringify(selector)}) || document.querySelector('input');
            if (el) {
              el.focus();
              el.value = ${JSON.stringify(textVal)};
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
            return false;
          })()
        `);
        this.emit('feedback', { message: `Typed: "${textVal}"`, level: 'success' });
        break;
      }

      default:
        console.warn('[AgentRuntime] Unhandled intent type:', intent.type);
    }

    this.actionHistory.push({ intent, timestamp: Date.now() });
    this.emit('action-finished', intent);
    if (!this.continuousVoice) {
      this.setState(AgentState.IDLE);
    }
  }
}

module.exports = AgentRuntime;

