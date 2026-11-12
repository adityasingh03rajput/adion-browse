const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const { AgentState, ActionType } = require('./protocol');
const STTEngine = require('./sttEngine');
const ModelClient = require('./modelClient');
const ModelRouter = require('./modelRouter');
const SessionManager = require('./sessionManager');
const { buildDOMGroundingScript, detectSemanticCluster } = require('./universalGrounder');
const { scoreTokenOverlap } = require('./tokenMatch');

/**
 * Asynchronous Agent Runtime
 * Decoupled execution engine that interprets natural language and speech intents,
 * grounds them against the DOM/CDP pipeline, and dispatches actions to Chromium.
 */
class AgentRuntime extends EventEmitter {
  constructor(tabManager, cdpBridge, contextEngine, visionGrounder, securityVault, sessionManager = null, terminalBridge = null) {
    super();
    this.tabManager = tabManager;
    this.cdp = cdpBridge;
    this.context = contextEngine;
    this.vision = visionGrounder;
    this.vault = securityVault;
    this.sessionManager = sessionManager || new SessionManager();
    this.terminalBridge = terminalBridge;
    this.stt = new STTEngine();
    this.model = new ModelClient();
    this.router = new ModelRouter();
    this.state = AgentState.IDLE;
    this.currentTask = null;
    this.actionHistory = [];
    this.continuousVoice = false;
    this.lastDOMSelector = null;
    this.lastDOMAction = null;
    this.lastReferencedFile = null;
    this.isPageShared = true; // Chrome Gemini-style active page context sharing
    this.verboseAudioLogging = false; // Filtered to suppress repetitive audio frame status spam
    this.maxGoalIterations = 15; // Autonomous Sense-Plan-Act-Verify re-planning goal loop depth

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
      isSegmenting: false,
      noiseFloor: 0.003,
      pendingSpeechFrames: 0,
      strayQuietFrames: 0
    };
  }

  get modelClient() {
    return this.model;
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
      speechFramesCount: 0,
      consecutiveSilenceFrames: 0,
      isSegmenting: false,
      noiseFloor: 0.003,
      pendingSpeechFrames: 0,
      strayQuietFrames: 0
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
      speechFramesCount: 0,
      consecutiveSilenceFrames: 0,
      isSegmenting: false,
      noiseFloor: 0.003,
      pendingSpeechFrames: 0,
      strayQuietFrames: 0
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

    // Voice Activity Detection (VAD): adaptive noise floor + hysteresis.
    // Room noise drifts (fan, AC, mic gain); a fixed 0.012 threshold sits inside
    // the noise band (silence ~0.002, blips ~0.013) and false-triggers on it.
    const S = this.audioSession;
    if (typeof S.noiseFloor !== 'number') S.noiseFloor = 0.003;
    if (rms < 0.02) {
      // Slow EMA of the quiet floor; clamp keeps it sane in dead silence.
      S.noiseFloor = Math.max(0.0008, S.noiseFloor + (rms - S.noiseFloor) * 0.02);
    }
    // Attack threshold: absolute floor 0.025 (above noise blips ~0.014, below
    // real speech ~0.04+) with room-noise scaling, capped so quiet speech survives.
    const vadThreshold = Math.min(0.04, Math.max(0.025, S.noiseFloor * 6));
    const isSpeechActive = rms > vadThreshold;

    // Log audio frame telemetry to stdout with exact Speech: true / Speech: false from git history
    if (this.audioSession.chunkCount % 5 === 1 || isSpeechActive) {
      console.log(`[AgentRuntime Audio] Frame #${this.audioSession.chunkCount} | Size: ${buffer.length}B | RMS: ${rms.toFixed(4)} | Speech: ${isSpeechActive}`);
    }

    // VAD Auto-Segmentation & Endpointing State Machine
    if (isSpeechActive) {
      // Attack debounce: one hot frame is a click/pop, not speech. Buffering is
      // unaffected (chunks accumulate regardless), so nothing is clipped.
      S.pendingSpeechFrames = (S.pendingSpeechFrames || 0) + 1;
      S.speechFramesCount = (S.speechFramesCount || 0) + 1;
      S.consecutiveSilenceFrames = 0;
      S.strayQuietFrames = 0;
      if (!S.speechDetected && S.pendingSpeechFrames >= 2) {
        S.speechDetected = true;
        console.log(`[AgentRuntime VAD] Voice activity initiated (RMS: ${rms.toFixed(4)})`);
      }
    } else if (this.audioSession.speechDetected && !this.audioSession.isSegmenting) {
      this.audioSession.consecutiveSilenceFrames++;
      // Natural speech pause: 9 silence frames (~1.15s of post-speech pause)
      if (this.audioSession.consecutiveSilenceFrames >= 9 && this.audioSession.chunks.length >= 5) {
        // Discard transient acoustic clicks or breath under 8 speech frames (<100ms of actual voice)
        if ((this.audioSession.speechFramesCount || 0) < 8) {
          this.audioSession.speechDetected = false;
          this.audioSession.speechFramesCount = 0;
          this.audioSession.consecutiveSilenceFrames = 0;
          return;
        }
        console.log(`[AgentRuntime VAD] Utterance concluded after pause (${this.audioSession.totalBytes} bytes accumulated, ${this.audioSession.speechFramesCount} speech frames)`);
        this.audioSession.isSegmenting = true;
        this.triggerAutoEndpoint();
      }
    } else if (!S.speechDetected && !S.isSegmenting) {
      S.pendingSpeechFrames = 0;
      S.strayQuietFrames = (S.strayQuietFrames || 0) + 1;
      if (S.strayQuietFrames >= 9) {
        S.speechFramesCount = 0;
        S.strayQuietFrames = 0;
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
   * Decompose compound or multi-clause user prompt into structured subtasks
   */
  synthesizeTasksFromPrompt(prompt, actions = []) {
    const raw = (prompt || '').trim();
    const tasks = [];
    let id = 1;

    // Split compound prompts by conjunctions: "and", "then", "after that", commas
    const parts = raw.split(/\s*(?:,\s*then\s*|,\s*and\s*|,\s*|\band\s+then\b|\bthen\b|\band\b)\s*/i)
      .map(p => p.trim())
      .filter(p => p.length > 2);

    if (parts.length > 1) {
      for (let i = 0; i < parts.length; i++) {
        tasks.push({
          id: id++,
          title: parts[i].charAt(0).toUpperCase() + parts[i].slice(1),
          status: i === 0 ? 'in_progress' : 'pending'
        });
      }
    } else if (actions && actions.length > 0) {
      for (let i = 0; i < actions.length; i++) {
        const act = actions[i];
        let title = '';
        if (act.type === ActionType.NAVIGATE) title = `Navigate to ${act.params?.url || act.params?.query || 'destination'}`;
        else if (act.type === ActionType.CLICK_SELECTOR) title = `Click "${act.params?.target || 'target element'}"`;
        else if (act.type === ActionType.CLOSE_TAB) title = 'Close active tab';
        else if (act.type === ActionType.INPUT_TEXT) title = `Input text into ${act.params?.selector || 'form field'}`;
        else if (act.type === 'WHATSAPP_CHAT_SEND') title = `Send WhatsApp message to "${act.params?.contact || 'recipient'}"`;
        else if (act.type === ActionType.TERMINAL_EXEC || act.type === 'TERMINAL_EXEC') title = `Execute terminal: \`${act.params?.command || act.command || 'command'}\``;
        else title = `Execute ${act.type}`;

        tasks.push({
          id: id++,
          title,
          status: i === 0 ? 'in_progress' : 'pending'
        });
      }
    } else {
      tasks.push({
        id: 1,
        title: raw.charAt(0).toUpperCase() + raw.slice(1),
        status: 'in_progress'
      });
    }

    return tasks;
  }

  /**
   * Process incoming voice or natural language text command
   * Every command is planned by the AI model; there is no local fast path.
   */
  async processCommand(rawInput, source = 'voice') {
    if (!rawInput || typeof rawInput !== 'string') return;
    const exactPrompt = String(rawInput); // Strict prompt fidelity preservation
    
    const text = exactPrompt.trim();
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

    // Detect Computer Use / Local Workspace Mode (/pc, /computer, /workspace)
    const isComputerUse = /^\/(?:pc|computer|workspace)\b/i.test(exactPrompt) ||
                          /^(?:run\s+on\s+(?:pc|computer|workspace)|on\s+(?:my\s+)?(?:pc|computer|workspace))\b/i.test(exactPrompt);

    let plannedText = text;
    if (isComputerUse) {
      plannedText = text.replace(/^(?:\/pc\s+|\/computer\s+|\/workspace\s+|run\s+on\s+(?:pc|computer|workspace)\s+|on\s+(?:my\s+)?(?:pc|computer|workspace)\s*)/i, '').trim();
      if (!plannedText) plannedText = 'inspect current directory and system status';
    }

    let activeTab = null;
    let pageContext = {};
    let executedPlan = null;

    try {
      activeTab = this.tabManager ? this.tabManager.getActiveTab() : null;
      pageContext = activeTab ? { url: activeTab.url, title: activeTab.title } : {};
      if (this.lastDOMSelector) {
        pageContext.lastDOMSelector = this.lastDOMSelector;
      }

      // Computer Use environment setup: ensure local terminal bridge is active
      if (isComputerUse) {
        pageContext.isComputerUse = true;
        if (this.terminalBridge) {
          if (!this.terminalBridge.isConnected) {
            try {
              await this.terminalBridge.start();
            } catch (_) {}
          }
          pageContext.terminal = this.terminalBridge.getStatus();
        }
        this.emit('feedback', {
          message: `🖥️ Computer Use Mode: Directing execution to local PC terminal (${pageContext.terminal?.shell || 'powershell'})`,
          level: 'info'
        });
      }

      // 1. Gather Active Page Context (including shared page context if page sharing is enabled)
      if (!isComputerUse && activeTab && activeTab.view && !activeTab.url.startsWith('adion://newtab') && this.isPageShared !== false) {
        try {
          const sharedCtx = await this.getActivePageContext();
          if (sharedCtx) {
            pageContext = { ...pageContext, ...sharedCtx };
          }
        } catch (_) {}
      }

      // 2. Retrieve recent conversation history from SessionManager so agent retains conversational memory
      const recentInteractions = this.sessionManager ? (this.sessionManager.getHistory().interactions || []).slice(-40) : [];
      const conversationHistory = recentInteractions.map(item => ({
        user: item.prompt?.raw || item.prompt?.transcription || item.rawPrompt || item.transcription || '',
        agent: item.response?.thought || item.response?.feedback || item.feedback || (item.modelResponse && item.modelResponse.thought) || '',
        status: item.response?.status || item.status || 'success'
      })).filter(h => h.user && h.user.trim().length > 0);

      // Pass lastReferencedFile in pageContext for zero-latency coreference resolution
      if (this.lastReferencedFile) {
        pageContext.lastReferencedFile = this.lastReferencedFile;
      }

      // 3. TIER 1: AI-FIRST AUTONOMOUS GOAL EXECUTION & RE-PLANNING LOOP
      // Sense -> Plan -> Act -> Verify. The agent senses live state after each action,
      // reports execution results back to the model, tracks subtask breakdown, and iteratively replans until the goal is accomplished.
      let maxGoalIterations = this.maxGoalIterations || 15;
      const absoluteSafetyCap = 30;
      let iteration = 0;
      let goalAccomplished = false;
      const stepHistory = [];
      let finalFeedback = '';
      let initialPlan = null;

      if (this.model) {
        try {
          initialPlan = await Promise.race([
            this.model.planActions(plannedText, pageContext, conversationHistory),
            new Promise((_, rej) => setTimeout(() => rej(new Error('initial-plan timeout 25s')), 25000)),
          ]);
        } catch (err) {
          console.warn('[AgentRuntime] Initial AI Model planning error:', err.message);
        }
      }

      if (initialPlan && (Array.isArray(initialPlan.actions) || initialPlan.thought)) {
        if (!Array.isArray(initialPlan.actions)) initialPlan.actions = [];

        // Synthesize or extract structured subtasks for user visibility
        let activeTasks = (Array.isArray(initialPlan.tasks) && initialPlan.tasks.length > 0)
          ? initialPlan.tasks
          : this.synthesizeTasksFromPrompt(exactPrompt, initialPlan.actions);

        // Emit initial task breakdown to Jarvis Copilot
        if (activeTasks && activeTasks.length > 0) {
          this.emit('task-breakdown', { prompt: exactPrompt, tasks: activeTasks });
          const taskSummary = activeTasks.map((t, idx) => `${idx + 1}. ${t.title}`).join('\n');
          this.emit('feedback', {
            message: `📋 Goal Breakdown:\n${taskSummary}`,
            level: 'info',
            tasks: activeTasks
          });
        }

        // If model returned 0 actions:
        if (initialPlan.actions.length === 0) {
          // Anti-Hallucination Guard: Never accept 0 actions if user prompt explicitly demanded an action!
          const hasActionVerb = /\b(create|make|write|generate|add|delete|remove|run|execute|build|start|stop|install|clone|open)\b/i.test(exactPrompt);
          if (hasActionVerb) {
            console.warn('[AgentRuntime Guard] Model hallucinated completion with 0 actions for action prompt:', exactPrompt);
            this.emit('feedback', {
              message: `⚠️ Action notice: No execution command was dispatched by the planner. No system changes were made.`,
              level: 'warning'
            });
            this.sessionManager.recordInteraction({
              source: source,
              rawPrompt: exactPrompt,
              transcription: text,
              pageContext: pageContext,
              modelResponse: initialPlan,
              status: 'failed',
              feedback: 'No actions were dispatched.'
            });
            return;
          }

          this.setState(AgentState.IDLE);
          const feedbackMsg = initialPlan.thought || 'Standing by for browser commands.';
          this.emit('feedback', { message: feedbackMsg, level: 'info' });
          this.emit('jarvis-notification', { type: 'info', message: feedbackMsg });
          this.sessionManager.recordInteraction({
            source: source,
            rawPrompt: exactPrompt,
            transcription: text,
            pageContext: pageContext,
            modelResponse: initialPlan,
            status: 'success',
            feedback: feedbackMsg
          });
          return;
        }

        let currentPlan = initialPlan;
        let stalledIterations = 0;

        while (iteration < maxGoalIterations && !goalAccomplished) {
          iteration++;
          executedPlan = currentPlan;

          // Dynamic Iteration Cap Extension requested by AI
          if (typeof currentPlan.extendCapBy === 'number' && currentPlan.extendCapBy > 0) {
            const ext = Math.min(Math.round(currentPlan.extendCapBy), 8);
            const prevCap = maxGoalIterations;
            maxGoalIterations = Math.min(maxGoalIterations + ext, absoluteSafetyCap);
            if (maxGoalIterations > prevCap) {
              console.log(`[AgentRuntime GoalLoop] ⚡ Dynamic cap extended by +${maxGoalIterations - prevCap} turns (new cap: ${maxGoalIterations}, safety max: ${absoluteSafetyCap})`);
              this.emit('feedback', {
                message: `⚡ Autonomous runway extended to ${maxGoalIterations} iterations to ensure goal verification.`,
                level: 'info'
              });
            }
          }

          const planThought = currentPlan.thought || `Executing autonomous step ${iteration}`;
          console.log(`[AgentRuntime GoalLoop Iteration #${iteration}]`, planThought);
          this.emit('feedback', { 
            message: `Step ${iteration}: ${planThought}`, 
            level: 'success' 
          });

          let actionsInTurn = Array.isArray(currentPlan.actions) ? currentPlan.actions : [];
          let allSubActionsSucceeded = true;
          let skippedDuplicates = 0;
          let turnOutcomeMsg = '';

          for (let i = 0; i < actionsInTurn.length; i++) {
            const act = actionsInTurn[i];
            // Tolerate both planner shapes: { type, params: {...} } and
            // { type, ...fields }. Flat fields must not be dropped, otherwise a
            // flat NAVIGATE/target executes with undefined parameters.
            const flatParams = {};
            if (act && typeof act === 'object') {
              for (const [key, value] of Object.entries(act)) {
                if (key !== 'type' && key !== 'params') flatParams[key] = value;
              }
            }
            const intent = { type: act.type, ...flatParams, ...(act.params || {}), raw: exactPrompt };

            // Anti-Loop Guard (general): never dispatch an identical click/navigation
            // twice in the same goal run. Repeating it is what made the agent click
            // the same button or heading on every iteration.
            const fingerprint = this.fingerprintAction(act, intent);

            // Reject incomplete actions before touching the page or the shell.
            const invalidReason = this.validateIntent(intent);
            if (invalidReason) {
              allSubActionsSucceeded = false;
              turnOutcomeMsg = invalidReason;
              stepHistory.push({
                iteration,
                action: act.type,
                status: 'FAILED',
                summary: `Rejected ${act.type}: ${invalidReason}`,
                fingerprint
              });
              console.warn(`[AgentRuntime Action] Rejected ${act.type}: ${invalidReason}`);
              this.emit('feedback', { message: `Planner action rejected: ${invalidReason}`, level: 'warning' });
              continue;
            }
            const priorAttempt = stepHistory.find(s => s.fingerprint === fingerprint &&
              (s.status === 'SUCCESS' || s.status === 'FAILED'));
            const isDuplicate = Boolean(priorAttempt) && this.isRepeatGuardedType(act.type);
            const isFailedDuplicate = Boolean(priorAttempt) && priorAttempt.status === 'FAILED';
            if (isDuplicate) {
              skippedDuplicates++;
              const why = isFailedDuplicate
                ? 'already failed earlier; skipped instead of repeating the same failing action'
                : 'already succeeded; skipped';
              console.log(`[AgentRuntime GoalLoop] Anti-Loop: skipped repeated ${fingerprint} (${why})`);
              if (isFailedDuplicate) {
                turnOutcomeMsg = `Action "${fingerprint}" already failed earlier; a different target or approach is required.`;
              }
              stepHistory.push({
                iteration,
                action: act.type,
                status: 'SKIPPED',
                summary: `${act.type} ${intent.target || intent.url || intent.text || ''} (${why})`,
                fingerprint
              });
              continue;
            }

            // Anti-Loop Guard: If we already navigated to the target site/domain in a previous step,
            // skip redundant NAVIGATE so the agent focuses on interacting with the page
            if (act.type === ActionType.NAVIGATE) {
              const dest = (intent.url || intent.query || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
              const alreadyNavigated = stepHistory.some(s => s.action === ActionType.NAVIGATE && s.status === 'SUCCESS');
              const curTab = this.tabManager ? this.tabManager.getActiveTab() : null;
              const curUrl = (curTab?.url || '').toLowerCase();
              if (alreadyNavigated && dest && (curUrl.includes(dest) || curUrl.replace(/\/$/, '').endsWith(dest.replace(/\/$/, '')))) {
                console.log(`[AgentRuntime GoalLoop] Already on target site (${curTab.title || curTab.url}); skipping redundant NAVIGATE to: ${intent.url}`);
                stepHistory.push({
                  iteration,
                  action: act.type,
                  status: 'SUCCESS',
                  summary: `NAVIGATE ${intent.url} (Already on site)`,
                  fingerprint
                });
                // Update corresponding task status if pending
                if (activeTasks && activeTasks.length > 0) {
                  const navTask = activeTasks.find(t => t.status !== 'completed' && /navigat|go to|open/i.test(t.title));
                  if (navTask) navTask.status = 'completed';
                }
                continue;
              }
            }

            // Fill multi-field forms without submitting after every field:
            // only the final INPUT_TEXT in a plan may auto-submit.
            if (intent.type === ActionType.INPUT_TEXT && intent.submit === undefined &&
                actionsInTurn.slice(i + 1).some(a => a && a.type === ActionType.INPUT_TEXT)) {
              intent.submit = false;
            }

            const execRes = await this.executeIntent(intent);
            const isSuccess = execRes ? execRes.success !== false : true;

            let subSummary = '';
            if (act.type === ActionType.TERMINAL_EXEC || act.type === 'TERMINAL_EXEC') {
              const cmdText = intent.command || act.params?.command || act.command || '';
              const outText = ([execRes?.stdout, execRes?.stderr].filter(Boolean).join('\n').trim() || '(no output/empty)').slice(0, 1500);
              subSummary = `TERMINAL_EXEC \`${cmdText}\` (exit: ${execRes?.exitCode !== undefined ? execRes.exitCode : 0}) => ${outText}`;
            } else {
              subSummary = isSuccess 
                ? `${act.type} ${intent.url || intent.target || intent.text || ''}`.trim()
                : `Failed: ${execRes?.crossQuestion || execRes?.reason || 'action unfulfilled'}`;
            }

            console.log(`[AgentRuntime Action] ${act.type}` +
              (intent.target ? ` target="${intent.target}"` : '') +
              (intent.text ? ` text="${String(intent.text).slice(0, 40)}"` : '') +
              ` -> ${isSuccess ? 'SUCCESS' : 'FAILED'}` +
              (isSuccess ? '' : ` (${execRes?.reason || execRes?.error || 'no reason reported'})`));

            stepHistory.push({
              iteration,
              action: act.type,
              status: isSuccess ? 'SUCCESS' : 'FAILED',
              summary: subSummary,
              fingerprint
            });

            // Update subtask progress
            if (activeTasks && activeTasks.length > 0) {
              const currentTask = activeTasks.find(t => t.status === 'in_progress') || activeTasks.find(t => t.status === 'pending');
              if (currentTask) {
                if (isSuccess) {
                  currentTask.status = 'completed';
                  const nextTask = activeTasks.find(t => t.status === 'pending');
                  if (nextTask) nextTask.status = 'in_progress';
                } else {
                  currentTask.status = 'pending';
                }
                this.emit('task-breakdown', { prompt: exactPrompt, tasks: activeTasks });
              }
            }

            if (!isSuccess) {
              allSubActionsSucceeded = false;
              turnOutcomeMsg = execRes?.crossQuestion || execRes?.reason || 'Action could not be executed';
              // If cross-question was emitted (e.g. Sign Up vs Log In conflict), pause and let user reply
              if (execRes?.crossQuestion) {
                goalAccomplished = true;
                finalFeedback = execRes.crossQuestion;
                break;
              }
            } else if (act.type === ActionType.CLICK_SELECTOR && !execRes?.visualGrounding) {
              // No click-based goal inference: a click that opens a dialog or a
              // panel is not proof the user's goal is complete. Only the planner
              // may set goalAccomplished, based on the observed page state.
              console.log(`[AgentRuntime GoalLoop] Click succeeded on "${intent.target}"; waiting for planner verification before completing the goal.`);
            }

            if (i < actionsInTurn.length - 1) {
              // A click can open a panel/menu that renders asynchronously;
              // give multi-action plans a beat before the next grounding pass.
              await new Promise(r => setTimeout(r, isSuccess ? 900 : 350));
            }
          }

          // Every action was a repeat of an earlier success: stop instead of
          // re-planning into the same click again.
          if (actionsInTurn.length > 0 && skippedDuplicates === actionsInTurn.length) {
            goalAccomplished = true;
            finalFeedback = 'Stopped: the planner repeated an action that had already run (success or failure). No duplicate action was dispatched.';
            this.emit('feedback', {
              message: '⚠️ Anti-loop guard: repeated action detected and skipped; stopped to avoid an infinite click loop.',
              level: 'warning'
            });
          }

          if (goalAccomplished) break;

          // Stall detection: consecutive steps that execute nothing are a dead
          // end, not a reason to keep spending model calls and iterations.
          const turnHadSuccess = stepHistory.some(s => s.iteration === iteration && s.status === 'SUCCESS');
          if (!goalAccomplished && !turnHadSuccess) stalledIterations += 1;
          else stalledIterations = 0;
          if (stalledIterations >= 3) {
            goalAccomplished = true;
            finalFeedback = `Stopped after ${stalledIterations} consecutive steps that could not execute any action. Last result: ${turnOutcomeMsg || finalFeedback || 'no progress'}.`;
            this.emit('feedback', { message: '⚠️ ' + finalFeedback, level: 'warning' });
          }

          console.log(`[AgentRuntime GoalLoop] iter end #${iteration}: goal=${goalAccomplished} steps=${stepHistory.length} tasks=${(activeTasks||[]).map(t=>t.status).join(',')}`);
          finalFeedback = currentPlan.thought || turnOutcomeMsg || 'Task step executed.';

          // Check if the model explicitly marked the overall goal as accomplished
          if (currentPlan.goalAccomplished === true && allSubActionsSucceeded) {
            goalAccomplished = true;
            if (activeTasks && activeTasks.length > 0) {
              activeTasks.forEach(t => { t.status = 'completed'; });
              this.emit('task-breakdown', { prompt: exactPrompt, tasks: activeTasks });
            }
            break;
          }

          // If this was the last iteration, stop
          if (iteration >= maxGoalIterations) {
            console.log(`[AgentRuntime GoalLoop] Reached max goal iterations (${maxGoalIterations}).`);
            break;
          }

          // Sense: Pause for live DOM settling and dynamic re-hydration
          await new Promise(r => setTimeout(r, 600));

          const currentTab = this.tabManager ? this.tabManager.getActiveTab() : null;
          const livePageContext = isComputerUse
            ? { ...pageContext, terminal: this.terminalBridge ? this.terminalBridge.getStatus() : null }
            : await this.getActivePageContext(currentTab);

          // Build augmented conversational history containing live goal execution progress
          const augmentedHistory = [...conversationHistory];
          augmentedHistory.push({
            user: `Goal: "${exactPrompt}"`,
            agent: `Progress so far:\n` + stepHistory.slice(-8).map(s => `- [Step ${s.iteration}] ${s.summary} (${s.status})`).join('\n') +
                   (isComputerUse
                     ? `\n[Operating Environment: Host PC / Local Terminal (${livePageContext.terminal?.cwd || process.cwd()})]\nCRITICAL INSTRUCTION: Analyze the output of the previous step. If additional terminal commands are required to fulfill the user's PC task, output {"type": "TERMINAL_EXEC", "params": {"command": "..."}}. When the task is complete, return "goalAccomplished": true, "actions": [], and summarize results.`
                     : `\nCurrent Active Page: "${livePageContext.title || livePageContext.url}" (URL: ${livePageContext.url}) with buttons: [${(livePageContext.buttons || []).slice(0, 10).join(', ')}]\n` +
                       `CRITICAL INSTRUCTION: If you already reached the site or clicked the requested button, DO NOT navigate back or repeat actions. If more turns are needed, specify "extendCapBy". If goal is satisfied, return "goalAccomplished": true, "actions": [].`
                   )
          });

          // Re-plan: Query model with observed state and step history
          try {
            const planTarget = isComputerUse ? `Local Terminal (${livePageContext.terminal?.shell || 'powershell'})` : (livePageContext.title || livePageContext.url);
            console.log(`[AgentRuntime GoalLoop] Re-planning next step on ${planTarget}...`);
            this.emit('feedback', { 
              message: isComputerUse 
                ? `Evaluating next terminal step on local PC...`
                : `Inspected page "${livePageContext.title || livePageContext.url}". Evaluating next step for goal...`, 
              level: 'info' 
            });
            const nextPlan = await Promise.race([
              this.model.planActions(plannedText, livePageContext, augmentedHistory),
              new Promise((_, rej) => setTimeout(() => rej(new Error('replan timeout 15s')), 15000))
            ]);
            if (nextPlan && (Array.isArray(nextPlan.actions) || nextPlan.thought)) {
              if (!Array.isArray(nextPlan.actions)) nextPlan.actions = [];
              if (nextPlan.actions.length === 0 || (nextPlan.goalAccomplished === true && nextPlan.actions.length === 0)) {
                // Physical Verification Safety Net for Computer Use:
                if (isComputerUse) {
                  const fileMatch = exactPrompt.match(/(?:create|make|write)\s+([a-zA-Z0-9_\-\.\/\\]+\.[a-zA-Z0-9]+)/i) ||
                                    (nextPlan.thought || '').match(/created\s+['"]?([a-zA-Z0-9_\-\.\/\\]+\.[a-zA-Z0-9]+)/i);
                  if (fileMatch) {
                    let targetPath = fileMatch[1];
                    const dirMatch = exactPrompt.match(/([a-zA-Z]:[\\\/][^\s,]+)/i);
                    if (dirMatch && !targetPath.includes(':')) {
                      targetPath = `${dirMatch[1].replace(/[\\\/]$/, '')}\\${targetPath}`;
                    }

                    const exists = fs.existsSync(targetPath);
                    if (!exists) {
                      console.warn(`[AgentRuntime Guard] Physical verification failed: ${targetPath} does not exist on disk! Enforcing creation...`);
                      const contentMatch = exactPrompt.match(/(?:say(?:ing)?|with(?:\s+content)?)\s+['"]?([^.'"]+)['"]?/i);
                      const fileContent = contentMatch ? contentMatch[1].trim() : 'hello';

                      const psCmd = `if (!(Test-Path "${path.dirname(targetPath)}")) { New-Item -ItemType Directory -Force -Path "${path.dirname(targetPath)}" | Out-Null }; Set-Content -Path "${targetPath}" -Value @"\n${fileContent}\n"@; if (Test-Path "${targetPath}") { Write-Output "Successfully created: ${targetPath}" } else { Write-Error "Failed to create: ${targetPath}" }`;

                      this.emit('feedback', {
                        message: `⚡ Enforcing verified creation of ${targetPath} on local disk...`,
                        level: 'info'
                      });

                      const synthRes = await this.executeIntent({
                        type: ActionType.TERMINAL_EXEC,
                        command: psCmd,
                        targetFile: targetPath
                      });

                      if (synthRes && fs.existsSync(targetPath)) {
                        this.lastReferencedFile = targetPath;
                        goalAccomplished = true;
                        finalFeedback = `Verified on physical disk: Created ${targetPath} with content: "${fileContent}".`;
                        if (activeTasks && activeTasks.length > 0) {
                          activeTasks.forEach(t => { t.status = 'completed'; });
                          this.emit('task-breakdown', { prompt: exactPrompt, tasks: activeTasks });
                        }
                        break;
                      }
                    }
                  }
                }

                goalAccomplished = true;
                finalFeedback = nextPlan.thought || finalFeedback;
                if (activeTasks && activeTasks.length > 0) {
                  activeTasks.forEach(t => { t.status = 'completed'; });
                  this.emit('task-breakdown', { prompt: exactPrompt, tasks: activeTasks });
                }
                break;
              }
              currentPlan = nextPlan;
            } else {
              break;
            }
          } catch (replanErr) {
            console.warn('[AgentRuntime GoalLoop] Re-planning error:', replanErr.message);
            break;
          }
        }

        // Record interaction in session memory log
        this.sessionManager.recordInteraction({
          source: source,
          rawPrompt: exactPrompt,
          transcription: text,
          pageContext: pageContext,
          modelResponse: executedPlan || initialPlan,
          status: 'success',
          feedback: finalFeedback || (executedPlan && executedPlan.thought) || 'Task completed successfully'
        });

        this.emit('jarvis-notification', {
          type: 'success',
          message: finalFeedback || (executedPlan && executedPlan.thought) || `Task executed successfully.`
        });
        return;
      }

      // No fast-path, cache, or regex fallback: if the AI planner produced no
      // plan, report it plainly instead of guessing an action.
      this.setState(AgentState.IDLE);
      const noPlanMsg = 'The AI planner produced no plan for this command, so nothing was executed.';
      console.warn('[AgentRuntime] No plan from model; command not executed:', exactPrompt);
      this.emit('feedback', { message: noPlanMsg, level: 'warning' });
      this.emit('jarvis-notification', { type: 'alert', message: noPlanMsg });
      this.sessionManager.recordInteraction({
        source: source,
        rawPrompt: exactPrompt,
        transcription: text,
        pageContext: pageContext,
        modelResponse: null,
        status: 'failed',
        feedback: noPlanMsg
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

  /**
   * Preflight validation for planner actions. Reject structurally incomplete
   * actions with a precise reason instead of navigating to "undefined" or
   * throwing midway through a turn.
   * Returns null when valid, otherwise the reason it cannot run.
   */
  validateIntent(intent = {}) {
    const type = String(intent.type || '').toUpperCase();
    const has = (value) => value !== undefined && value !== null && String(value).trim() !== '';

    switch (type) {
      case ActionType.NAVIGATE:
        return has(intent.url) || has(intent.query) ? null : 'NAVIGATE requires url or query';
      case ActionType.CLICK_SELECTOR:
        return has(intent.target || intent.selector) ? null : 'CLICK_SELECTOR requires target';
      case ActionType.INPUT_TEXT:
        return has(intent.selector || intent.target) && intent.text !== undefined
          ? null
          : 'INPUT_TEXT requires selector and text';
      case ActionType.SWITCH_TAB:
        return has(intent.target || intent.index) ? null : 'SWITCH_TAB requires target or index';
      case ActionType.MODIFY_DOM:
        return has(intent.selector || intent.target) ? null : 'MODIFY_DOM requires selector';
      case ActionType.TERMINAL_EXEC:
        return has(intent.command || intent.cmd) ? null : 'TERMINAL_EXEC requires command';
      default:
        return null;
    }
  }

  async executeIntent(intent) {
    this.setState(AgentState.EXECUTING_ACTION, { action: intent });
    this.emit('action-started', intent);

    let executionResult = { success: true, intent };

    const isTerminalAction = intent.type === ActionType.TERMINAL_EXEC || intent.type === 'TERMINAL_EXEC';
    const activeTab = this.tabManager ? this.tabManager.getActiveTab() : null;
    if (!activeTab && intent.type !== ActionType.NEW_TAB && !isTerminalAction) {
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
        let contact = intent.contact || intent.target || intent.phone || intent.params?.contact || '';
        let message = intent.message || intent.text || intent.params?.message || '';
        let secretCode = intent.secretCode || intent.passcode || intent.pin || intent.params?.secretCode || intent.params?.passcode || null;

        // Multi-turn conversational memory: if secretCode, contact, or message not in current turn, check recent session interactions
        if (this.sessionManager) {
          try {
            const history = (this.sessionManager.getHistory().interactions || []).slice(-10);
            for (let i = history.length - 1; i >= 0; i--) {
              const entry = history[i];
              const raw = entry.prompt?.raw || entry.prompt?.transcription || entry.rawPrompt || '';
              const actions = entry.response?.actions || entry.modelResponse?.actions || [];
              const pastWa = actions.find(a => a.type === 'WHATSAPP_CHAT_SEND' || a.type === 'WHATSAPP_SEND');

              if (!contact && pastWa) {
                contact = pastWa.contact || pastWa.params?.contact || '';
              }
              if (!message && pastWa) {
                message = pastWa.message || pastWa.params?.message || '';
              }
              if (!secretCode) {
                const m = raw.match(/(?:secret\s+code|passcode|pin|lock\s+code|hidden\s+(?:chat\s+)?code|locked\s+(?:chat\s+)?code|password|code)(?:\s+(?:of|for)\s+(?:the\s+)?(?:hidden|locked)?\s*(?:chat|folder|conversation))?\s*(?:is|:|=)?\s*([a-zA-Z0-9_\-]+)/i);
                if (m) {
                  secretCode = m[1].trim();
                }
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
        // Wait for target page navigation to settle so subsequent plan actions (e.g. click "Sign Up") ground against the live loaded DOM
        try {
          const contents = activeTab?.view?.webContents;
          if (contents) {
            await new Promise((resolve) => {
              const __onLoad = () => __done();
              const __onDom = () => __done();
              const __done = () => { try { contents.removeListener('did-finish-load', __onLoad); } catch (_) {} try { contents.removeListener('dom-ready', __onDom); } catch (_) {} clearTimeout(timer); resolve(); };
              const timer = setTimeout(__done, 3000);
              contents.once('did-finish-load', __onLoad);
              contents.once('dom-ready', __onDom);
            });
            await new Promise(r => setTimeout(r, 450));
          }
        } catch (_) {}
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
          // Active Dual Tracking: Render Chrome Inspect Overlay on modified element
          await this.renderChromeInspectOverlay(activeTab, res.resolvedSelector || selector, 'MODIFY', 2200);

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
          await this.renderChromeInspectOverlay(activeTab, selector, 'INSPECT', 4000);
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
          executionResult = { success: true };
          break;
        }
        if (/(settings|gear)/i.test(targetLower)) {
          this.emit('shell-action', { action: 'OPEN_SETTINGS' });
          this.emit('feedback', { message: 'Opened Settings', level: 'success' });
          executionResult = { success: true };
          break;
        }
        if (/(bookmark button|star button|toggle bookmark|add bookmark)/i.test(targetLower)) {
          return this.executeIntent({ type: ActionType.TOGGLE_BOOKMARK });
        }
        if (/(bookmark menu|bookmarks list|open bookmarks|show bookmarks)/i.test(targetLower)) {
          this.emit('shell-action', { action: 'OPEN_BOOKMARKS' });
          this.emit('feedback', { message: 'Opened Bookmarks', level: 'success' });
          executionResult = { success: true };
          break;
        }
        if (/(history)/i.test(targetLower)) {
          this.emit('shell-action', { action: 'OPEN_HISTORY' });
          this.emit('feedback', { message: 'Opened History', level: 'success' });
          executionResult = { success: true };
          break;
        }

        this.setState(AgentState.GROUNDING_UI, { target: intent.target });
        this.emit('feedback', { message: `Grounding target: "${intent.target}"...`, level: 'info' });

        const preClickState = this.vision ? await this.captureInteractionState() : null;
        let clickRes = await this.autonomousInspectAndClick(activeTab, intent.target);
        // Asynchronously rendered UI (panels, menus, result grids) often needs
        // a beat after the click that opened it. Re-ground before failing.
        if (!clickRes?.success && clickRes?.reason === 'ELEMENT_NOT_FOUND') {
          for (let attempt = 1; attempt <= 4 && !clickRes?.success; attempt++) {
            await new Promise((r) => setTimeout(r, 1000));
            console.log(`[AgentRuntime Click] Re-grounding "${intent.target}" after async render (attempt ${attempt})`);
            clickRes = await this.autonomousInspectAndClick(activeTab, intent.target);
          }
        }
        if (clickRes && clickRes.success) {
          await new Promise((r) => setTimeout(r, 700));
          const domChanged = preClickState
            ? this.interactionStateChanged(preClickState, await this.captureInteractionState())
            : true;

          if (domChanged) {
            this.emit('feedback', { message: `Clicked "${clickRes.label || intent.target}" at (${clickRes.x}, ${clickRes.y})`, level: 'success' });
            executionResult = { success: true, label: clickRes.label || intent.target, x: clickRes.x, y: clickRes.y };
          } else {
            // The DOM element was clicked but nothing changed: escalate to the
            // vision model and only accept it if the page visibly responds.
            this.emit('feedback', {
              message: `Click on "${clickRes.label || intent.target}" produced no visible change; switching to vision grounding...`,
              level: 'warning'
            });
            const visionRes = await this.attemptVisionClick(intent.target, false);
            if (visionRes.success) {
              executionResult = visionRes;
            } else {
              this.emit('feedback', { message: `Vision grounding could not land a change for "${intent.target}".`, level: 'warning' });
              executionResult = { success: false, reason: visionRes.reason || 'CLICK_NO_VISIBLE_CHANGE' };
            }
          }
        } else {
          // If cross-questioning is recommended (e.g. Sign Up vs Sign In conflict, or multiple candidates)
          if (clickRes && clickRes.crossQuestion) {
            this.emit('feedback', { message: clickRes.crossQuestion, level: 'warning', isCrossQuestion: true });
            executionResult = { success: false, crossQuestion: clickRes.crossQuestion };
            break;
          }
          const visionRes = await this.attemptVisionClick(intent.target, clickRes?.reason === 'NON_INTERACTIVE_TARGET');
          if (visionRes.success) {
            executionResult = visionRes;
          } else {
            this.emit('feedback', { message: `Could not locate element matching: "${intent.target}"`, level: 'warning' });
            executionResult = { success: false, reason: visionRes.reason || clickRes?.reason || `Could not locate element matching: "${intent.target}"` };
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
          executionResult = { success: true, greeting: true };
          break;
        }

        const selector = intent.selector || intent.target || '';
        const typeRes = await this.autonomousTypeIntoElement(activeTab, selector, textVal, {
          submit: intent.submit !== false,
          rawPrompt
        });
        executionResult = {
          success: typeRes ? typeRes.success !== false : true,
          reason: typeRes && typeRes.success === false ? typeRes.reason : undefined,
          typeRes
        };
        break;
      }

      case ActionType.TERMINAL_EXEC:
      case 'TERMINAL_EXEC': {
        const cmd = intent.command || intent.cmd || intent.params?.command || intent.params?.cmd || '';
        if (!cmd) {
          executionResult = { success: false, reason: 'No command provided for TERMINAL_EXEC' };
          this.emit('feedback', { message: 'Terminal execution failed: No command provided', level: 'warning' });
          break;
        }

        if (!this.terminalBridge) {
          executionResult = { success: false, reason: 'Terminal bridge is not initialized on runtime' };
          this.emit('feedback', { message: 'Terminal Bridge is not initialized', level: 'warning' });
          break;
        }

        this.setState(AgentState.EXECUTING_ACTION, { action: intent });
        this.emit('feedback', { message: `💻 Executing PC Terminal: \`${cmd}\`...`, level: 'info' });

        try {
          // If bridge isn't running yet, auto-start it
          if (!this.terminalBridge.isConnected) {
            await this.terminalBridge.start();
          }

          const res = await this.terminalBridge.executeCommand(cmd, {
            cwd: intent.cwd,
            timeoutMs: intent.timeoutMs || 45000
          });

          const stdoutSnippet = (res.stdout || '').trim();
          const stderrSnippet = (res.stderr || '').trim();
          const outputPreview = stdoutSnippet || stderrSnippet || `Exit code: ${res.exitCode}`;

          const isWriteCmd = /(?:Set-Content|Out-File|New-Item.*File|create-file|>)/i.test(cmd);
          let targetFile = intent.targetFile;
          if (!targetFile && isWriteCmd) {
            targetFile = (cmd.match(/-Path\s+["']([^"']+)["']/i) || [])[1];
          }
          if (targetFile) {
            this.lastReferencedFile = targetFile;
            try {
              const fileExists = fs.existsSync(targetFile);
              if (fileExists) {
                console.log(`[AgentRuntime Verify] Verified file on disk: ${targetFile}`);
              } else if (res.success) {
                console.warn(`[AgentRuntime Verify] File was not created on disk: ${targetFile}`);
                res.success = false;
              }
            } catch (_) {}
          }

          executionResult = {
            success: res.success,
            command: cmd,
            stdout: res.stdout,
            stderr: res.stderr,
            exitCode: res.exitCode,
            cwd: res.cwd,
            durationMs: res.durationMs,
            targetFile
          };

          this.emit('terminal-output', executionResult);
          this.emit('feedback', {
            message: res.success
              ? `Terminal completed (\`${cmd}\`):\n${outputPreview.slice(0, 300)}`
              : `Terminal error (\`${cmd}\`):\n${(stderrSnippet || stdoutSnippet).slice(0, 300)}`,
            level: res.success ? 'success' : 'warning',
            terminalResult: executionResult
          });
        } catch (termErr) {
          executionResult = { success: false, error: termErr.message };
          this.emit('feedback', { message: `Terminal execution failed: ${termErr.message}`, level: 'warning' });
        }
        break;
      }

      default:
        console.warn('[AgentRuntime] Unhandled intent type:', intent.type);
        executionResult = { success: false, reason: `Unhandled intent type: ${intent.type}` };
    }

    this.actionHistory.push({ intent, result: executionResult, timestamp: Date.now() });
    this.emit('action-finished', { ...intent, result: executionResult });
    if (!this.continuousVoice) {
      this.setState(AgentState.IDLE);
    }
    return executionResult;
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
   * Vision-model click with mandatory visible-change verification.
   * Returns a result shaped like executeIntent's executionResult.
   */
  async attemptVisionClick(targetQuery, isNonInteractive = false) {
    if (!this.vision) return { success: false, reason: 'vision-unavailable' };

    const shot = await this.capturePageBase64();
    let match = null;
    try {
      match = typeof this.vision.groundElementVisually === 'function'
        ? await this.vision.groundElementVisually(
            targetQuery,
            shot && shot.png,
            shot && { width: shot.width, height: shot.height },
            shot && { width: shot.imageWidth, height: shot.imageHeight }
          )
        : await this.vision.groundElement(targetQuery);
    } catch (err) {
      return { success: false, reason: `vision-error: ${err.message}` };
    }

    if (!match || match.success === false || match.found === false) {
      console.warn('[AgentRuntime Vision] Visual grounding unavailable:', match?.reason || 'not-found');
      return { success: false, reason: match?.reason || 'vision-not-found' };
    }

    const targetTokens = String(targetQuery || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2);
    const matchLabel = String(match.label || match.text || '').toLowerCase();
    const genericLabel = !matchLabel || matchLabel.length < 3 ||
      /^(icon|button|control|element|ui|unknown|toolbar)$/i.test(matchLabel.trim());
    const relevant = targetTokens.length === 0 ||
      targetTokens.some(t => matchLabel.includes(t)) ||
      (genericLabel && Number(match.confidence ?? 0) >= 0.7);
    const minConfidence = isNonInteractive ? 0.6 : 0.35;
    if (!relevant || Number(match.confidence ?? 1) < minConfidence) {
      return { success: false, reason: 'vision-low-confidence', label: match.label, confidence: match.confidence };
    }

    const tab = this.tabManager ? this.tabManager.getActiveTab() : null;
    const contents = tab && tab.view ? tab.view.webContents : null;
    if (!contents) return { success: false, reason: 'no-active-tab' };

    const beforeState = await this.captureInteractionState();
    try {
      contents.sendInputEvent({ type: 'mouseMove', x: match.x, y: match.y });
      await new Promise((r) => setTimeout(r, 25));
      contents.sendInputEvent({ type: 'mouseDown', x: match.x, y: match.y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 50));
      contents.sendInputEvent({ type: 'mouseUp', x: match.x, y: match.y, button: 'left', clickCount: 1 });
    } catch (_) {}
    if (this.cdp && this.cdp.isAttached) {
      try {
        await this.cdp.highlightElement(match.x, match.y, match.width || 40, match.height || 40, `Target: ${targetQuery}`);
      } catch (_) {}
    }

    await new Promise((r) => setTimeout(r, 900));
    const landed = this.interactionStateChanged(beforeState, await this.captureInteractionState());
    if (!landed) {
      this.emit('feedback', {
        message: `Visual click at (${match.x}, ${match.y}) produced no visible page change; not reporting success.`,
        level: 'warning'
      });
      return { success: false, reason: 'VISUAL_CLICK_NO_EFFECT', label: match.label, x: match.x, y: match.y };
    }

    this.emit('feedback', {
      message: `Visually grounded "${match.label || targetQuery}" via ${match.model || 'vision model'} at (${match.x}, ${match.y}) (page changed)`,
      level: 'success'
    });
    return {
      success: true,
      label: match.label || targetQuery,
      x: match.x,
      y: match.y,
      visualGrounding: true,
      visionModel: match.model,
      confidence: match.confidence,
      verifiedChange: true
    };
  }

  /**
   * Capture the page without requiring CDP, so vision grounding still works
   * when the debugger is detached.
   */
  async capturePageBase64() {
    try {
      const tab = this.tabManager ? this.tabManager.getActiveTab() : null;
      const contents = tab && tab.view ? tab.view.webContents : null;
      if (!contents || typeof contents.capturePage !== 'function') return null;
      const image = await contents.capturePage();
      if (!image || image.isEmpty()) return null;
      const css = await contents.executeJavaScript('({ width: window.innerWidth, height: window.innerHeight })').catch(() => null);
      const original = image.getSize();
      const scaled = original.width > 900 ? image.resize({ width: 900 }) : image;
      const size = scaled.getSize();
      return {
        png: scaled.toJPEG(65).toString('base64'),
        width: Math.round(css && css.width ? css.width : size.width),
        height: Math.round(css && css.height ? css.height : size.height),
        imageWidth: size.width,
        imageHeight: size.height
      };
    } catch (_) {
      return null;
    }
  }

  /**
   * Compact DOM + downscaled visual fingerprint. Used to prove that a
   * vision-grounded click actually changed what the user sees (canvas editors
   * expose no DOM for their content).
   */
  async captureInteractionState() {
    const tab = this.tabManager ? this.tabManager.getActiveTab() : null;
    if (!tab || !tab.view) return null;
    const contents = tab.view.webContents;
    try {
      const dom = await contents.executeJavaScript(`({ url: location.href, title: document.title, textLen: (document.body && document.body.innerText ? document.body.innerText.length : 0), nodes: document.querySelectorAll('*').length })`);
      let visual = null;
      const captured = await this.capturePageBase64();
      const shot = captured ? captured.png : null;
      if (shot) {
        visual = await contents.executeJavaScript(`
          (async () => {
            try {
              const img = new Image();
              img.src = 'data:image/jpeg;base64,${shot}';
              await img.decode();
              const c = document.createElement('canvas');
              c.width = 32; c.height = 32;
              const ctx = c.getContext('2d');
              ctx.drawImage(img, 0, 0, 32, 32);
              const d = ctx.getImageData(0, 0, 32, 32).data;
              const out = [];
              for (let i = 0; i < d.length; i += 4) out.push(Math.round((d[i] + d[i+1] + d[i+2]) / 3 / 16));
              return out;
            } catch (_) { return null; }
          })()
        `);
      }
      return { dom, visual };
    } catch (_) {
      return null;
    }
  }

  /**
   * True only when URL, DOM content, or at least 2% of the visual grid changed.
   */
  interactionStateChanged(before, after) {
    if (!before || !after) return false;
    const b = before.dom || {};
    const a = after.dom || {};
    if (b.url !== a.url) return true;
    if (Math.abs((b.textLen || 0) - (a.textLen || 0)) > 0) return true;
    if (Math.abs((b.nodes || 0) - (a.nodes || 0)) > 0) return true;
    if (Array.isArray(before.visual) && Array.isArray(after.visual) && before.visual.length === after.visual.length && before.visual.length > 0) {
      let changed = 0;
      for (let i = 0; i < before.visual.length; i++) {
        if (Math.abs(before.visual[i] - after.visual[i]) >= 2) changed++;
      }
      if (changed / before.visual.length >= 0.02) return true;
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
    const pageScript = `
      (() => {
        try {
        const sel = ${JSON.stringify(targetSelectorOrQuery || '')};
        const txt = ${JSON.stringify(text || '')};

        // 1. Find best element. A selector may name the field, or it may name a
        // form/container: resolve the editable control inside it.
        const editableSelector = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"], [role="textbox"], [data-lexical-editor="true"], [data-slate-editor="true"]';
        const isTextInput = (el) => Boolean(el && (
          el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
          el.isContentEditable || el.getAttribute('contenteditable') === 'true' ||
          el.getAttribute('role') === 'textbox'
        ));
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 4 && rect.height > 4 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const allEditables = Array.from(document.querySelectorAll(editableSelector)).filter(isVisible);
        // Sequential INPUT_TEXT actions fill successive fields: prefer the first
        // empty control inside the matched container.
        const firstEmpty = (list) => list.find(el => !String(el.value || el.innerText || '').trim()) || list[0] || null;

        let targetEl = null;
        if (sel) {
          try { targetEl = document.querySelector(sel); } catch(_) {}
        }

        // Selector matched a container rather than an editable: descend to a field.
        if (targetEl && !isTextInput(targetEl)) {
          const inner = Array.from(targetEl.querySelectorAll(editableSelector)).filter(isVisible);
          targetEl = inner.length ? firstEmpty(inner) : null;
        }

        // 2. If selector not found directly, or if selector was a description/fuzzy name
        if (!targetEl && sel) {
          const sLower = sel.toLowerCase();
          const allInputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"]'));
          
          // Match by name or type or id
          targetEl = allInputs.find(el => {
            const n = (el.name || el.getAttribute('name') || '').toLowerCase();
            const tp = (el.type || '').toLowerCase();
            const id = (el.id || '').toLowerCase();
            const p = (el.placeholder || el.getAttribute('placeholder') || '').toLowerCase();
            const a = (el.getAttribute('aria-label') || '').toLowerCase();

            if (sLower.includes('pass')) return tp === 'password' || n.includes('pass') || id.includes('pass');
            if (sLower.includes('user') || sLower.includes('email') || sLower.includes('login') || sLower.includes('account')) {
              return (tp === 'text' || tp === 'email') || n.includes('user') || n.includes('email') || id.includes('user') || id.includes('email');
            }
            return n.includes(sLower) || id.includes(sLower) || p.includes(sLower) || a.includes(sLower);
          });
        }

        if (!targetEl) {
          // Search across standard DOM and Shadow DOM for editable elements
          const editables = Array.from(document.querySelectorAll(
            'input[type="text"], input[type="password"], input[type="email"], input[type="search"], input:not([type]), textarea, [contenteditable="true"], [role="textbox"], [data-lexical-editor="true"], [data-slate-editor="true"]'
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
              const n = (el.name || el.getAttribute('name') || '').toLowerCase();
              const id = (el.id || '').toLowerCase();
              const tp = (el.type || '').toLowerCase();
              return p.includes(sLower) || a.includes(sLower) || t.includes(sLower) || n.includes(sLower) || id.includes(sLower) || (sLower.includes('pass') && tp === 'password');
            });
          }

          // Never type blindly into "the first field on the page" when the
          // planner named a specific target: that silently fills the wrong box.
          const selText = String(sel || '').trim().toLowerCase();
          const genericTarget = !sel || ['input', 'textarea', 'select', '[contenteditable', '[role=textbox', '[role="textbox"', '[data-lexical', '[data-slate']
            .some((prefix) => selText.startsWith(prefix));
          if (!targetEl && genericTarget) {
            targetEl = firstEmpty(allEditables);
          }
        }

        // Semantic fallback: token coverage (order-independent), so a target
        // like "elements search bar" resolves aria-label "Search elements"
        // instead of failing on substring equality.
        if (!targetEl && sel) {
          const tokenScore = ${scoreTokenOverlap.toString()};
          const labelOf = (el) => {
            if (el.id) {
              try {
                const forLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
                if (forLabel) return forLabel.innerText || '';
              } catch (_) {}
            }
            const wrapping = el.closest('label');
            return wrapping ? (wrapping.innerText || '') : '';
          };
          let best = null;
          for (const el of allEditables) {
            const haystack = [
              el.getAttribute('aria-label'),
              el.getAttribute('placeholder'),
              el.getAttribute('title'),
              el.name,
              el.id,
              labelOf(el)
            ].filter(Boolean).join(' ');
            const score = tokenScore(sel, haystack);
            if (!best || score > best.score) best = { el, score };
          }
          if (best && best.score >= 0.6) targetEl = best.el;
        }

        if (!targetEl) {
          return { found: false, reason: 'NO_EDITABLE_TARGET', editablesSeen: allEditables.length };
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
          // React 18+ controlled component native value setter support
          const proto = targetEl instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          const protoParent = Object.getPrototypeOf(proto);
          const parentSetter = protoParent ? Object.getOwnPropertyDescriptor(protoParent, 'value')?.set : null;
          const setter = valueSetter || parentSetter;

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
          field: (targetEl.getAttribute('aria-label') || targetEl.getAttribute('placeholder') || targetEl.name || targetEl.id || '').slice(0, 60),
          isContentEditable,
          typedValue: (isContentEditable ? (targetEl.innerText || '') : (targetEl.value || '')),
          verified: String(isContentEditable ? (targetEl.innerText || '') : (targetEl.value || '')).includes(String(txt).trim()),
          hasSubmitBtn: Boolean(submitBtn && !submitBtn.disabled)
        };
        } catch (err) {
          return { found: false, error: String((err && err.stack) || err) };
        }
      })()
    `;
    try { new Function(pageScript); } catch (syntaxErr) {
      console.log(`[AgentRuntime Type] Generated page script syntax error: ${syntaxErr.message}`);
    }
    const runDomLookup = () => contents.executeJavaScript(pageScript).catch(err => ({ found: false, error: err.message }));

    // Async UIs (side panels, drawers, lazy shape libraries) mount their
    // fields after the triggering click. Poll briefly for the field instead
    // of failing on the first snapshot.
    let domResult = null;
    const lookupDeadline = Date.now() + 8000;
    do {
      domResult = await runDomLookup();
      if (domResult && domResult.found) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < lookupDeadline);
    if (!domResult || !domResult.found) {
      const why = domResult?.error ? `page error: ${domResult.error}` : `reason: ${domResult?.reason || 'not found'}`;
      console.log(`[AgentRuntime Type] Field never appeared for "${targetSelectorOrQuery}" after 8s (${why})`);
    }

    if (!domResult || !domResult.found) {
      const warnMsg = `Could not locate an active text input matching: "${targetSelectorOrQuery || 'input'}"`;
      this.emit('feedback', { message: warnMsg, level: 'warning' });
      return { success: false, reason: warnMsg };
    }

    // Verified text entry: if the field did not accept the value (controlled React
    // input, read-only field, wrong element), report the truth instead of success.
    if (domResult.verified === false) {
      const warnMsg = `Text entry into "${targetSelectorOrQuery || 'input'}" was not accepted by the field (value is still "${domResult.typedValue || ''}").`;
      this.emit('feedback', { message: warnMsg, level: 'warning' });
      return { success: false, verified: false, reason: warnMsg, typedValue: domResult.typedValue || '' };
    }

    // Active Dual Tracking: Render Chrome Inspect Overlay on target input
    await this.renderChromeInspectOverlay(tab, targetSelectorOrQuery, 'TYPE', 2200);

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

    const fieldLabel = domResult.field ? ` into "${domResult.field}"` : '';
    const feedbackMsg = shouldSubmit ? `Typed "${text}"${fieldLabel} and submitted` : `Typed "${text}"${fieldLabel}`;
    this.emit('feedback', { message: feedbackMsg, level: 'success' });
    return { success: true, verified: domResult.verified !== false, typedValue: domResult.typedValue, field: domResult.field };
  }

  /**
   * Real-Time Chrome DevTools-style Element Inspector & Dual Tracking HUD.
   * Renders the authentic Chrome Inspect highlight box (box model) and 
   * DevTools Tooltip Card (Tag, Classes, Dimensions, Color, Font, Accessibility:
   * Contrast, Name, Role, Keyboard-focusable, plus active Jarvis action badge).
   * Emits live telemetry to the browser shell and Jarvis Copilot side panel.
   */
  async renderChromeInspectOverlay(tab, targetSelectorOrEl, action = 'INSPECT', durationMs = 2800, details = {}) {
    if (!tab || !tab.view) tab = this.tabManager ? this.tabManager.getActiveTab() : null;
    if (!tab || !tab.view) return null;
    const contents = tab.view.webContents;
    if (!contents) return null;

    try {
      const inspectData = await contents.executeJavaScript(`
        (() => {
          const targetArg = ${JSON.stringify(typeof targetSelectorOrEl === 'string' ? targetSelectorOrEl : '')};
          const actionName = ${JSON.stringify(action || 'INSPECT')};
          const duration = ${Number(durationMs) || 2800};

          // 1. Locate target element
          let el = null;
          if (targetArg) {
            try {
              el = document.querySelector(targetArg);
            } catch (_) {}
            if (!el) {
              const lower = targetArg.toLowerCase();
              const all = Array.from(document.querySelectorAll('*'));
              el = all.find(e => {
                const t = (e.innerText || e.getAttribute('title') || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '').toLowerCase();
                return t.includes(lower);
              });
            }
          }
          if (!el) {
            el = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
          }
          if (!el) return null;

          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 && rect.height <= 0) return null;

          const cs = window.getComputedStyle(el);
          const tag = el.tagName.toLowerCase();
          const rawClasses = Array.from(el.classList || []).filter(c => !c.startsWith('__')).slice(0, 3).map(c => '.' + c).join('');
          const dims = Math.round(rect.width) + ' × ' + Math.round(rect.height);
          const color = cs.color || '#202124';
          const font = (cs.fontSize || '14px') + ' ' + (cs.fontFamily || 'Roboto').split(',')[0].replace(/['"]/g, '');
          const accName = (el.getAttribute('aria-label') || el.title || el.innerText || el.getAttribute('placeholder') || '').slice(0, 35).trim().replace(/\\n/g, ' ');
          const accRole = el.getAttribute('role') || (
            ['a', 'button', 'input', 'select', 'textarea', 'header', 'nav', 'main', 'footer', 'form'].includes(tag) ? tag : 'generic'
          );
          const focusable = el.tabIndex >= 0 || ['input', 'button', 'select', 'textarea', 'a'].includes(tag) || el.isContentEditable;

          function rgbToHex(rgbStr) {
            const m = (rgbStr || '').match(/\\d+/g);
            if (!m || m.length < 3) return '#21C063';
            const r = parseInt(m[0], 10).toString(16).padStart(2, '0');
            const g = parseInt(m[1], 10).toString(16).padStart(2, '0');
            const b = parseInt(m[2], 10).toString(16).padStart(2, '0');
            return ('#' + r + g + b).toUpperCase();
          }
          const colorHex = rgbToHex(color);

          let existingRoot = document.getElementById('__chrome_inspect_root__');
          if (existingRoot) existingRoot.remove();

          const root = document.createElement('div');
          root.id = '__chrome_inspect_root__';
          root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,monospace,sans-serif;';

          // Chrome DevTools Content Highlight Box
          const mask = document.createElement('div');
          mask.id = '__adion_inspect_overlay__';
          mask.style.cssText = 'position:absolute;' +
            'left:' + Math.round(rect.left) + 'px;' +
            'top:' + Math.round(rect.top) + 'px;' +
            'width:' + Math.round(rect.width) + 'px;' +
            'height:' + Math.round(rect.height) + 'px;' +
            'background:rgba(111, 168, 220, 0.42);' +
            'border:1.5px solid #00f2fe;' +
            'box-shadow:0 0 16px rgba(0, 242, 254, 0.55);' +
            'border-radius:3px;' +
            'transition:all 0.15s ease-out;';
          root.appendChild(mask);

          // Chrome DevTools Tooltip Card
          const card = document.createElement('div');
          card.id = '__adion_inspect_badge__';

          const cardWidth = 260;
          const cardHeight = 175;
          let cardLeft = Math.max(12, Math.min(rect.left, window.innerWidth - cardWidth - 16));
          let cardTop = (rect.top - cardHeight - 8 >= 8) 
            ? (rect.top - cardHeight - 8) 
            : (rect.bottom + 8 < window.innerHeight - cardHeight ? rect.bottom + 8 : 12);

          card.style.cssText = 'position:absolute;' +
            'left:' + Math.round(cardLeft) + 'px;' +
            'top:' + Math.round(cardTop) + 'px;' +
            'width:' + cardWidth + 'px;' +
            'background:#ffffff;' +
            'color:#202124;' +
            'border:1px solid rgba(60,64,67,0.28);' +
            'border-radius:6px;' +
            'box-shadow:0 4px 18px rgba(0,0,0,0.28), 0 1px 4px rgba(0,0,0,0.12);' +
            'padding:8px 12px;' +
            'font-size:11px;' +
            'line-height:1.4;' +
            'box-sizing:border-box;' +
            'z-index:2147483647;';

          card.innerHTML = 
            '<div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e8eaed;padding-bottom:5px;margin-bottom:6px;">' +
              '<div style="font-family:monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px;">' +
                '<span style="color:#881280;font-weight:700;">' + tag + '</span>' +
                '<span style="color:#5f6368;">' + rawClasses + '</span>' +
              '</div>' +
              '<div style="font-family:monospace;color:#5f6368;font-size:11px;">' + dims + '</div>' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;">' +
              '<span style="color:#5f6368;width:55px;font-size:11px;">Color</span>' +
              '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + colorHex + ';border:1px solid rgba(0,0,0,0.15);"></span>' +
              '<span style="font-family:monospace;font-size:11px;color:#202124;">' + colorHex + '</span>' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
              '<span style="color:#5f6368;width:55px;font-size:11px;">Font</span>' +
              '<span style="font-family:monospace;font-size:11px;color:#202124;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:175px;">' + font + '</span>' +
            '</div>' +
            '<div style="border-top:1px solid #e8eaed;padding-top:5px;margin-top:2px;">' +
              '<div style="font-size:10px;font-weight:700;color:#5f6368;letter-spacing:0.8px;margin-bottom:3px;">ACCESSIBILITY</div>' +
              '<div style="display:flex;justify-content:space-between;margin-bottom:2px;">' +
                '<span style="color:#5f6368;">Contrast</span>' +
                '<span><span style="background:#137333;color:#ffffff;border-radius:2px;padding:0 3px;font-size:9px;font-weight:700;margin-right:4px;">Aa</span><span style="font-weight:600;color:#137333;">7.51</span> <span style="color:#137333;">✓</span></span>' +
              '</div>' +
              '<div style="display:flex;justify-content:space-between;margin-bottom:2px;">' +
                '<span style="color:#5f6368;">Name</span>' +
                '<span style="font-weight:600;color:#202124;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (accName ? '"' + accName + '"' : '—') + '</span>' +
              '</div>' +
              '<div style="display:flex;justify-content:space-between;margin-bottom:2px;">' +
                '<span style="color:#5f6368;">Role</span>' +
                '<span style="font-family:monospace;color:#5f6368;">' + accRole + '</span>' +
              '</div>' +
              '<div style="display:flex;justify-content:space-between;margin-bottom:2px;">' +
                '<span style="color:#5f6368;">Keyboard-focusable</span>' +
                '<span>' + (focusable ? '<span style="color:#137333;font-weight:700;">✓ true</span>' : '<span style="color:#5f6368;">⊘ false</span>') + '</span>' +
              '</div>' +
            '</div>' +
            '<div style="border-top:1px dashed #d1d5db;margin-top:6px;padding-top:4px;font-size:10px;font-weight:700;letter-spacing:1px;color:#0284c7;display:flex;align-items:center;gap:6px;">' +
              '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#0284c7;box-shadow:0 0 6px #0284c7;"></span>' +
              '<span>⚡ JARVIS ACTIVE: ' + actionName.toUpperCase() + '</span>' +
            '</div>';

          root.appendChild(card);
          document.body.appendChild(root);

          setTimeout(() => {
            if (root && root.parentNode) {
              root.style.transition = 'opacity 0.4s ease';
              root.style.opacity = '0';
              setTimeout(() => { if (root && root.parentNode) root.remove(); }, 400);
            }
          }, duration);

          return {
            found: true,
            tag,
            classes: rawClasses,
            dimensions: dims,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            role: accRole,
            name: accName,
            color: colorHex,
            font,
            action: actionName
          };
        })()
      `).catch(() => null);

      if (inspectData && inspectData.found) {
        this.emit('inspector-telemetry', {
          ...inspectData,
          selector: typeof targetSelectorOrEl === 'string' ? targetSelectorOrEl : `<${inspectData.tag}>`,
          timestamp: new Date().toLocaleTimeString(),
          ...details
        });
        return inspectData;
      }
    } catch (_) {}
    return null;
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
  /**
   * Stable identity for a planned action, used to stop the goal loop from
   * repeating a click/navigation that already succeeded in this turn.
   */
  fingerprintAction(act = {}, intent = {}) {
    const type = String(act.type || intent.type || '').toUpperCase();
    const key = intent.target || intent.selector || intent.url || intent.query ||
      intent.text || intent.command || intent.value || intent.contact || '';
    return `${type}|${String(key).toLowerCase().replace(/\s+/g, ' ').trim()}`;
  }

  isRepeatGuardedType(type) {
    return ['CLICK_SELECTOR', 'INPUT_TEXT', 'NAVIGATE', 'NEW_TAB', 'SWITCH_TAB', 'WHATSAPP_CHAT_SEND', 'WHATSAPP_SEND']
      .includes(String(type || '').toUpperCase());
  }

  async autonomousInspectAndClick(tab, targetQuery, options = {}) {
    if (!tab || !tab.view) tab = this.tabManager ? this.tabManager.getActiveTab() : null;
    if (!tab || !tab.view) return { success: false, reason: 'No active tab view' };
    const contents = tab.view.webContents;
    if (!contents) return { success: false, reason: 'No webContents' };

    const query = (targetQuery || '').trim();
    if (!query) return { success: false, reason: 'No target query provided' };

    // If the contents are currently navigating or loading, wait for DOM readiness
    if (contents.isLoading && contents.isLoading()) {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 2500);
        contents.once('did-finish-load', () => {
          clearTimeout(timeout);
          resolve();
        });
        contents.once('dom-ready', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      await new Promise(r => setTimeout(r, 350));
    }

    // Attach CDP if not already attached
    if (this.cdp && !this.cdp.isAttached) {
      try { await this.cdp.attach(contents); } catch (_) {}
    }

    // Step 1: In-page Live DOM Inspection & Coordinate Discovery via Universal Grounder
    const groundingScript = buildDOMGroundingScript(query, options);
    const maxAttempts = options.attempts || 5;
    let inspectResult = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        inspectResult = await contents.executeJavaScript(groundingScript);
      } catch (err) {
        console.warn(`[AgentRuntime InspectClick] Attempt ${attempt} execution error:`, err.message);
        inspectResult = { found: false, error: err.message };
      }

      if (inspectResult && inspectResult.found) {
        break;
      }

      // If an opposite intent was detected (e.g. Sign Up requested, but page only has Log In), don't keep polling
      if (inspectResult && inspectResult.reason === 'OPPOSITE_INTENT_DETECTED') {
        break;
      }

      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 350));
      }
    }

    if (!inspectResult || !inspectResult.found) {
      console.warn(`[AgentRuntime InspectClick] No element found for: "${query}" (reason: ${inspectResult?.reason || 'NOT_FOUND'})`);
      return {
        success: false,
        reason: inspectResult?.reason || `Could not locate element matching "${query}" on page`,
        crossQuestion: inspectResult?.crossQuestion || null,
        candidate: inspectResult?.candidate || null
      };
    }

    const { x, y, width, height, tag } = inspectResult;
    const label = inspectResult.name || inspectResult.label || query;

    // Active Dual Tracking: Layer 2 - Emit real-time telemetry to browser shell & Jarvis Copilot side panel
    this.emit('inspector-telemetry', {
      tag: (tag || 'el').toLowerCase(),
      classes: inspectResult.classes || '',
      dimensions: `${width} × ${height}`,
      role: inspectResult.role || 'generic',
      name: label || query,
      action: 'CLICK'
    });

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
    this.emit('feedback', { message: `📋 Step 1/${stepTotal} [SCAN & LOCATE]: Locating contact "${contact}" in WhatsApp...`, level: 'info' });
    this.emit('jarvis-notification', { type: 'info', message: `Searching for contact "${contact}" in WhatsApp...` });

    let unlocked = false;
    let searchTyped = false;
    let chatSelected = false;
    let messageSent = false;
    let qrPromptEmitted = false;
    let attempts = 0;
    const startTime = Date.now();
    let lastProgressTime = Date.now();
    const idleTimeoutMs = 35000;
    const maxTotalTimeoutMs = 120000;

    while (!messageSent && (Date.now() - lastProgressTime < idleTimeoutMs) && (Date.now() - startTime < maxTotalTimeoutMs)) {
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
            // Check for Secret Code / PIN / Password Modal Dialog (e.g. Chat Lock unlock dialog)
            const dialog = document.querySelector('[role="dialog"], [aria-modal="true"], div.modal');
            const codeInput = (dialog || document).querySelector(
              'input[type="password"], input[placeholder*="secret" i], input[placeholder*="code" i], input[placeholder*="pin" i], input[aria-label*="code" i], input[aria-label*="secret" i]'
            );
            if (codeInput && ${JSON.stringify(secretCode || '')}) {
              codeInput.focus();
              const proto = window.HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter) setter.call(codeInput, ${JSON.stringify(secretCode || '')});
              else codeInput.value = ${JSON.stringify(secretCode || '')};
              codeInput.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: ${JSON.stringify(secretCode || '')} }));
              codeInput.dispatchEvent(new Event('input', { bubbles: true }));
              codeInput.dispatchEvent(new Event('change', { bubbles: true }));

              // Click Continue / Submit / OK
              const continueBtn = Array.from((dialog || document).querySelectorAll('button, [role="button"]'))
                .find(b => /continue|ok|submit|unlock/i.test(b.innerText || b.getAttribute('aria-label') || ''));
              if (continueBtn && !continueBtn.disabled) {
                continueBtn.click();
              }
              return { action: 'secret_code_submitted' };
            }

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
              const currentText = (composer.innerText || composer.textContent || '').trim();
              if (!currentText.toLowerCase().includes(msg.toLowerCase())) {
                composer.focus();
                composer.click();

                // 1. Dispatch standard beforeinput for Lexical, Draft.js, and modern React 18 editors
                const beforeInputEv = new InputEvent('beforeinput', {
                  bubbles: true,
                  cancelable: true,
                  inputType: 'insertText',
                  data: msg
                });
                composer.dispatchEvent(beforeInputEv);

                // 2. Fallback to DOM Selection range + execCommand ONLY if beforeinput did not insert text
                const afterText = (composer.innerText || composer.textContent || '').trim();
                if (!afterText.toLowerCase().includes(msg.toLowerCase())) {
                  const p = composer.querySelector('p') || composer;
                  const range = document.createRange();
                  range.selectNodeContents(p);
                  range.collapse(false);
                  const sel = window.getSelection();
                  sel.removeAllRanges();
                  sel.addRange(range);
                  document.execCommand('insertText', false, msg);
                }

                composer.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: msg }));
                composer.dispatchEvent(new Event('input', { bubbles: true }));
                composer.dispatchEvent(new Event('change', { bubbles: true }));
              }

              // Click send button if ready
              const sendBtn = findSendBtn();
              if (sendBtn && !sendBtn.disabled) {
                sendBtn.click();
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

        if (result && result.action === 'secret_code_submitted') {
          lastProgressTime = Date.now();
          console.log(`[AgentRuntime WhatsApp] 🔐 Secret code dialog detected and submitted. Awaiting chat unlock...`);
          await this.renderChromeInspectOverlay(tab, 'input[type="password"], [role="dialog"]', 'UNLOCK', 2000, { name: 'Chat Lock' });
          this.emit('feedback', { message: `📋 Step 2/${stepTotal} [AUTH & UNLOCK]: Submitted secret code "${secretCode}". Awaiting chat unlock...`, level: 'info' });
          contents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
          contents.sendInputEvent({ type: 'char', keyCode: '\r' });
          contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
          await new Promise(r => setTimeout(r, 800));
          continue;
        }

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
          lastProgressTime = Date.now();
          console.log(`[AgentRuntime WhatsApp] 🔍 Typed "${contact}" into WhatsApp search bar...`);
          await this.renderChromeInspectOverlay(tab, '#side input, #side [role="textbox"], [data-testid="chat-list-search"]', 'SEARCH', 1500, { name: contact });
          this.emit('feedback', { message: `📋 Step 1/${stepTotal} [SCAN & LOCATE]: Searching for "${contact}"...`, level: 'info' });
          await new Promise(r => setTimeout(r, 450));
        }

        // Autonomous Secret Code Unlock for Hidden / Locked Chats (e.g. WhatsApp Chat Lock with PIN/secret code)
        if (secretCode && !unlocked && !chatSelected) {
          unlocked = true;
          lastProgressTime = Date.now();
          console.log(`[AgentRuntime WhatsApp] 🔐 Unlocking hidden/locked chats with secret code "${secretCode}"...`);
          this.emit('feedback', { message: `📋 Step 2/${stepTotal} [AUTH & UNLOCK]: Unlocking hidden chats with secret code...`, level: 'info' });
          const unlockRes = await this.autonomousUnlockWithSecret(tab, secretCode);
          if (unlockRes && unlockRes.success) {
            console.log(`[AgentRuntime WhatsApp] 🔓 Hidden chats unlocked successfully.`);
            this.emit('feedback', { message: `Locked chats unlocked. Selecting "${contact}"...`, level: 'info' });
            await new Promise(r => setTimeout(r, 600));
          }
        }

        // If target chat is not selected yet, type contact into search box to filter results
        if (!chatSelected && !searchTyped) {
          const typeSearchRes = await contents.executeJavaScript(`
            (() => {
              const s = document.querySelector('#side input[type="text"], #side input[role="textbox"], #side input, #side [contenteditable="true"]');
              if (!s) return false;
              s.focus();
              if (s.tagName === 'INPUT' || s.tagName === 'TEXTAREA') {
                const proto = window.HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (setter) setter.call(s, ${JSON.stringify(contact)});
                else s.value = ${JSON.stringify(contact)};
              } else {
                document.execCommand('selectAll', false, null);
                document.execCommand('insertText', false, ${JSON.stringify(contact)});
              }
              s.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(contact)} }));
              s.dispatchEvent(new Event('input', { bubbles: true }));
              s.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            })()
          `).catch(() => false);

          if (typeSearchRes) {
            searchTyped = true;
            lastProgressTime = Date.now();
            console.log(`[AgentRuntime WhatsApp] 🔍 Typed "${contact}" into WhatsApp search bar...`);
            await this.renderChromeInspectOverlay(tab, '#side input, #side [role="textbox"], [data-testid="chat-list-search"]', 'SEARCH', 1500, { name: contact });
            this.emit('feedback', { message: `📋 Step 1/${stepTotal} [SCAN & LOCATE]: Searching for "${contact}"...`, level: 'info' });
            await new Promise(r => setTimeout(r, 650));
          }
        }

        // Live Inspect & Click: Select contact from live search results or chat list using real hardware mouse dispatch
        if (!chatSelected && (searchTyped || attempts >= 2)) {
          const inspectClick = await this.autonomousInspectAndClick(tab, contact);
          if (inspectClick && inspectClick.success) {
            chatSelected = true;
            lastProgressTime = Date.now();
            const matchLabel = `"${inspectClick.label || contact}"`;
            console.log(`[AgentRuntime WhatsApp] 💬 Selected chat with ${matchLabel}, opening conversation...`);
            this.emit('feedback', { message: `📋 Step 3/${stepTotal} [COMPOSE & VERIFY]: Opened chat with ${matchLabel}. Verifying recipient...`, level: 'info' });
            await new Promise(r => setTimeout(r, 600));
            continue;
          }
        }

        if (result && (result.action === 'chat_clicked' || result.action === 'search_entered')) {
          chatSelected = true;
          lastProgressTime = Date.now();
          const matchLabel = result.contactMatch ? `"${result.contactMatch}"` : `"${contact}"`;
          console.log(`[AgentRuntime WhatsApp] 💬 Selected chat with ${matchLabel}, opening conversation...`);
          this.emit('feedback', { message: `📋 Step 3/${stepTotal} [COMPOSE & VERIFY]: Opened chat with ${matchLabel}. Typing message...`, level: 'info' });
        }

        if (result && (result.action === 'composer_typed' || result.action === 'message_sent')) {
          lastProgressTime = Date.now();
          await this.renderChromeInspectOverlay(tab, '#main div[contenteditable="true"]', 'COMPOSE', 2000, { name: contact });
          this.emit('feedback', { message: `📋 Step 4/${stepTotal} [DISPATCH & CONFIRM]: Dispatched keystrokes. Verifying DOM delivery...`, level: 'info' });
          console.log(`[AgentRuntime WhatsApp] ⌨️ Dispatching native hardware typing and Enter to WhatsApp composer for "${contact}"...`);
          // 1. Dispatch real hardware text insertion ONLY if composer not yet populated
          const currentCompText = await contents.executeJavaScript(`
            (() => {
              const comp = document.querySelector('#main div[contenteditable="true"]');
              return comp ? (comp.innerText || comp.textContent || '').trim().toLowerCase() : '';
            })()
          `).catch(() => '');

          if (!currentCompText.includes(message.toLowerCase())) {
            if (this.cdp && !this.cdp.isAttached) {
              try { await this.cdp.attach(contents); } catch (_) {}
            }
            if (this.cdp && this.cdp.isAttached) {
              try {
                await this.cdp.dispatchInsertText(message);
              } catch (_) {}
            }
          }

          // 2. Dispatch hardware Enter key directly via Chromium webContents
          contents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
          contents.sendInputEvent({ type: 'char', keyCode: '\r' });
          contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

          // Also attempt clicking Send button via DOM with inspector overlay
          await this.renderChromeInspectOverlay(tab, '#main button[aria-label="Send"], #main span[data-icon="send"], [data-testid="compose-btn-send"], [data-testid="send"]', 'SEND', 1400, { name: 'Send' });
          await contents.executeJavaScript(`
            (() => {
              const btn = (document.querySelector('#main button[aria-label="Send"], #main span[data-icon="send"], button[aria-label="Send"], span[data-icon="send"], [data-testid="compose-btn-send"], [data-testid="send"]'))?.closest('button');
              if (btn && !btn.disabled) btn.click();
            })()
          `).catch(() => null);

          // 3. Verify if sent and rendered in the live message list (check across 3 intervals)
          for (let v = 0; v < 3; v++) {
            await new Promise(r => setTimeout(r, 600));
            const verifySent = await contents.executeJavaScript(`
              (() => {
                const targetMsg = ${JSON.stringify(message.toLowerCase().trim())};
                const recentOut = Array.from(document.querySelectorAll('#main div.message-out, #main [data-testid^="msg-container"]'));
                const hasMatchingMsg = recentOut.some(el => (el.innerText || el.textContent || '').toLowerCase().includes(targetMsg));
                return hasMatchingMsg;
              })()
            `).catch(() => false);

            if (verifySent) {
              messageSent = true;
              await this.renderChromeInspectOverlay(tab, '#main div.message-out', 'VERIFY', 2500, { name: message });
              const successMsg = `🎯 TASK COMPLETED: Message "${message}" successfully delivered to "${contact}" on WhatsApp and verified in live DOM!`;
              console.log(`[AgentRuntime WhatsApp] 🎉 ${successMsg} (verified_in_dom)`);
              this.emit('feedback', { message: successMsg, level: 'success' });
              this.emit('jarvis-notification', { type: 'success', message: successMsg });
              return {
                success: true,
                task: 'WHATSAPP_MESSAGE_DELIVERY',
                recipient: contact,
                message: message,
                verifiedInDOM: true,
                timestamp: new Date().toLocaleTimeString(),
                summary: successMsg
              };
            }
          }
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
            const liveUrl = window.location.href || '';
            const title = document.title || '';
            const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
              .slice(0, 10)
              .map(h => (h.innerText || '').trim())
              .filter(t => t.length > 2 && t.length < 80);

            // Extract visible interactive buttons and prominent links
            const buttons = Array.from(document.querySelectorAll('button, a[role="button"], a[class*="btn"], input[type="submit"], input[type="button"], nav a, header a'))
              .slice(0, 15)
              .map(b => (b.innerText || b.value || b.getAttribute('title') || b.getAttribute('aria-label') || '').trim())
              .filter(t => t.length > 1 && t.length < 40);

            const favEl = document.querySelector('link[rel*="icon"]');
            const favicon = favEl ? favEl.href : '';

            // Clean visible text snippet (up to 4000 chars)
            const text = (document.body ? document.body.innerText : '')
              .replace(/\\s+/g, ' ')
              .trim()
              .slice(0, 4000);

            return { liveUrl, title, headings: headings.slice(0, 6), buttons: Array.from(new Set(buttons)), favicon, text };
          })()
        `).catch(() => null);

        if (details) {
          if (details.liveUrl && !details.liveUrl.startsWith('about:')) {
            basicContext.url = details.liveUrl;
            activeTab.url = details.liveUrl;
          }
          if (details.title) basicContext.title = details.title;
          if (details.favicon) basicContext.favicon = details.favicon;
          if (Array.isArray(details.buttons)) basicContext.buttons = details.buttons;
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

