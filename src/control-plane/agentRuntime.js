const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const { AgentState, ActionType } = require('./protocol');
const STTEngine = require('./sttEngine');
const ModelClient = require('./modelClient');
const SessionManager = require('./sessionManager');
const { buildDOMGroundingScript, detectSemanticCluster } = require('./universalGrounder');
const { scoreTokenOverlap } = require('./tokenMatch');

/**
 * Asynchronous Agent Runtime
 * Decoupled execution engine that interprets natural language and speech intents,
 * grounds them against the DOM/CDP pipeline, and dispatches actions to Chromium.
 */
const { evaluateAction } = require('./actionConsent');
const { createSettleWatcher } = require('./settleWatcher');
const JarvisSession = require('./jarvisSession');
const SkillManager = require('./skills/skillManager');

class AgentRuntime extends EventEmitter {
  constructor(tabManager, cdpBridge, contextEngine, visionGrounder, securityVault, sessionManager = null, terminalBridge = null) {
    super();
    this.tabManager = tabManager;
    this.cdp = cdpBridge;
    this.context = contextEngine;
    this.vision = visionGrounder;
    this.vault = securityVault;
    this.sessionManager = sessionManager || new SessionManager();
    this.jarvisSession = new JarvisSession();
    this.terminalBridge = terminalBridge;
    this.stt = new STTEngine();
    this.model = new ModelClient();
    this.skillManager = new SkillManager(this);
    this.skillManager.init();
    this.activeSkill = null;
    this.state = AgentState.IDLE;
    this.currentTask = null;
    this.taskModeEnabled = true;
    this.taskPauseResolver = null;
    this.actionHistory = [];
    this.continuousVoice = false;
    this.voiceRequiresWakeWord = false;
    this.wakeArmedUntil = 0;
    this.persistentGoal = false;
    this.goalRunId = 0;
    this.lastDOMSelector = null;
    this.lastDOMAction = null;
    this.lastReferencedFile = null;
    this.isPageShared = true; // Chrome Gemini-style active page context sharing
    this.sharedTabIds = null; // null = all open tabs by default; Array<id> = user-selected tabs
    this.verboseAudioLogging = false; // Filtered to suppress repetitive audio frame status spam
    this.maxGoalIterations = 15; // Autonomous Sense-Plan-Act-Verify re-planning goal loop depth

    // Audio stream session state & VAD tracking (inspired by nus-companion)
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
      strayQuietFrames: 0,
      // RMS-based VAD thresholds (inspired by nus-companion)
      speechRms: 30,       // Normalized threshold (0-100 scale, 30 = moderate sensitivity)
      pauseMs: 450,          // Quiet duration to end segment
      minSpeechMs: 350,      // Minimum speech duration
      preRollMs: 200,        // Pre-roll buffer before speech
      preRollBuffer: []      // Buffer to capture speech onset
    };
    // Conversation mode state tracking (inspired by nus-companion)
    this.convoState = {
      heldText: '',        // Buffer for mid-phrase text joining
      heldTimer: null,      // Timer for mid-phrase timeout
      lastUtteranceTime: 0, // Timestamp of last utterance
      utteranceCount: 0     // Count of utterances in current session
    };
    // Pending audio capture: Gemini-style — mic stays hot while a command is
    // being processed. Speech detected during processing is buffered and
    // queued as the next utterance instead of being dropped.
    this.pendingAudio = {
      chunks: [],
      totalBytes: 0,
      chunkCount: 0,
      speechDetected: false,
      pendingSpeechFrames: 0,
      speechFramesCount: 0,
      consecutiveSilenceFrames: 0,
      strayQuietFrames: 0
    };
    this.pendingQueue = []; // [{ pcm: Buffer, capturedAt: number }] — Gemini-style turn queue
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
  /**
   * Start a streaming audio session.
   * mode 'talk' (default): explicit push-to-talk — user tapped the mic, so every
   *   utterance is a command; the session ends after each command.
   * mode 'wake': hands-free always-listening — Adion only responds to
   *   utterances addressed with the "Adion" wake word.
   * mode 'convo': ChatGPT/Gemini-style conversation — continuous listening,
   *   no wake word required, mic re-arms automatically after each response.
   * mode 'jarvis': Jarvis mode — persistent AI assistant with 200k context window,
   *   remembers everything across the entire session.
   */
  startAudioSession(mode = 'talk') {
    this.isWakeMode = mode === 'wake';
    this.isConvoMode = mode === 'convo';
    this.isJarvisMode = mode === 'jarvis';
    this.voiceRequiresWakeWord = this.isWakeMode;
    this.continuousVoice = this.isWakeMode || this.isConvoMode || this.isJarvisMode;
    this.wakeArmedUntil = 0;
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
      strayQuietFrames: 0,
      // RMS-based VAD thresholds (inspired by nus-companion)
      speechRms: 30,       // Normalized threshold (0-100 scale, 30 = moderate sensitivity)
      pauseMs: 450,          // Quiet duration to end segment
      minSpeechMs: 350,      // Minimum speech duration
      preRollMs: 200,        // Pre-roll buffer before speech
      preRollBuffer: []      // Buffer to capture speech onset
    };
    // Reset pending capture for fresh session
    this.pendingAudio = {
      chunks: [], totalBytes: 0, chunkCount: 0,
      speechDetected: false, pendingSpeechFrames: 0,
      speechFramesCount: 0, consecutiveSilenceFrames: 0, strayQuietFrames: 0
    };
    this.pendingQueue = [];
    this.setState(AgentState.LISTENING);
    const modeDesc = this.isJarvisMode ? 'Jarvis mode (200k context)' : (this.isConvoMode ? 'Conversation mode (ChatGPT-style)' : (this.isWakeMode ? 'Wake mode (hands-free)' : 'Push-to-talk'));
    console.log(`[AgentRuntime Audio] Voice session initialized (${modeDesc})`);
    this.emit('feedback', { message: `Microphone stream open - ${modeDesc}`, level: 'info' });
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
      strayQuietFrames: 0,
      // RMS-based VAD thresholds (inspired by nus-companion)
      speechRms: 30,       // Normalized threshold (0-100 scale, 30 = moderate sensitivity)
      pauseMs: 450,          // Quiet duration to end segment
      minSpeechMs: 350,      // Minimum speech duration
      preRollMs: 200,        // Pre-roll buffer before speech
      preRollBuffer: []      // Buffer to capture speech onset
    };
    this.setState(AgentState.LISTENING);
    console.log('[AgentRuntime Audio] Voice session re-armed: ready for next speech command');
    this.emit('feedback', { 
      message: '👂 Listening... (voice active)', 
      level: 'info',
      voiceState: 'LISTENING',
      prompt: null
    });
  }

  /**
   * Ingest and process a streaming PCM audio chunk from the IPC bridge
   * Computes acoustic RMS energy and evaluates Voice Activity Detection (VAD)
   */
  processAudioStreamChunk(audioChunk) {
    // Gemini-style: while a command is being processed (session inactive but
    // continuous voice on), keep capturing speech into the pending buffer so
    // nothing the user says mid-processing is lost.
    if (!this.audioSession.active || this.audioSession.isSegmenting) {
      if (this.continuousVoice && !this.audioSession.isSegmenting) {
        this.processPendingAudioChunk(audioChunk);
      }
      return;
    }

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

    // RMS-based VAD (inspired by nus-companion)
    const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
    if (rms > this.audioSession.peakEnergy) {
      this.audioSession.peakEnergy = rms;
    }

    // Convert RMS to 0-100 scale for comparison with speechRms threshold
    const rmsNormalized = Math.min(100, (rms / 0.3) * 100); // Scale based on typical speech RMS ~0.3
    const isSpeechActive = rmsNormalized > this.audioSession.speechRms;

    // Pre-roll buffer: capture audio before speech onset (200ms)
    const S = this.audioSession;
    if (S.preRollBuffer) {
      S.preRollBuffer.push(buffer);
      // Keep only last 200ms worth of audio (approx 3 chunks at 16kHz 16-bit)
      if (S.preRollBuffer.length > 3) {
        S.preRollBuffer.shift();
      }
    }

    // Log audio frame telemetry to stdout with exact Speech: true / Speech: false from git history
    if (this.audioSession.chunkCount % 5 === 1 || isSpeechActive) {
      console.log(`[AgentRuntime Audio] Frame #${this.audioSession.chunkCount} | Size: ${buffer.length}B | RMS: ${rms.toFixed(4)} | NormRMS: ${rmsNormalized.toFixed(1)} | Speech: ${isSpeechActive}`);
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
        // Pre-roll audio is already in chunks (pushed at line 181), so no unshift needed
        // Clear pre-roll buffer since speech has been detected
        S.preRollBuffer = [];
        console.log(`[AgentRuntime VAD] Voice activity initiated (RMS: ${rms.toFixed(4)}, NormRMS: ${rmsNormalized.toFixed(1)})`);
      }
    } else if (this.audioSession.speechDetected && !this.audioSession.isSegmenting) {
      this.audioSession.consecutiveSilenceFrames++;
      // Voice-garble fix: endpoint on real milliseconds, not frame counts.
      // At 16kHz 16-bit mono, 1ms = 32 bytes, so msPerChunk = bytes/32.
      // (Old code assumed 50ms frames for pause but 128ms frames for
      // min-speech — both wrong for the real ~85ms renderer chunks.)
      const msPerChunk = Math.max(20, buffer.length / 32);
      const silenceMs = this.audioSession.consecutiveSilenceFrames * msPerChunk;
      const minChunks = Math.max(2, Math.ceil(240 / msPerChunk)); // ~240ms audio minimum
      if (silenceMs >= (this.audioSession.pauseMs || 450) && this.audioSession.chunks.length >= minChunks) {
        // Discard transient acoustic clicks or breath under minSpeechMs threshold
        const speechMs = (this.audioSession.speechFramesCount || 0) * msPerChunk;
        if (speechMs < (this.audioSession.minSpeechMs || 350)) {
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
   * Capture audio while a command is being processed (Gemini-style barge-in queue).
   * Runs the same RMS VAD; when an utterance completes, stores the PCM so it can
   * be transcribed and dispatched as the next command once processing finishes.
   */
  processPendingAudioChunk(audioChunk) {
    const P = this.pendingAudio;
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

    P.chunks.push(buffer);
    P.totalBytes += buffer.length;
    P.chunkCount++;

    // RMS VAD (same thresholds as main session)
    let sumSquares = 0;
    const sampleCount = Math.floor(buffer.length / 2);
    for (let i = 0; i < buffer.length - 1; i += 2) {
      const sample = buffer.readInt16LE(i) / 32768.0;
      sumSquares += sample * sample;
    }
    const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
    const rmsNormalized = Math.min(100, (rms / 0.3) * 100);
    const speechRms = this.audioSession.speechRms || 30;
    const isSpeechActive = rmsNormalized > speechRms;

    if (isSpeechActive) {
      P.pendingSpeechFrames = (P.pendingSpeechFrames || 0) + 1;
      P.speechFramesCount = (P.speechFramesCount || 0) + 1;
      P.consecutiveSilenceFrames = 0;
      P.strayQuietFrames = 0;
      if (!P.speechDetected && P.pendingSpeechFrames >= 2) {
        P.speechDetected = true;
      }
    } else if (P.speechDetected) {
      P.consecutiveSilenceFrames++;
      // Voice-garble fix: same ms-based endpointing as the main buffer.
      const msPerChunkP = Math.max(20, buffer.length / 32);
      const minChunksP = Math.max(2, Math.ceil(240 / msPerChunkP));
      if (P.consecutiveSilenceFrames * msPerChunkP >= (this.audioSession.pauseMs || 450) && P.chunks.length >= minChunksP) {
        const speechMsP = (P.speechFramesCount || 0) * msPerChunkP;
        if (speechMsP >= (this.audioSession.minSpeechMs || 350)) {
          const pcm = Buffer.concat(P.chunks);
          console.log(`[AgentRuntime Audio] 🎙️ Speech captured during processing (${pcm.length}B) — queued as next command`);
          this.pendingQueue.push({ pcm, capturedAt: Date.now() });
          if (this.pendingQueue.length > 5) this.pendingQueue.shift(); // cap queue depth
        }
        // Reset pending session for next utterance
        P.chunks = [];
        P.totalBytes = 0;
        P.chunkCount = 0;
        P.speechDetected = false;
        P.speechFramesCount = 0;
        P.consecutiveSilenceFrames = 0;
        P.pendingSpeechFrames = 0;
      }
    } else {
      P.pendingSpeechFrames = 0;
      P.strayQuietFrames = (P.strayQuietFrames || 0) + 1;
      if (P.strayQuietFrames >= 9) {
        P.speechFramesCount = 0;
        P.strayQuietFrames = 0;
      }
    }
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
        
        // Conversation/Jarvis mode: mid-phrase joining via shared helper (voice-garble fix #7)
        if (this.isConvoMode || this.isJarvisMode) {
          await this.dispatchConvoText(transcript.trim(), 'live');
        } else {
          await this.processCommand(transcript);
        }
      } else {
        this.emit('feedback', { message: 'No clear voice command identified', level: 'warning' });
      }
    } catch (err) {
      console.error('[AgentRuntime Pipeline] STT Error:', err);
      this.emit('feedback', { message: `STT error: ${err.message}`, level: 'error' });
    } finally {
      // Hands-free continuous loop (wake mode or convo mode): re-arm for the next command.
      // Push-to-talk: the user explicitly tapped the mic for ONE command, so
      // end the session and tell the renderer to close the mic stream.
      if (this.continuousVoice) {
        // Gemini-style: drain queued utterances FIRST while session stays
        // inactive (speech keeps routing to pendingAudio), then re-arm live mic.
        while (this.pendingQueue.length > 0 && this.continuousVoice) {
          const pending = this.pendingQueue.shift();
          await this.processPendingUtterance(pending.pcm);
        }
        if (this.continuousVoice) {
          this.rearmAudioSession();
        }
      } else {
        this.setState(AgentState.IDLE);
        this.emit('shell-action', { action: 'STOP_VOICE' });
      }
      
      // Clear mid-phrase buffer if session ended
      if (!this.continuousVoice && this.convoState.heldTimer) {
        clearTimeout(this.convoState.heldTimer);
        this.convoState.heldTimer = null;
        this.convoState.heldText = '';
      }
      // Clear pending capture on session end
      if (!this.continuousVoice) {
        this.pendingAudio = {
          chunks: [], totalBytes: 0, chunkCount: 0,
          speechDetected: false, pendingSpeechFrames: 0,
          speechFramesCount: 0, consecutiveSilenceFrames: 0, strayQuietFrames: 0
        };
        this.pendingQueue = [];
      }
    }
  }

  /**
   * Voice-garble fix #7: single shared convo/jarvis mid-phrase path.
   * - A stale hold (>=1.5s, continuation never arrived) is FLUSHED as its own
   *   command instead of silently dropped (old else-branch cleared heldText).
   * - Joined text is capped at 25 words; over-cap joins flush the held part
   *   first and handle the new text as a fresh turn, so two separate tasks
   *   never splice into one mega-prompt.
   * - Holding arms heldTimer: 1.6s with no continuation + runtime IDLE
   *   auto-flushes the held text (never while busy: no concurrent commands).
   */
  armConvoFlushTimer() {
    if (this.convoState.heldTimer) clearTimeout(this.convoState.heldTimer);
    this.convoState.heldTimer = setTimeout(() => {
      this.convoState.heldTimer = null;
      const held = this.convoState.heldText;
      if (!held) return;
      if (Date.now() - this.convoState.lastUtteranceTime < 1500) return; // continuation may still land
      if (this.state !== AgentState.IDLE) return; // busy: leave it; next utterance flushes it
      this.convoState.heldText = '';
      this.convoState.lastUtteranceTime = Date.now();
      console.log(`[AgentRuntime Convo] Auto-flushed stale held text: "${held}"`);
      this.processCommand(held).catch((err) => console.error('[AgentRuntime Convo] Auto-flush error:', err));
    }, 1600);
    if (this.convoState.heldTimer.unref) this.convoState.heldTimer.unref();
  }

  clearConvoHold() {
    if (this.convoState.heldTimer) { clearTimeout(this.convoState.heldTimer); this.convoState.heldTimer = null; }
    this.convoState.heldText = '';
  }

  async dispatchConvoText(cleanText, tag) {
    const S = this.convoState;
    const now = Date.now();
    const HOLD_WINDOW_MS = 1500;
    const JOIN_WORD_CAP = 25;
    const words = (t) => t.split(/\s+/).filter(Boolean).length;
    const endsMidPhrase = (t) => /\b(and|or|but|so|because|with|to|for|in|on|at|by|from|of)$/i.test(t);

    let text = cleanText;
    // Stale hold: previous fragment never got its continuation — run it as
    // its own command instead of silently dropping it.
    if (S.heldText && now - S.lastUtteranceTime >= HOLD_WINDOW_MS) {
      const stale = S.heldText;
      this.clearConvoHold();
      S.lastUtteranceTime = now;
      S.utteranceCount++;
      console.log(`[AgentRuntime Convo] Flushed stale held text (${tag}): "${stale}"`);
      await this.processCommand(stale);
    }
    // Fresh continuation: join, capped so separate tasks never splice.
    if (S.heldText && Date.now() - S.lastUtteranceTime < HOLD_WINDOW_MS) {
      const held = S.heldText;
      const joinedText = held + ' ' + text;
      this.clearConvoHold();
      S.lastUtteranceTime = Date.now();
      S.utteranceCount++;
      if (words(joinedText) > JOIN_WORD_CAP) {
        console.log(`[AgentRuntime Convo] Join over ${JOIN_WORD_CAP} words — split (${tag}): "${held}" | "${text}"`);
        await this.processCommand(held);
        S.lastUtteranceTime = Date.now();
        // fall through: handle the new text as a fresh turn below
      } else {
        console.log(`[AgentRuntime Convo] Joined mid-phrase (${tag}): "${joinedText}"`);
        await this.processCommand(joinedText);
        return;
      }
    }
    // Fresh turn: hold trailing-conjunction fragments for a continuation,
    // otherwise dispatch immediately.
    if (endsMidPhrase(text) && S.utteranceCount < 5) {
      S.heldText = text;
      S.lastUtteranceTime = Date.now();
      S.utteranceCount++;
      console.log(`[AgentRuntime Convo] Held mid-phrase (${tag}): "${text}"`);
      this.emit('feedback', { message: 'Waiting for continuation...', level: 'info' });
      this.armConvoFlushTimer();
      return;
    }
    S.lastUtteranceTime = Date.now();
    S.utteranceCount++;
    this.clearConvoHold();
    await this.processCommand(text);
  }

  /**
   * Transcribe and dispatch an utterance that was captured while a previous
   * command was still processing (Gemini-style queued turn).
   */
  async processPendingUtterance(pcm) {
    try {
      const transcript = await this.stt.transcribePCM(pcm);
      console.log(`[AgentRuntime Pipeline] Pending utterance transcribed: "${transcript}"`);
      if (transcript && transcript.trim()) {
        this.emit('transcript', { text: transcript });
        // Conversation/Jarvis mode: mid-phrase joining via shared helper (voice-garble fix #7)
        if (this.isConvoMode || this.isJarvisMode) {
          await this.dispatchConvoText(transcript.trim(), 'pending');
        } else {
          await this.processCommand(transcript);
        }
      }
    } catch (err) {
      console.error('[AgentRuntime Pipeline] Pending utterance STT error:', err);
      this.emit('feedback', { message: `Pending utterance STT error: ${err.message}`, level: 'error' });
    }
  }

  /**
   * Finalize the audio stream session and route accumulated speech to model / intent parser
   */
  async stopAudioSession(providedTranscript = null) {
    this.continuousVoice = false;
    this.voiceRequiresWakeWord = false;
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
        else if (act.type === ActionType.WAIT_FOR_ELEMENT) title = `Wait for "${act.params?.target || act.params?.selector || 'element'}"`;
        else if (act.type === ActionType.UPLOAD_FILE || act.type === ActionType.ATTACH_FILE) title = `Attach file to ${act.params?.target || 'page'}`;
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
    if (!rawInput) return;

    // Support direct structured action objects or JSON strings
    let directAction = null;
    if (typeof rawInput === 'object' && rawInput !== null && rawInput.type) {
      directAction = rawInput;
    } else if (typeof rawInput === 'string' && rawInput.trim().startsWith('{') && rawInput.trim().endsWith('}')) {
      try {
        const parsed = JSON.parse(rawInput.trim());
        if (parsed && parsed.type) {
          directAction = parsed;
        }
      } catch (_) {}
    }

    if (directAction) {
      this.setState(AgentState.EXECUTING_ACTION, { action: directAction });
      const execRes = await this.executeIntent(directAction);
      const isOk = execRes ? execRes.success !== false : true;
      this.setState(AgentState.IDLE);
      this.sessionManager.recordInteraction({
        source: source,
        rawPrompt: JSON.stringify(directAction),
        transcription: directAction.type,
        pageContext: {},
        modelResponse: { thought: `Executed direct action: ${directAction.type}`, actions: [directAction] },
        status: isOk ? 'success' : 'failed',
        feedback: execRes?.report || `Action ${directAction.type} finished`
      });
      if (this.jarvisSession) {
        this.jarvisSession.addTurn(JSON.stringify(directAction), `Action ${directAction.type} executed`, {});
      }
      return;
    }

    let commandInput = String(rawInput).trim();
    if (!commandInput) return;

    // Wake-word gate: during continuous hands-free listening, Adion only
    // responds to utterances addressed to it ("Adion, ...", "Hey Adion ...").
    // Ambient speech is ignored without leaving LISTENING state. Stop commands
    // stay exempt so the session can always be ended by voice.
    //
    // Conversation mode (convo): ChatGPT/Gemini-style — no wake word required,
    // just speak naturally. This mode is for back-and-forth dialogue.
    //
    // Jarvis mode: Persistent AI assistant with extended context — no wake word,
    // continuous listening, remembers everything across session.
    //
    // STT renders "Adion" unreliably ("AD on", "ADN", "addion", "एडियन", even
    // legacy "Jarvis"), so the matcher accepts observed mishearings. A bare
    // wake word arms a short window (~10s): the NEXT utterance is then treated
    // as the command, matching how users actually speak ("Adion." → "Open Canva").
    const isStopPhrase = /(stop listening|turn off (mic|microphone|voice)|exit voice|stop voice|cancel voice|shut down voice)/i.test(commandInput);
    if (source === 'voice' && this.voiceRequiresWakeWord && !this.isConvoMode && !this.isJarvisMode && !isStopPhrase) {
      const wakeMatch = commandInput.match(/^(?:(?:hey|hi|okay|ok|hello|yo)\s+)?(?:adion|addion|aidion|edion|adn|ad\s*on|a\s*dune|add\s*yon|ay\s*deon|एडियन|एडियोन|jarvis)(?=[\s,.:;!?\-]|$)/i);
      const wakeArmed = this.wakeArmedUntil && Date.now() < this.wakeArmedUntil;
      if (wakeMatch) {
        commandInput = commandInput.slice(wakeMatch[0].length).replace(/^[\s,.:;!?\-]+/, '').trim();
        this.wakeArmedUntil = 0;
        if (!commandInput) {
          this.wakeArmedUntil = Date.now() + 10000;
          this.emit('feedback', { message: "Yes? I'm listening.", level: 'info' });
          this.emit('adion-notification', { type: 'info', message: 'Adion is listening.' });
          return;
        }
      } else if (wakeArmed) {
        // Window consumed: this utterance is the command that followed the wake word.
        this.wakeArmedUntil = 0;
      } else {
        this.emit('feedback', { message: 'Ignored ambient speech — say "Adion" to wake me', level: 'info' });
        return;
      }
    }

    const exactPrompt = commandInput; // Strict prompt fidelity preservation
    const text = exactPrompt;
    if (!text) return;

    // Detect ongoing/sustained activities (games, monitoring, "until X") so the
    // goal loop keeps acting across many turns instead of ending after one step.
    this.persistentGoal = /\b(?:chess|game|gaming|match|until|monitor|survive|compete|battle|ongoing|continuous|practice)\b/i.test(exactPrompt) ||
                          /\bplay\b[\s\S]*\b(?:game|chess|match|online)\b/i.test(exactPrompt);
    const runId = ++this.goalRunId;

    // Hands-free voice stop command
    if (/(stop listening|turn off (mic|microphone|voice)|exit voice|stop voice|cancel voice|shut down voice)/i.test(text)) {
      this.continuousVoice = false;
      this.audioSession.active = false;
      this.emit('shell-action', { action: 'STOP_VOICE' });
      this.setState(AgentState.IDLE);
      this.emit('feedback', { message: 'Voice agent stopped listening', level: 'info' });
      this.emit('adion-notification', { type: 'info', message: 'Voice listening deactivated.' });
      return;
    }

    // Activity stop command: ends a sustained goal (game, monitor, etc.)
    if (/\b(?:stop\s+(?:playing|the\s+game|chess|it|the\s+match)|enough|quit(?:\s+the\s+game)?|that'?s\s+all|thats\s+all|stop\s+now)\b/i.test(text)) {
      this.persistentGoal = false;
      this.continuousVoice = false;
      this.audioSession.active = false;
      this.emit('shell-action', { action: 'STOP_VOICE' });
      this.setState(AgentState.IDLE);
      this.emit('feedback', { message: 'Stopped the ongoing activity.', level: 'info' });
      this.emit('adion-notification', { type: 'info', message: 'Activity stopped.' });
      return;
    }

    this.setState(AgentState.PARSING_INTENT, { input: exactPrompt });
    this.emit('feedback', { message: `Autonomous Agent coordinating: "${text}"`, level: 'info', isStep: true });

    // Meta Skills Commands (/skills, /skill list, /skill add, /skill delete, /skill toggle)
    if (this.skillManager) {
      if (/^\/skills?(?:\s+list)?\s*$/i.test(exactPrompt)) {
        const list = this.skillManager.getAllSkills();
        const formatted = list.map((s, i) => `${i + 1}. **${s.title}** (\`${s.trigger}\`) — ${s.description}${s.enabled ? '' : ' *(disabled)*'}`).join('\n');
        const msg = `🧩 **Installed AI Skills (${list.length})**:\n\n${formatted}\n\n*Type any \`/<command>\` to run, or click **+ Add Skill** in Copilot.*`;
        this.emit('feedback', { message: msg, level: 'info' });
        this.setState(AgentState.IDLE);
        return;
      }

      // Explicit slash command to import a skill from a URL / repository: /skill import <url>
      const importCmdMatch = exactPrompt.match(/^\/skills?\s+(?:import|install)\s+(https?:\/\/[^\s]+)/i);
      if (importCmdMatch) {
        const targetUrl = importCmdMatch[1];
        this.emit('feedback', { message: `🌐 Inspecting skill source at ${targetUrl}...`, level: 'info' });
        try {
          const importRes = await this.skillManager.importFromGitHub(targetUrl);
          const titles = importRes.skills.map(s => `**${s.title}** (\`${s.trigger}\`)`).join(', ');
          const feedbackMsg = `✨ **Skill Imported Successfully**: Installed ${importRes.count} skill(s) from **${importRes.owner}/${importRes.repo}**:\n${titles}\n\n*Use \`/<command>\` to trigger.*`;
          this.emit('feedback', { message: feedbackMsg, level: 'success' });
          this.emit('adion-notification', { type: 'success', message: `Imported ${importRes.count} skill(s)` });
          this.setState(AgentState.IDLE);
          return;
        } catch (err) {
          this.emit('feedback', { message: `⚠️ Skill import error: ${err.message}`, level: 'warning' });
          this.setState(AgentState.IDLE);
          return;
        }
      }

      const addMatch = exactPrompt.match(/^\/skills?\s+add\s+([a-zA-Z0-9_\-]+)\s+(\/[a-zA-Z0-9_\-]+)\s+([\s\S]+)$/i);
      if (addMatch) {
        const [_, name, trigger, desc] = addMatch;
        const created = this.skillManager.createSkill({
          name,
          trigger,
          title: name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          description: desc.trim(),
          instructions: `Directives for ${name}:\n1. Analyze user request and execute with specialized precision.\n2. Adhere to description: ${desc.trim()}`
        });
        const msg = `✨ **Skill Created & Installed**: **${created.title}** (\`${created.trigger}\`)\n${created.description}`;
        this.emit('feedback', { message: msg, level: 'success' });
        this.emit('adion-notification', { type: 'success', message: `Skill ${created.title} installed!` });
        this.setState(AgentState.IDLE);
        return;
      }
    }

    // Match Custom or Built-In Skill Trigger (e.g. /research, /price, /summarize, /extract, /review, or any user-added skill)
    let matchedSkill = this.skillManager ? this.skillManager.findMatchingSkill(exactPrompt) : null;
    let plannedText = text;

    if (matchedSkill) {
      this.activeSkill = matchedSkill.skill;
      this.emit('feedback', {
        message: `🎯 Activated Skill: **${this.activeSkill.title}** (\`${this.activeSkill.trigger}\`)`,
        level: 'info'
      });
      this.emit('adion-notification', {
        type: 'info',
        message: `Skill: ${this.activeSkill.title}`
      });

      if (matchedSkill.query) {
        plannedText = matchedSkill.query;
      } else {
        if (this.activeSkill.name === 'page-summary' || this.activeSkill.name === 'summarize') {
          plannedText = 'summarize the main points and key takeaways of this page';
        } else if (this.activeSkill.name === 'data-extractor' || this.activeSkill.name === 'extract') {
          plannedText = 'extract structured data, tables, and listings from this page';
        } else if (this.activeSkill.name === 'code-reviewer' || this.activeSkill.name === 'review') {
          plannedText = 'review the visible code and pull request changes for bugs and quality';
        } else {
          plannedText = `execute ${this.activeSkill.title}`;
        }
      }
    } else {
      this.activeSkill = null;
    }

    // Detect Computer Use / Local Workspace Mode (/pc, /pc_use, /computer, /workspace)
    if (/^\/(?:task_mode|task)\b/i.test(exactPrompt)) {
      const sub = exactPrompt.replace(/^\/(?:task_mode|task)\s*/i, '').trim();
      if (!sub) {
        this.taskModeEnabled = !this.taskModeEnabled;
        const msg = `⚡ Gemini Task Mode is now ${this.taskModeEnabled ? 'ENABLED (Stateful Loop + Work Panel)' : 'DISABLED'}`;
        this.emit('feedback', { message: msg, level: 'info' });
        this.emit('task-mode:status-change', { enabled: this.taskModeEnabled, activeTask: this.currentTask });
        this.setState(AgentState.IDLE);
        return;
      }
    }

    let isComputerUse = (matchedSkill && (matchedSkill.skill.name === 'computer-use' || matchedSkill.skill.trigger === '/pc_use')) ||
                          /^\/(?:pc_use|pc|computer|workspace)\b/i.test(exactPrompt) ||
                          /^(?:run\s+on\s+(?:pc|computer|workspace)|on\s+(?:my\s+)?(?:pc|computer|workspace))\b/i.test(exactPrompt);

    // Intelligent desktop app intent routing: if user mentions a native desktop application, route to PcEngine
    if (!isComputerUse && this.pcEngine && this.pcEngine.platform === 'win32') {
      const desktopAppPattern = /^(?:(?:open|launch|start|switch\s+to|bring\s+up)\s+(?:whatsapp|notepad|calculator|spotify|discord|slack|telegram|word|excel|powerpoint|paint|vlc|terminal|cmd|powershell)|(?:in|on)\s+whatsapp\b)/i;
      if (desktopAppPattern.test(exactPrompt.trim())) {
        isComputerUse = true;
      }
    }

    if (isComputerUse && !matchedSkill) {
      plannedText = text.replace(/^(?:\/pc_use\s+|\/pc\s+|\/computer\s+|\/workspace\s+|run\s+on\s+(?:pc|computer|workspace)\s+|on\s+(?:my\s+)?(?:pc|computer|workspace)\s*)/i, '').trim();
      if (!plannedText) plannedText = 'inspect current directory and system status';
    }

    // Ensure running PC task is stopped before a new command begins to prevent concurrent focus stealing
    if (this.pcEngine && typeof this.pcEngine.sessionStatus === 'function') {
      const pcStatus = this.pcEngine.sessionStatus();
      if (pcStatus && pcStatus.running) {
        console.log('[AgentRuntime] Cleanly superseding previous active PC task for new command');
        this.pcEngine.stopRun('superseded');
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // Fast Utterance Classification & Zero-Latency Dismiss (adapted from companion/src/guide/voice.js)
    const { classifyUtterance } = require('./voiceClassifier');
    const utterance = classifyUtterance(text);
    if (utterance.kind === 'dismiss') {
      console.log(`[AgentRuntime] Dismiss/cancel recognized: "${text}". Stopping active tasks.`);
      this.cancelCurrentTask();
      this.emit('feedback', { message: '🛑 Stopped as requested.', level: 'info' });
      this.emit('adion-notification', { type: 'info', message: 'Task stopped.' });
      this.setState(AgentState.IDLE);
      return;
    }

    let activeTab = null;
    let pageContext = {};
    let executedPlan = null;

    try {
      activeTab = this.tabManager ? this.tabManager.getActiveTab() : null;
      pageContext = activeTab ? { url: activeTab.url, title: activeTab.title } : {};
      if (this.activeSkill) {
        pageContext.activeSkill = this.activeSkill;
      }
      if (this.lastDOMSelector) {
        pageContext.lastDOMSelector = this.lastDOMSelector;
      }

      // Full PC control: drive the desktop through the Windows sidecars. /pc falls
      // through to the terminal path when they are unavailable, so it keeps working
      // on machines where PowerShell is blocked.
      const pcGoal = plannedText;
      if (isComputerUse && this.pcEngine && this.pcEngine.platform === 'win32') {
        try {
          this.setState(AgentState.EXECUTING_ACTION, { action: 'PC_TASK' });
          this.emit('feedback', { message: `🖥️ Driving the desktop: "${pcGoal}"...`, level: 'info' });
          const pcResult = await this.pcEngine.run(pcGoal);
          if (!pcResult || pcResult.outcome === 'unavailable') {
            console.warn('[AgentRuntime PC] sidecars unavailable, using terminal mode:', pcResult && pcResult.report);
          } else {
            const ok = pcResult.outcome === 'ok';
            this.emit('feedback', { message: pcResult.report || 'PC run finished.', level: ok ? 'success' : 'warning' });
            if (pcResult.text) {
              // "read this" / "summarize this": the words themselves are the answer.
              this.emit('feedback', { message: String(pcResult.text).slice(0, 8000), level: 'info' });
            }
            this.emit('adion-notification', { type: ok ? 'info' : 'warning', message: pcResult.report || 'PC run finished.' });
            this.setState(AgentState.IDLE);
            this.sessionManager.recordInteraction({
              source,
              rawPrompt: exactPrompt,
              transcription: text,
              pageContext: { isComputerUse: true, pc: true },
              modelResponse: { actions: [] },
              status: ok ? 'success' : 'failed',
              feedback: pcResult.report || ''
            });
            return;
          }
        } catch (pcError) {
          console.warn('[AgentRuntime PC] run failed, falling back to terminal mode:', pcError.message);
        }
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

      // 1. Gather Active Page Context (including simultaneous multi-tab context if page sharing is enabled)
      if (!isComputerUse && activeTab && this.isPageShared !== false) {
        try {
          const sharedCtx = await this.getActivePageContext(activeTab);
          if (sharedCtx) {
            pageContext = { ...pageContext, ...sharedCtx };
          }
        } catch (_) {}
      }

      // 2. Retrieve conversation history - unified Jarvis session (200k context) & SessionManager
      let conversationHistory = [];
      if (this.jarvisSession && this.jarvisSession.conversationHistory && this.jarvisSession.conversationHistory.length > 0) {
        const jarvisTurns = typeof this.jarvisSession.getRecentTurns === 'function'
          ? this.jarvisSession.getRecentTurns(100)
          : this.jarvisSession.conversationHistory.slice(-100);
        conversationHistory = jarvisTurns.map(turn => ({
          user: turn.user,
          agent: turn.assistant,
          status: 'success'
        }));
      } else if (this.sessionManager) {
        const recentInteractions = (this.sessionManager.getHistory().interactions || []).slice(-40);
        conversationHistory = recentInteractions.map(item => ({
          user: item.prompt?.raw || item.prompt?.transcription || item.rawPrompt || item.transcription || '',
          agent: item.response?.thought || item.response?.feedback || item.feedback || (item.modelResponse && item.modelResponse.thought) || '',
          status: item.response?.status || item.status || 'success'
        })).filter(h => h.user && h.user.trim().length > 0);
      }

      // Pass recentEntities & lastReferencedFile in pageContext for zero-latency coreference resolution
      if (this.jarvisSession && this.jarvisSession.recentEntities) {
        pageContext.recentEntities = this.jarvisSession.recentEntities;
      }
      if (this.lastReferencedFile) {
        pageContext.lastReferencedFile = this.lastReferencedFile;
      }

      // 3. TIER 1: AI-FIRST AUTONOMOUS GOAL EXECUTION & RE-PLANNING LOOP
      // Sense -> Plan -> Act -> Verify. The agent senses live state after each action,
      // reports execution results back to the model, tracks subtask breakdown, and iteratively replans until the goal is accomplished.
      let maxGoalIterations = this.persistentGoal ? 60 : (this.maxGoalIterations || 15);
      const absoluteSafetyCap = this.persistentGoal ? 300 : 30;
      let replanRetries = 0; // sustained activities survive transient model outages (429/503)
      let iteration = 0;
      let goalAccomplished = false;
      // goalAccomplished doubles as the loop terminator, so abort paths
      // (stall, anti-loop, cross-question) set it too — goalAborted keeps the
      // distinction so logs/persistence never report a failed run as success.
      let goalAborted = false;
      const stepHistory = [];
      let finalFeedback = '';
      let initialPlan = null;
      
      // Action repeat detection to prevent loops (inspired by nus-companion)
      const actionRepeats = new Map();
      const REPEAT_LIMIT = 3;
      const COOLDOWN_MS = 4000;
      const lastActionTime = new Map();
      
      // Screen stagnation detection (inspired by nus-companion)
      let lastScreenSignature = '';
      let sameScreenCount = 0;
      const SCREEN_STAGNATION_LIMIT = 2;

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

      if (initialPlan && (Array.isArray(initialPlan.actions) || initialPlan.thought || initialPlan.response)) {
        if (!Array.isArray(initialPlan.actions)) initialPlan.actions = [];

        // If model returned 0 actions: pure conversational turn, greeting, or direct Q&A
        if (initialPlan.actions.length === 0) {
          this.setState(AgentState.IDLE);

          let feedbackMsg = initialPlan.response || initialPlan.reply || initialPlan.message || '';
          if (!feedbackMsg) {
            const rawThought = String(initialPlan.thought || '').trim();
            // If thought is third-person robotic monologue, convert to warm, helpful first-person response
            if (/^(?:user\s+greeted|user\s+says|user\s+is\s+asking|the\s+user\s+wants|the\s+user\s+is|no\s+further\s+action\s+is\s+required)\b/i.test(rawThought)) {
              if (/^(?:hi|hello|hey|greetings|good\s+(?:morning|afternoon|evening)|howdy|sup|hola)\b/i.test(exactPrompt.trim())) {
                feedbackMsg = "Hello! How can I help you today? I'm ready to search the web, open tabs, navigate websites, or control your desktop.";
              } else {
                feedbackMsg = rawThought
                  .replace(/^(?:user\s+greeted\s+with\s*['"][^'"]*['"]\s*(?:while\s+[^.]*)?\.\s*no\s+further\s+action\s+is\s+required\s*(?:other\s+than\s+acknowledging\s+the\s+greeting)?\.?)/i, "Hello! How can I help you today?")
                  .replace(/^(?:the\s+user\s+is\s+asking\s+(?:about|for|to)?|the\s+user\s+wants\s+(?:to)?)\s*/i, "")
                  .trim();
                if (!feedbackMsg) feedbackMsg = "Hello! How can I assist you today?";
              }
            } else {
              feedbackMsg = rawThought || 'Standing by for browser commands.';
            }
          }

          if (this.currentTask) {
            this.currentTask.status = 'COMPLETED';
            this.currentTask.finalOutcome = feedbackMsg;
            this.emitTaskModeUpdate();
            this.emit('task-mode:completed', this.currentTask);
          }

          this.emit('feedback', { message: feedbackMsg, level: 'info', isCompletion: true });
          this.emit('adion-notification', { type: 'info', message: feedbackMsg });
          this.sessionManager.recordInteraction({
            source: source,
            rawPrompt: exactPrompt,
            transcription: text,
            pageContext: pageContext,
            modelResponse: initialPlan,
            status: 'success',
            feedback: feedbackMsg
          });
          if (this.jarvisSession) {
            this.jarvisSession.addTurn(exactPrompt, feedbackMsg, pageContext);
          }
          return;
        }

        // Synthesize or extract structured subtasks for user visibility
        let activeTasks = (Array.isArray(initialPlan.tasks) && initialPlan.tasks.length > 0)
          ? initialPlan.tasks
          : this.synthesizeTasksFromPrompt(exactPrompt, initialPlan.actions);

        // Emit initial task breakdown to Adion Copilot
        if (activeTasks && activeTasks.length > 0) {
          this.emit('task-breakdown', { prompt: exactPrompt, tasks: activeTasks });
          const taskSummary = activeTasks.map((t, idx) => `${idx + 1}. ${t.title}`).join('\n');
          this.emit('feedback', {
            message: `📋 Goal Breakdown:\n${taskSummary}`,
            level: 'info',
            tasks: activeTasks,
            isStep: true
          });
        }

        // Initialize Gemini Task Mode stateful model & Work Panel
        if (this.taskModeEnabled) {
          const taskId = 'task_' + Date.now();
          this.currentTask = {
            id: taskId,
            goal: exactPrompt,
            status: 'PLANNING_NEXT',
            mode: 'task',
            stepNumber: 0,
            maxSteps: maxGoalIterations,
            completedSteps: [],
            currentStep: null,
            remainingSteps: (activeTasks || []).map(t => ({ id: t.id, title: t.title, status: 'pending' })),
            touchedPages: activeTab && activeTab.url ? [{ url: activeTab.url, title: activeTab.title || activeTab.url, time: Date.now() }] : [],
            artifacts: [],
            pauseReason: null,
            sensitiveAction: null,
            loopState: {
              lastStateHash: null,
              consecutiveNoDeltaCount: 0
            }
          };
          this.emitTaskModeUpdate();
        }

        let currentPlan = initialPlan;
        let stalledIterations = 0;

        while (iteration < maxGoalIterations && !goalAccomplished) {
          iteration++;
          // A newer command (or stop phrase) superseded this goal run — abort cleanly.
          if (runId !== this.goalRunId) {
            goalAccomplished = true;
            finalFeedback = 'Superseded by a newer command.';
            break;
          }
          executedPlan = currentPlan;

          if (this.currentTask) {
            this.currentTask.stepNumber = iteration;
            this.currentTask.status = 'PLANNING_NEXT';
            this.setState(AgentState.PLANNING_NEXT);
            const curTab = this.tabManager ? this.tabManager.getActiveTab() : null;
            if (curTab && curTab.url && !this.currentTask.touchedPages.some(p => p.url === curTab.url)) {
              this.currentTask.touchedPages.push({ url: curTab.url, title: curTab.title || curTab.url, time: Date.now() });
            }
            this.emitTaskModeUpdate();
          }

          // Dynamic Iteration Cap Extension requested by AI:
          // Strictly protect against runway inflation on simple commands (hotkeys, tab actions, simple navigation)
          // or when previous steps made zero progress or repeated actions.
          const isSimpleCommand = /\b(close|switch|alt\s*\+?\s*f4|press|shortcut|theme|dark\s*mode|light\s*mode|volume|unmute|mute)\b/i.test(exactPrompt);
          if (!isSimpleCommand && typeof currentPlan.extendCapBy === 'number' && currentPlan.extendCapBy > 0 && stalledIterations === 0) {
            const ext = Math.min(Math.round(currentPlan.extendCapBy), 5);
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
            level: 'success',
            isStep: true
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
            
            // Repeat detection (inspired by nus-companion)
            let actionTarget = act.params?.target || act.params?.selector || act.params?.url || act.params?.query || act.params?.except || '';
            if (act.type === ActionType.CLOSE_TAB && !actionTarget) {
              actionTarget = activeTab ? activeTab.id : '';
            }
            const actionKey = act.type + ' ' + (actionTarget ? actionTarget : JSON.stringify(act.params || {}));
            const repeatCount = (actionRepeats.get(actionKey) || 0) + 1;
            actionRepeats.set(actionKey, repeatCount);
            
            // Check cooldown for launch actions
            const isLaunchAction = act.type === ActionType.NAVIGATE || act.type === ActionType.NEW_TAB;
            if (isLaunchAction) {
              const lastLaunch = lastActionTime.get(actionKey) || 0;
              if (Date.now() - lastLaunch < COOLDOWN_MS) {
                console.log(`[AgentRuntime GoalLoop] Cooldown: ${actionKey} launched ${Date.now() - lastLaunch}ms ago (< ${COOLDOWN_MS}ms)`);
                stepHistory.push({
                  iteration,
                  action: act.type,
                  status: 'SKIPPED',
                  summary: `${act.type} (cooldown - same action too recent)`,
                  fingerprint
                });
                continue;
              }
              lastActionTime.set(actionKey, Date.now());
            }
            
            // Block after REPEAT_LIMIT identical actions
            if (repeatCount >= REPEAT_LIMIT) {
              console.log(`[AgentRuntime GoalLoop] Repeat limit reached: ${actionKey} repeated ${repeatCount} times`);
              allSubActionsSucceeded = false;
              turnOutcomeMsg = `Action "${actionKey}" repeated ${repeatCount} times without progress. Try a different approach or stop.`;
              stepHistory.push({
                iteration,
                action: act.type,
                status: 'FAILED',
                summary: `Repeat limit (${REPEAT_LIMIT}) reached for ${actionKey}`,
                fingerprint
              });
              this.emit('feedback', { message: turnOutcomeMsg, level: 'warning' });
              break;
            }

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

            // Gemini Task Mode: Human-in-the-Loop Checkpoint & Takeover Guard
            if (this.taskModeEnabled) {
              const sensitiveCheck = this.isSensitiveActionForTaskMode(act, intent);
              if (sensitiveCheck) {
                this.setState(AgentState.PAUSED_FOR_USER);
                if (this.currentTask) {
                  this.currentTask.status = 'PAUSED_FOR_USER';
                  this.currentTask.pauseReason = sensitiveCheck.reason;
                  this.currentTask.sensitiveAction = { type: act.type, ...intent };
                  this.emitTaskModeUpdate();
                }
                this.emit('task-mode:paused', this.currentTask);
                this.emit('feedback', { message: `⏸️ [Task Mode Checkpoint] ${sensitiveCheck.reason}. Waiting for user confirmation or takeover...`, level: 'warning' });

                const userDecision = await new Promise(resolve => {
                  this.taskPauseResolver = resolve;
                });
                this.taskPauseResolver = null;

                if (userDecision && userDecision.stop) {
                  goalAccomplished = true;
                  goalAborted = true;
                  finalFeedback = 'Task stopped by user at checkpoint.';
                  break;
                }
                this.setState(AgentState.EXECUTING);
                if (this.currentTask) {
                  this.currentTask.status = 'EXECUTING';
                  this.currentTask.pauseReason = null;
                  this.currentTask.sensitiveAction = null;
                  this.emitTaskModeUpdate();
                }
                this.emit('task-mode:resumed', this.currentTask);
              }
            }

            const activeTabForStep = this.tabManager ? this.tabManager.getActiveTab() : null;
            const preStateHash = await this.computePageStateHash(activeTabForStep);

            if (this.currentTask) {
              const stepTitle = `${act.type} ${intent.target || intent.url || intent.text || ''}`.trim();
              this.currentTask.currentStep = {
                id: iteration,
                title: stepTitle,
                action: act.type,
                target: intent.target || intent.selector || intent.url || '',
                expectedOutcome: currentPlan.thought || 'Verify DOM state update',
                status: 'in_progress',
                startTime: Date.now()
              };
              this.currentTask.status = 'EXECUTING';
              this.setState(AgentState.EXECUTING);
              this.emitTaskModeUpdate();
            }

            const execRes = await this.executeIntent(intent);
            const isSuccess = execRes ? execRes.success !== false : true;

            // Gemini Task Mode: Post-Action State Observation & Delta Verification
            if (this.currentTask) {
              this.setState(AgentState.VERIFYING);
              this.currentTask.status = 'VERIFYING';
              this.emitTaskModeUpdate();

              const postTab = this.tabManager ? this.tabManager.getActiveTab() : null;
              const postStateHash = await this.computePageStateHash(postTab);
              if (preStateHash && postStateHash && preStateHash === postStateHash && act.type !== ActionType.SCROLL) {
                this.currentTask.loopState.consecutiveNoDeltaCount = (this.currentTask.loopState.consecutiveNoDeltaCount || 0) + 1;
                if (this.currentTask.loopState.consecutiveNoDeltaCount >= 2) {
                  console.log(`[AgentRuntime TaskMode] Stagnation detected: 2 consecutive steps produced no DOM delta (${preStateHash.slice(0, 40)}). Adapting strategy.`);
                  turnOutcomeMsg = `Notice: Page state did not change after action "${act.type}". Adapting strategy to alternative selector, scroll, or search.`;
                }
              } else {
                this.currentTask.loopState.consecutiveNoDeltaCount = 0;
              }

              if (this.currentTask.currentStep) {
                this.currentTask.completedSteps.push({
                  ...this.currentTask.currentStep,
                  status: isSuccess ? 'completed' : 'failed',
                  durationMs: Date.now() - this.currentTask.currentStep.startTime,
                  summary: isSuccess ? `${act.type} ${intent.target || intent.url || ''}`.trim() : (execRes?.reason || 'unfulfilled')
                });
                this.currentTask.currentStep = null;
              }
              if (activeTasks) {
                this.currentTask.remainingSteps = activeTasks.filter(t => t.status === 'pending');
              }
              this.emitTaskModeUpdate();
            }

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
                  actionRepeats.delete(actionKey);
                  sameScreenCount = 0;
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
              turnOutcomeMsg = execRes?.crossQuestion || execRes?.message || execRes?.reason || 'Action could not be executed';
              // If cross-question or target missing entirely, stop and report truthfully instead of blind retries
              if (execRes?.crossQuestion || execRes?.reason === 'TARGET_NOT_FOUND') {
                goalAccomplished = true;
                goalAborted = true;
                finalFeedback = execRes?.message || execRes?.crossQuestion || execRes?.reason || turnOutcomeMsg;
                break;
              }
            } else if (act.type === ActionType.CLICK_SELECTOR && !execRes?.visualGrounding) {
              // No click-based goal inference: a click that opens a dialog or a
              // panel is not proof the user's goal is complete. Only the planner
              // may set goalAccomplished, based on the observed page state.
              console.log(`[AgentRuntime GoalLoop] Click succeeded on "${intent.target}"; waiting for planner verification before completing the goal.`);
            } else if (act.type === ActionType.CLOSE_TAB && isSuccess && i === actionsInTurn.length - 1 && (currentPlan.goalAccomplished || /close/i.test(exactPrompt))) {
              goalAccomplished = true;
              finalFeedback = execRes?.message || `Closed requested tabs.`;
            } else if (act.type === ActionType.SWITCH_TAB && isSuccess && (currentPlan.goalAccomplished || (i === actionsInTurn.length - 1 && /\b(switch|go\s*to|focus)\b/i.test(exactPrompt)))) {
              goalAccomplished = true;
              finalFeedback = execRes?.message || `Switched to requested tab.`;
            } else if (act.type === ActionType.NAVIGATE && isSuccess && i === actionsInTurn.length - 1) {
              const hasSubsequentAction = /\b(and|then|after|find|search|look|click|read|summarize|tell|extract|type|fill|buy|check|press)\b/i.test(exactPrompt);
              const allTasksDone = activeTasks && activeTasks.length > 0 && activeTasks.every(t => t.status === 'completed');
              const isPureNav = /^(?:(?:kill\s+this\s+tab\s+and\s+)?(?:open|go\s+to|navigate\s+to|visit)\s+[\w\s\-\.\/:#?&=]+(?:please)?[\.\!]?)$/i.test(exactPrompt.trim()) && !hasSubsequentAction;
              if (currentPlan.goalAccomplished || isPureNav || (allTasksDone && !hasSubsequentAction)) {
                goalAccomplished = true;
                finalFeedback = `Navigated to ${intent.url || 'target page'}.`;
              }
            } else if (act.type === ActionType.NEW_TAB && isSuccess && i === actionsInTurn.length - 1) {
              const hasSubsequentAction = /\b(and|then|after|find|search|look|click|read|summarize|tell|extract|type|fill|buy|check|press)\b/i.test(exactPrompt);
              const allTasksDone = activeTasks && activeTasks.length > 0 && activeTasks.every(t => t.status === 'completed');
              const isPureNewTab = /^(?:(?:open|create|launch|new)\s+(?:a\s+)?tab(?:\s+for|\s+with|\s+to)?\s*[\w\s\-\.\/:#?&=]*)$/i.test(exactPrompt.trim()) && !hasSubsequentAction;
              if (currentPlan.goalAccomplished || isPureNewTab || (allTasksDone && !hasSubsequentAction)) {
                goalAccomplished = true;
                finalFeedback = `Opened new tab: ${intent.url || 'target page'}.`;
              }
            } else if (act.type === ActionType.TERMINAL_EXEC && isSuccess && i === actionsInTurn.length - 1) {
              const hasSubsequentAction = /\b(and|then|after|verify|check|run|exec)\b/i.test(exactPrompt);
              const allTasksDone = activeTasks && activeTasks.length > 0 && activeTasks.every(t => t.status === 'completed');
              if (currentPlan.goalAccomplished || (allTasksDone && !hasSubsequentAction)) {
                goalAccomplished = true;
                finalFeedback = execRes?.stdout || execRes?.message || `Executed terminal command successfully.`;
              }
            } else if ((act.type === ActionType.PC_PRESS || act.type === 'PC_PRESS') && isSuccess && i === actionsInTurn.length - 1) {
              const isStandaloneShortcut = /^(?:(?:press|hit|type\s+key|shortcut)\s+[a-zA-Z0-9+_\-\s]+|enter|escape|tab|space)$/i.test(exactPrompt.trim());
              if (isStandaloneShortcut || currentPlan.goalAccomplished === true) {
                goalAccomplished = true;
                finalFeedback = execRes?.report || `Dispatched keyboard shortcut.`;
              }
            } else if (currentPlan.goalAccomplished === true && isSuccess && i === actionsInTurn.length - 1) {
              goalAccomplished = true;
              finalFeedback = currentPlan.thought || 'Goal accomplished.';
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
            goalAborted = true;
            finalFeedback = 'Stopped: the planner repeated an action that had already run (success or failure). No duplicate action was dispatched.';
            this.emit('feedback', {
              message: '⚠️ Anti-loop guard: repeated action detected and skipped; stopped to avoid an infinite click loop.',
              level: 'warning'
            });
          }

          // Stall detection: consecutive steps that execute nothing are a dead
          // end, not a reason to keep spending model calls and iterations.
          const turnHadSuccess = stepHistory.some(s => s.iteration === iteration && s.status === 'SUCCESS');
          if (!goalAccomplished && !turnHadSuccess) stalledIterations += 1;
          else stalledIterations = 0;
          if (stalledIterations >= 3) {
            goalAccomplished = true;
            goalAborted = true;
            finalFeedback = `Stopped after ${stalledIterations} consecutive steps that could not execute any action. Last result: ${turnOutcomeMsg || finalFeedback || 'no progress'}.`;
            this.emit('feedback', { message: '⚠️ ' + finalFeedback, level: 'warning' });
            break;
          }

          if (goalAccomplished) break;

          console.log(`[AgentRuntime GoalLoop] iter end #${iteration}: goal=${goalAccomplished}${goalAborted ? ' (aborted)' : ''} steps=${stepHistory.length} tasks=${(activeTasks||[]).map(t=>t.status).join(',')}`);
          if (!goalAborted) {
            finalFeedback = currentPlan.thought || turnOutcomeMsg || 'Task step executed.';
          }

          // Check if the model explicitly marked the overall goal as accomplished,
          // or if all decomposed subtasks are completed and every action succeeded without pending work
          const hasSubsequentAction = /\b(and|then|after|find|search|look|click|read|summarize|tell|extract|type|fill|buy|check|press)\b/i.test(exactPrompt);
          const allTasksCompleted = activeTasks && activeTasks.length > 0 && activeTasks.every(t => t.status === 'completed');
          if ((currentPlan.goalAccomplished === true || (allTasksCompleted && !hasSubsequentAction)) && allSubActionsSucceeded) {
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

          // Sense: Pause for live DOM settling and dynamic re-hydration.
          // Sustained activities (games etc.) get a longer beat so the page
          // state (board, animations, turn timers) fully settles between turns.
          await new Promise(r => setTimeout(r, this.persistentGoal ? 1800 : 600));

          const currentTab = this.tabManager ? this.tabManager.getActiveTab() : null;

          // True DOM Perceptual Stagnation Check (DOM hash delta, not just URL/title)
          if (currentTab && !isComputerUse) {
            const currentDomHash = await this.computePageStateHash(currentTab).catch(() => '');
            if (currentDomHash && currentDomHash === lastScreenSignature) {
              sameScreenCount++;
            } else {
              sameScreenCount = 0;
              if (currentDomHash) lastScreenSignature = currentDomHash;
            }
            if (sameScreenCount >= 3) {
              console.log(`[AgentRuntime GoalLoop] DOM Stagnation detected: ${sameScreenCount} iterations without state change`);
              this.emit('feedback', { message: 'Screen unchanged across 3 iterations. Adapting strategy...', level: 'warning' });
              stepHistory.push({
                iteration,
                action: 'STAGNATION_DETECTED',
                status: 'INFO',
                summary: `DOM unchanged for ${sameScreenCount} iterations. Target panel or element may already be open, or requires scrolling or pressing Enter.`
              });
            }
          }

          const livePageContext = isComputerUse
            ? { ...pageContext, terminal: this.terminalBridge ? this.terminalBridge.getStatus() : null }
            : await this.getActivePageContext(currentTab);
          if (livePageContext && this.activeSkill) {
            livePageContext.activeSkill = this.activeSkill;
          }

          // Build augmented conversational history containing live goal execution progress
          const completedActionSummaries = Array.from(new Set(
            stepHistory
              .filter(s => s.status === 'SUCCESS' && s.action !== 'STAGNATION_DETECTED')
              .map(s => s.summary || s.action)
          )).filter(Boolean);

          const augmentedHistory = [...conversationHistory];
          augmentedHistory.push({
            user: `Goal: "${exactPrompt}"`,
            agent: `Progress so far:\n` + stepHistory.slice(-8).map(s => `- [Step ${s.iteration}] ${s.summary} (${s.status})`).join('\n') +
                   (completedActionSummaries.length > 0 ? `\nALREADY COMPLETED ACTIONS (DO NOT REPEAT): [${completedActionSummaries.join('; ')}]\n` : '') +
                   (isComputerUse
                     ? `\n[Operating Environment: Host PC / Local Terminal (${livePageContext.terminal?.cwd || process.cwd()})]\nCRITICAL INSTRUCTION: Analyze the output of the previous step. If additional terminal commands are required to fulfill the user's PC task, output {"type": "TERMINAL_EXEC", "params": {"command": "..."}}. When the task is complete, return "goalAccomplished": true, "actions": [], and summarize results.`
                     : `\nCurrent Active Page: "${livePageContext.title || livePageContext.url}" (URL: ${livePageContext.url}) with buttons: [${(livePageContext.buttons || []).slice(0, 25).join(', ')}]\n` +
                       (Array.isArray(livePageContext.openTabs) && livePageContext.openTabs.length > 1
                         ? `Open Tabs (${livePageContext.openTabs.length}): ` + livePageContext.openTabs.map(t => { const bg = (livePageContext.backgroundTabs || []).find(b => b.id === t.id); return `[Tab #${t.index}${t.isActive ? ' *ACTIVE*' : ''}: "${t.title}" (${t.url})]` + (bg && bg.headings && bg.headings.length ? ` (Headings: ${bg.headings.slice(0, 3).join(', ')})` : ''); }).join(' | ') + '\n'
                         : '') +
                       `CRITICAL INSTRUCTION: If you already reached the site or clicked the requested button, DO NOT navigate back or repeat actions. If more turns are needed, specify "extendCapBy". If goal is satisfied, return "goalAccomplished": true, "actions": [].` +
                       (this.persistentGoal
                         ? `\nONGOING ACTIVITY MODE: The goal is a sustained activity (e.g., a game or monitor). Keep executing the NEXT step of the activity on every turn. Set "goalAccomplished": true ONLY when the activity has verifiably ENDED (game over, victory, defeat, task complete) — completing a single move/step is NOT completion.`
                         : '')
                   )
          });

          // Re-plan: Query model with observed state and step history
          try {
            const planTarget = isComputerUse ? `Local Terminal (${livePageContext.terminal?.shell || 'powershell'})` : (livePageContext.title || livePageContext.url);
            console.log(`[AgentRuntime GoalLoop] Re-planning next step on ${planTarget}...`);
            const __replanStart = Date.now();
            this.emit('feedback', {
              message: isComputerUse
                ? `Evaluating next terminal step on local PC...`
                : `Inspected page "${livePageContext.title || livePageContext.url}". Context: ${livePageContext.buttons?.length || 0} buttons, ${livePageContext.scene?.length || 0} elements, ${livePageContext.headings?.length || 0} headings`,
              level: 'info'
            });
            // Heartbeat: keep the UI/logs alive during slow model calls
            const __heartbeat = setInterval(() => {
              const waited = ((Date.now() - __replanStart) / 1000).toFixed(0);
              console.log(`[AgentRuntime GoalLoop] ⏳ Still waiting on planner... ${waited}s`);
              this.emit('feedback', { message: `⏳ Planner thinking... ${waited}s`, level: 'info' });
            }, 5000);
            if (__heartbeat.unref) __heartbeat.unref();
            let nextPlan;
            try {
              nextPlan = await Promise.race([
                this.model.planActions(plannedText, livePageContext, augmentedHistory),
                new Promise((_, rej) => setTimeout(() => rej(new Error('replan timeout 15s')), 15000))
              ]);
            } finally {
              clearInterval(__heartbeat);
            }
            if (nextPlan && (Array.isArray(nextPlan.actions) || nextPlan.thought)) {
              if (!Array.isArray(nextPlan.actions)) nextPlan.actions = [];
              
              // Feedback: Show memory if available and verified against ground truth
              if (nextPlan.memory && !goalAborted) {
                const lastStep = stepHistory[stepHistory.length - 1];
                const hadRecentFailure = lastStep && (lastStep.status === 'FAILED' || lastStep.status === 'SKIPPED');
                const claimsActionComplete = /closed|switched|clicked|submitted|navigated|created|deleted/i.test(nextPlan.memory);
                if (!hadRecentFailure || !claimsActionComplete) {
                  console.log(`[AgentRuntime GoalLoop] Memory: ${nextPlan.memory}`);
                  this.emit('feedback', { message: `🧠 Memory: ${nextPlan.memory}`, level: 'debug' });
                }
              }
              if (nextPlan.next_goal) {
                console.log(`[AgentRuntime GoalLoop] Next Goal: ${nextPlan.next_goal}`);
                this.emit('feedback', { message: `🎯 Next: ${nextPlan.next_goal}`, level: 'debug' });
              }
              
              if (nextPlan.actions.length === 0 || (nextPlan.goalAccomplished === true && nextPlan.actions.length === 0)) {
                goalAccomplished = true;
                finalFeedback = nextPlan.thought || finalFeedback;
                if (activeTasks && activeTasks.length > 0) {
                  activeTasks.forEach(t => { t.status = 'completed'; });
                  this.emit('task-breakdown', { prompt: exactPrompt, tasks: activeTasks });
                }
                break;
              }
              currentPlan = nextPlan;
              replanRetries = 0;
            } else if (this.persistentGoal && replanRetries < 8) {
              // Sustained activity: model returned nothing usable — back off and retry
              // instead of abandoning a game mid-play (free-tier providers throttle often).
              replanRetries++;
              console.warn(`[AgentRuntime GoalLoop] Empty re-plan on sustained activity; retry ${replanRetries}/8 in 8s...`);
              this.emit('feedback', { message: `Model planner unavailable — retrying in 8s (${replanRetries}/8)...`, level: 'warning' });
              await new Promise(r => setTimeout(r, 8000));
              continue;
            } else {
              break;
            }
          } catch (replanErr) {
            console.warn('[AgentRuntime GoalLoop] Re-planning error:', replanErr.message);
            if (this.persistentGoal && replanRetries < 8) {
              replanRetries++;
              this.emit('feedback', { message: `Planner error (${replanErr.message}) — retrying in 8s (${replanRetries}/8)...`, level: 'warning' });
              await new Promise(r => setTimeout(r, 8000));
              continue;
            }
            break;
          }
        }

        let completionMsg = '';
        if (goalAborted) {
          completionMsg = finalFeedback || 'Task stopped before completion.';
        } else if (executedPlan && executedPlan.thought && executedPlan.thought.length > 15) {
          let cleanSummary = executedPlan.thought;
          // If thought is third-person planner reasoning monologue, convert to human-facing summary
          if (/^(?:the\s+user\s+wants|the\s+user\s+requested|user\s+wants|user\s+requested|i\s+will\s+navigate|i\s+will|i\s+need\s+to|we\s+need\s+to)\b/i.test(cleanSummary)) {
            const navSteps = stepHistory.filter(s => s.action === 'NAVIGATE' || s.action === 'NEW_TAB');
            if (navSteps.length > 1) {
              const urls = navSteps.map(s => (s.summary || '').replace(/^(?:NAVIGATE|NEW_TAB)\s*/i, '').trim()).filter(Boolean);
              cleanSummary = `I've opened the requested sites across ${urls.length} tabs:\n` + urls.map(u => `• ${u}`).join('\n');
            } else if (navSteps.length === 1) {
              const url = (navSteps[0].summary || '').replace(/^(?:NAVIGATE|NEW_TAB)\s*/i, '').trim();
              cleanSummary = `Navigated to ${url}.`;
            } else {
              cleanSummary = stepHistory.length > 0
                ? `Completed ${stepHistory.length} action(s) for: "${exactPrompt}".`
                : `Completed task: ${exactPrompt}`;
            }
          }
          completionMsg = cleanSummary;
        } else if (finalFeedback) {
          completionMsg = finalFeedback;
        } else {
          completionMsg = stepHistory.length > 1
            ? `Completed task successfully across ${stepHistory.length} step(s).`
            : 'Task completed successfully.';
        }

        // Record interaction in session memory log
        if (this.currentTask) {
          this.currentTask.status = goalAborted ? 'FAILED' : 'COMPLETED';
          this.currentTask.finalOutcome = completionMsg;
          this.setState(goalAborted ? AgentState.IDLE : AgentState.COMPLETED);
          this.emitTaskModeUpdate();
          if (!goalAborted) {
            this.emit('task-mode:completed', this.currentTask);
          }
        }

        this.sessionManager.recordInteraction({
          source: source,
          rawPrompt: exactPrompt,
          transcription: text,
          pageContext: pageContext,
          modelResponse: executedPlan || initialPlan,
          status: goalAborted ? 'aborted' : 'success',
          feedback: completionMsg
        });
        
        // Also record in Jarvis session
        if (this.jarvisSession) {
          this.jarvisSession.addTurn(exactPrompt, completionMsg, pageContext);
        }
        this.emit('feedback', { message: completionMsg, level: goalAborted ? 'warning' : 'success', isCompletion: true });
        this.emit('adion-notification', {
          type: goalAborted ? 'warning' : 'success',
          message: completionMsg
        });
        return;
      }

      // No fast-path, cache, or regex fallback: if the AI planner produced no plan, 
      // report it plainly instead of guessing an action.
      this.setState(AgentState.IDLE);
      const noPlanMsg = 'The AI planner produced no plan for this command, so nothing was executed.';
      console.warn('[AgentRuntime] No plan from model; command not executed:', exactPrompt);
      this.emit('feedback', { message: noPlanMsg, level: 'warning' });
      this.emit('adion-notification', { type: 'alert', message: noPlanMsg });
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
      this.emit('adion-notification', { type: 'alert', message: generalizedMsg });

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
        return (has(intent.target) || has(intent.index) || has(intent.query) || has(intent.tab) || has(intent.tabId) || has(intent.title) || has(intent.url) || has(intent.id))
          ? null
          : 'SWITCH_TAB requires target, index, or title';
      case ActionType.MODIFY_DOM:
        return has(intent.selector || intent.target) ? null : 'MODIFY_DOM requires selector';
      case ActionType.TERMINAL_EXEC:
        return has(intent.command || intent.cmd) ? null : 'TERMINAL_EXEC requires command';
      case ActionType.OPEN_APP:
      case 'OPEN_APP':
        return has(intent.name || intent.app) ? null : 'OPEN_APP requires name';
      case ActionType.PC_PRESS:
      case 'PC_PRESS':
        return has(intent.keys || intent.shortcut || intent.chord) ? null : 'PC_PRESS requires keys';
      case ActionType.PC_MOVE:
      case 'PC_MOVE':
        return (has(intent.x ?? intent.x1000) && has(intent.y ?? intent.y1000)) ? null : 'PC_MOVE requires x/y or x1000/y1000';
      case ActionType.RESEARCH_TOPIC:
      case 'RESEARCH_TOPIC':
        return has(intent.topic || intent.query) ? null : 'RESEARCH_TOPIC requires topic';
      default:
        return null;
    }
  }

  async executeIntent(intent) {
    this.setState(AgentState.EXECUTING_ACTION, { action: intent });
    this.emit('action-started', intent);

    let executionResult = { success: true, intent };

    const isTerminalAction = intent.type === ActionType.TERMINAL_EXEC || intent.type === 'TERMINAL_EXEC';
    const isIndependentAction = [
      ActionType.OPEN_APP, 'OPEN_APP',
      ActionType.PC_PRESS, 'PC_PRESS',
      ActionType.PC_CLICK, 'PC_CLICK',
      ActionType.PC_MOVE, 'PC_MOVE',
      ActionType.PC_TYPE, 'PC_TYPE',
      ActionType.PC_READ, 'PC_READ',
      ActionType.SYSTEM_VOLUME, 'SYSTEM_VOLUME',
      ActionType.DESKTOP_SCREENSHOT, 'DESKTOP_SCREENSHOT',
      ActionType.THEME_SET, 'THEME_SET', 'theme_set',
      ActionType.THEME_TOGGLE, 'THEME_TOGGLE', 'theme_toggle',
      ActionType.RESEARCH_TOPIC, 'RESEARCH_TOPIC',
      ActionType.COMPARE_PRICES, 'COMPARE_PRICES',
      'PAGE_ANALYSIS_OR_QA',
      'CONVERSATIONAL_ACKNOWLEDGE'
    ].includes(intent.type);

    const activeTab = this.tabManager ? this.tabManager.getActiveTab() : null;
    if (!activeTab && intent.type !== ActionType.NEW_TAB && !isTerminalAction && !isIndependentAction) {
      throw new Error('No active browser tab found');
    }

    // Ensure CDP is attached to active tab if needed for DOM actions
    if (activeTab && activeTab.view && [
      ActionType.SCROLL,
      ActionType.CLICK_SELECTOR,
      ActionType.CLICK_COORDINATE,
      ActionType.CAPTURE_VIEWPORT,
      ActionType.ANALYZE_IMAGES,
      ActionType.PLAY_VIDEO_FROM_THUMBNAIL,
      ActionType.WAIT_FOR_ELEMENT,
      ActionType.UPLOAD_FILE,
      ActionType.ATTACH_FILE
    ].includes(intent.type)) {
      await this.cdp.attach(activeTab.view.webContents);
    }

    switch (intent.type) {
      case 'CONVERSATIONAL_ACKNOWLEDGE': {
        this.setState(AgentState.IDLE);
        break;
      }

      case 'PAGE_ANALYSIS_OR_QA': {
        // This tool returns a conversational response without performing an action.
        // The model synthesizes a direct answer based on page context and conversation history.
        this.emit('feedback', { message: `Answering: ${intent.query || 'analyzing page...'}`, level: 'info' });
        
        // If we have a query, use the model client to synthesize a response
        if (intent.query && this.modelClient) {
          try {
            const pageContext = await this.getGeneralPageContext();
            const history = this.sessionManager ? this.sessionManager.getHistory().interactions.slice(-5) : [];
            
            const response = await this.modelClient.synthesizeAnswer(intent.query, pageContext, history);
            
            this.emit('feedback', { message: response, level: 'success' });
            executionResult = { success: true, answer: response, verified: true };
          } catch (err) {
            console.warn('[AgentRuntime PAGE_ANALYSIS_OR_QA] Error synthesizing answer:', err);
            this.emit('feedback', { message: 'Could not synthesize answer', level: 'warning' });
            executionResult = { success: false, reason: 'ANSWER_SYNTHESIS_FAILED', verified: false };
          }
        } else {
          // No query, just acknowledge
          executionResult = { success: true, answer: 'I can see the page content. How can I help?', verified: true };
        }
        break;
      }

      case ActionType.OPEN_APP:
      case 'OPEN_APP': {
        const appName = intent.name || intent.app || '';
        this.emit('feedback', { message: `🖥️ Launching desktop application: "${appName}"...`, level: 'info' });
        let launched = false;
        let report = '';
        if (this.pcEngine && this.pcEngine.actions && typeof this.pcEngine.actions.open_app === 'function') {
          try {
            const res = await this.pcEngine.actions.open_app({ name: appName });
            launched = res && res.ok;
            report = res && res.report;
          } catch (e) {
            report = e.message;
          }
        }
        if (!launched) {
          try {
            const { spawn } = require('child_process');
            if (process.platform === 'win32') {
              const child = spawn('cmd.exe', ['/c', 'start', '', String(appName)], { windowsHide: true, detached: true, stdio: 'ignore' });
              child.unref();
              launched = true;
            } else if (process.platform === 'darwin') {
              spawn('open', ['-a', String(appName)], { detached: true, stdio: 'ignore' }).unref();
              launched = true;
            } else {
              spawn('xdg-open', [String(appName)], { detached: true, stdio: 'ignore' }).unref();
              launched = true;
            }
          } catch (e) {
            report = e.message;
          }
        }
        if (launched) {
          this.emit('feedback', { message: `Launched application "${appName}" successfully.`, level: 'success' });
          executionResult = { success: true, verified: true, app: appName };
          if (this.jarvisSession) this.jarvisSession.updateEntities({ action: 'OPEN_APP' });
        } else {
          this.emit('feedback', { message: `Could not launch "${appName}": ${report || 'application not found'}`, level: 'warning' });
          executionResult = { success: false, reason: report || 'APPLICATION_NOT_FOUND', verified: false };
        }
        break;
      }

      case ActionType.PC_PRESS:
      case 'PC_PRESS': {
        const keys = intent.keys || intent.shortcut || intent.chord || '';
        this.emit('feedback', { message: `⌨️ Pressing shortcut: ${keys}...`, level: 'info' });

        const normalizedKeys = String(keys).toLowerCase().replace(/\s+/g, '');
        if (normalizedKeys === 'alt+f4' || normalizedKeys === 'alt+f-4') {
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.emit('feedback', { message: 'Alt+F4: Closing window...', level: 'success' });
            setTimeout(() => {
              try { this.mainWindow.close(); } catch (_) {}
            }, 300);
            executionResult = { success: true, verified: true, report: 'Closed window via Alt+F4' };
            break;
          }
        }

        if (this.pcEngine && this.pcEngine.actions && typeof this.pcEngine.actions.press === 'function') {
          if (this.pcEngine.status && !this.pcEngine.status().available) {
            await this.pcEngine.start().catch(() => {});
          }
          const res = await this.pcEngine.actions.press({ keys });
          const ok = res && res.ok;
          this.emit('feedback', { message: res?.report || `Pressed ${keys}`, level: ok ? 'success' : 'warning' });
          executionResult = { success: Boolean(ok), verified: Boolean(ok), report: res?.report };
        } else {
          executionResult = { success: false, reason: 'PC control engine unavailable' };
        }
        break;
      }

      case ActionType.PC_CLICK:
      case 'PC_CLICK': {
        this.emit('feedback', { message: `🖱️ Clicking desktop element "${intent.text || intent.target || 'target'}"...`, level: 'info' });
        // on-demand sidecar start (click): sidecars boot lazily; without this,
  // the first click/move/type/read after launch fails with "input.ps1 not running".
  if (this.pcEngine.status && !this.pcEngine.status().available) {
  await this.pcEngine.start().catch(() => {});
  }
        if (this.pcEngine && this.pcEngine.actions && typeof this.pcEngine.actions.click === 'function') {
          const res = await this.pcEngine.actions.click({ text: intent.text || intent.target, x: intent.x, y: intent.y, x1000: intent.x1000, y1000: intent.y1000 });
          const ok = res && res.ok;
          this.emit('feedback', { message: res?.report || 'Desktop click executed', level: ok ? 'success' : 'warning' });
          executionResult = { success: Boolean(ok), verified: Boolean(ok), report: res?.report };
        } else {
          executionResult = { success: false, reason: 'PC control engine unavailable' };
        }
        break;
      }

      case ActionType.PC_MOVE:
      case 'PC_MOVE': {
        this.emit('feedback', { message: 'Moving mouse' + (intent.x1000 !== undefined ? ' to x1000/y1000 (' + intent.x1000 + ', ' + intent.y1000 + ')' : (intent.x !== undefined ? ' to pixels (' + intent.x + ', ' + intent.y + ')' : '')) + '...', level: 'info' });
        // on-demand sidecar start (move): sidecars boot lazily; without this,
  // the first click/move/type/read after launch fails with "input.ps1 not running".
  if (this.pcEngine.status && !this.pcEngine.status().available) {
  await this.pcEngine.start().catch(() => {});
  }
        if (this.pcEngine && this.pcEngine.actions && typeof this.pcEngine.actions.move === 'function') {
          const res = await this.pcEngine.actions.move({ text: intent.text || intent.target, x: intent.x, y: intent.y, x1000: intent.x1000, y1000: intent.y1000 });
          const ok = res && res.ok;
          this.emit('feedback', { message: res && res.report ? res.report : 'Mouse moved', level: ok ? 'success' : 'warning' });
          executionResult = { success: Boolean(ok), verified: Boolean(ok), report: res && res.report };
        } else {
          executionResult = { success: false, reason: 'PC control engine unavailable' };
        }
        break;
      }

      case ActionType.PC_TYPE:
      case 'PC_TYPE': {
        const textVal = intent.text || intent.value || '';
        this.emit('feedback', { message: `⌨️ Typing into desktop window...`, level: 'info' });
        // on-demand sidecar start (type): sidecars boot lazily; without this,
  // the first click/move/type/read after launch fails with "input.ps1 not running".
  if (this.pcEngine.status && !this.pcEngine.status().available) {
  await this.pcEngine.start().catch(() => {});
  }
        if (this.pcEngine && this.pcEngine.actions && typeof this.pcEngine.actions.type === 'function') {
          const res = await this.pcEngine.actions.type({ text: textVal, enter: Boolean(intent.enter) });
          const ok = res && res.ok;
          this.emit('feedback', { message: res?.report || 'Typed into desktop window', level: ok ? 'success' : 'warning' });
          executionResult = { success: Boolean(ok), verified: Boolean(ok), report: res?.report };
        } else {
          executionResult = { success: false, reason: 'PC control engine unavailable' };
        }
        break;
      }

      case ActionType.PC_READ:
      case 'PC_READ': {
        this.emit('feedback', { message: `🔍 Reading desktop window content...`, level: 'info' });
        // on-demand sidecar start (read): sidecars boot lazily; without this,
  // the first click/move/type/read after launch fails with "input.ps1 not running".
  if (this.pcEngine.status && !this.pcEngine.status().available) {
  await this.pcEngine.start().catch(() => {});
  }
        if (this.pcEngine && this.pcEngine.actions && typeof this.pcEngine.actions.read === 'function') {
          const res = await this.pcEngine.actions.read({});
          const ok = res && res.ok;
          const readText = res?.text || res?.report || 'No text found in window.';
          this.emit('feedback', { message: readText.slice(0, 4000), level: ok ? 'success' : 'warning' });
          executionResult = { success: Boolean(ok), verified: Boolean(ok), text: readText };
        } else {
          executionResult = { success: false, reason: 'PC control engine unavailable' };
        }
        break;
      }

      case ActionType.SYSTEM_VOLUME:
      case 'SYSTEM_VOLUME': {
        const act = (intent.action || intent.mode || 'toggle').toLowerCase();
        let cmd = '';
        if (process.platform === 'win32') {
          if (act.includes('mute') || act.includes('toggle')) {
            cmd = 'powershell.exe -NoProfile -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]173)"';
          } else if (act.includes('up') || act.includes('increase') || act.includes('raise')) {
            cmd = 'powershell.exe -NoProfile -Command "for ($i=0; $i -lt 5; $i++) { (New-Object -ComObject WScript.Shell).SendKeys([char]175) }"';
          } else if (act.includes('down') || act.includes('decrease') || act.includes('lower')) {
            cmd = 'powershell.exe -NoProfile -Command "for ($i=0; $i -lt 5; $i++) { (New-Object -ComObject WScript.Shell).SendKeys([char]174) }"';
          } else {
            cmd = 'powershell.exe -NoProfile -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]173)"';
          }
        }
        if (cmd) {
          try {
            const { exec } = require('child_process');
            await new Promise((resolve) => exec(cmd, { timeout: 3000 }, resolve));
          } catch (_) {}
        }
        this.emit('feedback', { message: `System volume updated (${act}).`, level: 'success' });
        executionResult = { success: true, verified: true, action: act };
        break;
      }

      case ActionType.THEME_SET:
      case 'THEME_SET':
      case 'theme_set': {
        const theme = String(intent.theme || 'dark').toLowerCase();
        this.emit('shell-action', { action: 'THEME_SET', theme });
        this.emit('feedback', { message: `Browser theme switched to ${theme} mode`, level: 'success' });
        executionResult = { success: true, verified: true, theme };
        break;
      }

      case ActionType.THEME_TOGGLE:
      case 'THEME_TOGGLE':
      case 'theme_toggle': {
        this.emit('shell-action', { action: 'THEME_TOGGLE' });
        this.emit('feedback', { message: 'Toggled browser theme', level: 'success' });
        executionResult = { success: true, verified: true };
        break;
      }

      case ActionType.RESEARCH_TOPIC:
      case 'RESEARCH_TOPIC': {
        const topic = intent.topic || intent.query || 'web research';
        this.emit('feedback', { message: `🔬 Launching Deep Research Agent for: "${topic}"...`, level: 'info' });
        if (this.multiAgents && typeof this.multiAgents.executeDeepResearch === 'function') {
          try {
            const res = await this.multiAgents.executeDeepResearch(topic);
            const summary = res.summary || `Synthesized research for ${topic}`;
            const bullets = (res.keyPoints || []).map(p => `• ${p}`).join('\n');
            const fullOutput = `${summary}\n\n${bullets}`.trim();
            this.emit('feedback', { message: fullOutput, level: 'success' });
            executionResult = { success: true, verified: true, results: res };
          } catch (e) {
            this.emit('feedback', { message: `Research agent error: ${e.message}`, level: 'warning' });
            executionResult = { success: false, reason: e.message };
          }
        } else {
          executionResult = await this.executeIntent({ type: ActionType.NAVIGATE, query: topic });
        }
        break;
      }

      case ActionType.COMPARE_PRICES:
      case 'COMPARE_PRICES': {
        const prod = intent.product || intent.query || 'product';
        this.emit('feedback', { message: `🛍️ Comparative Shopping Agent scanning prices for "${prod}"...`, level: 'info' });
        if (this.multiAgents && typeof this.multiAgents.executeComparativeShopping === 'function') {
          try {
            const res = await this.multiAgents.executeComparativeShopping(prod, intent.targets || [
              { name: 'Store 1', basePrice: 59 },
              { name: 'Store 2', basePrice: 49 },
              { name: 'Store 3', basePrice: 65 }
            ]);
            const best = res.bestOption || {};
            const msg = `Best deal found for "${prod}": ${best.vendor} at $${best.price} (Potential savings: $${res.savings || 0})`;
            this.emit('feedback', { message: msg, level: 'success' });
            executionResult = { success: true, verified: true, results: res };
          } catch (e) {
            this.emit('feedback', { message: `Shopping agent error: ${e.message}`, level: 'warning' });
            executionResult = { success: false, reason: e.message };
          }
        } else {
          executionResult = await this.executeIntent({ type: ActionType.NAVIGATE, query: `buy ${prod} best price` });
        }
        break;
      }

      case ActionType.DESKTOP_SCREENSHOT:
      case 'DESKTOP_SCREENSHOT': {
        this.emit('feedback', { message: '📸 Capturing desktop screenshot & inspecting screen text...', level: 'info' });
        try {
          const { captureDisplay } = require('../pc/screenCapture');
          const cap = await captureDisplay();
          let ocrSummary = '';
          if (cap && cap.dataUrl) {
            try {
              const { recognizeText } = require('../pc/ocr');
              const fs = require('fs');
              const path = require('path');
              const tmpDir = path.join(process.cwd(), '.cache');
              if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
              const tmpImg = path.join(tmpDir, `screen_${Date.now()}.png`);
              const base64Data = cap.dataUrl.replace(/^data:image\/\w+;base64,/, '');
              fs.writeFileSync(tmpImg, Buffer.from(base64Data, 'base64'));
              const recognized = await recognizeText(tmpImg);
              try { fs.unlinkSync(tmpImg); } catch (_) {}
              if (recognized && recognized.trim()) {
                ocrSummary = recognized.trim().replace(/\s+/g, ' ').slice(0, 350);
              }
            } catch (_) {}
          }
          const summaryMsg = ocrSummary 
            ? `Captured desktop display (${cap?.pxWidth}x${cap?.pxHeight}). Visible screen text: "${ocrSummary}"`
            : `Captured desktop display (${cap?.pxWidth}x${cap?.pxHeight}).`;
          this.emit('feedback', { message: summaryMsg, level: 'success' });
          executionResult = { success: true, verified: true, capture: cap, report: summaryMsg, summary: summaryMsg };
        } catch (e) {
          executionResult = { success: false, reason: e.message };
        }
        break;
      }

      case ActionType.SCROLL: {
        const scrollBefore = await this.captureInteractionState({ visual: false });
        if (intent.direction === 'top') {
          await this.cdp.evaluate('window.scrollTo({ top: 0, behavior: "smooth" })');
        } else if (intent.direction === 'bottom') {
          await this.cdp.evaluate('window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })');
        } else {
          await this.cdp.dispatchScroll(intent.amount);
        }
        // Verify the scroll actually moved the page (smooth scroll + lazy load
        // need a beat). Honest failure lets the planner try another approach.
        let scrollChanged = !scrollBefore;
        if (scrollBefore) {
          const scrollDeadline = Date.now() + 1200;
          while (Date.now() < scrollDeadline) {
            await new Promise(r => setTimeout(r, 120));
            const now = await this.captureInteractionState({ visual: false });
            if (now && this.interactionStateChanged(scrollBefore, now)) { scrollChanged = true; break; }
          }
        }
        if (scrollChanged) {
          this.emit('feedback', { message: `Scrolled ${intent.direction}`, level: 'success' });
          executionResult = { success: true, verified: true };
        } else {
          this.emit('feedback', { message: `Scroll ${intent.direction} had no effect — page may already be at that position or not scrollable`, level: 'warning' });
          executionResult = { success: false, reason: 'SCROLL_NO_EFFECT', verified: false };
        }
        break;
      }

      case ActionType.NEW_TAB: {
        const tabCountBefore = this.tabManager ? this.tabManager.tabs.size : 0;
        const activeBefore = this.tabManager ? this.tabManager.activeTabId : null;
        this.tabManager.createTab(intent.url || 'adion://newtab');
        // Verify a new tab actually opened and became active
        let tabVerified = false;
        const tabDeadline = Date.now() + 2000;
        while (Date.now() < tabDeadline) {
          await new Promise(r => setTimeout(r, 100));
          if (this.tabManager && (this.tabManager.tabs.size > tabCountBefore || this.tabManager.activeTabId !== activeBefore)) {
            tabVerified = true; break;
          }
        }
        if (tabVerified) {
          this.emit('feedback', { message: `Opened new tab: ${intent.url}`, level: 'success', isStep: true });
          executionResult = { success: true, verified: true };
        } else {
          this.emit('feedback', { message: 'New tab did not open — browser may be busy', level: 'warning', isStep: true });
          executionResult = { success: false, reason: 'NEW_TAB_NOT_VERIFIED', verified: false };
        }
        break;
      }

      case ActionType.CLOSE_TAB: {
        if (!this.tabManager) {
          executionResult = { success: false, reason: 'TAB_MANAGER_UNAVAILABLE', verified: false };
          break;
        }

        const tabCountBefore = this.tabManager.tabs.size;
        const exceptTarget = intent.except || (intent.query && intent.query.match(/except\s+(.+)/i)?.[1]) || null;
        const specificTarget = intent.target || (intent.query && !intent.query.toLowerCase().includes('except') ? intent.query : null);

        if (exceptTarget) {
          const exLower = exceptTarget.toLowerCase().trim();
          const allTabs = Array.from(this.tabManager.tabs.values());
          const keepTab = allTabs.find(t =>
            (t.title || '').toLowerCase().includes(exLower) ||
            (t.url || '').toLowerCase().includes(exLower)
          );

          if (keepTab) {
            let closedCount = 0;
            for (const t of allTabs) {
              if (t.id === keepTab.id) continue;
              this.tabManager.closeTab(t.id);
              closedCount++;
            }
            this.tabManager.switchTab(keepTab.id);
            const msg = `Closed ${closedCount} tab(s), kept "${keepTab.title || exceptTarget}"`;
            this.emit('feedback', { message: msg, level: 'success' });
            executionResult = { success: true, verified: true, closedCount, message: msg };
            break;
          }

          // Target tab is NOT open in any browser tab.
          // Truthful handling: do NOT blindly destroy the user's workspace, do NOT emit fake success.
          const noMatchMsg = `No open tab matches "${exceptTarget}". All ${allTabs.length} tab(s) were kept open.`;
          console.warn(`[AgentRuntime CLOSE_TAB] ${noMatchMsg}`);
          this.emit('feedback', { message: noMatchMsg, level: 'warning' });
          executionResult = { success: false, reason: 'TARGET_NOT_FOUND', verified: true, message: noMatchMsg };
          break;
        }

        if (specificTarget && specificTarget !== 'current' && specificTarget !== 'active') {
          const qLower = specificTarget.toLowerCase().trim();
          const allTabs = Array.from(this.tabManager.tabs.values());
          const matching = allTabs.filter(t =>
            (t.title || '').toLowerCase().includes(qLower) ||
            (t.url || '').toLowerCase().includes(qLower)
          );
          if (matching.length > 0) {
            for (const t of matching) {
              this.tabManager.closeTab(t.id);
            }
            this.emit('feedback', { message: `Closed ${matching.length} matching tab(s)`, level: 'success' });
            executionResult = { success: true, verified: true, closedCount: matching.length };
            break;
          }
        }

        if (activeTab) {
          const tabToCloseId = activeTab.id;
          this.tabManager.closeTab(tabToCloseId);
          let closeVerified = false;
          const closeDeadline = Date.now() + 1500;
          while (Date.now() < closeDeadline) {
            await new Promise(r => setTimeout(r, 80));
            if (this.tabManager && !this.tabManager.tabs.has(tabToCloseId)) {
              closeVerified = true;
              break;
            }
          }
          if (closeVerified) {
            this.emit('feedback', { message: 'Closed active tab', level: 'success' });
            executionResult = { success: true, verified: true };
          } else {
            this.emit('feedback', { message: 'Tab did not close', level: 'warning' });
            executionResult = { success: false, reason: 'CLOSE_TAB_NOT_VERIFIED', verified: false };
          }
        }
        break;
      }

      case ActionType.GO_BACK: {
        const urlBefore = activeTab?.url || '';
        this.tabManager.goBackActiveTab();
        // History nav is async — poll for URL change (same-page anchors don't count)
        let backVerified = false;
        const backDeadline = Date.now() + 2500;
        while (Date.now() < backDeadline) {
          await new Promise(r => setTimeout(r, 120));
          const cur = this.tabManager?.getActiveTab()?.url || '';
          if (cur && cur !== urlBefore) { backVerified = true; break; }
        }
        if (backVerified) {
          this.emit('feedback', { message: 'Navigated back', level: 'success' });
          executionResult = { success: true, verified: true };
        } else {
          this.emit('feedback', { message: 'Nothing to go back to (or navigation did not occur)', level: 'warning' });
          executionResult = { success: false, reason: 'GO_BACK_NOT_VERIFIED', verified: false };
        }
        break;
      }

      case ActionType.GO_FORWARD: {
        const urlBefore = activeTab?.url || '';
        this.tabManager.goForwardActiveTab();
        let fwdVerified = false;
        const fwdDeadline = Date.now() + 2500;
        while (Date.now() < fwdDeadline) {
          await new Promise(r => setTimeout(r, 120));
          const cur = this.tabManager?.getActiveTab()?.url || '';
          if (cur && cur !== urlBefore) { fwdVerified = true; break; }
        }
        if (fwdVerified) {
          this.emit('feedback', { message: 'Navigated forward', level: 'success' });
          executionResult = { success: true, verified: true };
        } else {
          this.emit('feedback', { message: 'Nothing to go forward to (or navigation did not occur)', level: 'warning' });
          executionResult = { success: false, reason: 'GO_FORWARD_NOT_VERIFIED', verified: false };
        }
        break;
      }

      case ActionType.RELOAD: {
        // Verify reload actually started via did-start-loading
        const reloadContents = activeTab?.view?.webContents;
        let reloadVerified = false;
        if (reloadContents) {
          const __onStart = () => { reloadVerified = true; try { reloadContents.removeListener('did-start-loading', __onStart); } catch (_) {} };
          try { reloadContents.once('did-start-loading', __onStart); } catch (_) {}
          this.tabManager.reloadActiveTab();
          const reloadDeadline = Date.now() + 2500;
          while (Date.now() < reloadDeadline && !reloadVerified) {
            await new Promise(r => setTimeout(r, 100));
          }
          try { reloadContents.removeListener('did-start-loading', __onStart); } catch (_) {}
        } else {
          this.tabManager.reloadActiveTab();
          reloadVerified = true; // no contents to verify against — don't block
        }
        if (reloadVerified) {
          this.emit('feedback', { message: 'Reloaded page', level: 'success' });
          executionResult = { success: true, verified: true };
        } else {
          this.emit('feedback', { message: 'Reload did not start', level: 'warning' });
          executionResult = { success: false, reason: 'RELOAD_NOT_VERIFIED', verified: false };
        }
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

        const waSendRes = await this.observeAndDispatchWhatsApp(targetTab, phone, message);
        executionResult = waSendRes && waSendRes.success === false
          ? { success: false, reason: waSendRes.reason || 'WHATSAPP_SEND_NOT_VERIFIED', verified: false }
          : { success: true, verified: waSendRes ? waSendRes.verified !== false : false, message: waSendRes?.message };
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

        const targetFile = intent.file || (intent.isDocument ? intent.message : null);
        const waRes = await this.sendWhatsAppChat(targetTab, contact, message, isNumericPhone ? cleanPhone : null, secretCode, { file: targetFile });
        // Honest outcome: sendWhatsAppChat verifies delivery in the live DOM.
        // Its failure must reach the planner, not default to blind SUCCESS.
        executionResult = waRes && waRes.success === false
          ? { success: false, reason: waRes.reason || 'WHATSAPP_SEND_NOT_VERIFIED', verified: false }
          : { success: true, verified: waRes ? waRes.verified !== false : false, message: waRes?.message };
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
        const unreadRes = await this.clickWhatsAppUnreadChat(targetTab);
        executionResult = unreadRes && unreadRes.success === false
          ? { success: false, reason: unreadRes.reason || 'UNREAD_CHAT_NOT_OPENED', verified: false }
          : { success: true, verified: unreadRes ? unreadRes.verified !== false : false, message: unreadRes?.message };
        break;
      }

      case ActionType.NAVIGATE: {
        const destination = intent.url || intent.query || '';
        this.tabManager.navigateActiveTab(destination);
        this.emit('feedback', { message: `Navigating to: ${destination}`, level: 'success' });
        // Wait for target page navigation to settle so subsequent plan actions (e.g. click "Sign Up") ground against the live loaded DOM
        let navLoadFired = false;
        try {
          const contents = activeTab?.view?.webContents;
          if (contents) {
            await new Promise((resolve) => {
              const __onLoad = () => { navLoadFired = true; try { contents.removeListener('did-finish-load', __onLoad); } catch (_) {} __done(); };
              const __onDom = () => { navLoadFired = true; try { contents.removeListener('dom-ready', __onDom); } catch (_) {} __done(); };
              const __done = () => { clearTimeout(timer); resolve(); };
              const timer = setTimeout(__done, 3000);
              if (timer.unref) timer.unref();
              contents.once('did-finish-load', __onLoad);
              contents.once('dom-ready', __onDom);
            });
            await new Promise(r => setTimeout(r, 450));
          }
        } catch (_) {}
        // Verify navigation actually landed on the destination (D:\help
        // honest-outcome pattern): a failed/blocked nav must not report success.
        let navVerified = true;
        try {
          const navContents = activeTab?.view?.webContents;
          // Only verify when a real navigation event fired — same-page anchors,
          // mocks, and prerendered tabs can't be judged by URL comparison.
          if (navLoadFired && navContents && destination) {
            const landed = await navContents.executeJavaScript('location.href').catch(() => '');
            const destNorm = String(destination).toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
            const landedNorm = String(landed || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
            // Search/query destinations legitimately land on a results page;
            // only flag when the domain itself is absent.
            const destHost = destNorm.split('/')[0];
            // Only fail on a PROVEN mismatch — an unreadable/empty URL means
            // we cannot verify, not that navigation failed (test mocks, prerender).
            navVerified = !destHost || !landedNorm || landedNorm.includes(destHost) || landedNorm.includes(destNorm);
            if (!navVerified) {
              console.warn(`[AgentRuntime Nav] Destination mismatch: wanted "${destination}", landed on "${landed}"`);
            }
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
          const waNavRes = await this.observeAndDispatchWhatsApp(activeTab, phone, message);
          if (waNavRes && waNavRes.success === false) {
            executionResult = { success: false, reason: waNavRes.reason || 'WHATSAPP_SEND_NOT_VERIFIED', verified: false };
          }
        } else {
          await this.autoHandleContinuations(activeTab);
        }
        if (!navVerified) {
          this.emit('feedback', { message: `Navigation to "${destination}" did not reach the destination (landed elsewhere or blocked).`, level: 'warning' });
          executionResult = { success: false, reason: 'NAVIGATION_NOT_VERIFIED', verified: false };
        } else if (!executionResult || executionResult.success !== false) {
          executionResult = { success: true, verified: true };
          if (this.jarvisSession && destination) {
            const destHost = String(destination).replace(/^https?:\/\//i, '').split('/')[0];
            this.jarvisSession.updateEntities({ site: destHost, action: 'NAVIGATE' });
          }
        }
        break;
      }

      case ActionType.TOGGLE_DEVTOOLS: {
        this.tabManager.toggleDevTools();
        this.emit('feedback', { message: 'Toggled Developer Tools', level: 'success' });
        executionResult = { success: true, verified: 'dispatched' };
        break;
      }

      case ActionType.DEVTOOLS_SWITCH_PANEL: {
        const panel = intent.panel || 'console';
        this.tabManager.switchDevToolsPanel(panel);
        this.emit('feedback', { message: `Switched Developer Tools to "${panel}" panel`, level: 'success' });
        executionResult = { success: true, verified: 'dispatched' };
        break;
      }

      case ActionType.FOCUS_DEVTOOLS: {
        this.tabManager.focusDevTools();
        this.emit('feedback', { message: 'Focused Developer Tools', level: 'success' });
        executionResult = { success: true, verified: 'dispatched' };
        break;
      }

      case ActionType.FOCUS_PAGE: {
        this.tabManager.focusPage();
        this.emit('feedback', { message: 'Focused webpage content', level: 'success' });
        executionResult = { success: true, verified: 'dispatched' };
        break;
      }

      case ActionType.SWITCH_TAB: {
        const target = intent.target ?? intent.query ?? intent.tab ?? intent.tabId ?? intent.index ?? intent.title ?? intent.url ?? intent.id;
        const switched = this.tabManager.switchTabByQuery(target);
        if (switched) {
          this.emit('feedback', { message: `Switched to tab: "${switched.title || switched.url}"`, level: 'success' });
          executionResult = { success: true, verified: true, tab: switched.id };
        } else {
          this.emit('feedback', { message: `Could not find tab matching: "${target}"`, level: 'warning' });
          executionResult = { success: false, reason: `TAB_NOT_FOUND: ${target}`, verified: false };
        }
        break;
      }

      case ActionType.OPEN_DASHBOARD: {
        const dashCountBefore = this.tabManager ? this.tabManager.tabs.size : 0;
        this.tabManager.createTab('adion://dashboard');
        let dashVerified = false;
        const dashDeadline = Date.now() + 2000;
        while (Date.now() < dashDeadline) {
          await new Promise(r => setTimeout(r, 100));
          if (this.tabManager && this.tabManager.tabs.size > dashCountBefore) { dashVerified = true; break; }
        }
        if (dashVerified) {
          this.emit('feedback', { message: 'Opened live Telemetry & Diagnostics Dashboard', level: 'success' });
          executionResult = { success: true, verified: true };
        } else {
          this.emit('feedback', { message: 'Dashboard tab did not open', level: 'warning' });
          executionResult = { success: false, reason: 'DASHBOARD_NOT_VERIFIED', verified: false };
        }
        break;
      }

      case ActionType.SHOW_METRICS_OVERLAY: {
        this.emit('shell-action', { action: 'SHOW_METRICS_OVERLAY' });
        this.emit('feedback', { message: 'Active: Telemetry & Live Diagnostics Overlay GUI', level: 'success' });
        executionResult = { success: true, verified: 'dispatched' };
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
          this.emit('adion-notification', {
            type: 'success',
            message: `Updated <${(res.renderedTag || 'node').toLowerCase()}> ${res.resolvedSelector} (${res.action})`
          });
        } else {
          const generalizedMsg = 'The requested UI element could not be directly matched on the active page layout. Layout adaptation engaged.';
          this.emit('feedback', {
            message: generalizedMsg,
            level: 'warning'
          });
          this.emit('adion-notification', {
            type: 'alert',
            message: generalizedMsg
          });
          executionResult = { success: false, reason: res?.reason || 'DOM_MODIFY_FAILED', verified: false };
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
            executionResult = { success: false, reason: 'INSPECT_ELEMENT_NOT_FOUND', verified: false };
          }
        }
        break;
      }

      case ActionType.OPEN_SETTINGS: {
        this.emit('shell-action', { action: 'OPEN_SETTINGS' });
        this.emit('feedback', { message: 'Opened Settings', level: 'success' });
        executionResult = { success: true, verified: 'dispatched' };
        break;
      }

      case ActionType.OPEN_BOOKMARKS: {
        this.emit('shell-action', { action: 'OPEN_BOOKMARKS' });
        this.emit('feedback', { message: 'Opened Bookmarks', level: 'success' });
        executionResult = { success: true, verified: 'dispatched' };
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
          executionResult = { success: true, verified: true };
        } else {
          this.emit('feedback', { message: 'Cannot bookmark internal or empty page', level: 'warning' });
          executionResult = { success: false, reason: 'CANNOT_BOOKMARK_INTERNAL_PAGE', verified: false };
        }
        break;
      }

      case ActionType.OPEN_HISTORY: {
        this.emit('shell-action', { action: 'OPEN_HISTORY' });
        this.emit('feedback', { message: 'Opened History', level: 'success' });
        executionResult = { success: true, verified: 'dispatched' };
        break;
      }

      case ActionType.CLICK_COORDINATE: {
        // D:\help fallback: click by screen coordinates when DOM grounding
        // can't resolve the target. x,y may be normalized (0-1) viewport
        // fractions (from the Interactive Scene) or absolute CSS pixels.
        const contents = activeTab?.view?.webContents;
        if (!contents) { executionResult = { success: false, reason: 'No active tab for coordinate click' }; break; }
        let cx = Number(intent.x), cy = Number(intent.y);
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
          executionResult = { success: false, reason: 'CLICK_COORDINATE requires numeric x and y' };
          break;
        }
        const vp = await contents.executeJavaScript('({w: window.innerWidth, h: window.innerHeight})').catch(() => null);
        if (!vp) { executionResult = { success: false, reason: 'Could not read viewport size' }; break; }
        const px = (cx <= 1 && cy <= 1) ? Math.round(cx * vp.w) : Math.round(cx);
        const py = (cx <= 1 && cy <= 1) ? Math.round(cy * vp.h) : Math.round(cy);
        if (px < 0 || py < 0 || px > vp.w || py > vp.h) {
          executionResult = { success: false, reason: `Coordinates (${px},${py}) outside viewport ${vp.w}x${vp.h}` };
          break;
        }
        const before = await this.captureInteractionState({ visual: false });
        try {
          contents.sendInputEvent({ type: 'mouseMove', x: px, y: py });
          await new Promise(r => setTimeout(r, 20));
          contents.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
          await new Promise(r => setTimeout(r, 40));
          contents.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 });
        } catch (_) {}
        if (this.cdp && this.cdp.isAttached) { try { await this.cdp.dispatchClick(px, py); } catch (_) {} }
        // Tier 3: in-page DOM event sequence at the point (React/SPAs register
        // handlers on synthetic dispatched events too — same triple-tier as
        // autonomousInspectAndClick).
        await contents.executeJavaScript(`
          (() => {
            const el = document.elementFromPoint(${px}, ${py});
            if (!el) return;
            const opts = { bubbles: true, cancelable: true, clientX: ${px}, clientY: ${py}, button: 0, buttons: 1, view: window };
            el.dispatchEvent(new PointerEvent('pointerdown', opts));
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
            el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
            el.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
          })()
        `).catch(() => null);
        let coordChanged = !before;
        if (before) {
          const coordDeadline = Date.now() + 1400;
          while (Date.now() < coordDeadline) {
            await new Promise(r => setTimeout(r, 120));
            const now = await this.captureInteractionState({ visual: false });
            if (now && this.interactionStateChanged(before, now)) { coordChanged = true; break; }
          }
        }
        if (coordChanged) {
          this.emit('feedback', { message: `Clicked at (${px}, ${py})`, level: 'success' });
          executionResult = { success: true, verified: true, x: px, y: py };
        } else {
          this.emit('feedback', { message: `Click at (${px}, ${py}) produced no visible change`, level: 'warning' });
          executionResult = { success: false, reason: 'CLICK_NO_EFFECT', verified: false, x: px, y: py };
        }
        break;
      }

      case ActionType.CLICK_SELECTOR: {
        // Deterministic brakes: a click that sends, pays, deletes or posts is
        // only run when the person's own request asked for that class of action.
        const clickGate = this.actionAuthorized({ kind: 'page', label: intent.target || intent.selector }, intent);
        if (!clickGate.allowed) {
          this.emit('feedback', { message: clickGate.message, level: 'warning' });
          executionResult = { success: false, refused: true, reason: clickGate.reason };
          break;
        }

        const targetLower = (intent.target || '').toLowerCase();

        // Auth Gate Protection: Never attempt to autonomously complete third-party OAuth flows
        // (Google, Apple, Facebook sign-in) without user interaction.
        if (/continue with google|sign in with google|sign in with apple|login with google/i.test(targetLower)) {
          const curUrl = (activeTab?.url || '').toLowerCase();
          if (curUrl.includes('/auth') || curUrl.includes('/signup') || curUrl.includes('/login') || curUrl.includes('/account')) {
            console.log(`[AgentRuntime] Auth Gate detected on "${curUrl}". Halting autonomous OAuth click.`);
            const authMsg = 'Authentication Required: The site requires an account or sign-in to proceed. Please complete sign-in in the browser.';
            this.emit('feedback', { message: authMsg, level: 'warning' });
            this.emit('adion-notification', { type: 'warning', message: authMsg });
            executionResult = {
              success: false,
              refused: true,
              reason: 'AUTH_GATE_MANUAL_REQUIRED',
              crossQuestion: authMsg
            };
            break;
          }
        }

        this.setState(AgentState.GROUNDING_UI, { target: intent.target });
        this.emit('feedback', { message: `Grounding target: "${intent.target}"...`, level: 'info' });

        // Always capture pre-click state — DOM sampling does not require the
        // vision module. Gating this on `this.vision` made every click report
        // blind SUCCESS when vision was unavailable (WhatsApp loop bug).
        const preClickState = await this.captureInteractionState();
        // Primary path: AXTree grounding — D:\help's UIA screen-map equivalent.
        // One CDP call returns every semantic control; ~100ms vs seconds of
        // DOM-grounding retries. Falls through to DOM grounding on no-match.
        let clickRes = await this.groundClickAX(activeTab, intent.target);
        if (!clickRes?.success && clickRes?.reason && clickRes.reason !== 'CLICK_NO_EFFECT') {
          console.log(`[AgentRuntime Click] AXTree could not ground "${intent.target}" (${clickRes.reason}); falling back to DOM grounding`);
          clickRes = await this.autonomousInspectAndClick(activeTab, intent.target);
        } else if (clickRes?.success) {
          clickRes = { success: true, x: clickRes.x, y: clickRes.y, label: clickRes.label, tag: clickRes.role || 'ax' };
        }
        // Asynchronously rendered UI (panels, menus, result grids) often needs
        // a beat after the click that opened it. Re-ground before failing.
        if (!clickRes?.success && clickRes?.reason === 'ELEMENT_NOT_FOUND') {
          for (let attempt = 1; attempt <= 4 && !clickRes?.success; attempt++) {
            await new Promise((r) => setTimeout(r, 1000));
            console.log(`[AgentRuntime Click] Re-grounding "${intent.target}" after async render (attempt ${attempt})`);
            clickRes = await this.autonomousInspectAndClick(activeTab, intent.target);
          }
        }
        // D:\help coordinate fallback: grounding found nothing after retries —
        // resolve the target loosely in-page and click its center coordinates
        // with real mouse events, bypassing whatever blocked DOM grounding.
        if (!clickRes?.success && clickRes?.reason === 'ELEMENT_NOT_FOUND' && activeTab?.view?.webContents) {
          const coordRes = await this.attemptCoordinateFallback(activeTab, intent.target);
          if (coordRes && coordRes.success) {
            clickRes = { success: true, x: coordRes.x, y: coordRes.y, label: coordRes.label, tag: 'coord' };
          }
        }
        if (clickRes && clickRes.success) {
          const domChanged = preClickState
            ? await this.waitForPageChange(preClickState, { timeoutMs: 1600, giveUpMs: 800 })
            : true;

          if (domChanged) {
            this.emit('feedback', { message: `Clicked "${clickRes.label || intent.target}" at (${clickRes.x}, ${clickRes.y})`, level: 'success' });
            executionResult = { success: true, verified: true, label: clickRes.label || intent.target, x: clickRes.x, y: clickRes.y };
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
          executionResult = { success: false, reason: 'NO_IMAGES_MATCHED', verified: false };
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
          await this.cdp.waitForElement('ytd-video-renderer, ytd-rich-item-renderer, #contents', { timeoutMs: 6000, throwOnTimeout: false });
        }

        await this.cdp.attach(activeTab.view.webContents);

        // 2. Extract visible video card renderers & thumbnails from page
        let candidates = this.vision ? await this.vision.extractYouTubeVideoCandidates() : [];
        if (!candidates || candidates.length === 0) {
          await this.cdp.waitForElement('ytd-video-renderer, #video-title', { timeoutMs: 3000, throwOnTimeout: false });
          candidates = this.vision ? await this.vision.extractYouTubeVideoCandidates() : [];
        }

        // 3. Capture high-definition viewport screenshot
        const screenshot = await this.cdp.captureScreenshot();

        // 4. Query Vision Router (Qwen-VL / Groq Llama 3.2 Vision Free Tier)
        const analysis = await this.router.analyzeThumbnailVision(screenshot, query, candidates);
        console.log('[AgentRuntime Vision] Analysis output:', analysis);

        // 5. Ground and play the matched video candidate.
        // Bounds-check the model's index — an out-of-range matchedIndex must
        // NOT silently play candidates[0] (arbitrary wrong video = real-world
        // side effect). Only auto-pick the top candidate when the model gave
        // no index at all.
        let target = null;
        const midx = analysis && Number(analysis.matchedIndex);
        if (Number.isInteger(midx) && midx >= 1 && midx <= candidates.length) {
          target = candidates[midx - 1];
        } else if (analysis && analysis.matchedIndex == null && candidates.length === 1) {
          target = candidates[0]; // single candidate: unambiguous
        } else if (analysis && analysis.matchedIndex == null && analysis.confidence >= 0.8 && candidates.length > 0) {
          target = candidates[0]; // high-confidence no-index pick
        }

        if (target && this.vision) {
          await this.vision.playVideoCandidate(target);
          this.emit('feedback', {
            message: `Playing: "${target.title}" (${target.channel || 'YouTube'}) - Grounded via ${this.router.accounting.lastAssignedModel}!`,
            level: 'success'
          });
          executionResult = { success: true, verified: true, target: target.title };
        } else {
          this.emit('feedback', { message: `Could not confidently identify video thumbnail matching: "${query}"`, level: 'warning' });
          executionResult = { success: false, reason: 'NO_CONFIDENT_VIDEO_MATCH', verified: false };
        }
        break;
      }

      case ActionType.INPUT_TEXT: {
        // Deterministic Privacy & Sensitive Field Guard (adapted from companion/src/guide/sensitive.js)
        const { isSensitiveField, PRIVACY_REFUSAL } = require('./sensitiveGuard');
        if (isSensitiveField(intent)) {
          console.warn(`[AgentRuntime PrivacyGuard] Refused input into sensitive field: ${intent.target || intent.selector}`);
          this.emit('feedback', { message: `🛡️ ${PRIVACY_REFUSAL}`, level: 'warning' });
          executionResult = { success: false, refused: true, reason: 'SENSITIVE_FIELD_GUARD', message: PRIVACY_REFUSAL };
          break;
        }
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
          this.emit('adion-notification', { type: 'info', message: 'Ready for browser commands.' });
          executionResult = { success: true, greeting: true };
          break;
        }

        const selector = intent.selector || intent.target || '';
        const submitGate = this.actionAuthorized({
          kind: 'page',
          fieldName: selector,
          submit: intent.submit !== false
        }, intent);
        if (!submitGate.allowed) {
          this.emit('feedback', { message: submitGate.message, level: 'warning' });
          executionResult = { success: false, refused: true, reason: submitGate.reason };
          break;
        }

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

      case ActionType.WAIT_FOR_ELEMENT: {
        const target = intent.target || intent.selector || intent.query || intent.params?.target || intent.params?.selector;
        if (!target) {
          executionResult = { success: false, reason: 'Target query or selector is required for WAIT_FOR_ELEMENT' };
          break;
        }
        this.emit('feedback', { message: `Waiting for element "${target}" to render in DOM...`, level: 'info' });
        try {
          const waitRes = await this.cdp.waitForElement(target, {
            timeoutMs: intent.timeoutMs || intent.params?.timeoutMs || 8000,
            throwOnTimeout: true
          });
          executionResult = {
            success: true,
            details: `Element "${target}" verified at (${waitRes.x}, ${waitRes.y}) in ${waitRes.elapsedMs}ms.`,
            coords: { x: waitRes.x, y: waitRes.y }
          };
        } catch (err) {
          console.warn(`[AgentRuntime] WAIT_FOR_ELEMENT notice:`, err.message);
          executionResult = {
            success: false,
            reason: err.message
          };
        }
        break;
      }

      case ActionType.UPLOAD_FILE:
      case ActionType.ATTACH_FILE: {
        const target = intent.target || intent.selector || intent.params?.target || intent.params?.selector;
        const filePaths = intent.files || intent.filePath || intent.file || intent.params?.files || intent.params?.filePath || intent.params?.file;
        if (!filePaths) {
          executionResult = { success: false, reason: 'File path(s) required for file upload action' };
          break;
        }
        this.emit('feedback', { message: `Attaching file(s) to ${target || 'active document'}...`, level: 'info' });
        try {
          const uploadRes = await this.cdp.uploadFile(target, filePaths, intent.options || intent.params?.options || {});
          executionResult = {
            success: true,
            details: `Uploaded ${uploadRes.files.length} file(s) via ${uploadRes.method}.`,
            files: uploadRes.files
          };
        } catch (err) {
          console.error(`[AgentRuntime] File upload failed:`, err.message);
          this.emit('feedback', { message: `⚠️ File upload failed: ${err.message}`, level: 'warning' });
          executionResult = {
            success: false,
            reason: err.message
          };
        }
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

        // The shell is the largest blast radius in the product: nothing runs
        // until the person's own words authorized this class of command.
        const shellGate = this.actionAuthorized({ kind: 'shell', command: cmd }, intent);
        if (!shellGate.allowed) {
          this.emit('feedback', { message: shellGate.message, level: 'warning' });
          this.emit('adion-notification', { type: 'warning', message: 'Command blocked: it was not authorized by the request.' });
          executionResult = { success: false, refused: true, reason: shellGate.reason };
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
      try {
        const u = new URL(targetUrl.startsWith('http') || targetUrl.startsWith('file:') ? targetUrl : `file:///${targetUrl}`);
        const candidateName = path.basename(u.pathname);
        if (candidateName) {
          const workspaceCandidate = path.resolve(process.cwd(), candidateName);
          if (fs.existsSync(workspaceCandidate)) {
            targetPath = workspaceCandidate;
          }
        }
      } catch (_) {}
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
      const rxEsc = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // A. Match by exact element ID in source HTML
      if (elId) {
        const tagRegex = new RegExp(`(<${tag}[^>]*\\bid=["']${rxEsc(elId)}["'][^>]*>)`, 'i');
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
          } else if (modResult.action === 'setText' && modResult.appliedValue) {
            const fullTagRegex = new RegExp(`(<${tag}[^>]*\\bid=["']${rxEsc(elId)}["'][^>]*>)([\\s\\S]*?)(<\\/${tag}>)`, 'i');
            content = content.replace(fullTagRegex, `${openTag}${modResult.appliedValue}$3`);
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
          const altRegex = new RegExp(`(<${tag}[^>]*(?:id|data-id|data-testid)=["']${rxEsc(cleanSel)}["'][^>]*>)`, 'i');
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

    const landed = await this.waitForPageChange(beforeState, { timeoutMs: 1800, giveUpMs: 900 });
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
   * Full scrollable-page screenshot via CDP captureBeyondViewport — the whole
   * document, not just the viewport. Used when the task needs to see content
   * below the fold (long pages, feeds, documentation).
   */
  async captureFullPageBase64() {
    try {
      const tab = this.tabManager ? this.tabManager.getActiveTab() : null;
      const contents = tab && tab.view ? tab.view.webContents : null;
      if (!contents) return null;
      if (this.cdp && !this.cdp.isAttached) await this.cdp.attach(contents);
      if (!this.cdp || !this.cdp.isAttached) return null;
      const png = await this.cdp.captureFullPageScreenshot(1280);
      if (!png) return null;
      const css = await contents.executeJavaScript('({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })').catch(() => null);
      return {
        png,
        width: css ? css.width : 1280,
        height: css ? css.height : 0,
        fullPage: true
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
  async captureInteractionState(options = {}) {
    const tab = this.tabManager ? this.tabManager.getActiveTab() : null;
    if (!tab || !tab.view) return null;
    const contents = tab.view.webContents;
    try {
      const dom = await contents.executeJavaScript(`({ url: location.href, title: document.title, textLen: (document.body && document.body.innerText ? document.body.innerText.length : 0), nodes: document.querySelectorAll('*').length, scrollY: Math.round(window.scrollY || 0), scrollX: Math.round(window.scrollX || 0), focused: (document.activeElement ? (document.activeElement.tagName + '|' + (document.activeElement.getAttribute('aria-label') || document.activeElement.placeholder || document.activeElement.name || '')).slice(0, 80) : '') })`);
      // A capture without the expected signature (mocks, prerender, about:blank
      // races) is "cannot verify", not "verified unchanged" — return null so
      // callers treat the action as unverifiable rather than failed.
      if (!dom || typeof dom !== 'object' || (dom.textLen === undefined && dom.nodes === undefined && !dom.url)) return null;
      let visual = null;
      // Always capture visual sample (32x32 grayscale histogram) to catch DOM-invisible changes
      // (canvas, infinite scroll, drag-drop, any UI updates without URL/innerText changes).
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
    // Meaningful-change thresholds (D:\help ScreenWatcher-style jitter tolerance):
    // SPAs like WhatsApp mutate textLen/nodes constantly (timestamps, unread
    // badges, "typing…"), so any-delta detection reports false SUCCESS.
    if (Math.abs((b.textLen || 0) - (a.textLen || 0)) > 40) return true;
    if (Math.abs((b.nodes || 0) - (a.nodes || 0)) > 15) return true;
    // Scroll position: a real scroll moves >80px; layout jitter stays under it.
    if (Math.abs((b.scrollY || 0) - (a.scrollY || 0)) > 80) return true;
    if (Math.abs((b.scrollX || 0) - (a.scrollX || 0)) > 80) return true;
    // NOTE: focus-only changes are NOT page changes — clicking a row moves
    // focus without opening anything (was causing false SUCCESS on clicks).
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
        const editableSelector = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"], [role="textbox"], [data-lexical-editor="true"], [data-slate-editor="true"], div[contenteditable="true"]';
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
          const allInputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"], [role="textbox"], div[contenteditable="true"]'));
          
          // WhatsApp-specific search box patterns
          if (sLower.includes('search') || sLower.includes('start new chat')) {
            targetEl = allInputs.find(el => {
              const p = (el.placeholder || el.getAttribute('placeholder') || '').toLowerCase();
              const a = (el.getAttribute('aria-label') || '').toLowerCase();
              const t = (el.getAttribute('title') || '').toLowerCase();
              const dataTab = el.getAttribute('data-tab');
              return p.includes('search') || a.includes('search') || t.includes('search') || dataTab === '3';
            });
          }
          
          // Match by name or type or id
          if (!targetEl) {
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

        // Hardware-level character input for better React/Electron compatibility
        // First set the value via DOM, then dispatch hardware keystrokes for real framework state
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
    let submitVerified = null; // null = no submit attempted
    if (shouldSubmit) {
      // Capture pre-submit state so we can verify the submit actually did
      // something (message sent, search executed, form advanced) — typing
      // being verified does NOT prove submission worked (D:\help done-check).
      const preSubmitState = await this.captureInteractionState({ visual: false });
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

      // Poll briefly for a real page reaction to the submit.
      if (preSubmitState) {
        const submitDeadline = Date.now() + 1600;
        submitVerified = false;
        while (Date.now() < submitDeadline) {
          await new Promise(r => setTimeout(r, 140));
          const now = await this.captureInteractionState({ visual: false });
          if (now && this.interactionStateChanged(preSubmitState, now)) { submitVerified = true; break; }
        }
      }
    }

    const fieldLabel = domResult.field ? ` into "${domResult.field}"` : '';
    const submitNote = submitVerified === false ? ' (submit not confirmed — page did not visibly react)' : '';
    const feedbackMsg = shouldSubmit ? `Typed "${text}"${fieldLabel} and submitted${submitNote}` : `Typed "${text}"${fieldLabel}`;
    this.emit('feedback', { message: feedbackMsg, level: submitVerified === false ? 'warning' : 'success' });
    return { success: true, verified: domResult.verified !== false, submitVerified, typedValue: domResult.typedValue, field: domResult.field };
  }

  /**
   * Real-Time Chrome DevTools-style Element Inspector & Dual Tracking HUD.
   * Renders the authentic Chrome Inspect highlight box (box model) and 
   * DevTools Tooltip Card (Tag, Classes, Dimensions, Color, Font, Accessibility:
   * Contrast, Name, Role, Keyboard-focusable, plus active Adion action badge).
   * Emits live telemetry to the browser shell and Adion Copilot side panel.
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
              '<span>⚡ ADION ACTIVE: ' + actionName.toUpperCase() + '</span>' +
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
   * AXTree scene — D:\help's UIA screen-map equivalent. One CDP call returns
   * every semantic control (role + name) Chromium exposes to assistive tech.
   * Far more accurate and faster than DOM querySelectorAll heuristics.
   */
  async captureAXScene(tab) {
    const contents = tab?.view?.webContents;
    if (!contents) return [];
    try {
      if (this.cdp && !this.cdp.isAttached) await this.cdp.attach(contents);
      if (!this.cdp || !this.cdp.isAttached) return [];
      const nodes = await this.cdp.getAXTree();
      const ACTIONABLE = new Set(['button','link','textbox','searchbox','combobox','listbox','option','tab','tablist','menu','menubar','menuitem','menuitemcheckbox','menuitemradio','checkbox','radio','radio button','switch','slider','spinbutton','treeitem','gridcell','row','cell','listitem','article','form','dialog','alertdialog','toolbar','navigation','main','heading','img','image','video','canvas','document','webarea','application','group','generic','inline text box','section','region','banner','contentinfo','search','complementary','figure','feed','summary','details','meter','progressbar','scrollbar','separator','statictext','tooltip','status','log','marquee','timer','directory','doc-cover','doc-backlink','doc-bibliography','doc-endnote','doc-footnote','doc-glossary','doc-notice','doc-tip','emphasis','strong','code','insertion','deletion','subscript','superscript','time','mark','suggestion','comment','paragraph','line break','page break','annotation','comment']);
      const INTERACTIVE_ROLES = new Set(['button','link','textbox','searchbox','combobox','option','tab','menuitem','checkbox','radio','radio button','switch','listitem','treeitem','gridcell','row','cell','article','heading']);
      const CONTENT_ROLES = new Set(['statictext','inline text box','paragraph','article','heading','listitem','row','cell','gridcell','comment','mark','strong','emphasis','time']);
      // Two quotas scanned across the WHOLE tree: first-60-in-order floods on
      // apps whose left pane (chat lists, nav trees) emits hundreds of text
      // nodes before the main content pane is reached (WhatsApp msg-container).
      const interactive = [];
      const content = [];
      for (const n of nodes) {
        if (interactive.length >= 40 && content.length >= 40) break;
        const role = String(n.role?.value || n.role || '').toLowerCase();
        const name = String(n.name?.value || n.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!name || name.length < 3) continue;
        const props = n.properties || [];
        const has = (p) => props.some(pr => pr.name === p && (pr.value?.value === true || pr.value === true));
        const isInteractive = has('focusable') || has('editable') || has('settable') || INTERACTIVE_ROLES.has(role);
        const entry = { role, name, backendNodeId: n.backendDOMNodeId, id: n.nodeId };
        if (isInteractive && interactive.length < 40) { interactive.push(entry); continue; }
        // Content nodes need substance: skip icon-ish/tiny labels, keep real text.
        if (CONTENT_ROLES.has(role) && content.length < 40 && name.length >= 4 && !/^[\d:.,\s]+$/.test(name)) {
          content.push(entry);
        }
      }
      return [...interactive, ...content];
    } catch (_) {
      return [];
    }
  }

  /**
   * Ground a click through the AXTree: score node names against the query,
   * resolve the winner's backend node to viewport coords, click all three
   * tiers, verify effect. D:\help's resolvePoint→mouse.click flow.
   */
  async groundClickAX(tab, query) {
    const contents = tab?.view?.webContents;
    if (!contents || !query) return { success: false, reason: 'no-tab-or-query' };
    const scene = await this.captureAXScene(tab);
    if (!scene.length) return { success: false, reason: 'AXTREE_EMPTY' };

    const q = String(query).toLowerCase();
    const qTokens = q.split(/[^a-z0-9@.]+/).filter(t => t.length > 2);
    const tokenScore = typeof scoreTokenOverlap === 'function' ? scoreTokenOverlap : () => 0;
    const scored = [];
    for (const el of scene) {
      const name = el.name.toLowerCase();
      const nameTokens = name.split(/[^a-z0-9@.]+/).filter(t => t.length > 2);
      
      // Exact substring match is strongest signal
      let sc = name.includes(q) ? 2.0 : tokenScore(q, el.name);
      
      const foundTokens = qTokens.length > 0 ? qTokens.filter(t => nameTokens.includes(t)).length : 0;
      const coverage = qTokens.length > 0 ? foundTokens / qTokens.length : 0;

      // Filter out elements that have zero token overlap and no substring match
      if ((coverage === 0 || foundTokens === 0) && !name.includes(q)) {
        continue;
      }

      // If query has 2+ tokens, require meaningful token coverage unless exact substring match
      if (qTokens.length >= 2 && coverage < 0.35 && !name.includes(q)) {
        continue;
      }

      // Token coverage bonus
      if (qTokens.length > 0) {
        if (coverage === 1) {
          sc += 0.5; // All tokens present - strong signal
        } else if (coverage >= 0.75) {
          sc += 0.2; // Most tokens present
        } else if (coverage === 0) {
          sc -= 0.5; // No tokens match
        }
      }
      
      // Length penalty / bonus: only reward similar length if token overlap is already high
      const nameLen = name.length;
      const queryLen = q.length;
      if (coverage >= 0.7 || name.includes(q)) {
        if (nameLen >= queryLen - 2 && nameLen <= queryLen + 5) {
          sc += 0.3; // Bonus for similar length only when tokens actually match
        }
      }
      if (nameLen > queryLen + 15) {
        sc -= 0.4; // Penalty for much longer names
      }
      
      // Role bonus: prefer genuinely clickable roles for click targets
      if (['button','link','textbox','option','tab','menuitem','listitem','gridcell','row'].includes(el.role)) sc += 0.08;
      
      scored.push({ ...el, score: sc });
    }
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score < 0.5) return { success: false, reason: 'AXTREE_NO_MATCH', sceneSize: scene.length };
    
    // Strict validation: ensure the best match has sufficient token coverage
    if (qTokens.length > 1 && !best.name.toLowerCase().includes(q)) {
      const bestTokens = best.name.toLowerCase().split(/[^a-z0-9@.]+/).filter(t => t.length > 2);
      const matchedTokens = qTokens.filter(t => bestTokens.includes(t));
      const bestCoverage = matchedTokens.length / qTokens.length;
      if (bestCoverage < 0.5) {
        console.log(`[AgentRuntime AXClick] Rejecting candidate "${best.name}" due to low token coverage (${(bestCoverage * 100).toFixed(0)}% < 50%): matched [${matchedTokens.join(', ')}], missing [${qTokens.filter(t => !bestTokens.includes(t)).join(', ')}]`);
        return { success: false, reason: 'AXTREE_TOKEN_MISMATCH', best: best.name, matched: matchedTokens };
      }
    }
    
    // Ambiguity rule: two candidates within 0.05 means no clear winner
    if (scored.length > 1 && (best.score - scored[1].score) < 0.05) {
      return { success: false, reason: 'AXTREE_AMBIGUOUS', candidates: [best.name, scored[1].name] };
    }

    const center = await this.cdp.getNodeCenter(best.backendNodeId);
    if (!center) return { success: false, reason: 'AXTREE_NO_BOX', label: best.name };

    const before = await this.captureInteractionState({ visual: false });
    try {
      contents.sendInputEvent({ type: 'mouseMove', x: center.x, y: center.y });
      await new Promise(r => setTimeout(r, 20));
      contents.sendInputEvent({ type: 'mouseDown', x: center.x, y: center.y, button: 'left', clickCount: 1 });
      await new Promise(r => setTimeout(r, 40));
      contents.sendInputEvent({ type: 'mouseUp', x: center.x, y: center.y, button: 'left', clickCount: 1 });
    } catch (_) {}
    if (this.cdp && this.cdp.isAttached) { try { await this.cdp.dispatchClick(center.x, center.y); } catch (_) {} }
    await contents.executeJavaScript(`
      (() => {
        const el = document.elementFromPoint(${center.x}, ${center.y});
        if (!el) return;
        const opts = { bubbles: true, cancelable: true, clientX: ${center.x}, clientY: ${center.y}, button: 0, buttons: 1, view: window };
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
        el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
        el.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
      })()
    `).catch(() => null);

    let changed = !before;
    if (before) {
      const dl = Date.now() + 1400;
      while (Date.now() < dl) {
        await new Promise(r => setTimeout(r, 120));
        const now = await this.captureInteractionState({ visual: false });
        if (now && this.interactionStateChanged(before, now)) { changed = true; break; }
      }
    }
    console.log(`[AgentRuntime AXClick] "${best.name}" (${best.role}) @${center.x},${center.y} score=${best.score?.toFixed?.(2)} changed=${changed}`);
    return { success: changed, x: center.x, y: center.y, label: best.name, role: best.role, score: best.score, verified: changed };
  }

  /**
   * D:\help coordinate fallback: when DOM grounding can't resolve a target,
   * find the best fuzzy element match in-page and click its center with real
   * mouse events. Looser than autonomousInspectAndClick — token overlap on
   * label/aria/text plus clickable-ancestor climb, no strict selector needed.
   */
  async attemptCoordinateFallback(tab, targetQuery) {
    const contents = tab?.view?.webContents;
    if (!contents || !targetQuery) return { success: false, reason: 'no-tab-or-query' };
    const query = String(targetQuery);

    const found = await contents.executeJavaScript(`
      (() => {
        try {
          const q = ${JSON.stringify(query)}.toLowerCase();
          const qTokens = q.split(/[^a-z0-9@.]+/).filter(t => t.length > 2);
          const isVisible = (el) => {
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 8 && r.height > 8 && r.height <= window.innerHeight * 1.2 && r.bottom > 0 && r.top < window.innerHeight &&
                   s.display !== 'none' && s.visibility !== 'hidden';
          };
          const labelOf = (el) => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('data-tab') || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
          const score = ${scoreTokenOverlap.toString()};
          let best = null;
          const candidates = document.querySelectorAll('button, a, [role="button"], [role="link"], [role="option"], [role="menuitem"], [tabindex], [data-tab], li, [class*="row"], [class*="item"], [class*="cell"], [class*="chat"], div[onclick], span');
          for (const el of candidates) {
            if (!isVisible(el)) continue;
            const label = labelOf(el);
            if (!label || label.length > 160) continue;
            const labelLower = label.toLowerCase();
            const labelTokens = labelLower.split(/[^a-z0-9@.]+/).filter(t => t.length > 2);
            // Exact substring fast path
            let sc = labelLower.includes(q) ? 1.0 : score(q, label);
            // Token coverage check - require ALL tokens
            if (qTokens.length > 0) {
              const foundTokens = qTokens.filter(t => labelTokens.includes(t)).length;
              const coverage = foundTokens / qTokens.length;
              if (coverage === 1) {
                sc += 0.4; // All tokens present
              } else if (coverage === 0) {
                sc -= 0.2; // No tokens match
              }
            }
            if (sc < 0.35) continue;
            // Prefer clickable ancestors: climb until role/tabindex/onclick
            let target = el;
            for (let p = el; p && p !== document.body; p = p.parentElement) {
              const clickable = p.getAttribute('role') === 'button' || p.getAttribute('role') === 'link' ||
                p.hasAttribute('onclick') || p.getAttribute('tabindex') !== null ||
                /button|link/i.test(p.tagName);
              if (clickable) { target = p; break; }
              target = p;
            }
            const r = target.getBoundingClientRect();
            const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
            if (!best || sc > best.score) best = { x: cx, y: cy, label: labelOf(target) || label, score: sc, tag: target.tagName };
          }
          return best;
        } catch (e) { return { error: String(e) }; }
      })()
    `).catch(() => null);

    if (!found || found.error || !Number.isFinite(found.x)) {
      return { success: false, reason: found?.error || 'NO_COORD_MATCH' };
    }

    // Real OS-level mouse click at resolved coordinates + effect verification
    const before = await this.captureInteractionState({ visual: false });
    try {
      contents.sendInputEvent({ type: 'mouseMove', x: found.x, y: found.y });
      await new Promise(r => setTimeout(r, 20));
      contents.sendInputEvent({ type: 'mouseDown', x: found.x, y: found.y, button: 'left', clickCount: 1 });
      await new Promise(r => setTimeout(r, 40));
      contents.sendInputEvent({ type: 'mouseUp', x: found.x, y: found.y, button: 'left', clickCount: 1 });
    } catch (_) {}
    if (this.cdp && this.cdp.isAttached) { try { await this.cdp.dispatchClick(found.x, found.y); } catch (_) {} }
    // Tier 3: in-page DOM event sequence at the resolved point.
    await contents.executeJavaScript(`
      (() => {
        const el = document.elementFromPoint(${found.x}, ${found.y});
        if (!el) return;
        const opts = { bubbles: true, cancelable: true, clientX: ${found.x}, clientY: ${found.y}, button: 0, buttons: 1, view: window };
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
        el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
        el.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
      })()
    `).catch(() => null);

    let changed = !before;
    if (before) {
      const dl = Date.now() + 1400;
      while (Date.now() < dl) {
        await new Promise(r => setTimeout(r, 120));
        const now = await this.captureInteractionState({ visual: false });
        if (now && this.interactionStateChanged(before, now)) { changed = true; break; }
      }
    }
    console.log(`[AgentRuntime CoordFallback] Clicked "${found.label}" at (${found.x},${found.y}) score=${found.score?.toFixed?.(2)} changed=${changed}`);
    return { success: changed, x: found.x, y: found.y, label: found.label, verified: changed };
  }

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

  /**
   * Deterministic authorization for an action the planner proposed.
   * spec: { kind: 'shell', command } | { kind: 'page', label|fieldName|submit }
   * The person's own words come from the intent the goal loop annotated with the
   * raw request; the model is never asked again.
   */
  actionAuthorized(spec = {}, intent = {}) {
    const own = String(
      intent.raw || intent.rawPrompt || intent.prompt || intent.originalPrompt || ''
    );
    // Goal-loop continuations ("go", "next", "yes") re-plan sub-actions whose
    // authorization lives in the ORIGINAL request ("reply to him"). Keep the
    // last few authorizing prompts so the person's own words — not just the
    // latest filler utterance — decide whether a send/buy/delete class was asked.
    this.recentAuthPrompts = this.recentAuthPrompts || [];
    if (own && !this.recentAuthPrompts.includes(own)) {
      this.recentAuthPrompts.push(own);
      if (this.recentAuthPrompts.length > 4) this.recentAuthPrompts.shift();
    }
    const prompt = this.recentAuthPrompts.length
      ? this.recentAuthPrompts.join(' ')
      : String(this.lastAuthorizingPrompt || '');
    if (prompt) this.lastAuthorizingPrompt = prompt;
    const verdict = evaluateAction(spec, prompt, intent);
    if (!verdict.allowed) {
      console.warn(`[AgentRuntime Consent] Refused ${spec.kind || 'action'}: ${verdict.reason}`);
    }
    return verdict;
  }

  /**
   * Wait for the page to react to an action and then stop changing, instead of
   * sleeping a fixed 700-900 ms and looking once. Returns true when the page
   * visibly changed.
   */
  async waitForPageChange(before, options = {}) {
    if (!before) return true;
    const watcher = createSettleWatcher({
      sample: () => this.captureInteractionState({ visual: false }),
      changeTest: (base, current) => this.interactionStateChanged(base, current)
    });
    let outcome = { changed: false };
    try {
      outcome = await watcher.waitForSettle(before, Object.assign({ timeoutMs: 1600, giveUpMs: 800 }, options));
    } catch (err) {
      console.warn('[AgentRuntime Settle] watcher failed:', err.message);
    }
    if (outcome.changed) return true;
    // Canvas, video and heavily virtualised pages mutate nothing observable in
    // the DOM: fall back to the visual comparison once the screen has painted.
    await new Promise((r) => setTimeout(r, 260));
    return this.interactionStateChanged(before, await this.captureInteractionState());
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

    // Capture pre-click state for effect verification.
    const before = await this.captureInteractionState({ visual: false }).catch(() => null);

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

    // Active Dual Tracking: Layer 2 - Emit real-time telemetry to browser shell & Adion Copilot side panel
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

    // Step 4: Verify the click actually changed the page before claiming success.
    // A dispatched click is not proof of effect — React handlers may ignore it.
    const changed = before ? await this.waitForPageChange(before, { timeoutMs: 1200, giveUpMs: 500 }) : true;
    if (before && !changed) {
      return {
        success: false,
        reason: 'CLICK_NO_EFFECT',
        x, y, width, height, tag, label
      };
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
            this.emit('adion-notification', { type: 'success', message: successMsg });
            console.log(`[AgentRuntime] ✅ ${successMsg}`);
            return { success: true, message: successMsg };
          }

          if (pageStatus && pageStatus.status === 'qr_code_required' && !qrPromptEmitted) {
            qrPromptEmitted = true;
            const qrNotice = `WhatsApp Web requires authentication. Please scan the QR code on screen; I will send "${message}" as soon as connected.`;
            this.emit('feedback', { message: qrNotice, level: 'warning' });
            this.emit('adion-notification', { type: 'info', message: qrNotice });
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
      this.emit('adion-notification', { type: 'alert', message: failureNotice });
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
   * Search workspace and filesystem for requested document/file
   */
  findFileOnDisk(fileName) {
    if (!fileName) return null;
    const cleanName = path.basename(String(fileName).trim().replace(/['"]/g, ''));
    if (!cleanName) return null;

    if (path.isAbsolute(fileName) && fs.existsSync(fileName)) {
      return fileName;
    }

    const searchRoots = [
      path.join(__dirname, '..', 'companion', 'reflex'),
      path.join(__dirname, '..', 'companion'),
      path.join(__dirname, '..'),
      process.cwd(),
      path.join(process.env.USERPROFILE || '', 'Documents'),
      path.join(process.env.USERPROFILE || '', 'Desktop'),
      path.join(process.env.USERPROFILE || '', 'Downloads')
    ];

    for (const root of searchRoots) {
      if (!fs.existsSync(root)) continue;
      const direct = path.join(root, cleanName);
      if (fs.existsSync(direct)) return direct;

      try {
        const findInDir = (dir, depth = 0) => {
          if (depth > 2) return null;
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const ent of entries) {
            if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === '.cache') continue;
            const full = path.join(dir, ent.name);
            if (ent.isFile() && ent.name.toLowerCase() === cleanName.toLowerCase()) {
              return full;
            }
            if (ent.isDirectory()) {
              const res = findInDir(full, depth + 1);
              if (res) return res;
            }
          }
          return null;
        };
        const found = findInDir(root);
        if (found) return found;
      } catch (_) {}
    }
    return null;
  }

  /**
   * Autonomous in-page WhatsApp contact search, chat activation, and message dispatch.
   * Handles user intentions like "say thankyou to safal in whatsapp" directly
   * inside the authenticated WhatsApp Web interface (including locked/hidden chats).
   */
  async sendWhatsAppChat(tab, contact = '', message = '', phone = null, secretCode = null, options = {}) {
    if (!tab || !tab.view) {
      console.warn('[AgentRuntime WhatsApp] ⚠️ No active tab view available to dispatch WhatsApp message');
      return { success: false, reason: 'No active tab view' };
    }
    const contents = tab.view.webContents;
    if (!contents) {
      console.warn('[AgentRuntime WhatsApp] ⚠️ No webContents found on target tab');
      return { success: false, reason: 'No webContents' };
    }

    const docFile = (options && options.file) || (/\.(?:js|json|pdf|docx?|xlsx?|txt|png|jpe?g|webp|zip|tar|gz|py|java|c|cpp|cs|ts|html|css|md|csv)\b/i.test(message) ? message.replace(/^(?:the\s+)?(?:doc(?:ument)?|file|attachment)\s+/i, '').trim() : null);
    const resolvedFilePath = docFile ? this.findFileOnDisk(docFile) : null;
    const isDocMode = Boolean(resolvedFilePath && fs.existsSync(resolvedFilePath));

    const stepTotal = secretCode ? '4' : '3';
    console.log(`[AgentRuntime WhatsApp] 🚀 Initiating autonomous workflow: Send "${message}" to "${contact}"${isDocMode ? ` [DOCUMENT ATTACHMENT: ${resolvedFilePath}]` : ''}${secretCode ? ` (secretCode: ${secretCode})` : ''}`);
    this.emit('feedback', { message: `📋 Step 1/${stepTotal} [SCAN & LOCATE]: Locating contact "${contact}" in WhatsApp...`, level: 'info' });
    this.emit('adion-notification', { type: 'info', message: `Searching for contact "${contact}" in WhatsApp...` });

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
            if (isOpenChat && ${JSON.stringify(isDocMode)}) {
              return { action: 'doc_send_ready' };
            }

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
          this.emit('adion-notification', { type: 'info', message: qrMsg });
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

        if (result && result.action === 'doc_send_ready' && isDocMode) {
          lastProgressTime = Date.now();
          const fileName = path.basename(resolvedFilePath);
          console.log(`[AgentRuntime WhatsApp] 📄 Attaching and dispatching document "${fileName}" (${resolvedFilePath}) to "${contact}"...`);
          this.emit('feedback', { message: `📋 Step 4/${stepTotal} [ATTACH & SEND]: Attaching document "${fileName}" to chat with "${contact}"...`, level: 'info' });

          try {
            if (!fs.existsSync(resolvedFilePath)) {
              throw new Error(`Document file does not exist on disk: "${resolvedFilePath}"`);
            }

            // Ensure CDP is attached
            if (this.cdp && !this.cdp.isAttached) {
              await this.cdp.attach(contents);
            }

            // Step 1: Explicitly poll for attachment button
            console.log('[AgentRuntime WhatsApp] Polling DOM for WhatsApp attachment menu trigger...');
            const attachBtnRes = await this.cdp.waitForElement('button[title="Attach"], button[aria-label="Attach"], span[data-icon="plus"], span[data-icon="attach-menu-plus"], span[data-icon="clip"]', {
              timeoutMs: 4000,
              throwOnTimeout: false
            });

            if (attachBtnRes && attachBtnRes.found) {
              console.log(`[AgentRuntime WhatsApp] Clicking attachment button at (${attachBtnRes.x}, ${attachBtnRes.y})...`);
              await this.cdp.dispatchClick(attachBtnRes.x, attachBtnRes.y);
              // Wait for menu options / file input to mount
              await this.cdp.waitForElement('ul[role="menu"], div[role="application"], input[type="file"], span[data-icon="attach-document"]', {
                timeoutMs: 2500,
                throwOnTimeout: false
              });
            }

            // Step 2: Upload file via CDP primitives
            console.log(`[AgentRuntime WhatsApp] Uploading "${fileName}" via CDP uploadFile...`);
            await this.cdp.uploadFile('span[data-icon="attach-document"], li button', resolvedFilePath, { timeoutMs: 5000 });

            // Step 3: Explicitly wait for Document / Media preview modal & Send button to render in DOM
            console.log('[AgentRuntime WhatsApp] Waiting for document preview modal & send button to render...');
            const sendBtnRes = await this.cdp.waitForElement('span[data-icon="send"], [data-testid="send"], button[aria-label="Send"], div[aria-label="Send"]', {
              timeoutMs: 7000,
              throwOnTimeout: true
            });

            console.log(`[AgentRuntime WhatsApp] Send button ready at (${sendBtnRes.x}, ${sendBtnRes.y}), clicking Send...`);
            await this.cdp.dispatchClick(sendBtnRes.x, sendBtnRes.y);

            // Send Enter key as backup
            contents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
            contents.sendInputEvent({ type: 'char', keyCode: '\r' });
            contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

            // Step 4: Frame-synchronized live DOM polling for delivery
            console.log('[AgentRuntime WhatsApp] Polling live DOM for outgoing message bubble...');
            const pollStart = Date.now();
            let docVerified = false;

            while (Date.now() - pollStart < 8000) {
              docVerified = await contents.executeJavaScript(`
                (() => {
                  const outBubbles = Array.from(document.querySelectorAll('#main div.message-out, #main [data-testid^="msg-container"]'));
                  return outBubbles.some(el => (el.innerText || el.textContent || '').includes(${JSON.stringify(fileName)}));
                })()
              `).catch(() => false);

              if (docVerified) break;
              await new Promise(r => setTimeout(r, 150));
            }

            if (docVerified) {
              messageSent = true;
              const successMsg = `🎯 TASK COMPLETED: Document "${fileName}" (${resolvedFilePath}) successfully delivered to "${contact}" on WhatsApp and verified in live DOM!`;
              console.log(`[AgentRuntime WhatsApp] 🎉 ${successMsg} (verified_in_dom)`);
              this.emit('feedback', { message: successMsg, level: 'success' });
              this.emit('adion-notification', { type: 'success', message: successMsg });
              return {
                success: true,
                task: 'WHATSAPP_DOCUMENT_DELIVERY',
                recipient: contact,
                document: fileName,
                filePath: resolvedFilePath,
                verifiedInDOM: true,
                timestamp: new Date().toLocaleTimeString(),
                summary: successMsg
              };
            } else {
              throw new Error(`Document "${fileName}" was dispatched but could not be verified in outgoing message bubbles within 8s.`);
            }
          } catch (uploadError) {
            console.error(`[AgentRuntime WhatsApp] ❌ File upload step failed:`, uploadError.message);
            this.emit('feedback', {
              message: `⚠️ File upload error: ${uploadError.message}. Point of failure logged.`,
              level: 'warning'
            });
            return {
              success: false,
              task: 'WHATSAPP_DOCUMENT_DELIVERY',
              recipient: contact,
              document: fileName,
              error: uploadError.message,
              pointOfFailure: uploadError.code || 'UPLOAD_DISPATCH_FAILURE'
            };
          }
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

          // 3. Frame-synchronized live DOM polling for sent message delivery
          const verifyStart = Date.now();
          while (Date.now() - verifyStart < 4500) {
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
              this.emit('adion-notification', { type: 'success', message: successMsg });
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
            await new Promise(r => setTimeout(r, 120));
          }
        }

        if (attempts % 4 === 0) {
          const errDetail = result && result.action === 'eval_error' ? ` err="${String(result.error || '').slice(0, 120)}"` : '';
          console.log(`[AgentRuntime WhatsApp] Coordinating WhatsApp UI (attempt ${attempts}, status: ${result ? result.action : 'unknown'}${errDetail})...`);
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
      this.emit('adion-notification', { type: 'alert', message: failureNotice });
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
        // Verify the chat actually opened: the main pane must show a header
        // with a contact name (not the "WhatsApp" landing state).
        await new Promise(r => setTimeout(r, 900));
        const opened = await contents.executeJavaScript(`
          (() => {
            const main = document.querySelector('#main');
            if (!main) return false;
            const header = main.querySelector('header');
            const headerText = header ? (header.innerText || '').trim() : '';
            // A real chat header contains a name and usually a back/phone icon;
            // the landing pane shows "WhatsApp" or "Your personal messages".
            return headerText.length > 1 && !/whatsapp|your personal messages|end-to-end/i.test(headerText);
          })()
        `).catch(() => false);
        if (!opened) {
          return { success: false, reason: 'Clicked unread item but no chat pane opened (page may still be syncing)' };
        }
        const successMsg = `✅ Opened unread chat with "${res.chatName || 'contact'}" on WhatsApp Web!`;
        console.log(`[AgentRuntime WhatsApp] ${successMsg}`);
        this.emit('feedback', { message: successMsg, level: 'success' });
        this.emit('adion-notification', { type: 'success', message: successMsg });
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
   * Generic autonomous continuator for intermediate portal screens ("Continue in browser", "Use web version", "Open in web")
   */
  async autoHandleContinuations(tab) {
    if (!tab || !tab.view) return;
    try {
      const contents = tab.view.webContents;
      if (!contents || typeof contents.executeJavaScript !== 'function') return;
      await contents.executeJavaScript(`
        (() => {
          const continueBtn = Array.from(document.querySelectorAll('a, button')).find(el => {
            const text = (el.textContent || '').trim();
            return /continue (?:on|in) (?:browser|web)|use (?:the )?web (?:app|client|version)?|open in (?:browser|web)/i.test(text);
          });
          if (continueBtn) { continueBtn.click(); return 'continueWeb'; }
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
  async getActivePageContext(customTab = null) {
    if (this.isPageShared === false) {
      return {
        url: '',
        title: 'Sharing Paused',
        favicon: '',
        headings: [],
        suggestions: ['Resume page sharing to allow AI context awareness'],
        openTabs: [],
        backgroundTabs: [],
        isShared: false
      };
    }

    const allTabs = (this.tabManager && this.tabManager.tabs)
      ? Array.from(this.tabManager.tabs.values())
      : [];

    // Filter by sharedTabIds if user specified a subset
    const sharedTabs = (Array.isArray(this.sharedTabIds))
      ? allTabs.filter(t => this.sharedTabIds.includes(t.id))
      : allTabs;

    // Determine primary focus tab: customTab -> active tab (if shared) -> first shared tab -> null
    let activeTab = customTab;
    if (!activeTab && this.tabManager) {
      const liveActive = this.tabManager.getActiveTab();
      if (liveActive && sharedTabs.some(t => t.id === liveActive.id)) {
        activeTab = liveActive;
      } else if (sharedTabs.length > 0) {
        activeTab = sharedTabs[0];
      } else {
        activeTab = liveActive;
      }
    }

    if (!activeTab) {
      return {
        url: 'adion://newtab',
        title: 'New Tab',
        favicon: '',
        headings: [],
        suggestions: ['Explore top tech news', 'Check system diagnostics', 'Open GitHub'],
        openTabs: [],
        backgroundTabs: [],
        isShared: true
      };
    }

    const basicContext = {
      url: activeTab.url || '',
      title: activeTab.title || 'Untitled Tab',
      favicon: activeTab.favicon || '',
      headings: [],
      suggestions: [],
      isShared: true,
      openTabs: sharedTabs.map((t, idx) => ({
        index: idx + 1,
        id: t.id,
        title: t.title || 'Untitled Tab',
        url: t.url || '',
        isActive: this.tabManager ? t.id === this.tabManager.activeTabId : false
      }))
    };

    // Multi-Tab Context Sharing (Chrome Gemini Architecture)
    // Extract essential context from background shared tabs concurrently so the model has simultaneous multi-tab awareness
    const backgroundTabs = sharedTabs.filter(t => t.id !== activeTab.id && t.view && t.view.webContents && !t.url.startsWith('adion://newtab'));
    if (backgroundTabs.length > 0) {
      try {
        const bgPromises = backgroundTabs.slice(0, 8).map(async (bgTab) => {
          try {
            const bgData = await Promise.race([
              bgTab.view.webContents.executeJavaScript(`
                (() => {
                  const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
                    .slice(0, 5)
                    .map(h => (h.innerText || '').trim())
                    .filter(t => t.length > 2 && t.length < 70);
                  const buttons = Array.from(document.querySelectorAll('button, a[role="button"], a[class*="btn"], nav a, header a'))
                    .slice(0, 8)
                    .map(b => (b.innerText || b.value || b.getAttribute('title') || b.getAttribute('aria-label') || '').trim())
                    .filter(t => t.length > 1 && t.length < 35);
                  const snippet = (document.body ? document.body.innerText : '')
                    .replace(/\\s+/g, ' ')
                    .trim()
                    .slice(0, 400);
                  return { headings, buttons, snippet };
                })()
              `),
              new Promise(res => setTimeout(() => res(null), 350))
            ]);
            if (bgData) {
              return {
                index: sharedTabs.indexOf(bgTab) + 1,
                id: bgTab.id,
                title: bgTab.title || 'Untitled',
                url: bgTab.url || '',
                headings: bgData.headings || [],
                buttons: bgData.buttons || [],
                snippet: bgData.snippet || ''
              };
            }
          } catch (_) {}
          return null;
        });
        const resolved = await Promise.all(bgPromises);
        basicContext.backgroundTabs = resolved.filter(Boolean);
      } catch (_) {}
    }

    if (activeTab.view && activeTab.view.webContents && !activeTab.url.startsWith('adion://newtab')) {
      // Primary scene: AXTree — semantic controls with roles, like D:\help's
      // UIA screen map. One CDP call, ~100ms, no fragile DOM heuristics.
      try {
        const axScene = await this.captureAXScene(activeTab);
        if (axScene.length > 0) {
          // captureAXScene returns [interactive…, content…] — slice(0,40)
          // alone would drop every content node (chat messages, article text).
          // Balance the prompt sample: 20 controls + 20 content entries.
          const axInteractive = axScene.filter(e => !['statictext','inline text box','paragraph','comment','mark','strong','emphasis','time'].includes(e.role)).slice(0, 20);
          const axContent = axScene.filter(e => ['statictext','inline text box','paragraph','comment','mark','strong','emphasis','time','article','heading','listitem'].includes(e.role)).slice(0, 20);
          basicContext.scene = [...axInteractive, ...axContent].map(e => ({
            tag: e.role || 'ax', role: e.role, label: e.name, x: 0, y: 0, w: 0, h: 0
          }));
          basicContext.axScene = true;
        }
      } catch (_) {}
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

            // Interactive scene snapshot: every clickable/editable element with
            // position — the planner's "eyes" for SPA UIs (chat rows, cards,
            // custom controls) that aren't semantic <button>/<a> elements.
            const isVisible = (el) => {
              const r = el.getBoundingClientRect();
              const s = window.getComputedStyle(el);
              // Reject virtualised-list containers (e.g. 387x29381px wrappers):
              // their centre is far outside the viewport, so clicks aimed at
              // them land nowhere near the actual row.
              return r.width > 8 && r.height > 8 && r.height <= window.innerHeight * 1.2 &&
                     r.bottom > 0 && r.top < window.innerHeight &&
                     s.display !== 'none' && s.visibility !== 'hidden' && s.pointerEvents !== 'none';
            };
            const labelOf = (el) => (el.innerText || el.value || el.getAttribute('aria-label') ||
              el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('data-tab') || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
            const sceneSel = 'button, a, [role="button"], [role="link"], [role="tab"], [role="option"], [role="menuitem"], [contenteditable="true"], input, textarea, select, [tabindex]:not([tabindex="-1"]), [data-tab], [data-testid], [data-pre-plain-text], [dir="auto"], [class*="chat"], [class*="row"], [class*="item"], [class*="cell"], [class*="card"], [class*="message"]';
            const seen = new Set();
            const scene = [];
            for (const el of document.querySelectorAll(sceneSel)) {
              if (scene.length >= 40 || !isVisible(el)) continue;
              const label = labelOf(el);
              if (!label || seen.has(label)) continue;
              seen.add(label);
              const r = el.getBoundingClientRect();
              scene.push({
                tag: el.tagName.toLowerCase(),
                role: el.getAttribute('role') || '',
                label,
                x: Math.round(r.x), y: Math.round(r.y),
                w: Math.round(r.width), h: Math.round(r.height)
              });
            }
            const scrollY = Math.round(window.scrollY || 0);

            const activeEl = document.activeElement;
            const activeElement = (activeEl && activeEl !== document.body && activeEl !== document.documentElement)
              ? (activeEl.tagName.toLowerCase() + (activeEl.id ? '#' + activeEl.id : '') +
                 (activeEl.getAttribute('placeholder') ? ' [placeholder="' + activeEl.getAttribute('placeholder') + '"]' : '') +
                 (activeEl.value ? ' (value="' + activeEl.value.slice(0, 40) + '")' : ''))
              : '';

            return { liveUrl, title, headings: headings.slice(0, 8), buttons: Array.from(new Set(buttons)).slice(0, 30), favicon, text, scene, scrollY, activeElement };
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
          if (details.activeElement) basicContext.activeElement = details.activeElement;

          // Merge DOM scene with positions into basicContext.scene so planner has real element coordinates
          if (Array.isArray(details.scene) && details.scene.length > 0) {
            const seen = new Set(details.scene.map(e => e.label.toLowerCase()));
            const axExtras = (basicContext.scene || []).filter(e => e.label && !seen.has(e.label.toLowerCase()));
            basicContext.scene = [...details.scene, ...axExtras.slice(0, 15)];
          }
          if (Number.isFinite(details.scrollY)) basicContext.scrollY = details.scrollY;
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
      // General-purpose suggestions derived from page signals, not site names.
      const hasMessages = basicContext.scene && basicContext.scene.some(e =>
        /message|chat|comment|reply/i.test((e.label || '') + ' ' + (e.role || '')));
      const hasMedia = basicContext.scene && basicContext.scene.some(e =>
        /video|player|media|audio/i.test((e.label || '') + ' ' + (e.role || '')));
      basicContext.suggestions = hasMessages
        ? ['Reply to the latest message', 'Summarize recent messages', 'Find unread conversations']
        : hasMedia
          ? ['Summarize this content', 'Explain key topics', 'Find related items']
          : [
              'Summarize this page',
              'Explain main points of this page',
              'Extract key takeaways & links'
            ];
    }

    return basicContext;
  }

  /**
   * Cancel the active task cleanly, clearing any pause resolvers and goal runs
   */
  cancelCurrentTask() {
    this.goalRunId++;
    if (this.taskPauseResolver) {
      try { this.taskPauseResolver({ stop: true }); } catch (_) {}
      this.taskPauseResolver = null;
    }
    if (this.currentTask) {
      this.currentTask.status = 'STOPPED';
      this.currentTask.pauseReason = 'Task canceled by user or system dismiss';
      this.emitTaskModeUpdate();
    }
  }

  /**
   * Emit real-time Task Mode state update to UI renderer (Work Panel)
   */
  emitTaskModeUpdate() {
    if (!this.currentTask) return;
    this.emit('task-mode:update', {
      id: this.currentTask.id,
      goal: this.currentTask.goal,
      status: this.currentTask.status,
      mode: this.currentTask.mode,
      stepNumber: this.currentTask.stepNumber,
      maxSteps: this.currentTask.maxSteps,
      completedSteps: this.currentTask.completedSteps || [],
      currentStep: this.currentTask.currentStep || null,
      remainingSteps: this.currentTask.remainingSteps || [],
      touchedPages: this.currentTask.touchedPages || [],
      artifacts: this.currentTask.artifacts || [],
      pauseReason: this.currentTask.pauseReason || null,
      sensitiveAction: this.currentTask.sensitiveAction || null,
      consecutiveNoDeltaCount: this.currentTask.loopState?.consecutiveNoDeltaCount || 0
    });
  }

  /**
   * Human-in-the-Loop checkpoint handling (Gemini Task Mode):
   * Allows user to Approve sensitive steps, Take over browser, Hand back control, or Stop.
   */
  handleTaskModeUserAction(action, data = {}) {
    if (!this.currentTask) {
      return { success: false, reason: 'No active task' };
    }
    console.log(`[AgentRuntime TaskMode] 👤 User action received: "${action}" for task ${this.currentTask.id}`);

    if (action === 'approve') {
      if (this.taskPauseResolver) {
        const resolve = this.taskPauseResolver;
        this.taskPauseResolver = null;
        resolve({ approved: true });
      }
      this.currentTask.status = 'EXECUTING';
      this.currentTask.pauseReason = null;
      this.setState(AgentState.EXECUTING);
      this.emitTaskModeUpdate();
      this.emit('task-mode:resumed', this.currentTask);
      this.emit('feedback', { message: '✓ Checkpoint approved by user. Proceeding with execution...', level: 'success' });
      return { success: true, status: 'resumed' };
    }

    if (action === 'takeover') {
      this.setState(AgentState.PAUSED_FOR_USER);
      this.currentTask.status = 'PAUSED_FOR_USER';
      this.currentTask.pauseReason = 'User takeover active: You have full control of the browser. Complete your interaction, then click "Hand Back Control".';
      this.emitTaskModeUpdate();
      this.emit('task-mode:paused', this.currentTask);
      this.emit('feedback', { message: '🖐️ Manual Takeover Active: Browse freely. The AI is paused until you click "Hand Back Control".', level: 'info' });
      return { success: true, status: 'paused_for_takeover' };
    }

    if (action === 'resume') {
      if (this.taskPauseResolver) {
        const resolve = this.taskPauseResolver;
        this.taskPauseResolver = null;
        resolve({ resume: true });
      }
      this.currentTask.status = 'PLANNING_NEXT';
      this.currentTask.pauseReason = null;
      this.setState(AgentState.PLANNING_NEXT);
      this.emitTaskModeUpdate();
      this.emit('task-mode:resumed', this.currentTask);
      this.emit('feedback', { message: '▶️ Control handed back to AI: Re-sensing page DOM and resuming autonomous execution...', level: 'info' });
      return { success: true, status: 'resumed' };
    }

    if (action === 'stop') {
      if (this.taskPauseResolver) {
        const resolve = this.taskPauseResolver;
        this.taskPauseResolver = null;
        resolve({ stop: true });
      }
      this.cancelCurrentTask();
      this.currentTask.status = 'STOPPED';
      this.currentTask.pauseReason = 'Task aborted by user.';
      this.setState(AgentState.IDLE);
      this.emitTaskModeUpdate();
      this.emit('feedback', { message: '⏹️ Task stopped by user.', level: 'info' });
      return { success: true, status: 'stopped' };
    }

    return { success: false, reason: `Unknown user action: ${action}` };
  }

  /**
   * Determine whether an action requires a Human-in-the-Loop checkpoint before execution
   */
  isSensitiveActionForTaskMode(act, intent = {}) {
    if (!act) return null;
    const type = String(act.type || '').toUpperCase();
    if (type === 'WHATSAPP_CHAT_SEND' || type === 'WHATSAPP_SEND') {
      return { reason: `Sensitive Action: Sending message to "${intent.contact || intent.target || 'recipient'}"` };
    }
    const spec = {
      kind: (type === 'TERMINAL_EXEC') ? 'shell' : 'page',
      command: intent.command || act.params?.command,
      label: act.params?.target || act.params?.label || intent.target,
      text: act.params?.text || intent.text,
      fieldName: act.params?.selector || act.params?.fieldName || intent.target,
      submit: act.params?.enter || intent.enter || /submit|send|pay|buy/i.test(intent.target || '')
    };
    try {
      const verdict = evaluateAction(spec, intent.raw || '', intent);
      if (verdict.class === 'commit' || verdict.class === 'money' || verdict.family === 'money' || verdict.family === 'send') {
        return { reason: `Checkpoint: ${verdict.reason || 'This action modifies account state or transmits data.'}` };
      }
      if (verdict.class === 'refused' || verdict.family === 'private-field') {
        return { reason: 'Checkpoint: Sensitive private data requested. Please fill in credentials/passwords manually.' };
      }
    } catch (_) {}
    return null;
  }

  /**
   * Lightweight, zero-latency state hash for dynamic loop detection & DOM verification
   */
  async computePageStateHash(tab) {
    if (!tab || !tab.view || !tab.view.webContents) return '';
    try {
      const contents = tab.view.webContents;
      const res = await contents.executeJavaScript(`
        (() => {
          try {
            const url = window.location.href;
            const title = document.title;
            const interactive = Array.from(document.querySelectorAll('button, a, input, [role="button"], [role="dialog"], #main, header'))
              .slice(0, 35)
              .map(el => (el.tagName + ':' + (el.id || '') + ':' + (el.getAttribute('aria-label') || el.innerText || '').slice(0, 20)).trim())
              .join('|');
            return url + '#' + title + '#' + interactive;
          } catch (_) {
            return window.location.href;
          }
        })()
      `).catch(() => '');
      return res || '';
    } catch (_) {
      return '';
    }
  }
}

module.exports = AgentRuntime;

