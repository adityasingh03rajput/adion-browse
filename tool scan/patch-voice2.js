/**
 * Voice-garble fix follow-up for D:\Adion Browse (part 2).
 * Extends sttEngine.js hallucination filter: Whisper returns "Thank you." / "."
 * for pure digital silence — these must not become commands.
 * Idempotent. Usage on PC: node patch-voice2.js (run from "D:\Adion Browse")
 */
'use strict';
const fs = require('fs');
const path = require('path');
const STT = path.join(process.cwd(), 'src', 'control-plane', 'sttEngine.js');

let s = fs.readFileSync(STT, 'utf8');
const anchor = `    for (const pat of hallucinationPatterns) {
      if (pat.test(text)) {
        console.warn(\`[STTEngine] Discarded ambient audio/subtitles hallucination: "\${text}"\`);
        return '';
      }
    }`;
if (!s.includes(anchor)) throw new Error('anchor not found (already patched or upstream changed?)');
if (s.includes('Bare-pleasantries')) {
  console.log('SKIP: already patched');
  process.exit(0);
}
const addition = anchor + `

    // A2. Bare-pleasantries / non-content guard (voice-garble fix): Whisper
    // returns "Thank you." or "." for pure digital silence/noise. Those carry
    // no command — drop them instead of executing a phantom task.
    // (Tested: 1s of digital silence transcribed as "Thank you." on Groq.)
    {
      const bare = text.replace(/[.\\s]+$/g, '').trim().toLowerCase();
      if (
        /^(thank you|thanks|thankyou|you|uh|um|hmm|ah|oh)$/.test(bare) ||
        /^[^a-z0-9]*$/.test(text)
      ) {
        console.warn(\`[STTEngine] Discarded bare non-content hallucination: "\${text}"\`);
        return '';
      }
    }`;
s = s.replace(anchor, addition);
fs.writeFileSync(STT, s);
console.log('OK bare-pleasantries guard');
