#!/usr/bin/env node

/**
 * Adion Browse - Model Context Protocol (MCP) Stdio Bridge
 * 
 * Acts as a standard stdio bridge for MCP clients (Claude Desktop, Antigravity, LLM agents).
 * Connects standard input/output JSON-RPC stream directly to the Chromium browser framework's
 * hosted MCP server, eliminating conversational token bloat and providing direct browser execution.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');

const discoveryPath = path.resolve(__dirname, '../.data/mcp_server.json');

function getMcpEndpoint() {
  if (fs.existsSync(discoveryPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
      if (data && data.endpoint) {
        return data.endpoint;
      }
    } catch (_) {}
  }
  const defaultPort = parseInt(process.env.ADION_MCP_PORT, 10) || 9224;
  return `http://127.0.0.1:${defaultPort}/mcp`;
}

function forwardRequest(endpoint, requestObj) {
  return new Promise((resolve) => {
    try {
      const url = new URL(endpoint);
      const postData = JSON.stringify(requestObj);

      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 10000
      }, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode === 204 || !body.trim()) {
              resolve(null);
            } else {
              resolve(JSON.parse(body));
            }
          } catch (e) {
            resolve({
              jsonrpc: '2.0',
              id: requestObj.id || null,
              error: { code: -32700, message: 'Invalid response from browser MCP server: ' + e.message }
            });
          }
        });
      });

      req.on('error', (err) => {
        resolve({
          jsonrpc: '2.0',
          id: requestObj.id || null,
          error: {
            code: -32603,
            message: `Adion Browse is not currently running or MCP server unreachable on ${endpoint}. Start Adion Browse first (npm start). Details: ${err.message}`
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          jsonrpc: '2.0',
          id: requestObj.id || null,
          error: { code: -32603, message: 'Browser MCP request timed out after 10000ms' }
        });
      });

      req.write(postData);
      req.end();
    } catch (err) {
      resolve({
        jsonrpc: '2.0',
        id: requestObj.id || null,
        error: { code: -32603, message: 'Bridge request dispatch failed: ' + err.message }
      });
    }
  });
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      const errResp = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
      process.stdout.write(JSON.stringify(errResp) + '\n');
      return;
    }

    const endpoint = getMcpEndpoint();
    const response = await forwardRequest(endpoint, parsed);
    if (response) {
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

main().catch(err => {
  console.error('[MCP Stdio Bridge Fatal Error]:', err);
  process.exit(1);
});

