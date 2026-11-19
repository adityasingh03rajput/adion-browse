/**
 * Adion Browse — Windows sidecar client
 *
 * Adapted from nus-companion's win/probe.js (Apache-2.0, potlakai/nus-companion
 * v0.1.21), renamed and simplified: Adion's hotkeys live in Electron, so the
 * watch/key-polling path is gone. Everything else is the same contract — one
 * long-lived PowerShell process, JSON lines over stdio, a ping that decides
 * availability, and a restart with backoff.
 *
 * Every caller must tolerate `available === false` (not Windows, PowerShell
 * blocked, sidecar failed to answer): the PC layer then degrades to a clear
 * refusal, never to a hang.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const childProcess = require('child_process');

const PING_TIMEOUT_MS = 20000;
const DEFAULT_TIMEOUT_MS = 3000;
const RESTART_MAX_MS = 30000;

function resolveScript(name, resourcesPath) {
  const candidates = [];
  if (resourcesPath) candidates.push(path.join(resourcesPath, 'pc', name));
  candidates.push(path.join(__dirname, name));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {
      /* next */
    }
  }
  return null;
}

/**
 * createSidecar({ name, resourcesPath, platform, spawn, log, powershell })
 * name: 'probe.ps1' | 'input.ps1'
 */
function createSidecar(options = {}) {
  const emitter = new EventEmitter();
  const log = typeof options.log === 'function' ? options.log : () => {};
  const spawn = typeof options.spawn === 'function' ? options.spawn : childProcess.spawn;
  const platform = options.platform || process.platform;
  const name = options.name || 'probe.ps1';
  const powershell = options.powershell || (platform === 'win32' ? 'powershell.exe' : 'pwsh');
  const script = options.script || resolveScript(name, options.resourcesPath);

  let child = null;
  let stopped = true;
  let nextId = 1;
  let restartDelay = 1000;
  let restartTimer = null;
  let pingTimer = null;
  let buffer = '';
  const pending = new Map();
  const state = { available: false, pid: 0, restarts: 0, lastError: '', ready: false };

  function failPending(reason) {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      pending.delete(id);
    }
  }

  function handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (_) {
      log(`${name}: unparsable line: ${String(line).slice(0, 120)}`);
      return;
    }
    if (message && message.ev) {
      if (message.ev === 'ready') {
        state.ready = true;
        state.pid = Number(message.pid) || state.pid;
      }
      emitter.emit('event', message);
      emitter.emit(message.ev, message);
      return;
    }
    if (message && message.id != null && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(String(message.error)));
      else entry.resolve(message);
    }
  }

  function onExit(code) {
    const wasAvailable = state.available;
    child = null;
    state.available = false;
    state.ready = false;
    if (pingTimer) {
      clearTimeout(pingTimer);
      pingTimer = null;
    }
    failPending(`${name} exited`);
    emitter.emit('availability', false);
    if (stopped) return;
    log(`${name} exited (${code != null ? code : 'signal'})${wasAvailable ? ', restarting' : ''}`);
    state.restarts += 1;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      launch();
    }, restartDelay);
    if (restartTimer.unref) restartTimer.unref();
    restartDelay = Math.min(RESTART_MAX_MS, restartDelay * 2);
  }

  function launch() {
    if (child || stopped) return;
    if (platform !== 'win32') {
      state.lastError = 'not windows';
      return;
    }
    if (!script) {
      state.lastError = `${name} missing`;
      log(state.lastError);
      return;
    }
    try {
      child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      state.lastError = `spawn failed: ${error.message}`;
      log(state.lastError);
      child = null;
      onExit(-1);
      return;
    }
    buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.trim()) handleLine(line);
      }
    });
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (data) => {
        const text = String(data).trim();
        if (text) {
          state.lastError = text.slice(0, 300);
          log(`${name} stderr: ${text.slice(0, 300)}`);
        }
      });
    }
    child.on('error', (error) => {
      state.lastError = error.message;
      log(`${name} error: ${error.message}`);
    });
    child.on('exit', onExit);

    // The ping is the availability gate: no answer means degrade, not hang.
    pingTimer = setTimeout(() => {
      pingTimer = null;
      if (!state.available && child) {
        log(`${name}: no ping reply, giving up`);
        stopped = true;
        try {
          child.kill();
        } catch (_) {
          /* already gone */
        }
      }
    }, PING_TIMEOUT_MS);
    if (pingTimer.unref) pingTimer.unref();

    request('ping', {}, PING_TIMEOUT_MS)
      .then((reply) => {
        if (pingTimer) {
          clearTimeout(pingTimer);
          pingTimer = null;
        }
        state.available = true;
        state.pid = Number(reply.pid) || state.pid;
        restartDelay = 1000;
        log(`${name} ready (pid ${state.pid})`);
        emitter.emit('availability', true);
      })
      .catch((error) => {
        state.lastError = `ping: ${error.message}`;
      });
  }

  function request(op, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!child || !child.stdin || child.stdin.destroyed) {
        reject(new Error(`${name} not running`));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`${op} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      if (timer.unref) timer.unref();
      pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify(Object.assign({ id, op }, params))}\n`);
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  return {
    name,
    get available() {
      return state.available;
    },
    get pid() {
      return state.pid;
    },
    status() {
      return { name, available: state.available, pid: state.pid, restarts: state.restarts, lastError: state.lastError, script };
    },
    start() {
      if (!stopped) return;
      stopped = false;
      restartDelay = 1000;
      launch();
    },
    stop() {
      stopped = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (pingTimer) {
        clearTimeout(pingTimer);
        pingTimer = null;
      }
      const current = child;
      child = null;
      state.available = false;
      failPending(`${name} stopped`);
      if (current) {
        try {
          current.stdin.end();
        } catch (_) {
          /* already closed */
        }
        try {
          current.kill();
        } catch (_) {
          /* already gone */
        }
      }
    },
    request,
    on(event, callback) {
      emitter.on(event, callback);
      return () => emitter.off(event, callback);
    },
    _handleLine: handleLine
  };
}

module.exports = { createSidecar, resolveScript };
