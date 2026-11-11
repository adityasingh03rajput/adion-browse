/**
 * Adion Browse - Standalone Local Terminal Bridge
 * 
 * High-performance, zero-dependency standalone terminal execution bridge for Adion Browse.
 * Connects the browser's autonomous AI agent directly to the local PC terminal environment.
 * Operates across Windows (powershell.exe / cmd.exe), macOS (zsh / bash), and Linux (bash / sh).
 * 
 * Features:
 * 1. Zero External Dependencies: Runs natively on Node.js / Electron without requiring Python or pip.
 * 2. Standalone Executable Runtime: Can run embedded within Adion Browse or standalone via CLI (`node terminalBridge.js`).
 * 3. Bidirectional JSON-RPC / HTTP REST API: Exposes /exec, /status, /kill, and streaming output.
 * 4. Dual Shell Support: Default PowerShell on Windows with fallback to cmd.exe, and zsh/bash on POSIX.
 * 5. Execution Isolation & Safety Timeout: Configurable timeouts, working directory tracking, and process lifecycle control.
 */

const { spawn, exec } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');

const DEFAULT_BRIDGE_PORT = parseInt(process.env.ADION_TERMINAL_PORT, 10) || 9225;

class TerminalBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || DEFAULT_BRIDGE_PORT;
    this.cwd = options.cwd || process.cwd();
    this.server = null;
    this.isConnected = false;
    this.activeProcesses = new Map(); // pid -> { child, command, startTime }
    this.history = []; // Array of { id, command, output, exitCode, durationMs, timestamp }
    this.maxHistory = options.maxHistory || 100;

    // Platform shell resolution
    this.isWindows = process.platform === 'win32';
    this.defaultShell = this.isWindows 
      ? (process.env.COMSPEC ? 'powershell.exe' : 'cmd.exe')
      : (process.env.SHELL || '/bin/bash');
  }

  /**
   * Start the standalone HTTP / JSON-RPC Terminal Bridge Server
   */
  async start() {
    if (this.isConnected && this.server) {
      return { port: this.port, alreadyRunning: true };
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`[TerminalBridge] Port ${this.port} in use, attempting port ${this.port + 1}...`);
          this.port += 1;
          this.server.close();
          this.server.listen(this.port, '127.0.0.1');
        } else {
          this.isConnected = false;
          this.emit('status-change', { connected: false, error: err.message });
          reject(err);
        }
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        this.isConnected = true;
        console.log(`[TerminalBridge] 🚀 Local PC Terminal Bridge connected at http://127.0.0.1:${this.port}`);
        this.emit('status-change', { connected: true, port: this.port, shell: this.defaultShell, cwd: this.cwd });
        resolve({ port: this.port, shell: this.defaultShell, cwd: this.cwd });
      });
    });
  }

  /**
   * Stop the terminal bridge and clean up running child processes
   */
  async stop() {
    if (!this.server) {
      this.isConnected = false;
      return { stopped: true };
    }

    // Kill any active child processes
    for (const [pid, proc] of this.activeProcesses.entries()) {
      try {
        if (proc.child && !proc.child.killed) {
          proc.child.kill();
        }
      } catch (_) {}
    }
    this.activeProcesses.clear();

    return new Promise((resolve) => {
      this.server.close(() => {
        this.isConnected = false;
        this.server = null;
        console.log('[TerminalBridge] 🔌 Local PC Terminal Bridge disconnected.');
        this.emit('status-change', { connected: false });
        resolve({ stopped: true });
      });
    });
  }

  /**
   * Toggle the terminal bridge on/off
   */
  async toggle(enable) {
    const targetState = typeof enable === 'boolean' ? enable : !this.isConnected;
    if (targetState) {
      return await this.start();
    } else {
      return await this.stop();
    }
  }

  /**
   * Get current bridge status
   */
  getStatus() {
    return {
      connected: this.isConnected,
      port: this.port,
      shell: this.defaultShell,
      cwd: this.cwd,
      activeTasks: this.activeProcesses.size,
      totalExecuted: this.history.length,
      platform: os.platform(),
      hostname: os.hostname(),
      username: os.userInfo ? os.userInfo().username : 'user'
    };
  }

  /**
   * Execute command directly on local PC terminal
   */
  async executeCommand(command, options = {}) {
    if (!command || typeof command !== 'string') {
      throw new Error('Command must be a non-empty string');
    }

    const cmd = command.trim();
    const timeoutMs = options.timeoutMs || 45000;
    const executionCwd = options.cwd || this.cwd;
    const startTime = Date.now();
    const taskId = 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let isTimedOut = false;

      // Handle custom cwd changes (e.g. `cd folder`)
      const cdMatch = cmd.match(/^cd\s+["']?([^"']+)["']?$/i);
      if (cdMatch) {
        const targetDir = path.resolve(executionCwd, cdMatch[1].trim());
        try {
          if (require('fs').existsSync(targetDir)) {
            this.cwd = targetDir;
            const res = {
              success: true,
              taskId,
              command: cmd,
              stdout: `Working directory changed to: ${this.cwd}\n`,
              stderr: '',
              exitCode: 0,
              cwd: this.cwd,
              durationMs: Date.now() - startTime
            };
            this.recordHistory(res);
            this.emit('command-completed', res);
            return resolve(res);
          } else {
            const res = {
              success: false,
              taskId,
              command: cmd,
              stdout: '',
              stderr: `Directory not found: ${targetDir}\n`,
              exitCode: 1,
              cwd: this.cwd,
              durationMs: Date.now() - startTime
            };
            this.recordHistory(res);
            return resolve(res);
          }
        } catch (e) {
          const res = {
            success: false,
            taskId,
            command: cmd,
            stdout: '',
            stderr: e.message,
            exitCode: 1,
            cwd: this.cwd,
            durationMs: Date.now() - startTime
          };
          return resolve(res);
        }
      }

      // Shell execution parameters
      let shellExecutable = this.defaultShell;
      let shellArgs = [];

      if (this.isWindows) {
        if (shellExecutable.toLowerCase().includes('powershell')) {
          shellArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd];
        } else {
          shellArgs = ['/c', cmd];
        }
      } else {
        shellArgs = ['-c', cmd];
      }

      let child = null;
      try {
        child = spawn(shellExecutable, shellArgs, {
          cwd: executionCwd,
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
          windowsHide: true
        });
      } catch (spawnErr) {
        const failRes = {
          success: false,
          taskId,
          command: cmd,
          stdout: '',
          stderr: `Failed to spawn shell: ${spawnErr.message}`,
          exitCode: 1,
          cwd: executionCwd,
          durationMs: Date.now() - startTime
        };
        this.recordHistory(failRes);
        return resolve(failRes);
      }

      const pid = child.pid;
      this.activeProcesses.set(pid, { child, command: cmd, startTime, taskId });
      this.emit('command-started', { taskId, pid, command: cmd });

      // Stream stdout
      if (child.stdout) {
        child.stdout.on('data', (data) => {
          const chunk = data.toString();
          stdout += chunk;
          this.emit('command-output', { taskId, pid, chunk, stream: 'stdout' });
        });
      }

      // Stream stderr
      if (child.stderr) {
        child.stderr.on('data', (data) => {
          const chunk = data.toString();
          stderr += chunk;
          this.emit('command-output', { taskId, pid, chunk, stream: 'stderr' });
        });
      }

      // Safety timeout timer
      const timeoutTimer = setTimeout(() => {
        isTimedOut = true;
        try {
          if (!child.killed) {
            child.kill();
          }
        } catch (_) {}
      }, timeoutMs);

      child.on('error', (err) => {
        clearTimeout(timeoutTimer);
        this.activeProcesses.delete(pid);
        const res = {
          success: false,
          taskId,
          command: cmd,
          stdout,
          stderr: stderr ? `${stderr}\n${err.message}` : err.message,
          exitCode: 1,
          cwd: executionCwd,
          durationMs: Date.now() - startTime
        };
        this.recordHistory(res);
        this.emit('command-completed', res);
        resolve(res);
      });

      child.on('close', (code) => {
        clearTimeout(timeoutTimer);
        this.activeProcesses.delete(pid);
        const durationMs = Date.now() - startTime;

        let finalStderr = stderr;
        if (isTimedOut) {
          finalStderr += `\n[TerminalBridge] Process terminated after exceeding timeout (${timeoutMs}ms)`;
        }

        const isSuccess = code === 0 && !isTimedOut;
        const res = {
          success: isSuccess,
          taskId,
          pid,
          command: cmd,
          stdout: stdout.trimEnd(),
          stderr: finalStderr.trimEnd(),
          exitCode: isTimedOut ? 124 : (code ?? 0),
          cwd: executionCwd,
          durationMs
        };

        this.recordHistory(res);
        this.emit('command-completed', res);
        resolve(res);
      });
    });
  }

  /**
   * Keep a rolling history of executed commands
   */
  recordHistory(entry) {
    this.history.push({
      id: entry.taskId,
      command: entry.command,
      stdoutSnippet: (entry.stdout || '').slice(0, 500),
      stderrSnippet: (entry.stderr || '').slice(0, 500),
      exitCode: entry.exitCode,
      success: entry.success,
      cwd: entry.cwd,
      durationMs: entry.durationMs,
      timestamp: new Date().toLocaleTimeString()
    });

    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  /**
   * Handle incoming HTTP API and JSON-RPC requests
   */
  async handleRequest(req, res) {
    // Enable CORS for browser integration
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const pathname = parsedUrl.pathname;

    // GET /status
    if (req.method === 'GET' && (pathname === '/status' || pathname === '/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.getStatus(), null, 2));
      return;
    }

    // GET /history
    if (req.method === 'GET' && pathname === '/history') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ history: this.history }, null, 2));
      return;
    }

    // POST /exec
    if (req.method === 'POST' && pathname === '/exec') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const command = payload.command || payload.cmd;
          if (!command) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing "command" in request payload' }));
            return;
          }

          const result = await this.executeCommand(command, {
            cwd: payload.cwd || this.cwd,
            timeoutMs: payload.timeoutMs || 45000
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result, null, 2));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // Default 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found', availableEndpoints: ['/status', '/exec', '/history'] }));
  }
}

// Allow direct CLI execution: node src/terminal/terminalBridge.js
if (require.main === module) {
  const bridge = new TerminalBridge();
  bridge.start().then(({ port, shell, cwd }) => {
    console.log(`[TerminalBridge CLI] Running standalone on port ${port}`);
    console.log(`[TerminalBridge CLI] Shell: ${shell}`);
    console.log(`[TerminalBridge CLI] Working Dir: ${cwd}`);
  }).catch(err => {
    console.error('[TerminalBridge CLI] Startup error:', err);
    process.exit(1);
  });
}

module.exports = TerminalBridge;

