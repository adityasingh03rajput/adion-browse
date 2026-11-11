const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const { AgentState, ActionType } = require('./protocol');
const STTEngine = require('./sttEngine');
const ModelClient = require('./modelClient');
const ModelRouter = require('./modelRouter');
const SessionManager = require('./sessionManager');
const QueryPreprocessor = require('./queryPreprocessor');

/**
 * Asynchronous Agent Runtime
 * Decoupled execution engine that interprets natural language and speech intents,
 * grounds them against the DOM/CDP pipeline, and dispatches actions to Chromium.
 */
class AgentRuntime extends EventEmitter {
  constructor(tabManager, cdpBridge, contextEngine, visionGrounder, securityVault, sessionManager = null) {
    super();
    this.tabManager = tabManager;
    this.cdp = cdpBridge;
    this.context = contextEngine;
    this.vision = visionGrounder;
    this.vault = securityVault;
    this.sessionManager = sessionManager || new SessionManager();
    this.preprocessor = new QueryPreprocessor();
    this.stt = new STTEngine();
    this.model = new ModelClient();
    this.router = new ModelRouter();
    this.state = AgentState.IDLE;
    this.currentTask = null;
    this.actionHistory = [];
    this.continuousVoice = false;
    this.lastDOMSelector = null;
    this.lastDOMAction = null;
    this.isPageShared = true; // Chrome Gemini-style active page context sharing
    this.verboseAudioLogging = false; // Filtered to suppress repetitive audio frame status spam

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

    if (this.audioSession.chunkCount === 1) {
      console.log(`[AgentRuntime Audio] 🎙️ Speech audio frames streaming from hardware microphone`);
    }

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

    // Log audio frame telemetry to stdout with exact Speech: true / Speech: false from git history
    if (this.audioSession.chunkCount % 5 === 1 || isSpeechActive) {
      console.log(`[AgentRuntime Audio] Frame #${this.audioSession.chunkCount} | Size: ${buffer.length}B | RMS: ${rms.toFixed(4)} | Speech: ${isSpeechActive}`);
    }

    // VAD Auto-Segmentation & Endpointing State Machine
    if (isSpeechActive) {
      if (!this.audioSession.speechDetected) {
        console.log(`[AgentRuntime VAD] Voice activity initiated (RMS: ${rms.toFixed(4)})`);
      }
      this.audioSession.speechDetected = true;
      this.audioSession.consecutiveSilenceFrames = 0;
    } else if (this.audioSession.speechDetected && !this.audioSession.isSegmenting) {
      this.audioSession.consecutiveSilenceFrames++;
      // Natural speech pause: 9 silence frames (~1.15s of post-speech pause)
      if (this.audioSession.consecutiveSilenceFrames >= 9 && this.audioSession.chunks.length >= 5) {
        console.log(`[AgentRuntime VAD] Utterance concluded after pause (${this.audioSession.totalBytes} bytes accumulated)`);
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
    const totalBytes = this.audioSession.totalBytes || 0;
    const peakEnergy = this.audioSession.peakEnergy || 0;
    const chunkCount = this.audioSession.chunkCount || 0;

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
   * Uses QueryPreprocessor for <0.5ms fast-path intent routing, eliminating query latency.
   */
  async processCommand(rawInput, source = 'voice') {
    if (!rawInput || typeof rawInput !== 'string') return;
    const exactPrompt = String(rawInput); // Strict prompt fidelity preservation
    
    // 0. High-Speed Query Preprocessing (<0.5ms)
    const prep = this.preprocessor.preprocess(exactPrompt);
    const text = prep.normalized;
    if (!text) return;

    // Hands-free voice stop command
    if (/(stop listening|turn off (mic|microphone|voice)|exit voice|stop voice|cancel voice|shut down voice)/i.test(text)) {
      this.continuousVoice = false;
      this.audioSession.active = false;
      this.emit('shell-action', { action: 'STOP_VOICE' });
      this.setState(AgentState.IDLE);
      this.emit('feedback', { message: 'Voice agent stopped listening', level: 'info' });
      this.emit('jarvis-notification', { type: 'info', message: 'Voice listening deactivated.' });
      return;
    }

    this.setState(AgentState.PARSING_INTENT, { input: exactPrompt });
    this.emit('feedback', { message: `Autonomous Agent coordinating: "${text}"`, level: 'info' });

    let activeTab = null;
    let pageContext = {};
    let executedPlan = null;

    try {
      activeTab = this.tabManager ? this.tabManager.getActiveTab() : null;
      pageContext = activeTab ? { url: activeTab.url, title: activeTab.title } : {};
      if (this.lastDOMSelector) {
        pageContext.lastDOMSelector = this.lastDOMSelector;
      }

      // TIER 1: ZERO-LATENCY FAST-PATH ROUTER (<0.5ms execution)
      // Resolves DOM styles, audio sliders, navigation, and bookmarks immediately without remote LLM latency
      const fastIntent = this.preprocessor.extractFastIntent(prep, pageContext);
      if (fastIntent) {
        console.log(`[AgentRuntime FastPath] Executed in ${prep.durationMs}ms:`, fastIntent.thought || fastIntent.type);

        if (fastIntent.type === 'CONVERSATIONAL_ACKNOWLEDGE') {
          const feedbackMsg = fastIntent.thought || 'Standing by: ready for your browser commands.';
          if (!this.continuousVoice) {
            this.setState(AgentState.IDLE);
          }
          this.emit('feedback', { message: feedbackMsg, level: 'info' });
          this.emit('jarvis-notification', { type: 'info', message: feedbackMsg });
          this.sessionManager.recordInteraction({
            source: source,
            rawPrompt: exactPrompt,
            transcription: text,
            pageContext: pageContext,
            modelResponse: { thought: feedbackMsg, actions: [] },
            status: 'success',
            feedback: feedbackMsg
          });
          return;
        }

        const actionsToRun = Array.isArray(fastIntent.actions) && fastIntent.actions.length > 0
          ? fastIntent.actions
          : [fastIntent];

        for (let i = 0; i < actionsToRun.length; i++) {
          const act = actionsToRun[i];
          const intent = { type: act.type, ...(act.params || {}), ...act, raw: exactPrompt };
          await this.executeIntent(intent);
          if (i < actionsToRun.length - 1) {
            await new Promise(r => setTimeout(r, 250));
          }
        }

        // Cache resolved plan
        this.preprocessor.cachePlan(activeTab?.url, prep.normalized, { thought: fastIntent.thought, actions: actionsToRun });

        // Record interaction in session memory log
        this.sessionManager.recordInteraction({
          source: source,
          rawPrompt: exactPrompt,
          transcription: text,
          pageContext: pageContext,
          modelResponse: { thought: fastIntent.thought, actions: actionsToRun },
          status: 'success',
          feedback: fastIntent.thought || 'Task completed successfully'
        });

        this.emit('jarvis-notification', {
          type: 'success',
          message: fastIntent.thought || `Task executed: ${text}`
        });
        return;
      }

      // TIER 2: QUERY PLAN LRU CACHE LOOKUP (<0.2ms)
      const cachedPlan = this.preprocessor.getCachedPlan(activeTab?.url, prep.normalized);
      if (cachedPlan && Array.isArray(cachedPlan.actions) && cachedPlan.actions.length > 0) {
        console.log(`[AgentRuntime Cache] Cache hit for "${prep.normalized}"! Executing plan:`, cachedPlan.thought);
        this.emit('feedback', { message: `AI Plan (Cached): ${cachedPlan.thought}`, level: 'success' });

        for (let i = 0; i < cachedPlan.actions.length; i++) {
          const act = cachedPlan.actions[i];
          const intent = { type: act.type, ...(act.params || {}), raw: exactPrompt };
          await this.executeIntent(intent);
        }

        this.sessionManager.recordInteraction({
          source: source,
          rawPrompt: exactPrompt,
          transcription: text,
          pageContext: pageContext,
          modelResponse: cachedPlan,
          status: 'success',
          feedback: cachedPlan.thought
        });

        this.emit('jarvis-notification', {
          type: 'success',
          message: cachedPlan.thought
        });
        return;
      }

      // TIER 3: COMPLEX / MULTI-STEP REASONING (Groq Cloud / Local Model)
      // If active tab has content loaded and page sharing is enabled, retrieve shared page context
      if (activeTab && activeTab.view && !activeTab.url.startsWith('adion://newtab') && this.isPageShared !== false) {
        try {
          const sharedCtx = await this.getActivePageContext();
          if (sharedCtx) {
            pageContext = { ...pageContext, ...sharedCtx };
          }
        } catch (_) {}
      }

      // Retrieve recent conversation history from SessionManager so agent never forgets previous chat
      const recentInteractions = this.sessionManager ? (this.sessionManager.getHistory().interactions || []).slice(-8) : [];
      const conversationHistory = recentInteractions.map(item => ({
        user: item.rawPrompt || item.transcription,
        agent: item.feedback || (item.modelResponse && item.modelResponse.thought) || '',
        status: item.status
      }));

      let plan = null;
      try {
        plan = await this.model.planActions(text, pageContext, conversationHistory);
      } catch (err) {
        console.warn('[AgentRuntime] Model planning notice:', err.message);
      }

      if (plan && Array.isArray(plan.actions)) {
        if (plan.actions.length === 0) {
          this.setState(AgentState.IDLE);
          const feedbackMsg = plan.thought || 'Standing by for browser commands.';
          this.emit('feedback', { message: feedbackMsg, level: 'success' });
          this.emit('jarvis-notification', { type: 'info', message: feedbackMsg });
          this.sessionManager.recordInteraction({
            source: source,
            rawPrompt: exactPrompt,
            transcription: text,
            pageContext: pageContext,
            modelResponse: plan,
            status: 'success',
            feedback: feedbackMsg
          });
          return;
        }

        executedPlan = plan;
        this.preprocessor.cachePlan(activeTab?.url, prep.normalized, plan);
        this.emit('feedback', { message: `AI Plan: ${plan.thought || 'Executing actions'}`, level: 'success' });
        console.log(`[AgentRuntime Plan] Executing ${plan.actions.length} action(s):`, plan.thought);

        for (let i = 0; i < plan.actions.length; i++) {
          const act = plan.actions[i];
          const intent = { type: act.type, ...(act.params || {}), raw: exactPrompt };
          await this.executeIntent(intent);
          if (i < plan.actions.length - 1) {
            await new Promise(r => setTimeout(r, 350));
          }
        }

        // Record interaction in session memory log
        this.sessionManager.recordInteraction({
          source: source,
          rawPrompt: exactPrompt,
          transcription: text,
          pageContext: pageContext,
          modelResponse: plan,
          status: 'success',
          feedback: plan.thought || 'Task completed successfully'
        });

        this.emit('jarvis-notification', {
          type: 'success',
          message: plan.thought || `Task executed successfully.`
        });
        return;
      }

      // 4. Local Edge Rule Parser fallback
      const intent = await this.parseIntent(text);

      if (!intent) {
        this.setState(AgentState.IDLE);
        const warningMsg = 'Command evaluated: no immediate browser action matched current page context.';
        this.emit('feedback', { message: warningMsg, level: 'warning' });
        this.emit('jarvis-notification', { type: 'info', message: warningMsg });
        this.sessionManager.recordInteraction({
          source: source,
          rawPrompt: exactPrompt,
          transcription: text,
          pageContext: pageContext,
          modelResponse: null,
          status: 'info',
          feedback: warningMsg
        });
        return;
      }

      // 3. Execute parsed intent
      intent.raw = exactPrompt;
      await this.executeIntent(intent);

      this.sessionManager.recordInteraction({
        source: source,
        rawPrompt: exactPrompt,
        transcription: text,
        pageContext: pageContext,
        modelResponse: { thought: `Executed ${intent.type}`, actions: [intent] },
        status: 'success',
        feedback: 'Executed successfully'
      });

      this.emit('jarvis-notification', {
        type: 'success',
        message: `Command executed: ${text.slice(0, 45)}`
      });
    } catch (err) {
      console.warn('[AgentRuntime] Handled fault:', err.message);
      const generalizedMsg = this.getGeneralizedErrorMessage(err);
      this.setState(AgentState.ERROR, { error: generalizedMsg });
      this.emit('feedback', { message: generalizedMsg, level: 'warning' });
      this.emit('jarvis-notification', { type: 'alert', message: generalizedMsg });

      this.sessionManager.recordInteraction({
        source: source,
        rawPrompt: exactPrompt,
        transcription: text,
        pageContext: pageContext,
        modelResponse: executedPlan,
        status: 'error',
        feedback: generalizedMsg
      });

      if (!this.continuousVoice) {
        setTimeout(() => this.setState(AgentState.IDLE), 2500);
      }
    }
  }

  /**
   * Generates comprehensive, generalized user-facing error messages for system faults
   * Prevents premature failure logging on specific element targets.
   */
  getGeneralizedErrorMessage(err) {
    const raw = (typeof err === 'string' ? err : err?.message || '').toLowerCase();
    if (raw.includes('not found') || raw.includes('element') || raw.includes('selector')) {
      return 'The target UI element is currently unavailable or has shifted dynamically. Adaptive layout analysis active.';
    }
    if (raw.includes('503') || raw.includes('service unavailable') || raw.includes('rate limit') || raw.includes('429')) {
      return 'The model inference service is operating under high load. Automated backoff and retry engaged.';
    }
    if (raw.includes('network') || raw.includes('timeout') || raw.includes('econnreset') || raw.includes('fetch')) {
      return 'A transient network delay was detected. Browser process and tab states remain fully safeguarded.';
    }
    if (raw.includes('cdp') || raw.includes('target') || raw.includes('session')) {
      return 'Viewport synchronization active: aligning DevTools bridge with the current page.';
    }
    return 'The autonomous agent encountered a temporary system condition. Session memory and application state remain intact.';
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

    // Dynamic DOM Manipulation across ANY loaded web page or local file
    // 0. Audio Parameter & Slider Controls (e.g. "change base frequency boost from zero to 10 decibels", "set bass boost to 10 dB", "change slider to 10")
    const sliderMatch = lower.match(/(?:change|set|adjust|increase|decrease)\s+(?:the\s+)?(?:(bass|base|treble|frequency|boost|noise|threshold|vad|volume)\s*)*(?:frequency\s+)?(?:boost|slider|parameter|gain)?\s*(?:from\s+[a-z0-9\.\-]+\s+)?(?:to\s+|into\s+)?(-?\d+(?:\.\d+)?|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\b)\s*(?:decibels?|db|rms|%|hz)?$/i);
    if (sliderMatch && !/(color|background|theme|mode)/i.test(lower)) {
      const param = sliderMatch[1] ? sliderMatch[1].toLowerCase() : 'bass';
      const rawTarget = sliderMatch[2];
      const wordMap = { 'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10, 'twelve': 12 };
      const numericVal = wordMap[rawTarget] !== undefined ? wordMap[rawTarget] : rawTarget;

      let selector = 'Bass Frequency Boost';
      if (param.includes('vad') || param.includes('threshold')) selector = 'Voice Activity Threshold';
      else if (param.includes('noise')) selector = 'Noise Suppression';

      return {
        type: ActionType.MODIFY_DOM,
        selector: selector,
        action: 'setValue',
        value: String(numericVal)
      };
    }

    // 1. Text changing: e.g. "change text of button to Submit", "change title to Hello World"
    const textMatch = text.match(/(?:change|set)\s+(?:the\s+)?text\s+of\s+(?:the\s+)?(.+?)\s+to\s+["']?(.+?)["']?$/i);
    if (textMatch) {
      return {
        type: ActionType.MODIFY_DOM,
        selector: textMatch[1].trim(),
        action: 'setText',
        value: textMatch[2].trim()
      };
    }

    // 1b. Broader natural text editing: e.g. "change title to Hello", "edit header text to Welcome", "change X to Y"
    const generalTextMatch = text.match(/(?:change|edit|update|set)\s+(?:the\s+)?(.+?)\s+(?:text\s+)?(?:from\s+.+?\s+)?to\s+["']?(.+?)["']?$/i);
    if (generalTextMatch && !isKnownColor.test(generalTextMatch[2].trim()) && !/(http|www|tab|page|window|browser|volume|zoom|url)/i.test(generalTextMatch[1])) {
      return {
        type: ActionType.MODIFY_DOM,
        selector: generalTextMatch[1].trim(),
        action: 'setText',
        value: generalTextMatch[2].trim().replace(/^["']|["']$/g, '')
      };
    }

    // 2. Hide / Remove elements: e.g. "hide sidebar", "remove banner", "hide header"
    const hideMatch = lower.match(/(?:hide|remove|delete)\s+(?:the\s+)?([a-z0-9\s\-_#\.]+)/i);
    if (hideMatch && !/(tab|history|bookmarks|cache|cookies|data)/i.test(hideMatch[1])) {
      const target = hideMatch[1].trim();
      const isRemove = lower.startsWith('remove') || lower.startsWith('delete');
      return {
        type: ActionType.MODIFY_DOM,
        selector: target,
        action: isRemove ? 'remove' : 'hide',
        value: ''
      };
    }

    // 3. Color / Background styling: e.g. "change color of search button to yellow", "make header green", "turn title red"
    const isKnownColor = /^(yellow|red|green|blue|orange|purple|pink|cyan|white|black|gold|crimson|lime|emerald|teal|gray|grey|indigo|violet|magenta|brown|navy|olive|#([0-9a-f]{3}|[0-9a-f]{6}))$/i;
    const colorMatch = lower.match(/(?:change|set|make|turn)\s+(?:the\s+)?(?:(background(?:\s+color)?|color|text\s+color)\s+)?(?:of\s+)?(?:the\s+)?(.+?)\s+(?:to\s+|into\s+)?([#a-z0-9]+)$/i);
    if (colorMatch) {
      const type = colorMatch[1] ? colorMatch[1].toLowerCase() : '';
      const target = colorMatch[2].trim();
      const color = colorMatch[3].trim();
      if (isKnownColor.test(color) && !/(http|www|tab|page|window|browser|volume|zoom|url)/i.test(target)) {
        const isTextOnly = type.includes('text');
        const styleVal = isTextOnly ? `color: ${color};` : `background: ${color};`;
        return {
          type: ActionType.MODIFY_DOM,
          selector: target,
          action: 'setStyle',
          value: styleVal
        };
      }
    }

    // 4. Dark / Light mode: e.g. "make page dark", "dark mode", "make background black"
    if (/(?:make\s+(?:the\s+)?(?:page|background|theme)\s+(dark|black)|turn\s+on\s+dark\s+mode|dark\s+theme)/i.test(lower)) {
      return {
        type: ActionType.MODIFY_DOM,
        selector: 'body',
        action: 'setStyle',
        value: 'background: #121212 !important; color: #e0e0e0 !important;'
      };
    }
    if (/(?:make\s+(?:the\s+)?(?:page|background|theme)\s+(light|white)|turn\s+on\s+light\s+mode|light\s+theme)/i.test(lower)) {
      return {
        type: ActionType.MODIFY_DOM,
        selector: 'body',
        action: 'setStyle',
        value: 'background: #ffffff !important; color: #111111 !important;'
      };
    }

    // 5. Explicit DOM modification command: e.g. "modify dom #search action setStyle value color: red"
    const domModMatch = lower.match(/(?:modify dom|change dom|edit dom|update dom)\s+(?:selector\s+)?([#\.\w\-_]+)?\s*(?:action\s+)?(\w+)?\s*(?:value\s+)?(["'].+?["']|.+)?/i);
    if (domModMatch) {
      return {
        type: ActionType.MODIFY_DOM,
        selector: domModMatch[1] || 'body',
        action: domModMatch[2] || 'setText',
        value: (domModMatch[3] || '').replace(/^["']|["']$/g, '')
      };
    }
    if (/(inspect element|inspect dom)/i.test(lower)) {
      const inspectMatch = lower.match(/(?:inspect element|inspect dom)\s+([#\.\w\-_]+)/i);
      return {
        type: ActionType.INSPECT_ELEMENT,
        selector: inspectMatch ? inspectMatch[1] : 'body'
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

    const openMatch = lower.match(/(open|launch|navigate to|go to)\s+(https?:\/\/[^\s]+|[a-z0-9\-]+\.[a-z]{2,}[^\s]*|youtube|google|reddit|github|wikipedia|twitter|x\.com|audio\.html|audio|dashboard|metrics)/i);
    if (openMatch) {
      let target = openMatch[2].toLowerCase();
      if (target === 'audio.html' || target === 'audio') target = 'audio.html';
      else if (target === 'dashboard' || target === 'metrics') target = 'adion://dashboard';
      else if (target === 'youtube') target = 'https://www.youtube.com';
      else if (target === 'google') target = 'https://www.google.com';
      else if (target === 'reddit') target = 'https://www.reddit.com';
      else if (target === 'github') target = 'https://www.github.com';
      else if (target === 'wikipedia') target = 'https://www.wikipedia.org';
      else if (target === 'x.com' || target === 'twitter') target = 'https://x.com';
      return { type: ActionType.NAVIGATE, url: target };
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

    // Video Thumbnail Grounding & Playback via Qwen-VL / Vision Router
    const videoMatch = lower.match(/(?:play|watch|click\s+on|select|identify\s+and\s+play)\s+(?:the\s+)?(?:video\s+)?(?:about\s+|with\s+thumbnail\s+|from\s+thumbnail\s+)?(.+)/i);
    if (videoMatch && /(youtube|video|thumbnail|first video|second video|clip|trailer|song|music)/i.test(lower)) {
      const q = videoMatch[1].replace(/\b(from\s+thumbnail|with\s+thumbnail|video|on\s+youtube|youtube|about)\b/gi, '').replace(/\s+/g, ' ').trim();
      return {
        type: ActionType.PLAY_VIDEO_FROM_THUMBNAIL,
        query: q || videoMatch[1]
      };
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
      ActionType.ANALYZE_IMAGES,
      ActionType.PLAY_VIDEO_FROM_THUMBNAIL
    ].includes(intent.type)) {
      await this.cdp.attach(activeTab.view.webContents);
    }

    switch (intent.type) {
      case 'CONVERSATIONAL_ACKNOWLEDGE': {
        this.setState(AgentState.IDLE);
        break;
      }

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

      case 'WHATSAPP_SEND': {
        const phone = intent.phone || '';
        const message = intent.message || '';
        const url = intent.url || `https://web.whatsapp.com/send/?phone=${phone}&text=${encodeURIComponent(message)}`;
        
        let targetTab = activeTab;
        if (activeTab && activeTab.url && !activeTab.url.startsWith('adion://newtab') && !activeTab.url.includes('whatsapp')) {
          targetTab = this.tabManager.createTab(url);
          this.emit('feedback', { message: `Opened WhatsApp Web in new tab for +${phone}`, level: 'info' });
        } else {
          this.tabManager.navigateActiveTab(url);
          this.emit('feedback', { message: `Navigating to WhatsApp Web for +${phone}`, level: 'info' });
        }

        await this.observeAndDispatchWhatsApp(targetTab, phone, message);
        break;
      }

      case 'WHATSAPP_CHAT_SEND': {
        const contact = intent.contact || intent.target || intent.phone || intent.params?.contact || '';
        const message = intent.message || intent.text || intent.params?.message || '';
        let secretCode = intent.secretCode || intent.passcode || intent.pin || intent.params?.secretCode || intent.params?.passcode || null;

        // Multi-turn conversational memory: if secretCode not in current turn, check recent session interactions
        if (!secretCode && this.sessionManager) {
          try {
            const history = (this.sessionManager.getHistory().interactions || []).slice(-8);
            for (let i = history.length - 1; i >= 0; i--) {
              const raw = history[i].prompt?.raw || history[i].prompt?.transcription || '';
              const m = raw.match(/(?:secret\s+code|passcode|pin|lock\s+code|hidden\s+(?:chat\s+)?code|locked\s+(?:chat\s+)?code|password)(?:\s+(?:of|for)\s+(?:the\s+)?(?:hidden|locked)?\s*(?:chat|folder|conversation))?\s*(?:is|:|=)?\s*([a-zA-Z0-9_\-]+)/i);
              if (m) {
                secretCode = m[1].trim();
                break;
              }
            }
          } catch (_) {}
        }

        const cleanPhone = (intent.phone || contact).replace(/[^0-9]/g, '');
        const isNumericPhone = cleanPhone.length >= 7 && cleanPhone.length <= 15 && !/[a-zA-Z]/.test(contact);
        
        let targetTab = activeTab;
        if (!targetTab || !targetTab.url || !targetTab.url.includes('whatsapp.com')) {
          // Check if ANY existing tab is already on WhatsApp Web
          const existingWaTab = this.tabManager ? Array.from(this.tabManager.tabs.values()).find(t => t.url && t.url.includes('whatsapp.com')) : null;
          if (existingWaTab) {
            console.log(`[AgentRuntime WhatsApp] Found existing WhatsApp Web tab (${existingWaTab.id}), switching to it...`);
            this.tabManager.switchTab(existingWaTab.id);
            targetTab = existingWaTab;
            this.emit('feedback', { message: `Switched to active WhatsApp Web tab for "${contact}"`, level: 'info' });
          } else {
            const waUrl = (isNumericPhone && !secretCode)
              ? `https://web.whatsapp.com/send/?phone=${cleanPhone}&text=${encodeURIComponent(message)}`
              : 'https://web.whatsapp.com/';
            if (activeTab && activeTab.url && !activeTab.url.startsWith('adion://newtab')) {
              targetTab = this.tabManager.createTab(waUrl);
              console.log(`[AgentRuntime WhatsApp] Created new tab for WhatsApp Web: ${waUrl}`);
              this.emit('feedback', { message: `Opened WhatsApp Web in new tab for "${contact}"`, level: 'info' });
            } else {
              this.tabManager.navigateActiveTab(waUrl);
              console.log(`[AgentRuntime WhatsApp] Navigating active tab to WhatsApp Web: ${waUrl}`);
              this.emit('feedback', { message: `Navigating to WhatsApp Web for "${contact}"`, level: 'info' });
            }
          }
        }

        await this.sendWhatsAppChat(targetTab, contact, message, isNumericPhone ? cleanPhone : null, secretCode);
        break;
      }

      case 'WHATSAPP_UNREAD_CLICK': {
        let targetTab = activeTab;
        if (!targetTab || !targetTab.url || !targetTab.url.includes('whatsapp.com')) {
          const existingWaTab = this.tabManager ? Array.from(this.tabManager.tabs.values()).find(t => t.url && t.url.includes('whatsapp.com')) : null;
          if (existingWaTab) {
            console.log(`[AgentRuntime WhatsApp] Found existing WhatsApp Web tab (${existingWaTab.id}), switching to it...`);
            this.tabManager.switchTab(existingWaTab.id);
            targetTab = existingWaTab;
            this.emit('feedback', { message: 'Switched to active WhatsApp Web tab', level: 'info' });
          }
        }
        await this.clickWhatsAppUnreadChat(targetTab);
        break;
      }

      case ActionType.NAVIGATE: {
        const destination = intent.url || intent.query || '';
        this.tabManager.navigateActiveTab(destination);
        this.emit('feedback', { message: `Navigating to: ${destination}`, level: 'success' });
        if (destination.includes('wa.me') || destination.includes('whatsapp.com')) {
          let phone = intent.phone || '';
          let message = intent.message || '';
          try {
            const parsed = new URL(destination.startsWith('http') ? destination : `https://${destination}`);
            phone = phone || parsed.searchParams.get('phone') || parsed.pathname.replace(/[^0-9]/g, '');
            message = message || parsed.searchParams.get('text') || '';
          } catch (_) {}
          await this.observeAndDispatchWhatsApp(activeTab, phone, message);
        } else {
          await this.autoHandleContinuations(activeTab);
        }
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
        let selector = intent.selector || intent.target;
        const action = intent.action || 'setStyle';
        const value = intent.value || '';
        const attribute = intent.attribute || '';

        // Coreference & Follow-up correction resolution (e.g. "I said red, not white", "no, turn it yellow")
        const rawText = String(intent.raw || '').toLowerCase();
        const isFollowUp = /(i said|not (white|red|green|blue|black|yellow)|instead|make it|turn it|change it|no,)/i.test(rawText);
        if ((!selector || selector === 'body' || selector === 'button') && isFollowUp && this.lastDOMSelector) {
          console.log(`[AgentRuntime Coreference] Re-targeting follow-up correction to previous element: ${this.lastDOMSelector}`);
          selector = this.lastDOMSelector;
        }

        selector = selector || 'body';

        if (!activeTab || !activeTab.view) {
          throw new Error('No active browser tab found to modify DOM');
        }

        await this.cdp.attach(activeTab.view.webContents);
        const res = await this.cdp.modifyDOM(selector, action, value, attribute);

        console.log('[AgentRuntime DOM] Result:', res);

        if (res && res.success) {
          // Remember last modified selector for conversational context / follow-ups
          this.lastDOMSelector = res.resolvedSelector || selector;

          // File System Integration: If active tab is a local file, persist changes to disk
          let persisted = false;
          if (activeTab.url && activeTab.url.startsWith('file:///')) {
            persisted = await this.persistDOMChangeToFile(activeTab.url, res);
          }
          const persistNote = persisted ? ' (Persisted to disk)' : '';

          // DevTools Deep Integration: sync DevTools panel inspection
          try {
            if (activeTab.view && activeTab.view.webContents.isDevToolsOpened()) {
              this.tabManager.switchDevToolsPanel('elements');
            }
          } catch (_) {}

          this.emit('feedback', {
            message: `DOM Modified${persistNote}: <${(res.renderedTag || 'node').toLowerCase()}> ${res.resolvedSelector} (${res.action}). Live render verified!`,
            level: 'success'
          });
          this.emit('jarvis-notification', {
            type: 'success',
            message: `Updated <${(res.renderedTag || 'node').toLowerCase()}> ${res.resolvedSelector} (${res.action})`
          });
        } else {
          const generalizedMsg = 'The requested UI element could not be directly matched on the active page layout. Layout adaptation engaged.';
          this.emit('feedback', {
            message: generalizedMsg,
            level: 'warning'
          });
          this.emit('jarvis-notification', {
            type: 'alert',
            message: generalizedMsg
          });
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

        const clickRes = await this.autonomousInspectAndClick(activeTab, intent.target);
        if (clickRes && clickRes.success) {
          this.emit('feedback', { message: `Clicked "${clickRes.label || intent.target}" at (${clickRes.x}, ${clickRes.y})`, level: 'success' });
        } else {
          // Fallback to Vision Grounder if active
          const match = this.vision ? await this.vision.groundElement(intent.target) : null;
          if (match && (match.found || match.success)) {
            await this.cdp.highlightElement(match.x, match.y, match.width, match.height, `Target: ${intent.target}`);
            await new Promise((r) => setTimeout(r, 150));
            await this.cdp.dispatchClick(match.x, match.y);
            this.emit('feedback', { message: `Clicked "${match.label || match.text || intent.target}" at (${match.x}, ${match.y})`, level: 'success' });
          } else {
            this.emit('feedback', { message: `Could not locate element matching: "${intent.target}"`, level: 'warning' });
          }
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

      case ActionType.PLAY_VIDEO_FROM_THUMBNAIL: {
        const query = intent.query || intent.target || 'video';
        this.emit('feedback', { message: `Vision Router: Evaluating thumbnail requirements for "${query}" (Cost Policy: $0.00 Free Tier)`, level: 'info' });

        // 1. If not currently on YouTube, navigate to search results
        if (!activeTab.url.includes('youtube.com')) {
          const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
          this.tabManager.navigateActiveTab(searchUrl);
          this.emit('feedback', { message: `Navigating to YouTube: ${query}...`, level: 'info' });
          await new Promise(r => setTimeout(r, 2200));
        }

        await this.cdp.attach(activeTab.view.webContents);

        // 2. Extract visible video card renderers & thumbnails from page
        let candidates = this.vision ? await this.vision.extractYouTubeVideoCandidates() : [];
        if (!candidates || candidates.length === 0) {
          await new Promise(r => setTimeout(r, 1200));
          candidates = this.vision ? await this.vision.extractYouTubeVideoCandidates() : [];
        }

        // 3. Capture high-definition viewport screenshot
        const screenshot = await this.cdp.captureScreenshot();

        // 4. Query Vision Router (Qwen-VL / Groq Llama 3.2 Vision Free Tier)
        const analysis = await this.router.analyzeThumbnailVision(screenshot, query, candidates);
        console.log('[AgentRuntime Vision] Analysis output:', analysis);

        // 5. Ground and play the matched video candidate
        let target = null;
        if (analysis && analysis.matchedIndex && candidates[analysis.matchedIndex - 1]) {
          target = candidates[analysis.matchedIndex - 1];
        } else if (candidates.length > 0) {
          target = candidates[0];
        }

        if (target && this.vision) {
          await this.vision.playVideoCandidate(target);
          this.emit('feedback', {
            message: `Playing: "${target.title}" (${target.channel || 'YouTube'}) - Grounded via ${this.router.accounting.lastAssignedModel}!`,
            level: 'success'
          });
        } else {
          this.emit('feedback', { message: `Could not identify video thumbnail matching: "${query}"`, level: 'warning' });
        }
        break;
      }

      case ActionType.INPUT_TEXT: {
        const rawPrompt = String(intent.raw || '').toLowerCase().trim();
        const textVal = String(intent.text || intent.value || '').trim();

        // Anti-Unintended-Input Guard:
        // Do not type into page inputs unless user command explicitly intended to type/input/write text,
        // preventing greetings (e.g. "hie", "hi", "hey"), questions, or conversational speech from accidentally typing into webpage search boxes.
        const hasExplicitTypingIntent = /(?:type|input|write|enter|fill|search for|look up)\b/i.test(rawPrompt) || intent.explicitInput;
        const isGreetingOrCourtesy = /^(?:hie|hei|hy|heyy|heya|hai|hiya|hi|hello|hey|yo|howdy|thanks|thank you|ok|okay)[\.\!\?]?$/i.test(textVal.toLowerCase()) ||
          /^(?:hie|hei|hy|heyy|heya|hai|hiya|hi|hello|hey|yo|howdy)[\s\.,\!\?]/i.test(rawPrompt);

        if (!hasExplicitTypingIntent && isGreetingOrCourtesy) {
          console.warn(`[AgentRuntime Guard] Blocked unintended text input "${textVal}": identified as conversational greeting, not a page input command.`);
          this.emit('feedback', { message: `Greeting recognized: "${textVal}". Standing by for browser commands.`, level: 'info' });
          this.emit('jarvis-notification', { type: 'info', message: 'Ready for browser commands.' });
          break;
        }

        const selector = intent.selector || intent.target || '';
        await this.autonomousTypeIntoElement(activeTab, selector, textVal, {
          submit: intent.submit !== false,
          rawPrompt
        });
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

  /**
   * File System Integration: Persist DOM element mutations directly into the local source file on disk
   * Writes live styles, inner texts, and HTML changes directly into local workspace files (e.g. audio.html).
   */
  async persistDOMChangeToFile(targetUrl, modResult) {
    if (!targetUrl || !modResult || !modResult.success) return false;

    let targetPath = null;

    // 1. Resolve local file URL
    if (targetUrl.startsWith('file:///')) {
      let p = targetUrl.replace(/^file:\/\/\/?/, '');
      p = decodeURIComponent(p);
      p = path.normalize(p);
      if (fs.existsSync(p)) targetPath = p;
    }

    // 2. Fallback to workspace file lookup
    if (!targetPath) {
      if (targetUrl.includes('audio.html')) {
        targetPath = path.resolve(process.cwd(), 'audio.html');
      } else if (targetUrl.includes('dashboard.html')) {
        targetPath = path.resolve(process.cwd(), 'src/dashboard/dashboard.html');
      }
    }

    if (!targetPath || !fs.existsSync(targetPath)) {
      return false;
    }

    try {
      let content = fs.readFileSync(targetPath, 'utf8');
      const elId = modResult.elementId;
      const finalStyle = modResult.finalStyle;
      const tag = (modResult.renderedTag || 'button').toLowerCase();

      let modified = false;

      // A. Match by exact element ID in source HTML
      if (elId) {
        const tagRegex = new RegExp(`(<${tag}[^>]*\\bid=["']${elId}["'][^>]*>)`, 'i');
        const match = content.match(tagRegex);
        if (match) {
          let openTag = match[1];
          if (finalStyle) {
            if (/style=["'][^"']*["']/i.test(openTag)) {
              openTag = openTag.replace(/style=["'][^"']*["']/i, `style="${finalStyle}"`);
            } else {
              openTag = openTag.replace(/>$/, ` style="${finalStyle}">`);
            }
          }
          if ((modResult.action === 'setValue' || modResult.action === 'setSlider' || modResult.action === 'setText') && tag === 'input') {
            const rawVal = String(modResult.appliedValue || '').replace(/[^\d\.-]/g, '');
            if (rawVal) {
              if (/value=["'][^"']*["']/i.test(openTag)) {
                openTag = openTag.replace(/value=["'][^"']*["']/i, `value="${rawVal}"`);
              } else {
                openTag = openTag.replace(/>$/, ` value="${rawVal}">`);
              }
            }
            content = content.replace(tagRegex, openTag);
            // If updating bass slider, keep #valBass display span in sync
            if (elId === 'sliderBass' && rawVal) {
              content = content.replace(/(<span\s+id=["']valBass["'][^>]*>)[^<]*(<\/span>)/i, `$1${rawVal} dB$2`);
            }
          } else if (modResult.action === 'setText' && modResult.appliedValue) {
            const fullTagRegex = new RegExp(`(<${tag}[^>]*\\bid=["']${elId}["'][^>]*>)([\\s\\S]*?)(<\\/${tag}>)`, 'i');
            content = content.replace(fullTagRegex, `${openTag}${modResult.appliedValue}$3`);
            // If updating valBass display, keep sliderBass value in sync
            if (elId === 'valBass') {
              const rawVal = String(modResult.appliedValue).replace(/[^\d\.-]/g, '');
              if (rawVal) {
                content = content.replace(/(<input[^>]*id=["']sliderBass["'][^>]*value=["'])[^"']*(")/i, `$1${rawVal}$2`);
              }
            }
          } else {
            content = content.replace(tagRegex, openTag);
          }
          modified = true;
        }
      }

      // B. Fallback: match by data-id or data-testid (never by generic classes like .btn)
      if (!modified && modResult.resolvedSelector) {
        const cleanSel = modResult.resolvedSelector.replace(/^[#\.]/, '').trim();
        if (cleanSel && !['button', 'btn', 'input', 'div', 'span', 'p'].includes(cleanSel.toLowerCase())) {
          const altRegex = new RegExp(`(<${tag}[^>]*(?:id|data-id|data-testid)=["']${cleanSel}["'][^>]*>)`, 'i');
          const match = content.match(altRegex);
          if (match) {
            let openTag = match[1];
            if (finalStyle) {
              if (/style=["'][^"']*["']/i.test(openTag)) {
                openTag = openTag.replace(/style=["'][^"']*["']/i, `style="${finalStyle}"`);
              } else {
                openTag = openTag.replace(/>$/, ` style="${finalStyle}">`);
              }
            }
            content = content.replace(altRegex, openTag);
            modified = true;
          }
        }
      }

      if (modified) {
        fs.writeFileSync(targetPath, content, 'utf8');
        console.log(`[AgentRuntime FileSystem] Successfully persisted DOM change directly to file: ${targetPath}`);
        return true;
      }
    } catch (err) {
      console.warn(`[AgentRuntime FileSystem] Could not persist DOM change to file: ${err.message}`);
    }

    return false;
  }

  /**
   * Generalized Autonomous Typing & Input Dispatcher across ANY website
   * Handles standard inputs, textareas, contenteditable elements, Lexical, Draft.js, ProseMirror, and Shadow DOM.
   * Dispatches dual-tier DOM events and native Chromium hardware keystrokes (sendInputEvent) for React 18+ compatibility.
   */
  async autonomousTypeIntoElement(tab, targetSelectorOrQuery, text, options = {}) {
    if (!tab || !tab.view) return { success: false, reason: 'No active tab view' };
    const contents = tab.view.webContents;
    if (!contents) return { success: false, reason: 'No webContents' };

    const shouldSubmit = options.submit !== false;

    // Step 1: Locate target element and type via DOM
    const domResult = await contents.executeJavaScript(`
      (() => {
        const sel = ${JSON.stringify(targetSelectorOrQuery || '')};
        const txt = ${JSON.stringify(text || '')};

        // 1. Find best element
        let targetEl = null;
        if (sel) {
          try { targetEl = document.querySelector(sel); } catch(_) {}
        }

        if (!targetEl) {
          // Find currently active element if editable
          const active = document.activeElement;
          if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable || active.getAttribute('role') === 'textbox')) {
            targetEl = active;
          }
        }

        if (!targetEl) {
          // Search across standard DOM and Shadow DOM for editable elements
          const editables = Array.from(document.querySelectorAll(
            'input[type="text"], input[type="search"], input:not([type]), textarea, [contenteditable="true"], [role="textbox"], [data-lexical-editor="true"], [data-slate-editor="true"]'
          )).filter(el => {
            const rect = el.getBoundingClientRect();
            return rect.width > 20 && rect.height > 10 && window.getComputedStyle(el).display !== 'none' && window.getComputedStyle(el).visibility !== 'hidden';
          });

          if (sel) {
            const sLower = sel.toLowerCase();
            targetEl = editables.find(el => {
              const p = (el.placeholder || el.getAttribute('placeholder') || '').toLowerCase();
              const a = (el.getAttribute('aria-label') || '').toLowerCase();
              const t = (el.getAttribute('title') || '').toLowerCase();
              return p.includes(sLower) || a.includes(sLower) || t.includes(sLower);
            });
          }

          if (!targetEl && editables.length > 0) {
            targetEl = editables[0];
          }
        }

        if (!targetEl) {
          return { found: false };
        }

        // Focus & select
        try { targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(_) {}
        targetEl.focus();
        targetEl.click();

        const isContentEditable = targetEl.isContentEditable || targetEl.getAttribute('contenteditable') === 'true';

        if (isContentEditable) {
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, txt);
          targetEl.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: txt }));
          targetEl.dispatchEvent(new Event('input', { bubbles: true }));
          targetEl.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          const proto = targetEl instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) {
            setter.call(targetEl, txt);
          } else {
            targetEl.value = txt;
          }
          targetEl.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: txt }));
          targetEl.dispatchEvent(new Event('input', { bubbles: true }));
          targetEl.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // Check for adjacent or form send/submit button
        let submitBtn = null;
        if (targetEl.form) {
          submitBtn = targetEl.form.querySelector('button[type="submit"], input[type="submit"]');
        }
        if (!submitBtn) {
          const parentContainer = targetEl.closest('form, div[role="region"], #main, section, div') || document.body;
          submitBtn = parentContainer.querySelector('button[aria-label*="send" i], button[title*="send" i], span[data-icon="send"], button[type="submit"]')?.closest('button');
        }

        return {
          found: true,
          tag: targetEl.tagName,
          isContentEditable,
          hasSubmitBtn: Boolean(submitBtn && !submitBtn.disabled)
        };
      })()
    `).catch(err => ({ found: false, error: err.message }));

    if (!domResult || !domResult.found) {
      const warnMsg = `Could not locate an active text input matching: "${targetSelectorOrQuery || 'input'}"`;
      this.emit('feedback', { message: warnMsg, level: 'warning' });
      return { success: false, reason: warnMsg };
    }

    // Step 2: Dispatch Chromium native hardware Enter if submission requested
    if (shouldSubmit) {
      await new Promise(r => setTimeout(r, 120));
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      contents.sendInputEvent({ type: 'char', keyCode: '\r' });
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

      if (domResult.hasSubmitBtn) {
        await contents.executeJavaScript(`
          (() => {
            const btn = document.querySelector('button[aria-label*="send" i], button[title*="send" i], span[data-icon="send"], button[type="submit"]')?.closest('button');
            if (btn && !btn.disabled) btn.click();
          })()
        `).catch(() => null);
      }
    }

    const feedbackMsg = shouldSubmit ? `Typed "${text}" and submitted` : `Typed "${text}"`;
    this.emit('feedback', { message: feedbackMsg, level: 'success' });
    return { success: true, verified: true };
  }

  /**
   * Generalized Autonomous Live Inspect & Click Tool across ANY website.
   * Functions like the live Chrome DevTools Inspect tool:
   * - Traverses live DOM (standard DOM & Shadow DOM) with cognitive semantic and token matching
   * - Strips emojis/symbols and computes leaf-level specificity bonus (pinpoints exact text element)
   * - Generates live DevTools-style inspect overlay HUD (cyan bounding box, tag name, dimensions)
   * - Dispatches in-page pointer & mouse event sequence (pointerdown, mousedown, pointerup, mouseup, click)
   * - Dispatches real OS-level Chromium hardware mouse events via webContents.sendInputEvent
   * - Dispatches CDP Input.dispatchMouseEvent for absolute framework/React 18+ event registration
   */
  async autonomousInspectAndClick(tab, targetQuery, options = {}) {
    if (!tab || !tab.view) tab = this.tabManager ? this.tabManager.getActiveTab() : null;
    if (!tab || !tab.view) return { success: false, reason: 'No active tab view' };
    const contents = tab.view.webContents;
    if (!contents) return { success: false, reason: 'No webContents' };

    const query = (targetQuery || '').trim();
    if (!query) return { success: false, reason: 'No target query provided' };

    // Attach CDP if not already attached
    if (this.cdp && !this.cdp.isAttached) {
      try { await this.cdp.attach(contents); } catch (_) {}
    }

    // Step 1: In-page Live DOM Inspection & Coordinate Discovery
    const inspectResult = await contents.executeJavaScript(`
      (() => {
        const query = ${JSON.stringify(query)};
        const queryLower = query.toLowerCase().trim();

        // Helper: Strip emojis, zero-width chars, and punctuation for pure phonetic/semantic comparison
        function stripSymbols(s) {
          if (!s) return '';
          return s
            .replace(/[\\u{1F600}-\\u{1F64F}\\u{1F300}-\\u{1F5FF}\\u{1F680}-\\u{1F6FF}\\u{1F1E0}-\\u{1F1FF}\\u{2600}-\\u{26FF}\\u{2700}-\\u{27BF}\\u{FE00}-\\u{FE0F}]/gu, '')
            .replace(/[^\\p{L}\\p{N}\\s]/gu, ' ')
            .replace(/\\s+/g, ' ')
            .trim()
            .toLowerCase();
        }

        const cleanQuery = stripSymbols(query);
        const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'for', 'in', 'on', 'at', 'to', 'from', 'by', 'with', 'link', 'website', 'page', 'site', 'button', 'click', 'open', 'tap', 'please', 'can', 'you']);
        const queryTokens = cleanQuery.split(/\\s+/).filter(t => !stopWords.has(t) && t.length > 1);

        // Helper: Traverse all elements including open shadowRoots
        function getAllVisibleElements(root = document.body) {
          let elements = [];
          if (!root) return elements;
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
          let node = walker.currentNode;
          while (node) {
            const style = window.getComputedStyle(node);
            if (style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
              const rect = node.getBoundingClientRect();
              if (rect.width > 2 && rect.height > 2) {
                elements.push(node);
              }
            }
            if (node.shadowRoot) {
              elements = elements.concat(getAllVisibleElements(node.shadowRoot));
            }
            node = walker.nextNode();
          }
          return elements;
        }

        let bestMatch = null;
        let highestScore = 0;

        // Direct CSS selector attempt
        if (/^[#\\.]?[a-zA-Z0-9_\\-\\[\\]="':*^~$]+$/.test(query)) {
          try {
            const el = document.querySelector(query);
            if (el) {
              const r = el.getBoundingClientRect();
              if (r.width > 2 && r.height > 2) {
                bestMatch = el;
                highestScore = 1500;
              }
            }
          } catch (_) {}
        }

        if (!bestMatch) {
          const all = getAllVisibleElements();
          for (const el of all) {
            let score = 0;
            const text = (el.innerText || el.textContent || '').trim();
            const textLower = text.toLowerCase();
            const cleanText = stripSymbols(text);

            const title = (el.getAttribute('title') || '').trim();
            const cleanTitle = stripSymbols(title);

            const ariaLabel = (el.getAttribute('aria-label') || '').trim();
            const cleanAria = stripSymbols(ariaLabel);

            const placeholder = (el.getAttribute('placeholder') || '').trim();
            const cleanPlaceholder = stripSymbols(placeholder);

            const role = (el.getAttribute('role') || '').toLowerCase();
            const href = (el.getAttribute('href') || el.src || '').toLowerCase();
            const id = (el.id || '').toLowerCase();
            const testid = (el.getAttribute('data-testid') || '').toLowerCase();

            // 1. Exact string matches (after emoji/symbol strip)
            if (cleanText === cleanQuery || cleanTitle === cleanQuery || cleanAria === cleanQuery) {
              score += 1000;
            } else if (textLower === queryLower || title.toLowerCase() === queryLower || ariaLabel.toLowerCase() === queryLower) {
              score += 900;
            }

            // 2. Substring matches
            if (cleanTitle && (cleanTitle.includes(cleanQuery) || cleanQuery.includes(cleanTitle))) {
              score += 600;
            } else if (cleanAria && (cleanAria.includes(cleanQuery) || cleanQuery.includes(cleanAria))) {
              score += 550;
            } else if (cleanText && cleanText.includes(cleanQuery)) {
              score += 450;
            } else if (cleanPlaceholder && cleanPlaceholder.includes(cleanQuery)) {
              score += 400;
            }

            // 3. Multi-token semantic coverage
            if (queryTokens.length > 0) {
              let matchedCount = 0;
              const combinedClean = [cleanText, cleanTitle, cleanAria, cleanPlaceholder, href, id, testid].join(' ');
              for (const tok of queryTokens) {
                if (combinedClean.includes(tok)) matchedCount++;
              }
              const coverage = matchedCount / queryTokens.length;
              if (coverage >= 0.99) {
                score += 350 + (queryTokens.length * 20);
              } else if (coverage >= 0.5) {
                score += 150 + (matchedCount * 25);
              }
            }

            if (score <= 0) continue;

            // 4. Specificity & Leaf-level Bonus vs Giant Container Penalty
            const targetLen = cleanQuery.length;
            const textLen = cleanText.length;
            if (textLen > 0) {
              const diff = Math.abs(textLen - targetLen);
              if (diff <= 5) {
                score += 500; // Major leaf specificity bonus!
              } else if (diff <= 15) {
                score += 250;
              } else if (textLen > 150) {
                score -= 300; // Penalize ancestor wrappers
              }
            }

            // 5. Interactive context bonus
            const isClickable = el.tagName === 'BUTTON' || el.tagName === 'A' || role === 'button' || role === 'link' ||
              role === 'listitem' || role === 'row' || el.hasAttribute('tabindex') ||
              window.getComputedStyle(el).cursor === 'pointer' || el.onclick != null;
            if (isClickable) {
              score += 100;
            }

            if (score > highestScore) {
              highestScore = score;
              bestMatch = el;
            }
          }
        }

        if (!bestMatch || highestScore < 100) {
          return { found: false, highestScore };
        }

        // Scroll into view & compute exact live viewport coordinates
        try {
          bestMatch.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
        } catch (_) {}

        const rect = bestMatch.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);

        // Find closest clickable container (for dual-dispatch)
        const clickableContainer = bestMatch.closest('a, button, [role="button"], [role="link"], [role="listitem"], [role="row"], [tabindex], [data-testid^="list-item"]') || bestMatch;

        // Render DevTools-style Live Inspect Tool HUD Overlay
        let overlay = document.getElementById('__adion_inspect_overlay__');
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.id = '__adion_inspect_overlay__';
          overlay.style.position = 'fixed';
          overlay.style.pointerEvents = 'none';
          overlay.style.zIndex = '2147483647';
          overlay.style.border = '2px solid #00f2fe';
          overlay.style.backgroundColor = 'rgba(0, 242, 254, 0.18)';
          overlay.style.borderRadius = '4px';
          overlay.style.boxShadow = '0 0 16px rgba(0, 242, 254, 0.65)';
          overlay.style.transition = 'all 0.12s ease-out';

          const tag = document.createElement('div');
          tag.id = '__adion_inspect_badge__';
          tag.style.position = 'absolute';
          tag.style.top = '-26px';
          tag.style.left = '0';
          tag.style.background = 'linear-gradient(135deg, #00f2fe 0%, #4facfe 100%)';
          tag.style.color = '#0b0f19';
          tag.style.fontSize = '11px';
          tag.style.fontFamily = 'monospace';
          tag.style.fontWeight = '700';
          tag.style.padding = '2px 8px';
          tag.style.borderRadius = '4px';
          tag.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.4)';
          tag.style.whiteSpace = 'nowrap';
          overlay.appendChild(tag);
          document.body.appendChild(overlay);
        }

        overlay.style.left = rect.left + 'px';
        overlay.style.top = rect.top + 'px';
        overlay.style.width = rect.width + 'px';
        overlay.style.height = rect.height + 'px';
        overlay.style.display = 'block';

        const labelText = (bestMatch.getAttribute('title') || bestMatch.innerText || bestMatch.getAttribute('aria-label') || bestMatch.tagName).slice(0, 35);
        const badge = overlay.querySelector('#__adion_inspect_badge__');
        if (badge) {
          badge.innerText = bestMatch.tagName.toLowerCase() + ' | ' + labelText + ' (' + Math.round(rect.width) + '×' + Math.round(rect.height) + ')';
        }

        setTimeout(() => {
          if (overlay) overlay.style.display = 'none';
        }, 2500);

        // Dispatch in-page pointer & mouse event sequence across both leaf and container
        const eventOpts = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          screenX: x,
          screenY: y,
          button: 0,
          buttons: 1
        };

        try {
          bestMatch.dispatchEvent(new PointerEvent('pointerdown', { ...eventOpts, pointerId: 1, pointerType: 'mouse' }));
          bestMatch.dispatchEvent(new MouseEvent('mousedown', eventOpts));
          if (bestMatch.focus) bestMatch.focus();
          bestMatch.dispatchEvent(new PointerEvent('pointerup', { ...eventOpts, buttons: 0 }));
          bestMatch.dispatchEvent(new MouseEvent('mouseup', { ...eventOpts, buttons: 0 }));
          bestMatch.dispatchEvent(new MouseEvent('click', { ...eventOpts, buttons: 0 }));

          if (clickableContainer && clickableContainer !== bestMatch) {
            clickableContainer.dispatchEvent(new PointerEvent('pointerdown', { ...eventOpts, pointerId: 1, pointerType: 'mouse' }));
            clickableContainer.dispatchEvent(new MouseEvent('mousedown', eventOpts));
            clickableContainer.dispatchEvent(new PointerEvent('pointerup', { ...eventOpts, buttons: 0 }));
            clickableContainer.dispatchEvent(new MouseEvent('mouseup', { ...eventOpts, buttons: 0 }));
            try { clickableContainer.click(); } catch(_) {}
          }
        } catch (_) {}

        return {
          found: true,
          score: highestScore,
          x,
          y,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          tag: bestMatch.tagName,
          label: labelText
        };
      })()
    `).catch(err => ({ found: false, error: err.message }));

    if (!inspectResult || !inspectResult.found) {
      console.warn(`[AgentRuntime InspectClick] No element found for: "${query}"`);
      return { success: false, reason: `Could not locate element matching "${query}" on page` };
    }

    const { x, y, width, height, tag, label } = inspectResult;

    // Step 2: Dispatch Native Chromium OS-Level Hardware Mouse Events
    try {
      contents.sendInputEvent({ type: 'mouseMove', x, y });
      await new Promise(r => setTimeout(r, 25));
      contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      await new Promise(r => setTimeout(r, 50));
      contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    } catch (_) {}

    // Step 3: Dispatch CDP Mouse Events (if attached)
    if (this.cdp && this.cdp.isAttached) {
      try {
        await this.cdp.dispatchClick(x, y);
      } catch (_) {}
    }

    const successMsg = `Inspected & Clicked <${tag.toLowerCase()}> "${label}" at (${x}, ${y})`;
    console.log(`[AgentRuntime InspectClick] 🎯 ${successMsg}`);
    this.emit('feedback', { message: successMsg, level: 'success' });

    return {
      success: true,
      x,
      y,
      width,
      height,
      tag,
      label
    };
  }

  /**
   * Autonomous observer for WhatsApp & web messaging workflows.
   * Automatically bypasses intermediate landing gateways (e.g. "Continue to chat", "use WhatsApp Web"),
   * detects authentication states (QR code vs ready chat), and auto-dispatches the Send button
   * so the entire task completes end-to-end before concluding the plan.
   */
  async observeAndDispatchWhatsApp(tab, phone = '', message = '') {
    if (!tab || !tab.view) return { success: false, reason: 'No active tab view' };
    const contents = tab.view.webContents;
    if (!contents) return { success: false, reason: 'No webContents' };

    this.emit('feedback', { message: `Autonomous Workflow: Connecting to WhatsApp Web for +${phone || 'recipient'}...`, level: 'info' });

    let handledContinuation = false;
    let qrPromptEmitted = false;
    let messageSent = false;
    const startTime = Date.now();
    const timeoutMs = 35000; // 35-second budget for network, hydration & sending

    while (!messageSent && (Date.now() - startTime < timeoutMs)) {
      try {
        const currentUrl = typeof contents.getURL === 'function' ? contents.getURL() : '';

        // 1. Gateway Screen (api.whatsapp.com or wa.me)
        if (currentUrl.includes('api.whatsapp.com') || currentUrl.includes('wa.me')) {
          const res = await contents.executeJavaScript(`
            (() => {
              const webLink = Array.from(document.querySelectorAll('a, button')).find(el => 
                /use WhatsApp Web/i.test(el.textContent) || (el.href && el.href.includes('web.whatsapp.com'))
              );
              if (webLink) { webLink.click(); return 'webLink'; }
              const actionBtn = document.getElementById('action-button') || Array.from(document.querySelectorAll('a, button')).find(el => /continue to chat/i.test(el.textContent));
              if (actionBtn) { actionBtn.click(); return 'actionBtn'; }
              return null;
            })()
          `).catch(() => null);

          if (res && !handledContinuation) {
            handledContinuation = true;
            this.emit('feedback', { message: 'Gateway detected: automatically tapped "use WhatsApp Web"', level: 'info' });
          }
        }

        // 2. Web Client (web.whatsapp.com)
        if (currentUrl.includes('web.whatsapp.com')) {
          const pageStatus = await contents.executeJavaScript(`
            (() => {
              // Check for QR code screen
              const hasQr = Boolean(
                document.querySelector('canvas[aria-label*="Scan"], div[data-ref], [data-testid="qrcode"]') ||
                /scan this qr code|link with phone number/i.test(document.body.innerText)
              );
              if (hasQr) {
                return { status: 'qr_code_required' };
              }

              // Robust Universal Composer Resolver
              const mainPane = document.getElementById('main') || document.querySelector('[data-testid="conversation-panel-wrapper"]') || document.querySelector('div[role="region"]');
              const findComposer = () => {
                if (mainPane) {
                  const comp = mainPane.querySelector(
                    'div[contenteditable="true"], div[role="textbox"][contenteditable="true"], [data-lexical-editor="true"], p.selectable-text'
                  );
                  if (comp) return comp.closest('div[contenteditable="true"]') || comp;
                }
                const byAttr = document.querySelector(
                  '#main div[contenteditable="true"], ' +
                  'div[contenteditable="true"][title*="message" i], ' +
                  'div[contenteditable="true"][aria-label*="message" i], ' +
                  'div[contenteditable="true"][data-tab="10"], ' +
                  'footer div[contenteditable="true"], ' +
                  '[data-testid="conversation-compose-box-input"]'
                );
                if (byAttr) return byAttr;
                const allEditables = Array.from(document.querySelectorAll('div[contenteditable="true"], [role="textbox"]'));
                return allEditables.find(el => !el.closest('#side') && !el.closest('#pane-side') && !el.closest('header')) || null;
              };

              // Check for Send Button
              const sendBtn = (document.querySelector('#main button[aria-label="Send"], #main span[data-icon="send"], button[aria-label="Send"], span[data-icon="send"], [data-testid="compose-btn-send"], [data-testid="send"]'))?.closest('button');
              if (sendBtn && !sendBtn.disabled) {
                sendBtn.click();
                return { status: 'sent_clicked' };
              }

              // Check for input composer box
              const composer = findComposer();
              if (composer) {
                const currentText = (composer.innerText || composer.textContent || '').trim();
                const targetMsg = ${JSON.stringify(message || '')};
                if (currentText.length === 0 && targetMsg) {
                  composer.focus();
                  composer.click();
                  document.execCommand('selectAll', false, null);
                  document.execCommand('insertText', false, targetMsg);
                  composer.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: targetMsg }));
                  composer.dispatchEvent(new Event('input', { bubbles: true }));
                  composer.dispatchEvent(new Event('change', { bubbles: true }));
                }
                return { status: 'sent_entered' };
              }

              // Check for loading progress
              const isLoading = Boolean(document.querySelector('progress, [role="progressbar"]') || /connecting|loading/i.test(document.body.innerText));
              if (isLoading) {
                return { status: 'loading' };
              }

              return { status: 'initializing' };
            })()
          `).catch(() => ({ status: 'error' }));

          if (pageStatus && (pageStatus.status === 'sent_clicked' || pageStatus.status === 'sent_entered')) {
            // Dispatch hardware enter keystroke & send button click for absolute delivery
            try {
              contents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
              contents.sendInputEvent({ type: 'char', keyCode: '\r' });
              contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
              await contents.executeJavaScript(`
                (() => {
                  const btn = (document.querySelector('#main button[aria-label="Send"], #main span[data-icon="send"], button[aria-label="Send"], span[data-icon="send"]'))?.closest('button');
                  if (btn && !btn.disabled) btn.click();
                })()
              `).catch(() => null);
            } catch (_) {}

            messageSent = true;
            const successMsg = `Message "${message}" successfully sent to +${phone || 'recipient'} on WhatsApp!`;
            this.emit('feedback', { message: successMsg, level: 'success' });
            this.emit('jarvis-notification', { type: 'success', message: successMsg });
            console.log(`[AgentRuntime] ✅ ${successMsg}`);
            return { success: true, message: successMsg };
          }

          if (pageStatus && pageStatus.status === 'qr_code_required' && !qrPromptEmitted) {
            qrPromptEmitted = true;
            const qrNotice = `WhatsApp Web requires authentication. Please scan the QR code on screen; I will send "${message}" as soon as connected.`;
            this.emit('feedback', { message: qrNotice, level: 'warning' });
            this.emit('jarvis-notification', { type: 'info', message: qrNotice });
          }
        }
      } catch (_) {}

      // Wait 1 second before next inspection cycle
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!messageSent) {
      const failureNotice = qrPromptEmitted
        ? `WhatsApp Web requires QR scan. Please link phone to complete delivery.`
        : `Could not verify message delivery to +${phone || 'recipient'}. Action timed out.`;
      console.warn(`[AgentRuntime WhatsApp Handled]: ${failureNotice}`);
      this.emit('feedback', { message: failureNotice, level: 'warning' });
      this.emit('jarvis-notification', { type: 'alert', message: failureNotice });
      return { success: false, reason: failureNotice };
    }
  }

  /**
   * Generalized Autonomous Secret Code / Passcode Unlocker.
   * Unlocks protected, hidden, or locked sections across web applications (such as WhatsApp Web locked chats).
   * 1. Detects any active passcode/PIN/password input fields or unlock modals on the page and submits secretCode.
   * 2. For WhatsApp Web (and search-based unlock systems):
   *    Types the secret code into the search box to reveal the "Locked chats" entry, then clicks it using autonomousInspectAndClick.
   * 3. Handles unlock prompts and transitions into the unlocked view.
   */
  async autonomousUnlockWithSecret(tab, secretCode) {
    if (!tab || !tab.view) tab = this.tabManager ? this.tabManager.getActiveTab() : null;
    if (!tab || !tab.view) return { success: false, reason: 'No active tab view' };
    const contents = tab.view.webContents;
    if (!contents) return { success: false, reason: 'No webContents' };
    const code = (secretCode || '').trim();
    if (!code) return { success: false, reason: 'No secret code provided' };

    console.log(`[AgentRuntime Unlock] 🔐 Initiating autonomous unlock sequence with code "${code}"...`);
    this.emit('feedback', { message: `Step 1/4: Unlocking protected chats with secret code...`, level: 'info' });

    // Step 1: Check if an unlock prompt, PIN modal, or password field is already visible on screen
    const modalCheck = await contents.executeJavaScript(`
      (() => {
        const input = document.querySelector(
          'input[type="password"], input[type="number"][placeholder*="code" i], input[placeholder*="code" i], input[placeholder*="pin" i], input[aria-label*="code" i], input[aria-label*="secret" i], [data-testid*="secret-code"], [data-testid*="lock-code"]'
        );
        if (input && input.offsetParent !== null) {
          input.focus();
          return { foundInput: true };
        }
        return { foundInput: false };
      })()
    `).catch(() => ({ foundInput: false }));

    if (modalCheck && modalCheck.foundInput) {
      console.log(`[AgentRuntime Unlock] Found visible passcode input modal. Typing secret code...`);
      await this.autonomousTypeIntoElement(tab, 'input[type="password"], input[placeholder*="code" i], input[placeholder*="pin" i]', code, { submit: true });
      await new Promise(r => setTimeout(r, 600));
      return { success: true, method: 'modal_input' };
    }

    // Step 2: Search-based unlock (WhatsApp Web Chat Lock pattern)
    // Typing the secret code into the main search box reveals the "Locked chats" entry
    console.log(`[AgentRuntime Unlock] Typing secret code into search bar to reveal locked chats...`);
    const searchResult = await contents.executeJavaScript(`
      (() => {
        const searchBox = document.querySelector(
          '#side input[type="text"], #side input[role="textbox"], #side input, #side div[contenteditable="true"], [data-testid="chat-list-search"], div[title="Search or start new chat"], div[role="textbox"][data-tab="3"], #side [role="textbox"], input[type="search"]'
        ) || Array.from(document.querySelectorAll('#side input, #side [role="textbox"], #side div[contenteditable="true"]')).find(el => {
          const t = ((el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).toLowerCase();
          return t.includes('search') || t.includes('start');
        });
        if (!searchBox) return { searchFound: false };
        searchBox.focus();
        if (searchBox.tagName === 'INPUT' || searchBox.tagName === 'TEXTAREA') {
          const proto = searchBox instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) {
            setter.call(searchBox, ${JSON.stringify(code)});
          } else {
            searchBox.value = ${JSON.stringify(code)};
          }
        } else {
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, ${JSON.stringify(code)});
        }
        searchBox.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: ${JSON.stringify(code)} }));
        searchBox.dispatchEvent(new Event('input', { bubbles: true }));
        searchBox.dispatchEvent(new Event('change', { bubbles: true }));
        return { searchFound: true };
      })()
    `).catch(() => ({ searchFound: false }));

    if (searchResult && searchResult.searchFound) {
      await new Promise(r => setTimeout(r, 600));

      // Click "Locked chats" entry that appears in the search results
      const clickLocked = await this.autonomousInspectAndClick(tab, 'Locked chats');
      if (clickLocked && clickLocked.success) {
        console.log(`[AgentRuntime Unlock] 🔓 Clicked "Locked chats" item (${clickLocked.x}, ${clickLocked.y}).`);
        await new Promise(r => setTimeout(r, 600));

        // Check if an unlock PIN dialog popped up after clicking "Locked chats"
        const postModalCheck = await contents.executeJavaScript(`
          (() => {
            const pinInput = document.querySelector('input[type="password"], input[placeholder*="code" i], input[placeholder*="pin" i], div[contenteditable="true"][aria-label*="code" i]');
            return Boolean(pinInput && pinInput.offsetParent !== null);
          })()
        `).catch(() => false);

        if (postModalCheck) {
          console.log(`[AgentRuntime Unlock] Unlock PIN dialog appeared. Entering secret code...`);
          await this.autonomousTypeIntoElement(tab, 'input[type="password"], input[placeholder*="code" i], input[placeholder*="pin" i]', code, { submit: true });
          await new Promise(r => setTimeout(r, 600));
        }

        return { success: true, method: 'search_reveal_clicked' };
      }

      // Also try clicking "Locked"
      const clickLockedShort = await this.autonomousInspectAndClick(tab, 'Locked');
      if (clickLockedShort && clickLockedShort.success) {
        console.log(`[AgentRuntime Unlock] 🔓 Clicked "Locked" item (${clickLockedShort.x}, ${clickLockedShort.y}).`);
        await new Promise(r => setTimeout(r, 600));
        return { success: true, method: 'search_reveal_clicked' };
      }

      // If "Locked chats" was not a separate folder, clear the search box cleanly so direct contact search can proceed
      await contents.executeJavaScript(`
        (() => {
          const cancelBtn = document.querySelector(
            '#side button[aria-label*="cancel" i], #side button[aria-label*="clear" i], #side button[aria-label*="end icon" i], #side span[data-icon="x-alt"], #side button[data-testid="search-cancel"]'
          )?.closest('button');
          if (cancelBtn) { cancelBtn.click(); return; }
          const s = document.querySelector('#side input, #side [role="textbox"]');
          if (s) {
            if (s.tagName === 'INPUT' || s.tagName === 'TEXTAREA') {
              const proto = s instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter) setter.call(s, '');
              else s.value = '';
            } else {
              document.execCommand('selectAll', false, null);
              document.execCommand('delete', false, null);
            }
            s.dispatchEvent(new Event('input', { bubbles: true }));
            s.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })()
      `).catch(() => null);
    }

    // Step 3: Check if "Locked chats" is already visible in the chat list without search
    const clickDirect = await this.autonomousInspectAndClick(tab, 'Locked chats');
    if (clickDirect && clickDirect.success) {
      await new Promise(r => setTimeout(r, 600));
      return { success: true, method: 'direct_locked_clicked' };
    }

    return { success: false, reason: 'Could not unlock hidden chats with secret code' };
  }

  /**
   * Autonomous in-page WhatsApp contact search, chat activation, and message dispatch.
   * Handles user intentions like "say thankyou to safal in whatsapp" directly
   * inside the authenticated WhatsApp Web interface (including locked/hidden chats).
   */
  async sendWhatsAppChat(tab, contact = '', message = '', phone = null, secretCode = null) {
    if (!tab || !tab.view) {
      console.warn('[AgentRuntime WhatsApp] ⚠️ No active tab view available to dispatch WhatsApp message');
      return { success: false, reason: 'No active tab view' };
    }
    const contents = tab.view.webContents;
    if (!contents) {
      console.warn('[AgentRuntime WhatsApp] ⚠️ No webContents found on target tab');
      return { success: false, reason: 'No webContents' };
    }

    const stepTotal = secretCode ? '4' : '3';
    console.log(`[AgentRuntime WhatsApp] 🚀 Initiating autonomous workflow: Send "${message}" to "${contact}"${secretCode ? ` (secretCode: ${secretCode})` : ''}`);
    this.emit('feedback', { message: `Step 1/${stepTotal}: Locating contact "${contact}" in WhatsApp...`, level: 'info' });
    this.emit('jarvis-notification', { type: 'info', message: `Searching for contact "${contact}" in WhatsApp...` });

    let unlocked = false;
    let searchTyped = false;
    let chatSelected = false;
    let messageSent = false;
    let qrPromptEmitted = false;
    let attempts = 0;
    const startTime = Date.now();
    const timeoutMs = 40000;

    while (!messageSent && (Date.now() - startTime < timeoutMs)) {
      attempts++;
      try {
        const currentUrl = typeof contents.getURL === 'function' ? contents.getURL() : '';

        // If at gateway screen (api.whatsapp.com or wa.me), click "use WhatsApp Web"
        if (currentUrl.includes('api.whatsapp.com') || currentUrl.includes('wa.me')) {
          console.log('[AgentRuntime WhatsApp] Gateway detected, clicking through to web.whatsapp.com...');
          await contents.executeJavaScript(`
            (() => {
              const webLink = Array.from(document.querySelectorAll('a, button')).find(el => 
                /use WhatsApp Web/i.test(el.textContent) || (el.href && el.href.includes('web.whatsapp.com'))
              );
              if (webLink) { webLink.click(); return 'webLink'; }
              const actionBtn = document.getElementById('action-button') || Array.from(document.querySelectorAll('a, button')).find(el => /continue to chat/i.test(el.textContent));
              if (actionBtn) { actionBtn.click(); return 'actionBtn'; }
              return null;
            })()
          `).catch(() => null);
        }

        // Check DOM state in WhatsApp Web
        const result = await contents.executeJavaScript(`
          (() => {
            // A. Check for QR Code
            const hasQr = Boolean(
              document.querySelector('canvas[aria-label*="Scan"], div[data-ref], [data-testid="qrcode"]') ||
              /scan this qr code|link with phone number/i.test(document.body.innerText)
            );
            if (hasQr) return { action: 'qr_required' };

            const target = ${JSON.stringify(contact)}.trim().toLowerCase();
            const msg = ${JSON.stringify(message)};

            // B. Main conversation pane detection & Composer Finder
            const mainPane = document.getElementById('main') || document.querySelector('[data-testid="conversation-panel-wrapper"]') || document.querySelector('div[role="region"]');
            const isMainOpen = Boolean(mainPane);

            const findComposer = () => {
              if (mainPane) {
                const comp = mainPane.querySelector(
                  'div[contenteditable="true"], div[role="textbox"][contenteditable="true"], [data-lexical-editor="true"], p.selectable-text'
                );
                if (comp) return comp.closest('div[contenteditable="true"]') || comp;
              }
              const byAttr = document.querySelector(
                '#main div[contenteditable="true"], ' +
                'div[contenteditable="true"][title*="message" i], ' +
                'div[contenteditable="true"][aria-label*="message" i], ' +
                'div[contenteditable="true"][data-tab="10"], ' +
                'footer div[contenteditable="true"], ' +
                '[data-testid="conversation-compose-box-input"]'
              );
              if (byAttr) return byAttr;
              const allEditables = Array.from(document.querySelectorAll('div[contenteditable="true"], [role="textbox"]'));
              return allEditables.find(el => !el.closest('#side') && !el.closest('#pane-side') && !el.closest('header')) || null;
            };

            const findSendBtn = () => {
              return (
                document.querySelector('#main button[aria-label="Send"], #main span[data-icon="send"], button[aria-label="Send"], span[data-icon="send"], [data-testid="compose-btn-send"], [data-testid="send"]')
              )?.closest('button') || null;
            };

            // Helper: Clean emojis and symbols for rigorous recipient matching
            const cleanStr = s => (s || '')
              .toLowerCase()
              .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '')
              .replace(/[^\p{L}\p{N}\s]/gu, ' ')
              .replace(/\s+/g, ' ')
              .trim();

            const cleanTarget = cleanStr(target);

            // Check if active open chat header strictly matches target contact
            const headerTitleEl = (mainPane ? mainPane.querySelector('header') : document.querySelector('header'))
              ?.querySelector('span[title], div[title], span[dir="auto"], span.x1rg5ohu, h2, [data-testid="conversation-info-header-chat-title"]');
            const rawHeader = headerTitleEl ? (headerTitleEl.getAttribute('title') || headerTitleEl.innerText || '') : '';
            const cleanHeader = cleanStr(rawHeader);

            // Strict Recipient Verification: Header MUST match target contact
            const isOpenChat = isMainOpen && Boolean(cleanTarget && cleanHeader && (cleanHeader.includes(cleanTarget) || cleanTarget.includes(cleanHeader)));

            // C. STRICT SAFETY: Only interact with composer IF the open chat is confirmed to match target contact!
            const composer = findComposer();
            if (composer && isOpenChat) {
              composer.focus();
              composer.click();
              document.execCommand('selectAll', false, null);
              document.execCommand('insertText', false, msg);
              composer.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: msg }));
              composer.dispatchEvent(new Event('input', { bubbles: true }));
              composer.dispatchEvent(new Event('change', { bubbles: true }));

              // Check if Send button is immediately active
              const sendBtn = findSendBtn();
              if (sendBtn && !sendBtn.disabled) {
                sendBtn.click();
                return { action: 'message_sent', method: 'button_click' };
              }

              return { action: 'composer_typed' };
            }

            // D. Guard: If target conversation pane is ALREADY open and verified, wait for composer
            if (isOpenChat) {
              return { action: 'waiting_for_composer' };
            }

            // If another person's chat is open (e.g. Mummy is open, but target is pidduk):
            // We MUST NOT touch composer! We must find and switch to target contact!
            const isUnmatchedChat = isMainOpen && !isOpenChat;

            const sidePane = document.getElementById('pane-side') || document.querySelector('#side');
            if (sidePane) {
              const allChatItems = Array.from(sidePane.querySelectorAll('div[role="listitem"], div[role="row"], div[data-testid^="list-item"]'));
              for (const item of allChatItems) {
                const text = cleanStr(item.innerText || item.textContent || '');
                if (text.includes(cleanTarget)) {
                  item.click();
                  return { action: 'chat_clicked', contactMatch: text.split('\n')[0] };
                }
              }

              const spans = Array.from(sidePane.querySelectorAll('span[title], div[title], span[dir="auto"]'));
              const matchSpan = spans.find(s => {
                const t = cleanStr(s.getAttribute('title') || s.innerText || '');
                return t.includes(cleanTarget);
              });
              if (matchSpan) {
                const clickTarget = matchSpan.closest('div[role="listitem"], div[role="row"], div[data-testid^="list-item"]') || matchSpan;
                clickTarget.click();
                return { action: 'chat_clicked', contactMatch: matchSpan.getAttribute('title') || matchSpan.innerText };
              }
            }

            // E. Search Bar: If not found in immediate list, focus and search
            const searchBox = document.querySelector(
              '#side input[type="text"], #side input[role="textbox"], #side input, #side div[contenteditable="true"], [data-testid="chat-list-search"], div[title="Search or start new chat"], div[role="textbox"][data-tab="3"], #side [role="textbox"], input[type="search"]'
            ) || Array.from(document.querySelectorAll('#side input, #side [role="textbox"], #side div[contenteditable="true"]')).find(el => {
              const t = cleanStr((el.getAttribute('title') || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' + (el.innerText || ''));
              return t.includes('search') || t.includes('start');
            });

            if (searchBox) {
              if (!${JSON.stringify(searchTyped)}) {
                searchBox.focus();
                if (searchBox.tagName === 'INPUT' || searchBox.tagName === 'TEXTAREA') {
                  const proto = searchBox instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                  if (setter) {
                    setter.call(searchBox, ${JSON.stringify(contact)});
                  } else {
                    searchBox.value = ${JSON.stringify(contact)};
                  }
                } else {
                  document.execCommand('selectAll', false, null);
                  document.execCommand('insertText', false, ${JSON.stringify(contact)});
                }
                searchBox.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: ${JSON.stringify(contact)} }));
                searchBox.dispatchEvent(new Event('input', { bubbles: true }));
                searchBox.dispatchEvent(new Event('change', { bubbles: true }));
                return { action: 'search_typed', currentHeader: rawHeader };
              }
            }

            return { action: isUnmatchedChat ? 'unmatched_chat_open' : 'waiting_for_ui', currentHeader: rawHeader };
          })()
        `).catch(err => ({ action: 'eval_error', error: err.message }));

        if (result && result.action === 'qr_required' && !qrPromptEmitted) {
          qrPromptEmitted = true;
          const qrMsg = `WhatsApp Web requires QR scan. Please link phone; will send "${message}" to "${contact}" automatically once linked.`;
          console.log(`[AgentRuntime WhatsApp] ⚠️ ${qrMsg}`);
          this.emit('feedback', { message: qrMsg, level: 'warning' });
          this.emit('jarvis-notification', { type: 'info', message: qrMsg });
        }

        if (result && result.action === 'unmatched_chat_open') {
          const current = result.currentHeader ? `"${result.currentHeader}"` : 'another chat';
          console.log(`[AgentRuntime WhatsApp] ⚠️ Active conversation is ${current}, but requested target is "${contact}". Switching to "${contact}"...`);
          this.emit('feedback', { message: `Active conversation is ${current}. Switching to "${contact}"...`, level: 'info' });
        }

        if (result && result.action === 'search_typed' && !searchTyped) {
          searchTyped = true;
          console.log(`[AgentRuntime WhatsApp] 🔍 Typed "${contact}" into WhatsApp search bar...`);
          this.emit('feedback', { message: `Step 1/3: Searching for "${contact}"...`, level: 'info' });
          await new Promise(r => setTimeout(r, 450));
        }

        // Autonomous Secret Code Unlock for Hidden / Locked Chats (e.g. WhatsApp Chat Lock with PIN/secret code)
        if (secretCode && !unlocked && !chatSelected) {
          unlocked = true;
          console.log(`[AgentRuntime WhatsApp] 🔐 Unlocking hidden/locked chats with secret code "${secretCode}"...`);
          this.emit('feedback', { message: `Unlocking hidden/locked chats with secret code...`, level: 'info' });
          const unlockRes = await this.autonomousUnlockWithSecret(tab, secretCode);
          if (unlockRes && unlockRes.success) {
            console.log(`[AgentRuntime WhatsApp] 🔓 Hidden chats unlocked successfully.`);
            this.emit('feedback', { message: `Locked chats unlocked. Selecting "${contact}"...`, level: 'info' });
            await new Promise(r => setTimeout(r, 600));
          }
        }

        // Live Inspect & Click: Select contact from live search results or chat list using real hardware mouse dispatch
        if (!chatSelected && (searchTyped || attempts >= 2 || unlocked)) {
          const inspectClick = await this.autonomousInspectAndClick(tab, contact);
          if (inspectClick && inspectClick.success) {
            chatSelected = true;
            const matchLabel = `"${inspectClick.label || contact}"`;
            console.log(`[AgentRuntime WhatsApp] 💬 Selected chat with ${matchLabel}, opening conversation...`);
            this.emit('feedback', { message: `Step 2/3: Opened chat with ${matchLabel}. Typing message...`, level: 'info' });
            await new Promise(r => setTimeout(r, 600));
            continue;
          }
        }

        if (result && (result.action === 'chat_clicked' || result.action === 'search_entered')) {
          chatSelected = true;
          const matchLabel = result.contactMatch ? `"${result.contactMatch}"` : `"${contact}"`;
          console.log(`[AgentRuntime WhatsApp] 💬 Selected chat with ${matchLabel}, opening conversation...`);
          this.emit('feedback', { message: `Step 2/3: Opened chat with ${matchLabel}. Typing message...`, level: 'info' });
        }

        if (result && result.action === 'composer_typed') {
          console.log(`[AgentRuntime WhatsApp] ⌨️ Dispatching native hardware Enter to WhatsApp composer for "${contact}"...`);
          await new Promise(r => setTimeout(r, 150));
          // Dispatch hardware Enter key directly via Chromium webContents
          contents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
          contents.sendInputEvent({ type: 'char', keyCode: '\r' });
          contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

          // Also attempt clicking Send button via DOM
          await contents.executeJavaScript(`
            (() => {
              const btn = (document.querySelector('#main button[aria-label="Send"], #main span[data-icon="send"], button[aria-label="Send"], span[data-icon="send"]'))?.closest('button');
              if (btn && !btn.disabled) btn.click();
            })()
          `).catch(() => null);

          // Verify if sent
          await new Promise(r => setTimeout(r, 450));
          const verifySent = await contents.executeJavaScript(`
            (() => {
              const comp = document.querySelector('#main div[contenteditable="true"], div[title="Type a message"], div[aria-label*="Type a message" i]');
              const text = comp ? (comp.innerText || comp.textContent || '').trim() : '';
              const isCleared = text === '';
              const recentOut = Array.from(document.querySelectorAll('#main div.message-out, #main [data-testid^="msg-container"]'));
              const lastOut = recentOut.length > 0 ? (recentOut[recentOut.length - 1].innerText || '').toLowerCase() : '';
              const targetMsg = ${JSON.stringify(message.toLowerCase().trim())};
              const matchesMsg = targetMsg && lastOut.includes(targetMsg);
              return isCleared || matchesMsg;
            })()
          `).catch(() => false);

          if (verifySent) {
            messageSent = true;
            const successMsg = `✅ Sent "${message}" to "${contact}" on WhatsApp!`;
            console.log(`[AgentRuntime WhatsApp] 🎉 ${successMsg} (hardware_enter)`);
            this.emit('feedback', { message: successMsg, level: 'success' });
            this.emit('jarvis-notification', { type: 'success', message: successMsg });
            return { success: true, message: successMsg };
          }
        }

        if (result && result.action === 'message_sent') {
          messageSent = true;
          const successMsg = `✅ Sent "${message}" to "${contact}" on WhatsApp!`;
          console.log(`[AgentRuntime WhatsApp] 🎉 ${successMsg} (${result.method})`);
          this.emit('feedback', { message: successMsg, level: 'success' });
          this.emit('jarvis-notification', { type: 'success', message: successMsg });
          return { success: true, message: successMsg };
        }

        if (attempts % 4 === 0) {
          console.log(`[AgentRuntime WhatsApp] Coordinating WhatsApp UI (attempt ${attempts}, status: ${result ? result.action : 'unknown'})...`);
        }
      } catch (err) {
        console.warn(`[AgentRuntime WhatsApp Exception]:`, err.message);
      }

      await new Promise(r => setTimeout(r, 900));
    }

    if (!messageSent) {
      const failureNotice = qrPromptEmitted
        ? `WhatsApp Web requires QR scan. Please link your phone to enable automatic messaging.`
        : `Could not verify delivery of "${message}" to "${contact}". Action did not complete within timeout.`;
      console.warn(`[AgentRuntime WhatsApp Handled]: ${failureNotice}`);
      this.emit('feedback', { message: failureNotice, level: 'warning' });
      this.emit('jarvis-notification', { type: 'alert', message: failureNotice });
      return { success: false, reason: failureNotice };
    }

    const successMsg = `✅ Sent "${message}" to "${contact}" on WhatsApp!`;
    console.log(`[AgentRuntime WhatsApp Completed]: ${successMsg}`);
    this.emit('feedback', { message: successMsg, level: 'success' });
    return { success: true, message: successMsg };
  }

  /**
   * Autonomous unread message finder & opener on WhatsApp Web
   */
  async clickWhatsAppUnreadChat(tab) {
    if (!tab || !tab.view) return { success: false, reason: 'No active tab view' };
    const contents = tab.view.webContents;
    if (!contents) return { success: false, reason: 'No webContents' };

    console.log('[AgentRuntime WhatsApp] 🔍 Locating unread chat in WhatsApp Web...');
    this.emit('feedback', { message: 'Locating unread chat in WhatsApp...', level: 'info' });

    try {
      const res = await contents.executeJavaScript(`
        (() => {
          const sidePane = document.getElementById('pane-side') || document.querySelector('#side');
          if (!sidePane) return { success: false, reason: 'side pane not found' };

          // 1. Look for unread badge elements in chat list (#pane-side)
          const unreadBadges = Array.from(sidePane.querySelectorAll(
            '[aria-label*="unread" i], [data-testid="unread-count"], [data-testid="icon-unread-count"], span[class*="unread" i]'
          ));
          
          for (const badge of unreadBadges) {
            const chatItem = badge.closest('div[role="listitem"], div[role="row"], div[data-testid^="list-item"]');
            if (chatItem) {
              const chatName = (chatItem.querySelector('span[title]')?.getAttribute('title') || chatItem.innerText || '').split('\\n')[0];
              chatItem.click();
              return { success: true, chatName };
            }
          }

          // 2. Look for items containing numeric badge counts
          const allItems = Array.from(sidePane.querySelectorAll('div[role="listitem"], div[role="row"]'));
          for (const item of allItems) {
            const spans = Array.from(item.querySelectorAll('span'));
            const badgeSpan = spans.find(s => /^\\d{1,4}$/.test(s.innerText.trim()) && s.offsetHeight > 10 && s.offsetHeight < 30);
            if (badgeSpan) {
              const chatName = (item.querySelector('span[title]')?.getAttribute('title') || item.innerText).split('\\n')[0];
              item.click();
              return { success: true, chatName };
            }
          }

          // 3. Try clicking the "Unread" filter pill at top of WhatsApp
          const unreadFilterPill = Array.from(document.querySelectorAll('button, div[role="button"]')).find(b => 
            /unread/i.test(b.innerText || b.getAttribute('title') || b.getAttribute('aria-label') || '')
          );
          if (unreadFilterPill) {
            unreadFilterPill.click();
            setTimeout(() => {
              const firstFiltered = sidePane.querySelector('div[role="listitem"], div[role="row"]');
              if (firstFiltered) firstFiltered.click();
            }, 300);
            return { success: true, chatName: 'First unread filtered chat' };
          }

          return { success: false, reason: 'No unread chat found' };
        })()
      `).catch(err => ({ success: false, reason: err.message }));

      if (res && res.success) {
        const successMsg = `✅ Opened unread chat with "${res.chatName || 'contact'}" on WhatsApp Web!`;
        console.log(`[AgentRuntime WhatsApp] ${successMsg}`);
        this.emit('feedback', { message: successMsg, level: 'success' });
        this.emit('jarvis-notification', { type: 'success', message: successMsg });
        return { success: true, message: successMsg };
      } else {
        const infoMsg = 'No unread messages found on WhatsApp Web.';
        console.log(`[AgentRuntime WhatsApp] ℹ️ ${infoMsg}`);
        this.emit('feedback', { message: infoMsg, level: 'info' });
        return { success: false, message: infoMsg };
      }
    } catch (err) {
      console.warn('[AgentRuntime WhatsApp Unread Exception]:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Generic autonomous continuator for intermediate prompts ("Continue on browser", "Continue in web")
   */
  async autoHandleContinuations(tab) {
    if (!tab || !tab.view) return;
    try {
      const contents = tab.view.webContents;
      if (!contents || typeof contents.executeJavaScript !== 'function') return;
      await contents.executeJavaScript(`
        (() => {
          // Check for WhatsApp intermediate web link
          const waWeb = Array.from(document.querySelectorAll('a, button')).find(el => 
            /use WhatsApp Web/i.test(el.textContent) || (el.href && el.href.includes('web.whatsapp.com'))
          );
          if (waWeb) { waWeb.click(); return 'waWeb'; }

          // Check for standard "Continue on browser" / "Continue in browser" buttons
          const continueBrowser = Array.from(document.querySelectorAll('a, button')).find(el => 
            /continue (?:on|in) (?:browser|web)/i.test(el.textContent)
          );
          if (continueBrowser) { continueBrowser.click(); return 'continueBrowser'; }
          return null;
        })()
      `).catch(() => null);
    } catch (_) {}
  }
  /**
   * Chrome Gemini-style Page Sharing Extractor
   * Retrieves active webpage title, headings, favicon, and clean article content
   * to provide real context for questions, summaries, and smart prompt suggestions.
   */
  async getActivePageContext() {
    const activeTab = this.tabManager ? this.tabManager.getActiveTab() : null;
    if (!activeTab) {
      return {
        url: 'adion://newtab',
        title: 'New Tab',
        favicon: '',
        headings: [],
        suggestions: ['Explore top tech news', 'Check system diagnostics', 'Open GitHub'],
        isShared: this.isPageShared !== false
      };
    }

    const basicContext = {
      url: activeTab.url || '',
      title: activeTab.title || 'Untitled Tab',
      favicon: activeTab.favicon || '',
      headings: [],
      suggestions: [],
      isShared: this.isPageShared !== false
    };

    if (activeTab.view && activeTab.view.webContents && !activeTab.url.startsWith('adion://newtab')) {
      try {
        const details = await activeTab.view.webContents.executeJavaScript(`
          (() => {
            const title = document.title || '';
            const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
              .slice(0, 10)
              .map(h => (h.innerText || '').trim())
              .filter(t => t.length > 2 && t.length < 80);

            const favEl = document.querySelector('link[rel*="icon"]');
            const favicon = favEl ? favEl.href : '';

            // Clean visible text snippet (up to 4000 chars)
            const text = (document.body ? document.body.innerText : '')
              .replace(/\\s+/g, ' ')
              .trim()
              .slice(0, 4000);

            return { title, headings: headings.slice(0, 6), favicon, text };
          })()
        `).catch(() => null);

        if (details) {
          if (details.title) basicContext.title = details.title;
          if (details.favicon) basicContext.favicon = details.favicon;
          if (Array.isArray(details.headings) && details.headings.length > 0) {
            basicContext.headings = details.headings;
            // Generate smart contextual suggestions from headings (Chrome Gemini Style)
            basicContext.suggestions = details.headings.slice(0, 3).map((h, idx) => {
              const cleanH = h.replace(/^[^a-zA-Z0-9]+/, '');
              if (idx === 0) return `Explain ${cleanH}`;
              if (idx === 1) return `Describe ${cleanH}`;
              return `Compare ${cleanH} to standard browsers`;
            });
          }
          basicContext.pageText = details.text;
        }
      } catch (_) {}
    }

    if (!basicContext.suggestions || basicContext.suggestions.length === 0) {
      if (basicContext.url.includes('whatsapp.com')) {
        basicContext.suggestions = [
          'Say hi to recent chat',
          'Search unread messages',
          'Summarize latest messages'
        ];
      } else if (basicContext.url.includes('youtube.com')) {
        basicContext.suggestions = [
          'Summarize this video',
          'Explain key topics in this video',
          'Play next recommended video'
        ];
      } else {
        basicContext.suggestions = [
          'Summarize this page',
          'Explain main points of this page',
          'Extract key takeaways & links'
        ];
      }
    }

    return basicContext;
  }
}

module.exports = AgentRuntime;

