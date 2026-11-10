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

  browserProcess = spawn(ELECTRON_BIN, ['.'], {
    cwd: ROOT_DIR,
    env: getEnv(),
    stdio: 'inherit'
  });

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
