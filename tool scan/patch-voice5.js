/**
 * Voice-garble fix part 5 for D:\Adion Browse (src/control-plane/agentRuntime.js).
 *  #7 Convo mid-phrase joining guard. The 1.5s heldText join (two duplicated
 *     blocks: live path + pending path) had three defects that garbled tasks:
 *     (a) STALE HOLD LOSS: if the continuation arrived >=1.5s later, the else
 *         branch cleared heldText WITHOUT ever processing it — the first half
 *         of the task was silently lost.
 *     (b) UNBOUNDED JOINS: hold->join chains could splice two separate tasks
 *         ("open X and" + "scroll down and" + ...) into one mega-prompt that
 *         the conjunction-splitter downstream then mis-split.
 *     (c) DEAD TIMER: convoState.heldTimer was cleared but never armed, so a
 *         held fragment with no continuation sat until the next utterance.
 *  Fix: one shared helper dispatchConvoText(cleanText, tag) used by BOTH
 *  call sites, which (i) flushes a stale hold as its own command first,
 *  (ii) caps joins at 25 words (over-cap: run held part alone, handle the
 *  new text as a fresh turn), (iii) arms heldTimer on hold: after 1.6s with
 *  no continuation AND runtime IDLE, the held text auto-flushes (never while
 *  busy, so no concurrent processCommand). Hold/join stays gated to
 *  convo+jarvis modes (call sites unchanged in that respect).
 * Idempotent. Usage on PC: node patch-voice5.js (run from "D:\Adion Browse").
 * Self-tests the patched logic with stubbed `this` (incl. real 1.6s timer).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const child = require('child_process');

const RT = path.join(process.cwd(), 'src', 'control-plane', 'agentRuntime.js');
const BAK = RT + '.bak-voicefix2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function read() { return fs.readFileSync(RT, 'utf8'); }
function write(s) { fs.writeFileSync(RT, s); }

async function main() {
  if (!fs.existsSync(RT)) throw new Error('agentRuntime.js not found (run from D:\\Adion Browse)');

  // 0. Backup current pre-#7 state once (fixes #1-3,#5,#6 already in it).
  if (!fs.existsSync(BAK)) {
    fs.copyFileSync(RT, BAK);
    console.log('OK backup: agentRuntime.js.bak-voicefix2');
  } else console.log('SKIP backup: already exists');

  let s = read();

  // Idempotency: already patched?
  if (s.includes('async dispatchConvoText(cleanText, tag)')) {
    console.log('SKIP patch: dispatchConvoText already present');
  } else {
    // 1. Insert shared helpers before processPendingUtterance's doc block.
    const anchor = '  /**\n   * Transcribe and dispatch an utterance that was captured while a previous\n   * command was still processing (Gemini-style queued turn).\n   */';
    if (!s.includes(anchor)) throw new Error('#7: helper anchor not found');
    const helpers = `  /**
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
      console.log(\`[AgentRuntime Convo] Auto-flushed stale held text: "\${held}"\`);
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
    const words = (t) => t.split(/\\s+/).filter(Boolean).length;
    const endsMidPhrase = (t) => /\\b(and|or|but|so|because|with|to|for|in|on|at|by|from|of)$/i.test(t);

    let text = cleanText;
    // Stale hold: previous fragment never got its continuation — run it as
    // its own command instead of silently dropping it.
    if (S.heldText && now - S.lastUtteranceTime >= HOLD_WINDOW_MS) {
      const stale = S.heldText;
      this.clearConvoHold();
      S.lastUtteranceTime = now;
      S.utteranceCount++;
      console.log(\`[AgentRuntime Convo] Flushed stale held text (\${tag}): "\${stale}"\`);
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
        console.log(\`[AgentRuntime Convo] Join over \${JOIN_WORD_CAP} words — split (\${tag}): "\${held}" | "\${text}"\`);
        await this.processCommand(held);
        S.lastUtteranceTime = Date.now();
        // fall through: handle the new text as a fresh turn below
      } else {
        console.log(\`[AgentRuntime Convo] Joined mid-phrase (\${tag}): "\${joinedText}"\`);
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
      console.log(\`[AgentRuntime Convo] Held mid-phrase (\${tag}): "\${text}"\`);
      this.emit('feedback', { message: 'Waiting for continuation...', level: 'info' });
      this.armConvoFlushTimer();
      return;
    }
    S.lastUtteranceTime = Date.now();
    S.utteranceCount++;
    this.clearConvoHold();
    await this.processCommand(text);
  }

`;
    s = s.split(anchor).join(helpers + anchor);
    console.log('OK #7a helpers inserted');

    // 2. Replace BOTH duplicated join blocks with one-line helper calls.
    // Start anchors differ (live vs pending); the tail (else dispatching the
    // raw transcript) is identical — first match after each start is its own.
    const tail = /(\} else \{\s+await this\.processCommand\(transcript\);\s+\})/;
    const starts = [
      ['live', '// Conversation/Jarvis mode: implement segment joining for mid-phrase detection (inspired by nus-companion)'],
      ['pending', '// Apply same convo/jarvis mid-phrase joining as the live path'],
    ];
    for (const [tag, start] of starts) {
      const re = new RegExp(escapeRegExp(start) + '[\\s\\S]*?' + tail.source);
      const matches = s.match(new RegExp(re.source, 'g')) || [];
      if (matches.length !== 1) throw new Error(`#7b ${tag}: expected 1 block, found ${matches.length}`);
      s = s.replace(re, `// Conversation/Jarvis mode: mid-phrase joining via shared helper (voice-garble fix #7)\n        if (this.isConvoMode || this.isJarvisMode) {\n          await this.dispatchConvoText(transcript.trim(), '${tag}');\n        $1`);
      console.log(`OK #7b ${tag} call site replaced`);
    }
    write(s);
  }

  // 3. Syntax check.
  child.execSync(`node --check "${RT}"`, { stdio: 'pipe' });
  console.log('OK node --check');

  // 4. Marker counts.
  s = read();
  const c = (t) => s.split(t).length - 1;
  const markers = {
    dispatchDef: c('async dispatchConvoText(cleanText, tag)'),
    dispatchCalls: c('dispatchConvoText(transcript.trim()'),
    armDef: c('armConvoFlushTimer() {'),
    armCalls: c('this.armConvoFlushTimer()'),
    clearDef: c('clearConvoHold() {'),
    joinCap: c('JOIN_WORD_CAP'),
    oldLiveStart: c('implement segment joining for mid-phrase detection'),
    oldPendingStart: c('Apply same convo/jarvis mid-phrase joining'),
  };
  console.log(JSON.stringify(markers));
  if (markers.dispatchDef !== 1 || markers.dispatchCalls !== 2) throw new Error('marker mismatch (dispatch)');
  if (markers.armDef !== 1 || markers.armCalls !== 1) throw new Error('marker mismatch (arm)');
  if (markers.joinCap < 3) throw new Error('marker mismatch (cap)');
  if (markers.oldLiveStart !== 0 || markers.oldPendingStart !== 0) throw new Error('old blocks remain!');

  // 5. Behavioral sim: extract the 3 methods, run against a stub `this`.
  const AgentState = { IDLE: 'idle', BUSY: 'busy' };
  const src = read();
  function extractMethod(name) {
    const key = name + '() {';
    const alt = name.replace('()', '(cleanText, tag) {');
    let idx = src.indexOf('  ' + key);
    let headerLen = ('  ' + key).length;
    if (idx < 0 && name === 'dispatchConvoText') {
      idx = src.indexOf('  async dispatchConvoText(cleanText, tag) {');
      headerLen = '  async dispatchConvoText(cleanText, tag) {'.length;
    }
    if (idx < 0) throw new Error('extract: ' + name + ' not found');
    let depth = 1, i = idx + headerLen;
    while (depth > 0 && i < src.length) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    return src.slice(idx + 2, i); // e.g. "armConvoFlushTimer() { ... }"
  }
  const factory = eval(`(function make(stub){ return { ${extractMethod('armConvoFlushTimer')}, ${extractMethod('clearConvoHold')}, ${extractMethod('dispatchConvoText')} }; })`);
  function makeStub(state) {
    const calls = [];
    const feedbacks = [];
    const stub = {
      convoState: { heldText: '', heldTimer: null, lastUtteranceTime: 0, utteranceCount: 0 },
      state,
      processCommand: async (t) => { calls.push(t); },
      emit: (ev, d) => { feedbacks.push(ev); },
      calls, feedbacks,
    };
    return Object.assign(stub, factory(stub));
  }
  const results = [];
  // A: stale hold flushes as its own command, new text NOT joined.
  {
    const t = makeStub(AgentState.IDLE);
    t.convoState.heldText = 'open youtube and';
    t.convoState.lastUtteranceTime = Date.now() - 5000;
    await t.dispatchConvoText('play some jazz', 'live');
    results.push(['A stale-flush', JSON.stringify(t.calls) === JSON.stringify(['open youtube and', 'play some jazz']) ? 'PASS' : 'FAIL ' + JSON.stringify(t.calls)]);
  }
  // B: fresh continuation joins.
  {
    const t = makeStub(AgentState.IDLE);
    t.convoState.heldText = 'scroll down to';
    t.convoState.lastUtteranceTime = Date.now() - 200;
    await t.dispatchConvoText('the red shoes', 'live');
    results.push(['B fresh-join', JSON.stringify(t.calls) === JSON.stringify(['scroll down to the red shoes']) ? 'PASS' : 'FAIL ' + JSON.stringify(t.calls)]);
  }
  // C: over-cap join splits (20-word hold + 10-word continuation).
  {
    const t = makeStub(AgentState.IDLE);
    const held20 = Array(20).fill('word').join(' ');
    t.convoState.heldText = held20;
    t.convoState.lastUtteranceTime = Date.now() - 100;
    await t.dispatchConvoText('this continuation has exactly ten words in it yes sir', 'pending');
    const ok = t.calls.length === 2 && t.calls[0] === held20 && t.calls[1] === 'this continuation has exactly ten words in it yes sir';
    results.push(['C word-cap-split', ok ? 'PASS' : 'FAIL ' + JSON.stringify(t.calls)]);
  }
  // D: trailing conjunction holds + auto-flushes while IDLE (~1.6s).
  {
    const t = makeStub(AgentState.IDLE);
    await t.dispatchConvoText('search for cats and', 'live');
    const heldNow = t.convoState.heldText === 'search for cats and' && t.calls.length === 0;
    await sleep(2000);
    const flushed = t.calls.length === 1 && t.calls[0] === 'search for cats and' && t.convoState.heldText === '';
    results.push(['D hold+autoflush', heldNow && flushed ? 'PASS' : `FAIL held=${heldNow} calls=${JSON.stringify(t.calls)}`]);
  }
  // E: timer does NOT flush while busy; next utterance flushes instead.
  {
    const t = makeStub(AgentState.BUSY);
    await t.dispatchConvoText('open settings and', 'live');
    await sleep(2000);
    const stillHeld = t.convoState.heldText === 'open settings and' && t.calls.length === 0;
    t.state = AgentState.IDLE;
    t.convoState.lastUtteranceTime = Date.now() - 5000; // force stale
    await t.dispatchConvoText('click save', 'live');
    const ok = stillHeld && JSON.stringify(t.calls) === JSON.stringify(['open settings and', 'click save']);
    results.push(['E busy-noflush+stale', ok ? 'PASS' : `FAIL held=${stillHeld} calls=${JSON.stringify(t.calls)}`]);
  }
  // F: normal command passes straight through, no hold.
  {
    const t = makeStub(AgentState.IDLE);
    await t.dispatchConvoText('open youtube', 'live');
    results.push(['F passthrough', JSON.stringify(t.calls) === JSON.stringify(['open youtube']) ? 'PASS' : 'FAIL ' + JSON.stringify(t.calls)]);
  }
  for (const [n, r] of results) console.log(`SIM ${n}: ${r}`);
  if (results.some(([, r]) => !r.startsWith('PASS'))) throw new Error('sim failures');
  console.log('VOICEFIX5 DONE');
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

main().catch((e) => { console.error('VOICEFIX5 FAILED:', e.message); process.exit(1); });
