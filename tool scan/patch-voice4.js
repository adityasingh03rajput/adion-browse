/**
 * Voice-garble fix part 4 for D:\Adion Browse (src/renderer/app.js).
 *  #4 Migrate mic capture ScriptProcessorNode (deprecated, main thread,
 *     glitches under UI load -> choppy PCM -> garbled Whisper) to
 *     AudioWorkletNode (audio thread) with sequence-number gap logging,
 *     keeping the legacy path as automatic fallback.
 * Idempotent. Usage on PC: node patch-voice4.js (run from "D:\Adion Browse")
 */
'use strict';
const fs = require('fs');
const path = require('path');
const APP = path.join(process.cwd(), 'src', 'renderer', 'app.js');
const changed = [];
function rep(label, oldStr, newStr) {
  let s = fs.readFileSync(APP, 'utf8');
  if (!s.includes(oldStr)) {
    if (s.includes(newStr.slice(0, 60))) { console.log(`SKIP ${label}: already patched`); return; }
    throw new Error(`${label}: anchor not found`);
  }
  const count = s.split(oldStr).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 occurrence, found ${count}`);
  fs.writeFileSync(APP, s.split(oldStr).join(newStr));
  changed.push(label);
  console.log(`OK ${label}`);
}

rep('#4a worklet state vars',
`  let audioContext = null;
  let scriptProcessor = null;
  let micSourceNode = null;`,
`  let audioContext = null;
  let scriptProcessor = null;
  let micSourceNode = null;
  let voiceWorkletNode = null; // AudioWorklet capture node (preferred path)
  let voiceSeqExpected = 0; // next expected worklet chunk seq (gap detection)`);

rep('#4b shared frame handler',
`      // 4096 buffer on hardware rate = ~85ms at 48kHz
      scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);

      let chunksSent = 0;
      scriptProcessor.onaudioprocess = (e) => {
        if (!isListening) return;
        const inputData = e.inputBuffer.getChannelData(0);`,
`      // Voice frames: AudioWorklet (audio thread, gap-tracked) preferred —
      // legacy ScriptProcessor fallback is wired below if worklets fail.
      // NOTE: both paths funnel through handleVoiceFrame, so DSP is identical.
      let chunksSent = 0;
      voiceSeqExpected = 0;
      const handleVoiceFrame = (inputData, seq) => {
        if (!isListening) return;
        if (typeof seq === 'number') {
          if (seq !== voiceSeqExpected) {
            try { window.adionAPI.log(\`[Voice UI] dropped audio chunk(s): got seq \${seq}, expected \${voiceSeqExpected}\`); } catch(_) {}
          }
          voiceSeqExpected = seq + 1;
        }`);

rep('#4c worklet wiring + fallback',
`        // Stream raw PCM frame across IPC to Control Plane / Local Model
        window.adionAPI.agent.sendVoiceChunk(pcmBuffer.buffer);
      };

      // Route through a zero-gain node: ScriptProcessorNode only pulls audio when
      // connected toward destination, but the mic must never play through the
      // speakers (feedback/echo). A muted gain keeps the graph alive silently.
      const micMuteGain = audioContext.createGain();
      micMuteGain.gain.value = 0;
      micSourceNode.connect(scriptProcessor);
      scriptProcessor.connect(micMuteGain);
      micMuteGain.connect(audioContext.destination);`,
`        // Stream raw PCM frame across IPC to Control Plane / Local Model
        window.adionAPI.agent.sendVoiceChunk(pcmBuffer.buffer);
      };

      // Route through a zero-gain node: audio nodes only pull when connected
      // toward destination, but the mic must never play through the speakers
      // (feedback/echo). A muted gain keeps the graph alive silently.
      const micMuteGain = audioContext.createGain();
      micMuteGain.gain.value = 0;
      let voiceCaptureReady = false;
      if (audioContext.audioWorklet && audioContext.audioWorklet.addModule) {
        try {
          await audioContext.audioWorklet.addModule(new URL('./voice-capture.worklet.js', document.baseURI));
          voiceWorkletNode = new AudioWorkletNode(audioContext, 'adion-voice-capture');
          voiceWorkletNode.port.onmessage = (ev) => {
            const msg = ev.data || {};
            if (msg.pcm) handleVoiceFrame(new Float32Array(msg.pcm), msg.seq);
          };
          micSourceNode.connect(voiceWorkletNode);
          voiceWorkletNode.connect(micMuteGain);
          voiceCaptureReady = true;
          try { window.adionAPI.log('[Voice UI] AudioWorklet capture active (gap-tracked, 4096-sample blocks)'); } catch(_) {}
        } catch (workletErr) {
          try { window.adionAPI.log('[Voice UI] AudioWorklet unavailable, ScriptProcessor fallback: ' + (workletErr && workletErr.message ? workletErr.message : workletErr)); } catch(_) {}
          voiceWorkletNode = null;
        }
      }
      if (!voiceCaptureReady) {
        // Legacy fallback: deprecated ScriptProcessorNode on the main thread.
        // Glitches under UI load (dropped/duplicated chunks garble Whisper).
        scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
        scriptProcessor.onaudioprocess = (e) => handleVoiceFrame(e.inputBuffer.getChannelData(0));
        micSourceNode.connect(scriptProcessor);
        scriptProcessor.connect(micMuteGain);
      }
      micMuteGain.connect(audioContext.destination);`);

rep('#4d worklet teardown',
`    if (scriptProcessor) {
      try { scriptProcessor.disconnect(); } catch (_) {}
      scriptProcessor = null;
    }`,
`    if (voiceWorkletNode) {
      try { voiceWorkletNode.disconnect(); } catch (_) {}
      try { voiceWorkletNode.port.close(); } catch (_) {}
      voiceWorkletNode = null;
    }
    if (scriptProcessor) {
      try { scriptProcessor.disconnect(); } catch (_) {}
      scriptProcessor = null;
    }`);

console.log('\nPatched: ' + (changed.length ? changed.join(', ') : 'nothing'));
