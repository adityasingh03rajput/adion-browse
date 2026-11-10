const EventEmitter = require('events');
const { AgentState, ActionType } = require('./protocol');
const STTEngine = require('./sttEngine');

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
    this.state = AgentState.IDLE;
    this.currentTask = null;
    this.actionHistory = [];

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
   * Start a streaming audio session
   */
  startAudioSession() {
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
    console.log('[AgentRuntime Audio] Voice stream session initialized');
    this.emit('feedback', { message: 'Microphone stream open - capturing audio frames...', level: 'info' });
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
        this.setState(AgentState.IDLE);
      }
    } catch (err) {
      console.error('[AgentRuntime Pipeline] STT Error:', err);
      this.emit('feedback', { message: `STT error: ${err.message}`, level: 'error' });
      this.setState(AgentState.IDLE);
    }
  }

  /**
   * Finalize the audio stream session and route accumulated speech to model / intent parser
   */
  async stopAudioSession(providedTranscript = null) {
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

    this.setState(AgentState.PARSING_INTENT, { input: text });
    this.emit('feedback', { message: `Interpreting command: "${text}"`, level: 'info' });

    try {
      // 1. Parse intent
      const intent = await this.parseIntent(text);

      if (!intent) {
        this.setState(AgentState.IDLE);
        this.emit('feedback', { message: `Could not determine action for: "${text}"`, level: 'warning' });
        return;
      }

      // 2. Execute parsed intent
      await this.executeIntent(intent);
    } catch (err) {
      console.error('[AgentRuntime] Execution error:', err);
      this.setState(AgentState.ERROR, { error: err.message });
      this.emit('feedback', { message: `Execution failed: ${err.message}`, level: 'error' });
      setTimeout(() => this.setState(AgentState.IDLE), 2500);
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

    const activeTab = this.tabManager.getActiveTab();
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
        this.tabManager.navigateActiveTab(intent.query);
        this.emit('feedback', { message: `Navigating to: ${intent.query}`, level: 'success' });
        break;
      }

      case ActionType.CLICK_SELECTOR: {
        this.setState(AgentState.GROUNDING_UI, { target: intent.target });
        this.emit('feedback', { message: `Grounding target: "${intent.target}"...`, level: 'info' });

        const match = this.vision ? await this.vision.groundElement(intent.target) : await this.cdp.findElementCoordinates(intent.target);
        if (match && (match.found || match.success)) {
          // Highlight target visual box first
          await this.cdp.highlightElement(match.x, match.y, match.width, match.height, `Target: ${intent.target}`);
          await new Promise((r) => setTimeout(r, 200));

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

      default:
        console.warn('[AgentRuntime] Unhandled intent type:', intent.type);
    }

    this.actionHistory.push({ intent, timestamp: Date.now() });
    this.emit('action-finished', intent);
    this.setState(AgentState.IDLE);
  }
}

module.exports = AgentRuntime;

