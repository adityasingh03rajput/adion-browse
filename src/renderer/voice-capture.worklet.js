/* Adion voice capture worklet — replaces ScriptProcessorNode scheduling.
 *
 * Runs on the audio thread (immune to main-thread jank while the agent works),
 * accumulates 128-sample render quanta into 4096-sample hardware-rate blocks
 * (same ~85ms @48kHz chunking as before) and tags each with a sequence number
 * so the main thread can log gaps. Dropped/duplicated chunks choppy-decode in
 * Whisper as garbled words — now they are at least visible in the logs.
 *
 * DSP (downsample to 16kHz, 1.35x preamp, Int16, RMS) intentionally stays on
 * the main thread in handleVoiceFrame (src/renderer/app.js) — this node only
 * guarantees timing + sequencing, so behavior is otherwise unchanged.
 */
class AdionVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(4096);
    this.fill = 0;
    this.seq = 0;
  }

  process(inputs) {
    const ch = inputs && inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      let off = 0;
      while (off < ch.length) {
        const room = 4096 - this.fill;
        const take = Math.min(room, ch.length - off);
        this.block.set(ch.subarray(off, off + take), this.fill);
        this.fill += take;
        off += take;
        if (this.fill === 4096) {
          const copy = this.block.slice();
          this.port.postMessage({ seq: this.seq++, pcm: copy.buffer }, [copy.buffer]);
          this.fill = 0;
        }
      }
    }
    return true; // keep alive; outputs default to silence (muted downstream)
  }
}

registerProcessor('adion-voice-capture', AdionVoiceCapture);
