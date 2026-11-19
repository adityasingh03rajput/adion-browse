/**
 * Voice-garble fix part 4b: worklet teardown in BOTH cleanup sites
 * (stale-cleanup at mic start + stopMicrophoneStream).
 * Usage on PC: node patch-voice4b.js (run from "D:\Adion Browse")
 */
'use strict';
const fs = require('fs');
const path = require('path');
const APP = path.join(process.cwd(), 'src', 'renderer', 'app.js');
const oldStr = `    if (scriptProcessor) {
      try { scriptProcessor.disconnect(); } catch (_) {}
      scriptProcessor = null;
    }`;
const newStr = `    if (typeof voiceWorkletNode !== 'undefined' && voiceWorkletNode) {
      try { voiceWorkletNode.disconnect(); } catch (_) {}
      try { voiceWorkletNode.port.close(); } catch (_) {}
      voiceWorkletNode = null;
    }
    if (scriptProcessor) {
      try { scriptProcessor.disconnect(); } catch (_) {}
      scriptProcessor = null;
    }`;
let s = fs.readFileSync(APP, 'utf8');
if (!s.includes(oldStr)) {
  console.log(s.includes('voiceWorkletNode.disconnect') ? 'SKIP: already patched' : 'ANCHOR MISSING');
  process.exit(s.includes('voiceWorkletNode.disconnect') ? 0 : 1);
}
const count = s.split(oldStr).length - 1;
if (count !== 2) throw new Error('expected 2 occurrences, found ' + count);
fs.writeFileSync(APP, s.split(oldStr).join(newStr));
console.log('OK #4d worklet teardown x2');
