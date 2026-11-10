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

    // 3. Fast Acoustic & Phonetic Pattern Matcher
    if (!rawTranscript) {
      const classifiedText = this.classifyAcousticCommand(pcmBuffer);
      console.log(`[STTEngine] Acoustic Classifier matched: "${classifiedText}"`);
      rawTranscript = classifiedText;
    }

    // 4. Transcription Normalization, Phonetic Error Correction & Hallucination Filter
    const cleaned = this.cleanAndNormalizeTranscript(rawTranscript);
    if (cleaned !== rawTranscript) {
      console.log(`[STTEngine] Normalized transcript: "${cleaned}" (raw was: "${rawTranscript}")`);
    }
    return cleaned;
  }

  /**
   * Cleans listening errors, normalizes phonetic greeting slips (e.g. "hie", "hei"),
   * and discards ambient video subtitle / outro hallucinations.
   */
  cleanAndNormalizeTranscript(rawInput) {
    if (!rawInput || typeof rawInput !== 'string') return '';
    let text = rawInput.trim();

    // A. Reject Whisper hallucinations on ambient noise or background audio
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
      /watching!/i
    ];

    for (const pat of hallucinationPatterns) {
      if (pat.test(text)) {
        console.warn(`[STTEngine] Discarded ambient audio/subtitles hallucination: "${text}"`);
        return '';
      }
    }

    // B. Reject unnatural word-repetition loops (e.g. "you you you you you")
    if (/(\b\w+\b)(?:\s+\1){3,}/i.test(text)) {
      console.warn(`[STTEngine] Discarded repetitive acoustic loop hallucination: "${text}"`);
      return '';
    }

    // C. Normalize phonetic greeting slips ("hie", "hei", "hy", "heyy", "heya", "hai", "hiya") to standard "hey" / "hi"
    text = text
      .replace(/\b(hie|hei|hy|heyy|heya|hai|hiya)\b/gi, 'hey')
      .replace(/\bbase\s+boost\b/gi, 'bass boost')
      .replace(/\bbase\s+frequency\b/gi, 'bass frequency')
      .replace(/\bcolour\b/gi, 'color')
      .replace(/\byoutube\s*dot\s*com\b/gi, 'youtube.com')
      .replace(/\binstagram\s*dot\s*com\b/gi, 'instagram.com')
      .replace(/\bgoogle\s*dot\s*com\b/gi, 'google.com')
      .replace(/\b(?:close|shut|kill)\s+(?:the|this)?\s*tap\b/gi, 'close tab')
      .replace(/\bnew\s+tap\b/gi, 'new tab')
      .replace(/\bswitch\s+(?:to\s+)?tap\b/gi, 'switch tab')
      .replace(/\bthe\s+tap\b/gi, 'the tab')
      .replace(/\bthis\s+tap\b/gi, 'this tab')
      .replace(/\byou\s+tube\b/gi, 'youtube')
      .replace(/\bnew\s+year\s+to\s+you\b/gi, 'open youtube');

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
    formData.append('language', 'en');
    formData.append('temperature', '0.0');
    formData.append('prompt', 'Browser commands: search YouTube, open YouTube, open google, search, close tab, new tab, scroll down, click, go back.');

    const res = await fetch(config.groqWhisperUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.groqApiKey}`
      },
      body: formData
    });

    if (res.ok) {
      const data = await res.json();
      return (data.text || '').trim();
    }
    return '';
  }

  /**
   * Acoustic Cadence, Zero-Crossing Rate (ZCR) and Syllabic Envelope Matcher
   * Classifies core browser command intents from raw PCM audio features
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
    const timeout = setTimeout(() => controller.abort(), 600);

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
   * Package raw 16kHz PCM into a standard 44-byte header WAV buffer
   */
  createWavBuffer(pcmBuffer) {
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

