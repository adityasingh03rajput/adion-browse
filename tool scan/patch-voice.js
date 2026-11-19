/**
 * Voice-garble fix patch for D:\Adion Browse.
 * Applies 3 agreed fixes, idempotent (safe to re-run):
 *  #1 sttEngine.js: gate acoustic fallback (default OFF + RMS gate) + rmsOf helper
 *  #2 sttEngine.js: gentler AGC (2x cap, noise gate, no double-boost)
 *  #3 agentRuntime.js: ms-based VAD endpointing (main + pending buffers)
 * Usage on PC:  node patch-voice.js  (run from "D:\Adion Browse")
 * Backups are expected at src\control-plane\*.bak-voicefix (made earlier).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const STT = path.join(ROOT, 'src', 'control-plane', 'sttEngine.js');
const RT = path.join(ROOT, 'src', 'control-plane', 'agentRuntime.js');

let changed = [];
function replaceOnce(file, label, oldStr, newStr, expectCount = 1) {
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes(newStr.slice(0, 80)) && !s.includes(oldStr)) {
    console.log(`SKIP ${label}: already patched`);
    return;
  }
  const count = s.split(oldStr).length - 1;
  if (count !== expectCount) throw new Error(`${label}: expected ${expectCount} occurrence(s), found ${count}`);
  s = s.split(oldStr).join(newStr);
  fs.writeFileSync(file, s);
  changed.push(label);
  console.log(`OK ${label}`);
}

// ---------- #1a: constructor gate ----------
replaceOnce(STT, '#1a constructor gate',
`  constructor(options = {}) {
    this.whisperEndpoint = options.whisperEndpoint || 'http://127.0.0.1:8080/inference';
    this.sampleRate = 16000;
  }`,
`  constructor(options = {}) {
    this.whisperEndpoint = options.whisperEndpoint || 'http://127.0.0.1:8080/inference';
    this.sampleRate = 16000;
    // Voice-garble fix: the acoustic guesser must NEVER invent a command from
    // noise/silence. Default OFF — Whisper silence returns '' instead.
    // Enable only for offline demos: new STTEngine({ acousticFallback: true }).
    this.acousticFallback = options.acousticFallback === true;
    this.acousticMinRms = options.acousticMinRms || 0.03;
  }`);

// ---------- #1b: gate fallback + rmsOf helper ----------
replaceOnce(STT, '#1b fallback gate',
`    // 3. Fast Acoustic & Phonetic Pattern Matcher
    if (!rawTranscript) {
      const classifiedText = this.classifyAcousticCommand(pcmBuffer);
      console.log(\`[STTEngine] Acoustic Classifier matched: "\${classifiedText}"\`);
      rawTranscript = classifiedText;
    }`,
`    // 3. Fast Acoustic & Phonetic Pattern Matcher (GATED — see constructor).
    // Previously this ALWAYS invented a command ('scroll down', 'open youtube',
    // ...) from any noise/silence whenever Whisper came back empty. Now it only
    // runs when explicitly enabled AND the audio is loud enough to be speech.
    if (!rawTranscript && this.acousticFallback) {
      const rms = this.rmsOf(pcmBuffer);
      if (rms >= this.acousticMinRms) {
        const classifiedText = this.classifyAcousticCommand(pcmBuffer);
        console.log(\`[STTEngine] Acoustic Classifier matched: "\${classifiedText}" (rms \${rms.toFixed(4)})\`);
        rawTranscript = classifiedText;
      } else {
        console.log(\`[STTEngine] Acoustic fallback skipped: too quiet (rms \${rms.toFixed(4)}) — returning silence\`);
      }
    }`);

replaceOnce(STT, '#1c rmsOf helper',
`  classifyAcousticCommand(pcmBuffer) {`,
`  /** RMS of an Int16 PCM buffer, 0..1 — used to gate the acoustic fallback. */
  rmsOf(pcmBuffer) {
    if (!pcmBuffer || pcmBuffer.length < 2) return 0;
    let sum = 0;
    const n = Math.floor(pcmBuffer.length / 2);
    for (let i = 0; i < pcmBuffer.length - 1; i += 2) {
      const v = pcmBuffer.readInt16LE(i) / 32768.0;
      sum += v * v;
    }
    return n > 0 ? Math.sqrt(sum / n) : 0;
  }

  classifyAcousticCommand(pcmBuffer) {`);

// ---------- #2: gentler AGC ----------
replaceOnce(STT, '#2 gentle AGC',
`    // If audio is quiet (peak under 65% full scale), apply dynamic boost up to 4.5x
    if (maxAmp > 100 && maxAmp < 22000) {
      const multiplier = Math.min(4.5, 24000 / maxAmp);`,
`    // Gentle AGC (voice-garble fix): the browser already runs autoGainControl
    // plus a 1.35x preamp, so this stage must NOT double-boost room noise.
    // Cap 2x, require a real signal (peak >= 1500), leave loud audio alone
    // (peak >= 16000), and skip near-silence (rms < 0.02) entirely.
    let rmsLevel = 0;
    {
      let sumSq = 0;
      const n = Math.floor(pcmBuffer.length / 2);
      for (let i = 0; i < pcmBuffer.length - 1; i += 2) {
        const v = pcmBuffer.readInt16LE(i) / 32768.0;
        sumSq += v * v;
      }
      rmsLevel = n > 0 ? Math.sqrt(sumSq / n) : 0;
    }
    if (maxAmp >= 1500 && maxAmp < 16000 && rmsLevel >= 0.02) {
      const multiplier = Math.min(2.0, 13000 / maxAmp);`);

// ---------- #3a: main VAD ms-based ----------
replaceOnce(RT, '#3a main VAD ms',
`    } else if (this.audioSession.speechDetected && !this.audioSession.isSegmenting) {
      this.audioSession.consecutiveSilenceFrames++;
      // Natural speech pause: configurable pause duration (~450ms per nus-companion)
      if (this.audioSession.consecutiveSilenceFrames >= 9 && this.audioSession.chunks.length >= 5) {
        // Discard transient acoustic clicks or breath under minSpeechMs threshold
        const minSpeechFrames = Math.ceil(this.audioSession.minSpeechMs / 128); // 128ms per frame
        if ((this.audioSession.speechFramesCount || 0) < minSpeechFrames) {`,
`    } else if (this.audioSession.speechDetected && !this.audioSession.isSegmenting) {
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
        if (speechMs < (this.audioSession.minSpeechMs || 350)) {`);

// ---------- #3b: pending VAD ms-based ----------
replaceOnce(RT, '#3b pending VAD ms',
`    } else if (P.speechDetected) {
      P.consecutiveSilenceFrames++;
      if (P.consecutiveSilenceFrames >= 9 && P.chunks.length >= 5) {
        const minSpeechFrames = Math.ceil((this.audioSession.minSpeechMs || 350) / 128);
        if ((P.speechFramesCount || 0) >= minSpeechFrames) {`,
`    } else if (P.speechDetected) {
      P.consecutiveSilenceFrames++;
      // Voice-garble fix: same ms-based endpointing as the main buffer.
      const msPerChunkP = Math.max(20, buffer.length / 32);
      const minChunksP = Math.max(2, Math.ceil(240 / msPerChunkP));
      if (P.consecutiveSilenceFrames * msPerChunkP >= (this.audioSession.pauseMs || 450) && P.chunks.length >= minChunksP) {
        const speechMsP = (P.speechFramesCount || 0) * msPerChunkP;
        if (speechMsP >= (this.audioSession.minSpeechMs || 350)) {`);

console.log('\nPatched: ' + (changed.length ? changed.join(', ') : 'nothing (all skipped)'));
