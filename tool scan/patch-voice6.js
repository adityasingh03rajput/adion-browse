/**
 * Voice subtitle feature for D:\Adion Browse (src/renderer/{index.html,styles.css,app.js}).
 *  Adds a persistent bottom-center caption bar showing the INPUT voice:
 *   - "Listening…" prompt while the mic is hot (sticky until speech arrives)
 *   - live interim captions as you speak (dimmer style)
 *   - final captions: Web Speech final (6s dwell) + authoritative control-plane
 *     transcript (7s dwell) — replaces the old tiny 11.5px muted HUD preview
 *     that vanished with the 3.5s HUD auto-dismiss.
 *  A fresh final is never clobbered by a re-arm LISTENING event (2.5s guard);
 *  stopping the mic only clears a stale "Listening…" prompt, never a final.
 * Idempotent. Usage on PC: node patch-voice6.js (run from "D:\Adion Browse").
 */
'use strict';
const fs = require('fs');
const path = require('path');
const child = require('child_process');

const ROOT = process.cwd();
const HTML = path.join(ROOT, 'src', 'renderer', 'index.html');
const CSS = path.join(ROOT, 'src', 'renderer', 'styles.css');
const APP = path.join(ROOT, 'src', 'renderer', 'app.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rep(file, label, oldStr, newStr, sentinel) {
  let s = fs.readFileSync(file, 'utf8');
  // Idempotency FIRST: skip when the insertion's unique marker is present
  // (required because newStr contains oldStr, so oldStr still matches after patching).
  if (sentinel && s.includes(sentinel)) { console.log(`SKIP ${label}: already patched`); return; }
  const count = s.split(oldStr).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 occurrence, found ${count}`);
  fs.writeFileSync(file, s.split(oldStr).join(newStr));
  console.log(`OK ${label}`);
}

async function main() {
  for (const f of [HTML, CSS, APP]) if (!fs.existsSync(f)) throw new Error('missing: ' + f);
  if (!fs.existsSync(APP + '.bak-subtitles')) {
    fs.copyFileSync(APP, APP + '.bak-subtitles');
    console.log('OK backup: app.js.bak-subtitles');
  } else console.log('SKIP backup: already exists');

  // Self-heal: earlier revs used a non-idempotent rep() (newStr contained
  // oldStr), so a re-run duplicated insertions. Restore app.js once from the
  // pre-subtitles backup and drop any 2nd copy of the subtitle CSS.
  {
    const a0 = fs.readFileSync(APP, 'utf8');
    if (a0.split('function showVoiceSubtitle(').length - 1 > 1 && fs.existsSync(APP + '.bak-subtitles')) {
      fs.copyFileSync(APP + '.bak-subtitles', APP);
      console.log('HEAL app.js restored from .bak-subtitles (duplicates removed)');
    }
    let c0 = fs.readFileSync(CSS, 'utf8');
    const marker = '/* Voice input subtitles:';
    const first = c0.indexOf(marker), second = c0.indexOf(marker, first + 1);
    if (first >= 0 && second >= 0) {
      const kf = '@keyframes voiceSubtitleDots {';
      const k = c0.indexOf(kf, second);
      if (k < 0) throw new Error('HEAL: keyframes not found in 2nd css copy');
      let depth = 0, i = k;
      for (; i < c0.length; i++) {
        if (c0[i] === '{') depth++;
        else if (c0[i] === '}') { depth--; if (depth === 0) break; }
      }
      c0 = c0.slice(0, second) + c0.slice(i + 1);
      c0 = c0.replace(/\n{3,}/g, '\n\n');
      fs.writeFileSync(CSS, c0);
      console.log('HEAL styles.css second copy removed');
    }
  }

  // 1. index.html: subtitle bar right after the HUD overlay closes.
  {
    const s = fs.readFileSync(HTML, 'utf8');
    if (s.includes('id="voiceSubtitleBar"')) {
      console.log('SKIP html subtitle bar: already present');
    } else {
      const re = /(<button class="btn-agent-close" id="btnCancelAgent"[^>]*>[^<]*<\/button>\s*<\/div>\s*<\/div>)/;
      const m = s.match(new RegExp(re.source, 'g')) || [];
      if (m.length !== 1) throw new Error(`html overlay tail: expected 1, found ${m.length}`);
      const bar = `$1\n\n  <!-- VOICE INPUT SUBTITLES: live captions of what the mic heard -->\n  <div class="voice-subtitle-bar" id="voiceSubtitleBar" aria-live="polite">\n    <span class="voice-subtitle-label" id="voiceSubtitleLabel">YOU</span>\n    <span class="voice-subtitle-text" id="voiceSubtitleText"></span>\n  </div>`;
      fs.writeFileSync(HTML, s.replace(re, bar));
      console.log('OK html subtitle bar');
    }
  }

  // 2. styles.css: caption styling after the transcript-preview rules.
  rep(CSS, 'css subtitle bar',
`.agent-transcript-preview.has-text {
  display: block;
}`,
`.agent-transcript-preview.has-text {
  display: block;
}

/* Voice input subtitles: video-caption style bar, bottom-center, above HUD.
   pointer-events:none so captions never swallow clicks. */
.voice-subtitle-bar {
  position: fixed;
  left: 50%;
  bottom: 88px;
  transform: translateX(-50%) translateY(12px);
  max-width: min(720px, 86vw);
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 18px;
  background: rgba(0, 0, 0, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 12px;
  box-shadow: 0 6px 28px rgba(0, 0, 0, 0.5);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s ease, transform 0.25s ease;
  z-index: 12000;
}

.voice-subtitle-bar.visible {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

.voice-subtitle-label {
  flex: none;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.12em;
  color: #7df9ff;
  border: 1px solid rgba(125, 249, 255, 0.45);
  border-radius: 6px;
  padding: 2px 7px;
}

.voice-subtitle-text {
  font-size: 18px;
  line-height: 1.35;
  color: #fff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
  text-align: center;
  overflow-wrap: anywhere;
}

.voice-subtitle-bar.interim .voice-subtitle-text {
  opacity: 0.72;
}

.voice-subtitle-bar.listening .voice-subtitle-text {
  color: #bfe9ff;
}

.voice-subtitle-bar.listening .voice-subtitle-text::after {
  content: '';
  animation: voiceSubtitleDots 1.2s steps(4) infinite;
}

@keyframes voiceSubtitleDots {
  0% { content: ''; }
  25% { content: ' .'; }
  50% { content: ' ..'; }
  75% { content: ' ...'; }
}`,
'voiceSubtitleDots');

  // 3a. app.js: element refs after the transcript preview ref.
  rep(APP, 'js subtitle refs',
`  const agentTranscriptPreview = document.getElementById('agentTranscriptPreview');`,
`  const agentTranscriptPreview = document.getElementById('agentTranscriptPreview');
  const voiceSubtitleBar = document.getElementById('voiceSubtitleBar');
  const voiceSubtitleText = document.getElementById('voiceSubtitleText');
  const voiceSubtitleLabel = document.getElementById('voiceSubtitleLabel');`,
'voiceSubtitleBar = document');

  // 3b. app.js: subtitle state next to latestTranscript.
  rep(APP, 'js subtitle state',
`  let latestTranscript = '';`,
`  let latestTranscript = '';
  let voiceSubtitleHideTimer = null; // auto-hide timer for the voice subtitle bar
  let voiceSubtitleFinalAt = 0; // timestamp of last final caption (LISTENING guard)`,
'voiceSubtitleHideTimer');

  // 3c. app.js: helpers before showAgentHud.
  rep(APP, 'js subtitle helpers',
`  function showAgentHud(stateText, message, isListeningMode = false) {`,
`  /**
   * Voice subtitles: persistent bottom captions of the INPUT voice.
   * Interim results render dimmed; finals stay for dwellMs then fade.
   * sticky:true (the "Listening…" prompt) stays until replaced.
   */
  function showVoiceSubtitle(text, opts = {}) {
    if (!voiceSubtitleBar || !voiceSubtitleText) return;
    voiceSubtitleText.textContent = text;
    if (opts.label && voiceSubtitleLabel) voiceSubtitleLabel.textContent = opts.label;
    voiceSubtitleBar.classList.add('visible');
    voiceSubtitleBar.classList.toggle('interim', !!opts.interim);
    voiceSubtitleBar.classList.toggle('listening', !!opts.listening);
    if (!opts.interim && !opts.listening) voiceSubtitleFinalAt = Date.now();
    if (voiceSubtitleHideTimer) { clearTimeout(voiceSubtitleHideTimer); voiceSubtitleHideTimer = null; }
    if (!opts.sticky) {
      voiceSubtitleHideTimer = setTimeout(hideVoiceSubtitle, opts.dwellMs || (opts.interim ? 4000 : 6000));
    }
  }

  function hideVoiceSubtitle() {
    if (voiceSubtitleHideTimer) { clearTimeout(voiceSubtitleHideTimer); voiceSubtitleHideTimer = null; }
    if (voiceSubtitleBar) voiceSubtitleBar.classList.remove('visible', 'interim', 'listening');
  }

  /**
   * Show the "Listening…" prompt, unless a fresh final caption (<2.5s old)
   * is on screen — a re-arm LISTENING event must never clobber what the
   * user just said.
   */
  function showListeningSubtitle() {
    if (Date.now() - voiceSubtitleFinalAt < 2500) return;
    showVoiceSubtitle('Listening…', { listening: true, label: 'MIC', sticky: true });
  }

  function showAgentHud(stateText, message, isListeningMode = false) {`,
'function showVoiceSubtitle(');

  // 3d. app.js: live interim + final captions from Web Speech results.
  rep(APP, 'js webspeech captions',
`        agentTranscriptPreview.innerText = \`"\${transcript}"\`;
        agentTranscriptPreview.classList.add('has-text');`,
`        agentTranscriptPreview.innerText = \`"\${transcript}"\`;
        agentTranscriptPreview.classList.add('has-text');
        // Voice subtitles: live interim captions while speaking, solid final after
        try {
          const __lastRes = event.results[event.results.length - 1];
          const __isFinal = !!(__lastRes && __lastRes.isFinal);
          showVoiceSubtitle(transcript, __isFinal ? { label: 'YOU', dwellMs: 6000 } : { interim: true, label: 'YOU' });
        } catch (_) {}`,
'__isFinal');

  // 3e. app.js: "Listening…" prompt when the mic goes hot.
  rep(APP, 'js mic-hot prompt',
`    showAgentHud('LISTENING', 'Microphone active - speak now...', true);`,
`    showAgentHud('LISTENING', 'Microphone active - speak now...', true);
    showListeningSubtitle();`,
"speak now...', true);\n    showListeningSubtitle();");

  // 3f. app.js: authoritative control-plane transcript -> long-dwell final caption.
  rep(APP, 'js controlplane caption',
`        if (agentTranscriptPreview) {
          agentTranscriptPreview.innerText = \`"\${data.text}"\`;
          agentTranscriptPreview.classList.add('has-text');
        }`,
`        if (agentTranscriptPreview) {
          agentTranscriptPreview.innerText = \`"\${data.text}"\`;
          agentTranscriptPreview.classList.add('has-text');
        }
        showVoiceSubtitle(data.text, { label: 'YOU', dwellMs: 7000 });`,
'showVoiceSubtitle(data.text');

  // 3g. app.js: stopVoice clears only a stale "Listening…" prompt, never a final.
  rep(APP, 'js stop keeps final',
`    if (agentTranscriptPreview) {
      agentTranscriptPreview.classList.remove('has-text');
    }`,
`    if (agentTranscriptPreview) {
      agentTranscriptPreview.classList.remove('has-text');
    }
    // Voice subtitles: keep a fresh final caption on screen; only clear a
    // stale "Listening…" prompt (it would otherwise stick around forever).
    try { if (voiceSubtitleBar && voiceSubtitleBar.classList.contains('listening')) hideVoiceSubtitle(); } catch (_) {}`,
"contains('listening')) hideVoiceSubtitle");

  // 3h. app.js: continuous-mode re-arm shows the prompt (guarded by 2.5s rule).
  rep(APP, 'js rearm prompt',
`        showAgentHud('LISTENING', isListening ? 'Ready for next voice command... (listening)' : 'Listening...', true);`,
`        showAgentHud('LISTENING', isListening ? 'Ready for next voice command... (listening)' : 'Listening...', true);
        showListeningSubtitle();`,
"Ready for next voice command... (listening)' : 'Listening...', true);\n        showListeningSubtitle();");

  // 4. Syntax checks (JS only — node --check cannot parse CSS).
  {
    const s = fs.readFileSync(HTML, 'utf8');
    const opens = (s.match(/<div/g) || []).length, closes = (s.match(/<\/div>/g) || []).length;
    console.log(`html div balance: open=${opens} close=${closes}`);
    if (opens !== closes) throw new Error('html div imbalance');
    child.execSync(`node --check "${APP}"`, { stdio: 'pipe' });
    console.log('OK node --check app.js');
  }

  // 5. Marker counts.
  {
    const a = fs.readFileSync(APP, 'utf8');
    const c = (t) => a.split(t).length - 1;
    const markers = {
      helpers: c('function showVoiceSubtitle('), hide: c('function hideVoiceSubtitle('),
      listening: c('function showListeningSubtitle('), calls: c('showVoiceSubtitle('),
      guard: c('voiceSubtitleFinalAt'), webspeech: c('__isFinal'),
    };
    console.log(JSON.stringify(markers));
    if (markers.helpers !== 1 || markers.hide !== 1 || markers.listening !== 1) throw new Error('helper count mismatch');
    if (markers.calls !== 4) throw new Error('call-site count mismatch: ' + markers.calls);
    const h = fs.readFileSync(HTML, 'utf8');
    if ((h.match(/id="voiceSubtitleBar"/g) || []).length !== 1) throw new Error('html bar count mismatch');
    const css = fs.readFileSync(CSS, 'utf8');
    if ((css.match(/\.voice-subtitle-bar(?![\w-])/g) || []).length !== 5) throw new Error('css count mismatch: ' + (css.match(/\.voice-subtitle-bar(?![\w-])/g) || []).length);
  }

  // 6. Behavioral sim with stubbed DOM (incl. real hide timers).
  {
    const cls = () => {
      const set = new Set();
      return {
        add: (...a) => a.forEach((x) => set.add(x)),
        remove: (...a) => a.forEach((x) => set.delete(x)),
        toggle: (x, f) => { if (f) set.add(x); else set.delete(x); },
        contains: (x) => set.has(x),
      };
    };
    const env = {
      bar: { classList: cls() },
      text: { textContent: '' },
      label: { textContent: '' },
    };
    const src = fs.readFileSync(APP, 'utf8');
    function extract(name) {
      const key = '  function ' + name + '(';
      const idx = src.indexOf(key);
      if (idx < 0) throw new Error('extract: ' + name);
      // Skip the parameter list first (it may contain braces, e.g. opts = {}):
      // paren-match from the '(' ending the key, then body opens at next '{'.
      let p = 0, j = idx + key.length - 1;
      for (; j < src.length; j++) {
        if (src[j] === '(') p++;
        else if (src[j] === ')') { p--; if (p === 0) break; }
      }
      const b = src.indexOf('{', j);
      let depth = 0, i = b;
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
      }
      return src.slice(idx + 2, i + 1);
    }
    const factory = (() => {
      const parts = {
        head: '(function(env){' +
          'const voiceSubtitleBar = env.bar, voiceSubtitleText = env.text, voiceSubtitleLabel = env.label;' +
          'let voiceSubtitleHideTimer = null;' +
          'let voiceSubtitleFinalAt = 0;',
        m1: extract('showVoiceSubtitle'),
        m2: extract('hideVoiceSubtitle'),
        m3: extract('showListeningSubtitle'),
        tail: 'return { show: showVoiceSubtitle, hide: hideVoiceSubtitle, listen: showListeningSubtitle,' +
          ' snapshot: () => ({ visible: voiceSubtitleBar.classList.contains(\'visible\'),' +
          ' interim: voiceSubtitleBar.classList.contains(\'interim\'),' +
          ' listening: voiceSubtitleBar.classList.contains(\'listening\'),' +
          ' text: voiceSubtitleText.textContent }),' +
          ' ageFinal: (ms) => { voiceSubtitleFinalAt = Date.now() - ms; } }; })',
      };
      const built = parts.head + '\n' + parts.m1 + '\n' + parts.m2 + '\n' + parts.m3 + '\n' + parts.tail;
      try {
        return eval(built);
      } catch (e) {
        const info = 'm1_len=' + parts.m1.length + ' m1_tail=' + JSON.stringify(parts.m1.slice(-60)) +
          ' | m2_len=' + parts.m2.length + ' m2_tail=' + JSON.stringify(parts.m2.slice(-60)) +
          ' | m3_len=' + parts.m3.length + ' m3_tail=' + JSON.stringify(parts.m3.slice(-60));
        console.log('SIM EVAL DIAG: ' + info);
        fs.writeFileSync(path.join(ROOT, 'tool scan', 'voice6-eval-dump.js'), built);
        throw e;
      }
    })();
    const t = factory(env);
    const R = [];
    t.show('hel', { interim: true, label: 'YOU' });
    let s1 = t.snapshot();
    R.push(['S1 interim', s1.visible && s1.interim && s1.text === 'hel' ? 'PASS' : 'FAIL ' + JSON.stringify(s1)]);
    t.show('hello world', { label: 'YOU', dwellMs: 60 });
    let s2a = t.snapshot();
    await sleep(150);
    let s2b = t.snapshot();
    R.push(['S2 final+autohide', !s2a.interim && s2a.text === 'hello world' && !s2b.visible ? 'PASS' : 'FAIL ' + JSON.stringify([s2a, s2b])]);
    t.show('Listening…', { listening: true, label: 'MIC', sticky: true });
    await sleep(120);
    let s3 = t.snapshot();
    R.push(['S3 sticky', s3.visible && s3.listening ? 'PASS' : 'FAIL ' + JSON.stringify(s3)]);
    t.show('keep me', { label: 'YOU', dwellMs: 60000 });
    t.listen();
    const blocked = t.snapshot().text === 'keep me';
    t.ageFinal(3000);
    t.listen();
    const through = t.snapshot().text === 'Listening…';
    R.push(['S4 guard', blocked && through ? 'PASS' : 'FAIL blocked=' + blocked + ' text=' + t.snapshot().text]);
    t.hide();
    for (const [n, r] of R) console.log('SIM ' + n + ': ' + r);
    if (R.some((x) => !x[1].startsWith('PASS'))) throw new Error('sim failures');
  }
  console.log('VOICE6 DONE');
}

main().catch((e) => { console.error('VOICE6 FAILED:', e.message); process.exit(1); });
