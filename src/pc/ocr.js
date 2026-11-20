'use strict';
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

/**
 * Windows Native OCR via WinRT Windows.Media.Ocr.OcrEngine
 * Completely local, free, zero network dependency, runs in ~100-250ms.
 */
function recognizeText(imagePath) {
  return new Promise((resolve) => {
    if (!imagePath || !fs.existsSync(imagePath)) {
      return resolve('');
    }

    const scriptPath = path.join(__dirname, 'ocr.ps1');
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-Path', path.resolve(imagePath),
      '-Mode', 'text'
    ], { windowsHide: true });

    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', () => {});
    child.on('close', (code) => {
      resolve(code === 0 ? stdout.trim() : '');
    });
    child.on('error', () => resolve(''));
  });
}

/**
 * Recognize words with exact bounding rectangles from an image.
 * Returns { text: string, words: Array<{ text: string, x: number, y: number, w: number, h: number }> }
 */
function recognizeWords(imagePath) {
  return new Promise((resolve) => {
    if (!imagePath || !fs.existsSync(imagePath)) {
      return resolve({ text: '', lines: [], words: [] });
    }

    const scriptPath = path.join(__dirname, 'ocr.ps1');
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-Path', path.resolve(imagePath),
      '-Mode', 'words'
    ], { windowsHide: true });

    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', () => {});
    child.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        try {
          const parsed = JSON.parse(stdout.trim());
          return resolve({
            text: parsed.text || '',
            lines: Array.isArray(parsed.lines) ? parsed.lines : [],
            words: Array.isArray(parsed.words) ? parsed.words : []
          });
        } catch (_) {
          return resolve({ text: stdout.trim(), lines: [], words: [] });
        }
      }
      resolve({ text: '', lines: [], words: [] });
    });
    child.on('error', () => resolve({ text: '', lines: [], words: [] }));
  });
}

/**
 * Locate text on screen and return exact center coordinates without cloud vision tokens.
 * Supports single words and multi-word token sequences.
 */
async function findWordCoordinates(imagePath, query) {
  const clean = String(query || '').trim().toLowerCase();
  if (!clean) return { found: false, reason: 'empty-query' };

  const { words, lines, text } = await recognizeWords(imagePath);
  if ((!words || words.length === 0) && (!lines || lines.length === 0)) {
    return { found: false, reason: 'no-text-detected', fullText: text };
  }

  // 1. First, check whole lines for exact or substring match
  if (Array.isArray(lines) && lines.length > 0) {
    const lineMatch = lines.find(l => {
      const lt = String(l.text || '').toLowerCase().trim();
      return lt === clean || lt.includes(clean);
    });
    if (lineMatch) {
      const cx = Math.round(lineMatch.x + lineMatch.w / 2);
      const cy = Math.round(lineMatch.y + lineMatch.h / 2);
      return {
        found: true,
        x: cx,
        y: cy,
        width: lineMatch.w,
        height: lineMatch.h,
        label: lineMatch.text,
        confidence: String(lineMatch.text || '').toLowerCase().trim() === clean ? 0.99 : 0.92
      };
    }
  }

  const queryTokens = clean.split(/\s+/).filter(Boolean);

  // 2. Exact or substring match for single word
  if (queryTokens.length === 1) {
    const target = queryTokens[0];
    // Exact word match
    let match = words.find(w => w.text && w.text.toLowerCase() === target);
    // Prefix / substring match
    if (!match) {
      match = words.find(w => w.text && w.text.toLowerCase().includes(target));
    }
    // Reverse substring (e.g. target is longer)
    if (!match) {
      match = words.find(w => w.text && target.includes(w.text.toLowerCase()) && w.text.length >= 3);
    }

    if (match) {
      const cx = Math.round(match.x + match.w / 2);
      const cy = Math.round(match.y + match.h / 2);
      return {
        found: true,
        x: cx,
        y: cy,
        width: match.w,
        height: match.h,
        label: match.text,
        confidence: match.text.toLowerCase() === target ? 0.98 : 0.85
      };
    }
  }

  // 3. Multi-word phrase matching
  for (let i = 0; i <= words.length - queryTokens.length; i++) {
    let matched = true;
    for (let j = 0; j < queryTokens.length; j++) {
      const wText = (words[i + j]?.text || '').toLowerCase();
      if (!wText.includes(queryTokens[j])) {
        matched = false;
        break;
      }
    }
    if (matched) {
      const first = words[i];
      const last = words[i + queryTokens.length - 1];
      const left = Math.min(first.x, last.x);
      const top = Math.min(first.y, last.y);
      const right = Math.max(first.x + first.w, last.x + last.w);
      const bottom = Math.max(first.y + first.h, last.y + last.h);
      const cx = Math.round((left + right) / 2);
      const cy = Math.round((top + bottom) / 2);
      return {
        found: true,
        x: cx,
        y: cy,
        width: right - left,
        height: bottom - top,
        label: words.slice(i, i + queryTokens.length).map(w => w.text).join(' '),
        confidence: 0.95
      };
    }
  }

  return { found: false, reason: 'query-not-found-in-ocr', wordsCount: words.length };
}

/**
 * Recognize words and text directly from base64 image data using local Windows OCR.
 */
async function recognizeWordsInBase64(base64Data) {
  if (!base64Data) return { text: '', lines: [], words: [] };
  const cleanB64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
  const tempPath = path.join(os.tmpdir(), `adion_ocr_words_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.png`);
  try {
    const buffer = Buffer.from(cleanB64, 'base64');
    fs.writeFileSync(tempPath, buffer);
    const result = await recognizeWords(tempPath);
    return result;
  } catch (err) {
    return { text: '', lines: [], words: [], error: err.message };
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_) {}
  }
}

/**
 * Locate text coordinates directly from base64 image data using local Windows OCR.
 */
async function findTextInBase64(base64Data, query) {
  if (!base64Data || !query) return { found: false };
  const cleanB64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
  const tempPath = path.join(os.tmpdir(), `adion_ocr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.png`);
  try {
    const buffer = Buffer.from(cleanB64, 'base64');
    fs.writeFileSync(tempPath, buffer);
    const result = await findWordCoordinates(tempPath, query);
    return result;
  } catch (err) {
    return { found: false, error: err.message };
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_) {}
  }
}

module.exports = {
  recognizeText,
  recognizeWords,
  recognizeWordsInBase64,
  findWordCoordinates,
  findTextInBase64
};
