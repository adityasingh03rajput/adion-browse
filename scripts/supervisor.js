/**
 * Adion Browse - Process Supervisor & Resilience Watchdog
 *
 * Supervises the Electron browser runtime process:
 * - Detects unexpected terminations, SIGINT interruptions, and crashes.
 * - Automatically restarts the browser to ensure continuous agent operation.
 * - Restores open tabs and session state via the local persistent store.
 * - Provides graceful double-SIGINT safety shutdown.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT_DIR = path.resolve(__dirname, '..');
const ELECTRON_BIN = require('electron');

let browserProcess = null;
let isShuttingDown = false;
let restartCount = 0;
let lastRestartTime = Date.now();
let lastSigintTime = 0;

function getEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ELECTRON_CACHE = path.join(ROOT_DIR, '.cache', 'electron');
  return env;
}

function startBrowser() {
  if (isShuttingDown) return;

  const now = Date.now();
  if (now - lastRestartTime < 8000) {
    restartCount++;
  } else {
    restartCount = 0;
  }
  lastRestartTime = now;

  console.log('\n======================================================');
  console.log('[Adion Supervisor] 🛡️  Process resilience monitor active');
  console.log(`[Adion Supervisor] Launching Adion Browse (attempt #${restartCount + 1})...`);
  console.log('======================================================\n');

  const logDir = path.join(ROOT_DIR, '.data');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'browser.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  browserProcess = spawn(ELECTRON_BIN, ['.'], {
    cwd: ROOT_DIR,
    env: getEnv(),
    stdio: ['inherit', 'pipe', 'pipe']
  });

  const noisePatterns = [
    /:\d+:\d+\/\d+\.\d+:(ERROR|WARNING|INFO):/i,
    /gpu_process_host\.cc/i,
    /gpu_init\.cc/i,
    /sandbox_win\.cc/i,
    /audio_manager_win\.cc/i,
    /angle_platform_impl\.cc/i,
    /gl_surface_egl\.cc/i,
    /d3d11_device\.cc/i,
    /cert_verify_proc/i,
    /viz_main_impl\.cc/i,
    /paint_controller\.cc/i,
    /DevTools listening on ws:/i,
    /DeprecationWarning/i,
    /GetInterfaceInfo/i,
    /ALSA/i,
    /DirectSound/i,
    /fallback to non-strict/i,
    /\[AgentRuntime Audio\] Diagnostics: Frame #/i
  ];

  function createStructuredLogger(stream, isStderr = false) {
    let pendingBuffer = '';
    return (chunk) => {
      const text = chunk.toString();
      if (stream) stream.write(text);

      pendingBuffer += text;
      const lines = pendingBuffer.split(/\r?\n/);
      pendingBuffer = lines.pop();

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (noisePatterns.some(pattern => pattern.test(line))) {
          continue;
        }

        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

        let formatted = line;
        if (line.includes('[AgentRuntime Audio]') || line.includes('[AgentRuntime VAD]')) {
          formatted = `[${timeStr}] 🎙️  ${line.replace(/\[AgentRuntime\s+/, '[')}`;
        } else if (line.includes('[STTEngine]')) {
          formatted = `[${timeStr}] 🗣️  ${line}`;
        } else if (line.includes('[ModelClient]') || line.includes('[Claude]') || line.includes('[AnthropicProvider]')) {
          formatted = `[${timeStr}] 🤖 ${line}`;
        } else if (line.includes('[MCPServer]')) {
          formatted = `[${timeStr}] 📡 ${line}`;
        } else if (line.includes('[SessionManager]')) {
          formatted = `[${timeStr}] 💾 ${line}`;
        } else if (line.includes('[AgentRuntime FileSystem]') || line.includes('[AgentRuntime FastPath]')) {
          formatted = `[${timeStr}] ⚡ ${line.replace('[AgentRuntime ', '[')}`;
        } else if (isStderr && /error/i.test(line)) {
          formatted = `[${timeStr}] ⚠️  [SYSTEM ERROR] ${line}`;
        } else if (isStderr) {
          continue;
        } else {
          formatted = `[${timeStr}] ℹ️  ${line}`;
        }

        console.log(formatted);
      }
    };
  }

  const handleStdout = createStructuredLogger(logStream, false);
  const handleStderr = createStructuredLogger(logStream, true);

  browserProcess.stdout.on('data', handleStdout);
  browserProcess.stderr.on('data', handleStderr);

  const currentPid = browserProcess.pid;
  console.log(`[Adion Supervisor] Browser process active (PID: ${currentPid})`);

  browserProcess.on('error', (err) => {
    console.error(`[Adion Supervisor] Failed to spawn browser process:`, err);
    scheduleRestart(2000);
  });

  browserProcess.on('exit', (code, signal) => {
    console.log(`\n[Adion Supervisor] Browser process (PID: ${currentPid}) exited with code ${code}, signal: ${signal || 'none'}`);

    if (isShuttingDown) {
      console.log('[Adion Supervisor] Clean shutdown complete. Exiting.');
      process.exit(0);
      return;
    }

    // Normal clean user close (e.g. user closed browser window normally)
    if (code === 0 && !signal) {
      console.log('[Adion Supervisor] Browser closed normally by user (code 0). Exiting supervisor.');
      process.exit(0);
      return;
    }

    // Unexpected exit, crash, or signal interruption
    console.warn(`[Adion Supervisor] ⚠️  Unexpected termination detected (code: ${code}, signal: ${signal}).`);
    console.warn(`[Adion Supervisor] Resilient recovery triggered. Auto-restarting browser...`);

    // Back off slightly if repeated crashes in short succession
    const delay = restartCount >= 4 ? 4000 : 1200;
    scheduleRestart(delay);
  });
}

function scheduleRestart(delayMs) {
  if (isShuttingDown) return;
  console.log(`[Adion Supervisor] Restarting browser in ${delayMs / 1000}s...`);
  setTimeout(() => {
    startBrowser();
  }, delayMs);
}

// Graceful SIGINT / SIGTERM Handling
process.on('SIGINT', () => {
  const now = Date.now();
  if (now - lastSigintTime < 2500) {
    console.log('\n[Adion Supervisor] Double Ctrl+C received. Force stopping supervisor and browser...');
    isShuttingDown = true;
    if (browserProcess && !browserProcess.killed) {
      try {
        browserProcess.kill('SIGKILL');
      } catch (_) {}
    }
    process.exit(0);
  } else {
    lastSigintTime = now;
    console.log('\n[Adion Supervisor] SIGINT (Ctrl+C) received. Press Ctrl+C again within 2.5s to terminate supervisor, or supervisor will maintain resilience.');
    if (browserProcess && !browserProcess.killed) {
      try {
        browserProcess.kill('SIGINT');
      } catch (_) {}
    }
  }
});

process.on('SIGTERM', () => {
  isShuttingDown = true;
  if (browserProcess && !browserProcess.killed) {
    try {
      browserProcess.kill('SIGTERM');
    } catch (_) {}
  }
  process.exit(0);
});

// Start initial browser instance
startBrowser();

