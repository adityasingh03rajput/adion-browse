/**
 * Voice-garble fix part 3 for D:\Adion Browse (sttEngine.js).
 *  #5 local Whisper: dynamic timeout scaled to audio length (was fixed 600ms,
 *     so every real utterance timed out and fell through to the guesser)
 *  #6 Groq Whisper: vocabulary prompt biasing short commands
 *     ("close tab" no longer decodes as "clothes tub")
 *  cleanup: fix docstring misplaced by part-1 patch (rmsOf vs classifier)
 * Idempotent. Usage on PC: node patch-voice3.js (run from "D:\Adion Browse")
 */
'use strict';
const fs = require('fs');
const path = require('path');
const STT = path.join(process.cwd(), 'src', 'control-plane', 'sttEngine.js');
const changed = [];
function rep(label, oldStr, newStr) {
  let s = fs.readFileSync(STT, 'utf8');
  if (!s.includes(oldStr)) {
    if (s.includes(newStr.slice(0, 60))) { console.log(`SKIP ${label}: already patched`); return; }
    throw new Error(`${label}: anchor not found`);
  }
  const count = s.split(oldStr).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 occurrence, found ${count}`);
  fs.writeFileSync(STT, s.split(oldStr).join(newStr));
  changed.push(label);
  console.log(`OK ${label}`);
}

rep('#5 dynamic local timeout',
`  async queryLocalWhisper(pcmBuffer) {
    const wavBuffer = this.createWavBuffer(pcmBuffer);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600);`,
`  async queryLocalWhisper(pcmBuffer) {
    const wavBuffer = this.createWavBuffer(pcmBuffer);
    const controller = new AbortController();
    // Voice-garble fix: the old fixed 600ms aborted every real utterance
    // (whisper.cpp needs ~0.3-0.5x audio duration), so the local path NEVER
    // succeeded and everything fell through to the acoustic guesser.
    const audioMs = pcmBuffer ? (pcmBuffer.length / 32) : 0; // 16kHz 16-bit mono
    const budgetMs = Math.min(15000, Math.max(2500, 1500 + audioMs * 0.6));
    const timeout = setTimeout(() => controller.abort(), budgetMs);`);

rep('#6 vocabulary prompt',
`    formData.append('model', config.groqWhisperModel || 'whisper-large-v3-turbo');
    formData.append('response_format', 'json');`,
`    formData.append('model', config.groqWhisperModel || 'whisper-large-v3-turbo');
    formData.append('response_format', 'json');
    // Voice-garble fix: bias the decoder toward our command vocabulary so
    // short commands ("close tab") don't decode as lookalikes ("clothes tub").
    // Whisper treats prompt as context/style primer, not as transcript.
    formData.append('prompt', 'Browser voice commands: open youtube, open google, new tab, close tab, go back, go forward, reload, scroll down, scroll up, search, stop, cancel, never mind, next, continue. The speaker gives one short browser command.');`);

rep('cleanup rmsOf docstring',
`  /**
   * Acoustic Cadence, Zero-Crossing Rate (ZCR) and Syllabic Envelope Matcher
   * Classifies core browser command intents from raw PCM audio features
   */
  /** RMS of an Int16 PCM buffer, 0..1 — used to gate the acoustic fallback. */
  rmsOf(pcmBuffer) {`,
`  /**
   * RMS of an Int16 PCM buffer, 0..1 — used to gate the acoustic fallback.
   */
  rmsOf(pcmBuffer) {`);

rep('restore classifier docstring',
`  classifyAcousticCommand(pcmBuffer) {`,
`  /**
   * Acoustic Cadence, Zero-Crossing Rate (ZCR) and Syllabic Envelope Matcher.
   * Classifies core browser command intents from raw PCM audio features.
   * NOTE: only used when acousticFallback is explicitly enabled (default off).
   */
  classifyAcousticCommand(pcmBuffer) {`);

console.log('\nPatched: ' + (changed.length ? changed.join(', ') : 'nothing'));
