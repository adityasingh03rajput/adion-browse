#!/usr/bin/env node

/**
 * Adion Browse - Model Context Protocol (MCP) Port Forwarder & Tunnel Manager
 * 
 * Verifies local MCP loopback availability (http://127.0.0.1:9224), resolves LAN endpoints,
 * optionally spawns public HTTPS tunnels via localtunnel for remote Claude connections,
 * and outputs exact configuration JSON blocks for Claude Desktop and Claude Code.
 */

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const discoveryPath = path.resolve(__dirname, '../.data/mcp_server.json');
const isTunnelReq = process.argv.includes('--tunnel') || process.argv.includes('-t');

function getMcpConfig() {
  if (fs.existsSync(discoveryPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
      if (data && data.port) return data;
    } catch (_) {}
  }
  const defaultPort = parseInt(process.env.ADION_MCP_PORT, 10) || 9224;
  return {
    port: defaultPort,
    endpoint: `http://127.0.0.1:${defaultPort}/mcp`,
    sse: `http://127.0.0.1:${defaultPort}/sse`
  };
}

function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function checkMcpHealth(port) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const req = http.request({
      hostname: '127.0.0.1',
      port: port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 3000
    }, (res) => {
      resolve(res.statusCode === 200 || res.statusCode === 204);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(postData);
    req.end();
  });
}

function startLocaltunnel(port) {
  return new Promise((resolve, reject) => {
    console.log(`\n[Tunnel] Initializing public HTTPS tunnel on port ${port}...`);
    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const lt = spawn(npxCmd, ['--yes', 'localtunnel', '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let resolved = false;

    lt.stdout.on('data', (data) => {
      const str = data.toString();
      const match = str.match(/https:\/\/[^\s]+/);
      if (match && !resolved) {
        resolved = true;
        resolve({ url: match[0].trim(), process: lt });
      }
    });

    lt.stderr.on('data', (err) => {
      const msg = err.toString();
      if (!resolved && msg.includes('Error')) {
        resolved = true;
        reject(new Error(msg));
      }
    });

    lt.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Tunnel creation timed out after 12 seconds'));
      }
    }, 12000);
  });
}

async function resolveActivePort() {
  const config = getMcpConfig();
  const candidatePorts = [config.port, 9224, 9225, 9288].filter(Boolean);
  for (const p of candidatePorts) {
    if (await checkMcpHealth(p)) {
      return p;
    }
  }
  return config.port || 9224;
}

async function main() {
  const port = await resolveActivePort();
  const lanIp = getLanIp();
  const isHealthy = await checkMcpHealth(port);

  console.log('================================================================================');
  console.log('       ADION BROWSE - MODEL CONTEXT PROTOCOL (MCP) PORT FORWARDING              ');
  console.log('================================================================================');

  if (!isHealthy) {
    console.log(`⚠️  Adion Browse MCP server is not currently responding on 127.0.0.1:${port}.`);
    console.log(`👉 Please ensure Adion Browse is running: npm start\n`);
  } else {
    console.log(`✅ Adion Browse MCP server is ACTIVE and HEALTHY on port ${port}\n`);
  }

  console.log(`📍 Local Loopback Endpoints:`);
  console.log(`   - JSON-RPC Endpoint : http://127.0.0.1:${port}/mcp`);
  console.log(`   - SSE Event Stream  : http://127.0.0.1:${port}/sse`);
  console.log(`   - Stdio Bridge Path : ${path.resolve(__dirname, 'mcp-server.js')}\n`);

  console.log(`🌐 Local Network (LAN) Endpoints (IP: ${lanIp}):`);
  console.log(`   - LAN JSON-RPC      : http://${lanIp}:${port}/mcp`);
  console.log(`   - LAN SSE Stream    : http://${lanIp}:${port}/sse\n`);

  let tunnelUrl = null;
  let tunnelProc = null;

  if (isTunnelReq) {
    try {
      const tunnel = await startLocaltunnel(port);
      tunnelUrl = tunnel.url;
      tunnelProc = tunnel.process;
      console.log(`🚀 Public Cloud / Remote Tunnel Active:`);
      console.log(`   - Public Base URL   : ${tunnelUrl}`);
      console.log(`   - Remote JSON-RPC   : ${tunnelUrl}/mcp`);
      console.log(`   - Remote SSE Stream : ${tunnelUrl}/sse\n`);
    } catch (err) {
      console.warn(`[Tunnel Warning] Could not establish localtunnel: ${err.message}`);
    }
  } else {
    console.log(`💡 Tip: To generate a public HTTPS tunnel for remote Claude Web / API, run:`);
    console.log(`   node scripts/port-forward.js --tunnel\n`);
  }

  console.log('--------------------------------------------------------------------------------');
  console.log('  CLAUDE DESKTOP CONFIGURATION (claude_desktop_config.json)                     ');
  console.log('  Location: %APPDATA%\\Claude\\claude_desktop_config.json                          ');
  console.log('--------------------------------------------------------------------------------');

  const stdioConfig = {
    mcpServers: {
      "adion-browse": {
        command: "node",
        args: [path.resolve(__dirname, 'mcp-server.js')]
      }
    }
  };

  const sseConfig = {
    mcpServers: {
      "adion-browse": {
        endpoint: tunnelUrl ? `${tunnelUrl}/sse` : `http://127.0.0.1:${port}/sse`
      }
    }
  };

  console.log('\n[Option 1: Recommended for Claude Desktop on Windows (Stdio Bridge)]');
  console.log(JSON.stringify(stdioConfig, null, 2));

  console.log('\n[Option 2: Network / SSE Stream (Claude Desktop / Remote Agents)]');
  console.log(JSON.stringify(sseConfig, null, 2));

  console.log('\n================================================================================');

  if (tunnelProc) {
    console.log('⚡ Tunnel is running in foreground. Press Ctrl+C to terminate the tunnel.');
    process.on('SIGINT', () => {
      tunnelProc.kill();
      process.exit(0);
    });
  }
}

main().catch(console.error);
