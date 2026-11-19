'use strict';
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

/**
 * Windows Native OCR via WinRT Windows.Media.Ocr.OcrEngine
 * Completely local, free, zero network dependency, runs in ~300ms.
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
      '-Path', path.resolve(imagePath)
    ], { windowsHide: true });

    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', () => {});
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        resolve('');
      }
    });
    child.on('error', () => resolve(''));
  });
}

module.exports = { recognizeText };
