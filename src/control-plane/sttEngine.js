const config = require('./config');

/**
 * Local Speech-to-Text (STT) Engine & Acoustic Command Classifier
 * Transcribes raw 16kHz 16-bit mono Linear PCM audio buffers into text.
 * Integrates Whisper-Large-v3-Turbo on Groq for ultra-low-latency transcription,
 * local whisper.cpp endpoints, and edge acoustic phonetic classifiers.
 */
class STTEngine {
  constructor(options = {}) {
    this.whisperEndpoint = options.whisperEndpoint || 'http://127.0.0.1:8080/inference';
    this.sampleRate = 16000;
    // Voice-garble fix: the acoustic guesser must NEVER invent a command from
    // noise/silence. Default OFF — Whisper silence returns '' instead.
    // Enable only for offline demos: new STTEngine({ acousticFallback: true }).
    this.acousticFallback = options.acousticFallback === true;
    this.acousticMinRms = options.acousticMinRms || 0.03;
  }

  /**
   * Transcribe a raw 16kHz 16-bit PCM Buffer into text
   */
  async transcribePCM(pcmBuffer) {
    if (!pcmBuffer || pcmBuffer.length < 3200) {
      // Under 100ms of audio
      return '';
    }

    let rawTranscript = '';

    // 1. High-Performance Whisper-Large-v3-Turbo
    if (config.groqApiKey) {
      try {
        const groqText = await this.queryGroqWhisper(pcmBuffer);
        if (groqText && groqText.trim()) {
          console.log(`[STTEngine] Whisper-large-v3-turbo transcribed: "${groqText}"`);
          rawTranscript = groqText.trim();
        }
      } catch (err) {
        console.warn('[STTEngine] Whisper cloud call failed, using fallback:', err.message);
      }
    }

    // 2. Try local Whisper.cpp HTTP endpoint if running
    if (!rawTranscript) {
      try {
        const whisperResult = await this.queryLocalWhisper(pcmBuffer);
        if (whisperResult && whisperResult.trim()) {
          console.log(`[STTEngine] Local Whisper transcribed: "${whisperResult}"`);
          rawTranscript = whisperResult.trim();
        }
      } catch (e) {
        // Whisper endpoint not running; fall through to edge acoustic classifier
      }
    }

    // 3. Fast Acoustic & Phonetic Pattern Matcher (GATED — see constructor).
    // Previously this ALWAYS invented a command ('scroll down', 'open youtube',
    // ...) from any noise/silence whenever Whisper came back empty. Now it only
    // runs when explicitly enabled AND the audio is loud enough to be speech.
    if (!rawTranscript && this.acousticFallback) {
      const rms = this.rmsOf(pcmBuffer);
      if (rms >= this.acousticMinRms) {
        const classifiedText = this.classifyAcousticCommand(pcmBuffer);
        console.log(`[STTEngine] Acoustic Classifier matched: "${classifiedText}" (rms ${rms.toFixed(4)})`);
        rawTranscript = classifiedText;
      } else {
        console.log(`[STTEngine] Acoustic fallback skipped: too quiet (rms ${rms.toFixed(4)}) — returning silence`);
      }
    }

    // 4. Transcription Normalization, Phonetic Error Correction & Hallucination Filter
    const cleaned = this.cleanAndNormalizeTranscript(rawTranscript, pcmBuffer);
    if (cleaned !== rawTranscript) {
      console.log(`[STTEngine] Normalized transcript: "${cleaned}" (raw was: "${rawTranscript}")`);
    }
    return cleaned;
  }

  /**
   * Cleans listening errors, normalizes phonetic greeting slips (e.g. "hie", "hei"),
   * and discards ambient video subtitle / outro hallucinations.
   */
  cleanAndNormalizeTranscript(rawInput, pcmBuffer) {
    if (!rawInput || typeof rawInput !== 'string') return '';
    let text = rawInput.trim();

    // A. Reject Whisper hallucinations on ambient noise, silence, or prompt regurgitation
    const hallucinationPatterns = [
      /gracias\s+por\s+ver\s+el\s+video/i,
      /subt[íi]tulos\s+realizados\s+por/i,
      /thank\s+you\s+for\s+watching/i,
      /thanks\s+for\s+watching/i,
      /suscr[íi]bete/i,
      /please\s+subscribe/i,
      /like\s+and\s+subscribe/i,
      /amara\.org/i,
      /community\s+subtitles/i,
      /watching!/i,
      /browser\s+voice\s+commands/i,
      /web\s+search,\s+page\s+navigation/i,
      /page\s+navigation,\s+and\s+tab\s+management/i,
      /tab\s+management\./i
    ];

    for (const pat of hallucinationPatterns) {
      if (pat.test(text)) {
        console.warn(`[STTEngine] Discarded ambient audio/subtitles hallucination: "${text}"`);
        return '';
      }
    }

    // A2. Bare-pleasantries / non-content guard (voice-garble fix): Whisper
    // returns "Thank you." or "." for pure digital silence/noise. Those carry
    // no command — drop them instead of executing a phantom task.
    // (Tested: 1s of digital silence transcribed as "Thank you." on Groq.)
    {
      const bare = text.replace(/[.\s]+$/g, '').trim().toLowerCase();
      if (
        /^(thank you|thanks|thankyou|you|uh|um|hmm|ah|oh)$/.test(bare) ||
        /^[^a-z0-9]*$/.test(text)
      ) {
        console.warn(`[STTEngine] Discarded bare non-content hallucination: "${text}"`);
        return '';
      }
    }

    // B0. Collapse decoder phrase-loops (D:\help collapseLoops): any 1-12 word
    // phrase repeated 3+ times in a row is kept once — sliding window version.
    {
      const w = text.split(/\s+/).filter(Boolean);
      const key = (s) => s.toLowerCase().replace(/[^a-z0-9']/g, '');
      const out = [];
      let i = 0;
      while (i < w.length) {
        let collapsed = false;
        for (let n = 1; n <= 12 && i + 3 * n <= w.length; n++) {
          let reps = 1;
          while (i + (reps + 1) * n <= w.length && w.slice(i, i + n).every((x, k) => key(x) === key(w[i + reps * n + k]))) reps++;
          if (reps >= 3) { out.push(...w.slice(i, i + n)); i += reps * n; collapsed = true; break; }
        }
        if (!collapsed) { out.push(w[i]); i++; }
      }
      const collapsedText = out.join(' ');
      if (collapsedText !== text) {
        console.warn(`[STTEngine] Collapsed decoder loop: "${text}" -> "${collapsedText}"`);
        text = collapsedText;
      }
    }

    // B. Reject unnatural word-repetition loops (e.g. "you you you you you")
    if (/(\b\w+\b)(?:\s+\1){3,}/i.test(text)) {
      console.warn(`[STTEngine] Discarded repetitive acoustic loop hallucination: "${text}"`);
      return '';
    }

    // B2. Plausibility guard (D:\help listen.js): fast speech is ~4 words/sec.
    // More words than the audio could physically hold = decoder hallucination.
    if (typeof pcmBuffer !== 'undefined' && pcmBuffer && pcmBuffer.length > 0) {
      const audioMs = (pcmBuffer.length / 2) / 16; // 16kHz Int16 mono
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      if (wordCount > Math.ceil((audioMs / 1000) * 5) + 3 && wordCount > 4) {
        console.warn(`[STTEngine] Discarded implausible transcript: ${wordCount} words in ${Math.round(audioMs)}ms of audio`);
        return '';
      }
    }

    // C. Normalize phonetic greeting slips ("hie", "hei", "hy", "heyy", "heya", "hai", "hiya") to standard "hey" / "hi"
    text = text
      .replace(/\b(hie|hei|hy|heyy|heya|hai|hiya)\b/gi, 'hey')
      .replace(/\bbase\s+boost\b/gi, 'bass boost')
      .replace(/\bbase\s+frequency\b/gi, 'bass frequency')
      .replace(/\bcolour\b/gi, 'color')
      // Universal spoken domain normalization: e.g. "something dot com" -> "something.com"
      .replace(/(\w+)\s*dot\s*(com|org|net|edu|gov|io|ai|co|app)\b/gi, '$1.$2')
      // Acoustic tab command slips ("tap" -> "tab")
      .replace(/\b(?:close|shut|kill)\s+(?:the|this)?\s*tap\b/gi, 'close tab')
      .replace(/\bnew\s+tap\b/gi, 'new tab')
      .replace(/\bswitch\s+(?:to\s+)?tap\b/gi, 'switch tab')
      .replace(/\bthe\s+tap\b/gi, 'the tab')
      .replace(/\bthis\s+tap\b/gi, 'this tab');

    return text.trim();
  }

  /**
   * Transcribe audio using Whisper-Large-v3-turbo on Groq LPU
   */
  async queryGroqWhisper(pcmBuffer) {
    const wavBuffer = this.createWavBuffer(pcmBuffer);
    const blob = new Blob([wavBuffer], { type: 'audio/wav' });
    const formData = new FormData();
    formData.append('file', blob, 'speech.wav');
    formData.append('model', config.groqWhisperModel || 'whisper-large-v3-turbo');
    formData.append('response_format', 'json');
    // Voice-garble fix: bias the decoder toward our command vocabulary so
    // short commands ("close tab") don't decode as lookalikes ("clothes tub").
    // Whisper treats prompt as context/style primer, not as transcript.
    formData.append('prompt', 'Browser voice commands: open youtube, open google, new tab, close tab, go back, go forward, reload, scroll down, scroll up, search, stop, cancel, never mind, next, continue. The speaker gives one short browser command.');
    // Bilingual STT: auto-detect speech language (Hindi/Hinglish/English). Forcing
    // 'en' mistranscribes Hindi commands. Lock via config.groqWhisperLanguage if needed.
    if (config.groqWhisperLanguage) formData.append('language', config.groqWhisperLanguage);
    formData.append('temperature', '0.0');

    const sttTimeout = new AbortController();
    const sttTimer = setTimeout(() => sttTimeout.abort(), 8000);
    let res;
    try {
      res = await fetch(config.groqWhisperUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.groqApiKey}`
        },
        body: formData,
        signal: sttTimeout.signal
      });
    } finally {
      clearTimeout(sttTimer);
    }

    if (res.ok) {
      const data = await res.json();
      return (data.text || '').trim();
    }
    return '';
  }

  /**
   * RMS of an Int16 PCM buffer, 0..1 — used to gate the acoustic fallback.
   */
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

  /**
   * Acoustic Cadence, Zero-Crossing Rate (ZCR) and Syllabic Envelope Matcher.
   * Classifies core browser command intents from raw PCM audio features.
   * NOTE: only used when acousticFallback is explicitly enabled (default off).
   */
  classifyAcousticCommand(pcmBuffer) {
    const samples = [];
    const numSamples = Math.floor(pcmBuffer.length / 2);
    let zeroCrossings = 0;
    let totalEnergy = 0;

    for (let i = 0; i < pcmBuffer.length - 1; i += 2) {
      const s = pcmBuffer.readInt16LE(i) / 32768.0;
      samples.push(s);
      totalEnergy += s * s;
      if (samples.length > 1) {
        const prev = samples[samples.length - 2];
        if ((prev >= 0 && s < 0) || (prev < 0 && s >= 0)) {
          zeroCrossings++;
        }
      }
    }

    const durationSec = numSamples / this.sampleRate;
    const zcr = zeroCrossings / numSamples;
    const rms = Math.sqrt(totalEnergy / numSamples);

    // Analyze syllabic bursts / energy peaks (frame window 40ms = 640 samples)
    const windowSize = 640;
    const frameEnergies = [];
    for (let i = 0; i < samples.length; i += windowSize) {
      let frameSum = 0;
      const count = Math.min(windowSize, samples.length - i);
      for (let j = 0; j < count; j++) {
        const val = samples[i + j];
        frameSum += val * val;
      }
      frameEnergies.push(Math.sqrt(frameSum / count));
    }

    // Count distinct vocal bursts (syllables) above baseline noise
    const energyThreshold = rms * 0.7;
    let burstCount = 0;
    let inBurst = false;
    frameEnergies.forEach((e) => {
      if (e > energyThreshold && !inBurst) {
        burstCount++;
        inBurst = true;
      } else if (e < energyThreshold * 0.5) {
        inBurst = false;
      }
    });

    console.log(`[STTEngine Features] Duration: ${durationSec.toFixed(2)}s | ZCR: ${zcr.toFixed(4)} | RMS: ${rms.toFixed(4)} | Bursts: ${burstCount}`);

    // High ZCR indicates dominant sibilant / fricative sounds ('s', 'sh') like "scroll", "search"
    const hasSibilantOnset = zcr > 0.08;

    // Command mapping heuristics based on duration, bursts, and frequency characteristics
    if (hasSibilantOnset) {
      if (durationSec > 0.9 && burstCount >= 2) {
        // "scroll down" or "scroll up"
        const lastHalfSamples = samples.slice(Math.floor(samples.length / 2));
        let secondHalfZcr = 0;
        for (let k = 1; k < lastHalfSamples.length; k++) {
          if ((lastHalfSamples[k - 1] >= 0 && lastHalfSamples[k] < 0) || (lastHalfSamples[k - 1] < 0 && lastHalfSamples[k] >= 0)) {
            secondHalfZcr++;
          }
        }
        const secondHalfZcrNorm = secondHalfZcr / lastHalfSamples.length;
        return secondHalfZcrNorm > 0.07 ? 'scroll up' : 'scroll down';
      } else if (durationSec <= 0.9) {
        return 'scroll down';
      } else {
        return 'search';
      }
    }

    // Low ZCR with 2-3 bursts: "open youtube", "open google", "new tab", "close tab", "go back"
    if (burstCount === 1) {
      if (durationSec < 0.6) return 'reload';
      return 'go back';
    }

    if (burstCount === 2) {
      if (durationSec < 0.75) return 'new tab';
      if (durationSec < 1.1) return 'close tab';
      return 'open youtube';
    }

    if (burstCount >= 3) {
      if (durationSec > 1.4) return 'open youtube';
      return 'open google';
    }

    // Default natural fallback for medium vocal command
    return 'scroll down';
  }

  /**
   * Attempt transcription against a local Whisper server
   */
  async queryLocalWhisper(pcmBuffer) {
    const wavBuffer = this.createWavBuffer(pcmBuffer);
    const controller = new AbortController();
    // Voice-garble fix: the old fixed 600ms aborted every real utterance
    // (whisper.cpp needs ~0.3-0.5x audio duration), so the local path NEVER
    // succeeded and everything fell through to the acoustic guesser.
    const audioMs = pcmBuffer ? (pcmBuffer.length / 32) : 0; // 16kHz 16-bit mono
    const budgetMs = Math.min(15000, Math.max(2500, 1500 + audioMs * 0.6));
    const timeout = setTimeout(() => controller.abort(), budgetMs);

    try {
      const res = await fetch(this.whisperEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wavBuffer,
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (res.ok) {
        const json = await res.json();
        return json.text || '';
      }
    } catch (e) {
      clearTimeout(timeout);
    }
    return '';
  }

  /**
   * Software Automatic Gain Control (AGC) & Volume Normalization
   * Boosts quiet microphone audio so Whisper acoustic models receive optimal speech levels
   */
  normalizePCM(pcmBuffer) {
    if (!pcmBuffer || pcmBuffer.length < 2) return pcmBuffer;
    let maxAmp = 0;
    for (let i = 0; i < pcmBuffer.length - 1; i += 2) {
      const val = Math.abs(pcmBuffer.readInt16LE(i));
      if (val > maxAmp) maxAmp = val;
    }
    // Gentle AGC (voice-garble fix): the browser already runs autoGainControl
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
      const multiplier = Math.min(2.0, 13000 / maxAmp);
      const normalized = Buffer.alloc(pcmBuffer.length);
      for (let i = 0; i < pcmBuffer.length - 1; i += 2) {
        const sample = pcmBuffer.readInt16LE(i);
        const boosted = Math.max(-32767, Math.min(32767, Math.round(sample * multiplier)));
        normalized.writeInt16LE(boosted, i);
      }
      return normalized;
    }
    return pcmBuffer;
  }

  /**
   * Package raw 16kHz PCM into a standard 44-byte header WAV buffer
   */
  createWavBuffer(rawPcmBuffer) {
    const pcmBuffer = this.normalizePCM(rawPcmBuffer);
    const wavHeader = Buffer.alloc(44);
    const numChannels = 1;
    const sampleRate = 16000;
    const bitsPerSample = 16;
    const dataSize = pcmBuffer.length;

    wavHeader.write('RIFF', 0);
    wavHeader.writeUInt32LE(36 + dataSize, 4);
    wavHeader.write('WAVE', 8);
    wavHeader.write('fmt ', 12);
    wavHeader.writeUInt32LE(16, 16);
    wavHeader.writeUInt16LE(1, 20); // PCM format
    wavHeader.writeUInt16LE(numChannels, 22);
    wavHeader.writeUInt32LE(sampleRate, 24);
    wavHeader.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
    wavHeader.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
    wavHeader.writeUInt16LE(bitsPerSample, 34);
    wavHeader.write('data', 36);
    wavHeader.writeUInt32LE(dataSize, 40);

    return Buffer.concat([wavHeader, pcmBuffer]);
  }
}

module.exports = STTEngine;

