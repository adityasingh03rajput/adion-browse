const fs = require('fs');
const path = require('path');

/**
 * Lightweight Environment & Secret Config Loader
 * Loads `.env` secrets into process.env without external dependency overhead.
 */
function loadEnv() {
  const envPath = path.join(__dirname, '../../.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      content.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx !== -1) {
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim();
            if (!process.env[key]) {
              process.env[key] = val;
            }
          }
        }
      });
    } catch (e) {
      console.warn('[Config] Failed to load .env file:', e.message);
    }
  }

  return {
    groqApiKey: process.env.GROQ_API_KEY || '',
    groqApiUrl: process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions',
    groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    groqWhisperUrl: process.env.GROQ_WHISPER_URL || 'https://api.groq.com/openai/v1/audio/transcriptions',
    groqWhisperModel: process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo',
    mercuryApiKey: process.env.MERCURY_API_KEY || '',
    mercuryApiUrl: process.env.MERCURY_API_URL || 'https://api.mercury.ai/v1/chat/completions',
    mercuryModel: process.env.MERCURY_MODEL || 'mercury-coder',
    localModelEndpoint: process.env.LOCAL_MODEL_ENDPOINT || 'http://127.0.0.1:11434/api/generate'
  };
}

module.exports = loadEnv();
