const DEFAULT_ENDPOINT = 'https://api.anysearch.com/mcp';
const MCP_PROTOCOL_VERSION = '2025-03-26';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESULT_CHARS = 7000;

/**
 * Minimal Streamable HTTP MCP client for the hosted AnySearch service.
 * The endpoint is intentionally fixed in production; callers can inject fetch
 * in tests without allowing a user-controlled URL/SSRF configuration.
 */
class AnySearchClient {
  constructor(options = {}) {
    this.endpoint = options.endpoint || DEFAULT_ENDPOINT;
    this.apiKey = String(options.apiKey || process.env.ANYSEARCH_API_KEY || '').trim();
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.timeoutMs = options.timeoutMs || 12000;
    this.protocolVersion = null;
    this.sessionId = null;
    this.nextRequestId = 1;
    this.initialized = false;
    this.initializing = null;
    this.searchToolAvailable = false;
  }

  async initialize() {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;

    this.initializing = this._initialize().finally(() => {
      this.initializing = null;
    });
    return this.initializing;
  }

  async _initialize() {
    if (typeof this.fetchFn !== 'function') {
      throw new Error('Fetch is unavailable; AnySearch cannot be reached.');
    }

    const response = await this._sendRequest('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'adion-browse', version: '1.0.0' }
    }, { initialize: true });

    const negotiatedVersion = response?.result?.protocolVersion;
    if (!negotiatedVersion) {
      throw new Error('AnySearch returned an invalid MCP initialize response.');
    }
    this.protocolVersion = negotiatedVersion;

    await this._sendNotification('notifications/initialized');

    const toolsResponse = await this._sendRequest('tools/list', {});
    const tools = toolsResponse?.result?.tools;
    this.searchToolAvailable = Array.isArray(tools) && tools.some((tool) => tool && tool.name === 'search');
    if (!this.searchToolAvailable) {
      throw new Error('The AnySearch MCP server does not expose its search tool.');
    }

    this.initialized = true;
  }

  async search(query, maxResults = 5) {
    const cleanQuery = sanitizeQuery(query);
    if (!cleanQuery) throw new Error('A non-empty search query is required.');

    await this.initialize();
    const limit = Math.max(1, Math.min(10, Math.trunc(Number(maxResults) || 5)));
    const response = await this._sendRequest('tools/call', {
      name: 'search',
      arguments: { query: cleanQuery, max_results: limit }
    });

    const result = response?.result;
    if (!result) throw new Error('AnySearch returned an empty tool result.');
    if (result.isError) {
      throw new Error(extractToolText(result) || 'AnySearch search failed.');
    }

    const text = extractToolText(result).trim();
    if (!text) throw new Error('AnySearch returned no search results.');
    return text.slice(0, MAX_RESULT_CHARS);
  }

  async _sendRequest(method, params, options = {}) {
    const id = this.nextRequestId++;
    const message = { jsonrpc: '2.0', id, method, params };
    const response = await this._postMessage(message, options);

    if (!response || response.id !== id) {
      throw new Error(`AnySearch returned an invalid response for ${method}.`);
    }
    if (response.error) {
      throw new Error(response.error.message || `AnySearch MCP error (${response.error.code || 'unknown'}).`);
    }
    return response;
  }

  async _sendNotification(method, params = undefined) {
    const message = { jsonrpc: '2.0', method };
    if (params !== undefined) message.params = params;
    await this._postMessage(message);
  }

  async _postMessage(message, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'X-Anysearch-Client': 'mcp/1.0.0'
    };

    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (!options.initialize && this.protocolVersion) {
      headers['MCP-Protocol-Version'] = this.protocolVersion;
    }

    try {
      const response = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        signal: controller.signal
      });

      const issuedSessionId = response.headers?.get?.('mcp-session-id');
      if (issuedSessionId) this.sessionId = issuedSessionId;

      const contentType = response.headers?.get?.('content-type') || '';
      const expectedResponseId = response.ok ? message.id : undefined;
      const { body, parsed: streamedResponse } = await readResponseBody(response, contentType, expectedResponseId);
      if (!response.ok) {
        const detail = body.replace(/\s+/g, ' ').trim().slice(0, 300);
        throw new Error(`AnySearch MCP HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      if (!body.trim() && !streamedResponse) return null; // Normal for an accepted JSON-RPC notification.

      const parsed = streamedResponse || parseMcpResponse(body, contentType, message.id);
      if (!parsed) throw new Error('AnySearch returned an unreadable MCP response.');
      return parsed;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`AnySearch request timed out after ${this.timeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function sanitizeQuery(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

async function readResponseBody(response, contentType = '', expectedId = undefined) {
  const isSse = /text\/event-stream/i.test(contentType);
  const reader = isSse ? response.body?.getReader?.() : null;

  // Streamable HTTP may keep an SSE response open for server notifications.
  // Stop reading as soon as the matching JSON-RPC response arrives.
  if (reader && expectedId !== undefined) {
    const decoder = new TextDecoder();
    let body = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        body += decoder.decode(value, { stream: true });
        if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
          throw new Error('AnySearch response exceeded the 1 MB safety limit.');
        }
        const parsed = parseMcpResponse(body, contentType, expectedId);
        if (parsed) {
          await reader.cancel().catch(() => {});
          return { body, parsed };
        }
      }
      body += decoder.decode();
      return { body, parsed: parseMcpResponse(body, contentType, expectedId) };
    } finally {
      try { reader.releaseLock(); } catch (_) {}
    }
  }

  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('AnySearch response exceeded the 1 MB safety limit.');
  }
  return { body, parsed: null };
}

function parseMcpResponse(body, contentType = '', expectedId = undefined) {
  const isEventStream = /text\/event-stream/i.test(contentType) || /^\s*(?:event|data):/m.test(body);
  if (!isEventStream) {
    try {
      return JSON.parse(body);
    } catch (_) {
      return null;
    }
  }

  const messages = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const dataLines = block.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''));
    if (!dataLines.length) continue;
    try {
      const message = JSON.parse(dataLines.join('\n'));
      if (message && typeof message === 'object') messages.push(message);
    } catch (_) {
      // Ignore SSE keep-alives or non-JSON event data.
    }
  }

  if (expectedId !== undefined) {
    return messages.find((message) => message.id === expectedId) || null;
  }
  return messages[messages.length - 1] || null;
}

function extractToolText(result) {
  const chunks = Array.isArray(result.content)
    ? result.content.filter((item) => item?.type === 'text' && typeof item.text === 'string').map((item) => item.text)
    : [];
  if (chunks.length) return chunks.join('\n');
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return '';
}

module.exports = AnySearchClient;
module.exports.sanitizeQuery = sanitizeQuery;
module.exports.parseMcpResponse = parseMcpResponse;
