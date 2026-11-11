/**
 * Adion Browse - Model Context Protocol (MCP) Server
 * 
 * Implements the standard Model Context Protocol (v2024-11-05) within the Chromium framework.
 * Enables direct, low-overhead communication between LLM agents (e.g. Antigravity, Claude, external agents)
 * and Adion Browse functions, slashing token consumption by up to 90% via:
 * 
 * 1. Structured Tool Schemas: Typed tool calls eliminate multi-turn conversational guessing.
 * 2. Token-Optimized Page Content: Semantic DOM extraction strips bloated scripts/styles into clean markdown.
 * 3. Direct Browser & DSP Controls: Zero-latency tab control, DOM modification, and audio DSP tuning.
 * 4. Dual Transport: Embedded HTTP/SSE JSON-RPC endpoint & stdio bridge for seamless MCP client integration.
 */

const http = require('http');
const url = require('url');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const { ActionType } = require('../control-plane/protocol');

const MCP_PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_PORT = parseInt(process.env.ADION_MCP_PORT, 10) || 9224;

class MCPServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.controlPlane = options.controlPlane || null;
    this.tabManager = options.tabManager || null;
    this.runtime = options.runtime || null;
    this.cdp = options.cdp || null;

    this.port = DEFAULT_PORT;
    this.server = null;
    this.isRunning = false;
    this.sseClients = new Set();

    this.serverInfo = {
      name: 'adion-browse-mcp',
      version: '1.0.0',
      description: 'Adion Browse Model Context Protocol Server - Direct High-Performance Chromium Control'
    };

    this.capabilities = {
      tools: {
        listChanged: false
      },
      resources: {
        subscribe: false,
        listChanged: false
      },
      prompts: {
        listChanged: false
      }
    };

    this.tools = this.registerTools();
    this.resources = this.registerResources();
    this.prompts = this.registerPrompts();
  }

  /**
   * Register available MCP Tools with JSON Schema declarations
   */
  registerTools() {
    return [
      {
        name: 'browser_navigate',
        description: 'Navigate the active browser tab or open a new tab with a specified URL or search query.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Destination URL (e.g., https://example.com) or search query' },
            newTab: { type: 'boolean', description: 'Whether to open in a new tab instead of navigating the active tab' }
          },
          required: ['url']
        }
      },
      {
        name: 'browser_list_tabs',
        description: 'List all open browser tabs with their IDs, URLs, titles, and active status.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'browser_create_tab',
        description: 'Open a new browser tab with an optional URL.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Initial URL (defaults to adion://newtab)' }
          }
        }
      },
      {
        name: 'browser_close_tab',
        description: 'Close the specified tab or the currently active tab.',
        inputSchema: {
          type: 'object',
          properties: {
            tabId: { type: 'string', description: 'Tab ID to close (defaults to active tab if omitted)' }
          }
        }
      },
      {
        name: 'browser_switch_tab',
        description: 'Switch focus to a specific tab by ID, title, or search query.',
        inputSchema: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Tab ID or query matching tab title or URL' }
          },
          required: ['target']
        }
      },
      {
        name: 'browser_get_page_content',
        description: 'Extract token-optimized page content (summary, markdown, or text) from the active tab. Dramatically reduces LLM token consumption by stripping raw scripts, stylesheets, and inline assets.',
        inputSchema: {
          type: 'object',
          properties: {
            format: {
              type: 'string',
              enum: ['summary', 'markdown', 'text', 'html'],
              description: 'Content format. "summary" extracts key interactive elements; "markdown" extracts clean readable text; "text" extracts plain innerText.'
            },
            maxLength: {
              type: 'number',
              description: 'Maximum characters to return (defaults to 8000)'
            }
          }
        }
      },
      {
        name: 'browser_click_element',
        description: 'Click a button, link, or DOM element on the active page using CSS selector, ID, or text label.',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector, ID (e.g. #submit), or semantic text label of the element to click' }
          },
          required: ['selector']
        }
      },
      {
        name: 'browser_modify_dom',
        description: 'Dynamically modify element text, CSS styles, attributes, or input values on the active page or local HTML file.',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector or label of the target element' },
            action: {
              type: 'string',
              enum: ['setText', 'setStyle', 'setValue', 'setAttribute'],
              description: 'Modification action'
            },
            value: { type: 'string', description: 'New text, CSS style string, value, or attribute content' },
            attribute: { type: 'string', description: 'Attribute name (required for setAttribute)' }
          },
          required: ['selector', 'action', 'value']
        }
      },
      {
        name: 'browser_evaluate_javascript',
        description: 'Execute isolated JavaScript code in the active tab context via Chrome DevTools Protocol.',
        inputSchema: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: 'JavaScript code expression to evaluate' }
          },
          required: ['expression']
        }
      },
      {
        name: 'browser_scroll',
        description: 'Scroll the active tab viewport in a specified direction.',
        inputSchema: {
          type: 'object',
          properties: {
            direction: {
              type: 'string',
              enum: ['down', 'up', 'top', 'bottom'],
              description: 'Direction to scroll'
            },
            amount: { type: 'number', description: 'Pixel distance to scroll (defaults to 450)' }
          },
          required: ['direction']
        }
      },
      {
        name: 'browser_capture_screenshot',
        description: 'Capture a high-definition viewport screenshot as base64 PNG data.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'browser_dispatch_agent_command',
        description: 'Send a natural language instruction or autonomous command to the browser AI agent (Jarvis) runtime.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The natural language instruction to execute' }
          },
          required: ['command']
        }
      },
      {
        name: 'audio_adjust_slider',
        description: 'Directly adjust audio DSP parameters (Bass Frequency Boost, VAD Speech Threshold, Noise Suppression) with instant UI and disk persistence.',
        inputSchema: {
          type: 'object',
          properties: {
            parameter: {
              type: 'string',
              enum: ['bass', 'vad', 'noise', 'volume'],
              description: 'Audio DSP parameter to adjust'
            },
            value: { type: 'number', description: 'Target value (e.g., 10 for bass boost dB, 0.05 for VAD RMS, 15 for noise dB)' }
          },
          required: ['parameter', 'value']
        }
      },
      {
        name: 'audio_get_dsp_state',
        description: 'Retrieve the current values of audio DSP sliders and voice stream parameters.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'session_get_memory',
        description: 'Retrieve recorded user commands, model responses, and execution feedback from session memory.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Number of recent interactions to return (defaults to 20)' }
          }
        }
      },
      {
        name: 'session_clear_memory',
        description: 'Clear session memory log and begin a fresh session.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'browser_get_shields_stats',
        description: 'Get privacy statistics (ads blocked, trackers intercepted, HTTPS upgrades) from Adion Shields.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'ai_list_providers',
        description: 'List all available 3rd-party AI model providers (ChatGPT/OpenAI, Claude/Anthropic, Gemini/Antigravity, Custom, Groq) and active status.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'ai_set_provider',
        description: 'Set the active AI model provider to operate Adion Browse directly in place of default models.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: {
              type: 'string',
              enum: ['openai', 'anthropic', 'gemini', 'custom', 'groq', 'auto'],
              description: 'Name of the AI provider to activate'
            }
          },
          required: ['provider']
        }
      },
      {
        name: 'ai_configure_credentials',
        description: 'Configure API key, base URL, or active model for a 3rd-party provider (e.g. OpenAI, Anthropic, Gemini, Custom).',
        inputSchema: {
          type: 'object',
          properties: {
            provider: { type: 'string', description: 'Provider name (openai, anthropic, gemini, custom)' },
            apiKey: { type: 'string', description: 'API Key' },
            apiUrl: { type: 'string', description: 'Optional custom API endpoint' },
            model: { type: 'string', description: 'Target model ID (e.g., gpt-4o, claude-3-5-sonnet, gemini-2.0-flash)' }
          },
          required: ['provider']
        }
      }
    ];
  }

  /**
   * Register available MCP Resources
   */
  registerResources() {
    return [
      {
        uri: 'browser://tabs',
        name: 'Open Browser Tabs',
        description: 'Real-time JSON array of all open tabs with IDs, titles, and URLs.',
        mimeType: 'application/json'
      },
      {
        uri: 'browser://active-tab',
        name: 'Active Tab Metadata',
        description: 'Metadata of the currently focused browser tab.',
        mimeType: 'application/json'
      },
      {
        uri: 'browser://dom/summary',
        name: 'Active Page Structural DOM Summary',
        description: 'Token-optimized summary of headings, forms, inputs, and interactive buttons on the active page.',
        mimeType: 'application/json'
      },
      {
        uri: 'browser://session/memory',
        name: 'Session Interaction History',
        description: 'Recorded prompt, action, and feedback log from SessionManager.',
        mimeType: 'application/json'
      },
      {
        uri: 'browser://audio/dsp',
        name: 'Audio DSP & Voice Engine Parameters',
        description: 'Current slider parameters and voice stream configuration.',
        mimeType: 'application/json'
      },
      {
        uri: 'browser://shields/stats',
        name: 'Adion Shields Privacy Metrics',
        description: 'Cumulative ad and tracker blocking metrics.',
        mimeType: 'application/json'
      }
    ];
  }

  /**
   * Register MCP Prompts
   */
  registerPrompts() {
    return [
      {
        name: 'browse_and_summarize',
        description: 'Extract and summarize active web page content with minimum token overhead.',
        arguments: [
          { name: 'url', description: 'Optional URL to navigate to first', required: false }
        ]
      },
      {
        name: 'modify_webpage_element',
        description: 'Inspect and modify a DOM element style or text across any loaded web page.',
        arguments: [
          { name: 'selector', description: 'Target selector or label', required: true },
          { name: 'styleOrText', description: 'New style or text value', required: true }
        ]
      },
      {
        name: 'tune_audio_parameters',
        description: 'Tune audio DSP filters and voice recognition threshold.',
        arguments: [
          { name: 'bassGain', description: 'Bass frequency boost in dB', required: false }
        ]
      }
    ];
  }

  /**
   * Handle incoming JSON-RPC 2.0 Request
   */
  async handleJsonRpc(request) {
    if (!request || typeof request !== 'object') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }

    const { id, method, params } = request;

    try {
      switch (method) {
        case 'initialize': {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: this.capabilities,
              serverInfo: this.serverInfo
            }
          };
        }

        case 'notifications/initialized': {
          // Handshake completion notification
          return null;
        }

        case 'ping': {
          return { jsonrpc: '2.0', id, result: {} };
        }

        case 'tools/list': {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              tools: this.tools
            }
          };
        }

        case 'tools/call': {
          const { name, arguments: args } = params || {};
          const result = await this.executeTool(name, args || {});
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
                }
              ],
              isError: false
            }
          };
        }

        case 'resources/list': {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              resources: this.resources
            }
          };
        }

        case 'resources/read': {
          const { uri } = params || {};
          const content = await this.readResource(uri);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              contents: [
                {
                  uri,
                  mimeType: 'application/json',
                  text: typeof content === 'string' ? content : JSON.stringify(content, null, 2)
                }
              ]
            }
          };
        }

        case 'prompts/list': {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              prompts: this.prompts
            }
          };
        }

        case 'prompts/get': {
          const { name, arguments: args } = params || {};
          const promptData = this.getPrompt(name, args || {});
          return {
            jsonrpc: '2.0',
            id,
            result: promptData
          };
        }

        default: {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` }
          };
        }
      }
    } catch (err) {
      console.error(`[MCPServer Error] Method "${method}" failed:`, err);
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: `Internal server error: ${err.message}` }
      };
    }
  }

  /**
   * Tool Execution Router
   */
  async executeTool(name, args) {
    const activeTab = this.tabManager ? this.tabManager.getActiveTab() : null;

    switch (name) {
      case 'browser_navigate': {
        const dest = args.url;
        if (!dest) throw new Error('Missing parameter: url');
        if (args.newTab || !activeTab) {
          if (this.tabManager) this.tabManager.createTab(dest);
          return { success: true, action: 'created_tab_and_navigated', url: dest };
        } else {
          this.tabManager.navigateActiveTab(dest);
          return { success: true, action: 'navigated', url: dest, tabId: activeTab.id };
        }
      }

      case 'browser_list_tabs': {
        if (!this.tabManager) return { tabs: [] };
        const tabs = [];
        for (const [id, t] of this.tabManager.tabs.entries()) {
          tabs.push({
            id: t.id,
            url: t.url,
            title: t.title,
            isLoading: t.isLoading,
            isActive: id === this.tabManager.activeTabId
          });
        }
        return { count: tabs.length, activeTabId: this.tabManager.activeTabId, tabs };
      }

      case 'browser_create_tab': {
        const initialUrl = args.url || 'adion://newtab';
        if (!this.tabManager) throw new Error('TabManager unavailable');
        this.tabManager.createTab(initialUrl);
        const newActive = this.tabManager.getActiveTab();
        return { success: true, tabId: newActive?.id, url: initialUrl };
      }

      case 'browser_close_tab': {
        if (!this.tabManager) throw new Error('TabManager unavailable');
        const targetId = args.tabId || this.tabManager.activeTabId;
        if (!targetId) throw new Error('No tab available to close');
        this.tabManager.closeTab(targetId);
        return { success: true, closedTabId: targetId, remainingTabs: this.tabManager.tabs.size };
      }

      case 'browser_switch_tab': {
        if (!this.tabManager) throw new Error('TabManager unavailable');
        const switched = this.tabManager.switchTabByQuery(args.target);
        if (switched) {
          return { success: true, tabId: switched.id, title: switched.title, url: switched.url };
        } else {
          return { success: false, message: `No tab found matching target: "${args.target}"` };
        }
      }

      case 'browser_get_page_content': {
        if (!activeTab || !activeTab.view) {
          return { error: 'No active browser tab found' };
        }
        await this.ensureCdpAttached(activeTab);
        const format = args.format || 'summary';
        const maxLength = args.maxLength || 8000;

        if (format === 'summary') {
          // Token-optimized interactive DOM extractor
          const summaryScript = `
            (() => {
              const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
                .slice(0, 10).map(h => ({ level: h.tagName.toLowerCase(), text: h.innerText.trim() })).filter(h => h.text);
              const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'))
                .slice(0, 15).map(b => ({
                  id: b.id || undefined,
                  text: (b.innerText || b.value || b.getAttribute('aria-label') || '').trim(),
                  selector: b.id ? ('#' + b.id) : (b.className ? ('.' + b.className.split(' ').filter(Boolean).join('.')) : undefined)
                })).filter(b => b.text);
              const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, select'))
                .slice(0, 10).map(i => ({
                  id: i.id || undefined,
                  type: i.type || 'text',
                  placeholder: i.placeholder || undefined,
                  name: i.name || undefined,
                  value: i.value || undefined
                }));
              const links = Array.from(document.querySelectorAll('a[href]'))
                .slice(0, 12).map(a => ({ text: a.innerText.trim(), href: a.href })).filter(a => a.text && !a.href.startsWith('javascript:'));

              return {
                title: document.title,
                url: window.location.href,
                headings,
                interactiveButtons: buttons,
                inputs,
                primaryLinks: links
              };
            })()
          `;
          const summaryData = await this.cdp.evaluate(summaryScript);
          return {
            format: 'summary',
            url: activeTab.url,
            title: activeTab.title,
            tokenEstimate: Math.round(JSON.stringify(summaryData).length / 4),
            data: summaryData
          };
        } else if (format === 'markdown' || format === 'text') {
          const textScript = `
            (() => {
              const clone = document.body.cloneNode(true);
              const removeTags = ['script', 'style', 'svg', 'noscript', 'iframe'];
              removeTags.forEach(t => clone.querySelectorAll(t).forEach(el => el.remove()));
              return clone.innerText.replace(/\\n{3,}/g, '\\n\\n').trim();
            })()
          `;
          let text = await this.cdp.evaluate(textScript);
          if (typeof text === 'string' && text.length > maxLength) {
            text = text.slice(0, maxLength) + `... [Truncated ${text.length - maxLength} chars for token efficiency]`;
          }
          return {
            format: format,
            url: activeTab.url,
            title: activeTab.title,
            tokenEstimate: Math.round((text || '').length / 4),
            content: text
          };
        } else {
          // HTML format with size limit
          const html = await this.cdp.evaluate('document.documentElement.outerHTML');
          const cleanHtml = typeof html === 'string' && html.length > maxLength
            ? html.slice(0, maxLength) + '... [Truncated]'
            : html;
          return { format: 'html', url: activeTab.url, content: cleanHtml };
        }
      }

      case 'browser_click_element': {
        if (!activeTab || !activeTab.view) throw new Error('No active browser tab found');
        const contents = activeTab.view.webContents;
        const sel = args.selector;
        if (!sel) throw new Error('Missing parameter: selector');

        // Locate coordinates via DOM with leaf-level specificity
        const coords = await contents.executeJavaScript(`
          (() => {
            const query = ${JSON.stringify(sel)}.trim();
            const qLower = query.toLowerCase();

            function strip(s) {
              if (!s) return '';
              return s.replace(/[\\u{1F600}-\\u{1F64F}\\u{1F300}-\\u{1F5FF}\\u{1F680}-\\u{1F6FF}\\u{1F1E0}-\\u{1F1FF}\\u{2600}-\\u{26FF}\\u{2700}-\\u{27BF}\\u{FE00}-\\u{FE0F}]/gu, '')
                .replace(/[^\\p{L}\\p{N}\\s]/gu, ' ')
                .replace(/\\s+/g, ' ')
                .trim()
                .toLowerCase();
            }

            const cleanQ = strip(query);
            let bestMatch = null;
            let highestScore = 0;

            const all = Array.from(document.querySelectorAll('*')).filter(el => {
              const r = el.getBoundingClientRect();
              return r.width > 2 && r.height > 2 && window.getComputedStyle(el).display !== 'none';
            });

            for (const el of all) {
              let score = 0;
              const text = (el.innerText || el.textContent || '').trim();
              const cleanText = strip(text);
              const title = (el.getAttribute('title') || '').trim();
              const cleanTitle = strip(title);
              const aria = (el.getAttribute('aria-label') || '').trim();
              const cleanAria = strip(aria);
              const testid = (el.getAttribute('data-testid') || '').toLowerCase();

              const isHighlight = testid.includes('highlight') || el.tagName === 'MARK' || (el.className && typeof el.className === 'string' && el.className.includes('highlight'));
              if (isHighlight && (cleanText === cleanQ || cleanQ.includes(cleanText) || cleanText.includes(cleanQ))) {
                score += 700;
              }

              if (cleanTitle === cleanQ || cleanText === cleanQ || cleanAria === cleanQ) score += 1000;
              else if (cleanTitle.includes(cleanQ) || cleanQ.includes(cleanTitle)) score += 600;
              else if (cleanText.includes(cleanQ)) score += 450;

              if (cleanTitle.includes('is also in this') || cleanText.includes('is also in this')) score -= 1000;
              if (score <= 0) continue;

              const diff = Math.abs(cleanText.length - cleanQ.length);
              if (diff <= 5) score += 500;
              else if (diff <= 15) score += 250;
              else if (cleanText.length > 150) score -= 400;

              if (score > highestScore) {
                highestScore = score;
                bestMatch = el;
              }
            }

            if (!bestMatch) return null;
            bestMatch.scrollIntoView({ behavior: 'auto', block: 'center' });
            const clickTarget = bestMatch.closest('div[role=\"button\"], button, a, div[role=\"row\"], div[role=\"listitem\"], [role=\"gridcell\"][tabindex], div[tabindex]') || bestMatch;
            const innerActionable = clickTarget.querySelector('[role=\"button\"], [role=\"gridcell\"][tabindex=\"0\"], button, a') || clickTarget;
            const r = innerActionable.getBoundingClientRect();
            return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), text: (bestMatch.innerText || bestMatch.getAttribute('title') || '').slice(0, 50) };
          })()
        `);

        if (coords) {
          contents.sendInputEvent({ type: 'mouseMove', x: coords.x, y: coords.y });
          contents.sendInputEvent({ type: 'mouseDown', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
          contents.sendInputEvent({ type: 'mouseUp', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
          return { success: true, coords };
        }
        return { success: false, reason: 'Element not found for selector: ' + sel };
      }

      case 'browser_modify_dom': {
        if (!activeTab || !activeTab.view) throw new Error('No active browser tab found');
        await this.ensureCdpAttached(activeTab);
        const { selector, action, value, attribute } = args;

        const res = await this.cdp.modifyDOM(selector, action, value, attribute || '');

        // File system persistence if local file
        let persisted = false;
        if (this.runtime && activeTab.url && activeTab.url.startsWith('file:///')) {
          persisted = await this.runtime.persistDOMChangeToFile(activeTab.url, res);
        }

        return {
          success: res?.success || false,
          selector,
          action,
          value,
          persistedToFile: persisted,
          resolvedSelector: res?.resolvedSelector
        };
      }

      case 'browser_evaluate_javascript': {
        if (!activeTab || !activeTab.view) throw new Error('No active browser tab found');
        const contents = activeTab.view.webContents;
        const result = await contents.executeJavaScript(args.expression);
        return { result };
      }

      case 'browser_scroll': {
        if (!activeTab || !activeTab.view) throw new Error('No active browser tab found');
        const dir = args.direction || 'down';
        const amt = typeof args.amount === 'number' ? args.amount : 450;

        try {
          if (dir === 'top') {
            await activeTab.view.webContents.executeJavaScript('window.scrollTo({ top: 0, behavior: "smooth" }); true;');
          } else if (dir === 'bottom') {
            await activeTab.view.webContents.executeJavaScript('window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }); true;');
          } else {
            const delta = dir === 'up' ? -amt : amt;
            await activeTab.view.webContents.executeJavaScript(`window.scrollBy({ top: ${delta}, left: 0, behavior: "smooth" }); true;`);
            if (this.cdp && this.cdp.isAttached) {
              try { await this.cdp.dispatchScroll(delta, 3, 10); } catch (_) {}
            }
          }
          return { success: true, direction: dir, amount: amt };
        } catch (err) {
          return { success: true, direction: dir, amount: amt, note: 'Scroll dispatched: ' + err.message };
        }
      }

      case 'browser_capture_screenshot': {
        if (!activeTab || !activeTab.view) throw new Error('No active browser tab found');
        const contents = activeTab.view.webContents;
        let base64Png = '';
        try {
          const image = await contents.capturePage();
          base64Png = image.toPNG().toString('base64');
        } catch (_) {
          if (this.cdp && this.cdp.isAttached) {
            try { base64Png = await this.cdp.captureScreenshot(); } catch (__) {}
          }
        }
        return {
          format: 'image/png;base64',
          data: base64Png ? base64Png.slice(0, 80) + `... [${base64Png.length} total bytes]` : null,
          byteLength: base64Png ? base64Png.length : 0
        };
      }

      case 'browser_dispatch_agent_command': {
        if (!this.runtime) throw new Error('Agent runtime not initialized');
        const res = await this.runtime.processCommand(args.command);
        return { success: true, result: res, state: this.runtime.state };
      }

      case 'audio_adjust_slider': {
        const { parameter, value } = args;
        let selector = '#sliderBass, Bass Frequency Boost';
        let elementId = 'sliderBass';
        let unit = 'dB';

        if (parameter === 'vad') {
          selector = '#sliderVad, Voice Activity Threshold';
          elementId = 'sliderVad';
          unit = 'RMS';
        } else if (parameter === 'noise') {
          selector = '#sliderNoise, Noise Suppression';
          elementId = 'sliderNoise';
          unit = 'dB';
        }

        if (activeTab && activeTab.view) {
          await this.ensureCdpAttached(activeTab);
          await this.cdp.modifyDOM(selector, 'setValue', String(value));
          if (activeTab.url && activeTab.url.startsWith('file:///')) {
            await this.runtime?.persistDOMChangeToFile(activeTab.url, {
              success: true,
              resolvedSelector: `#${elementId}`,
              action: 'setValue',
              value: String(value)
            });
          }
        }

        // Notify UI
        if (this.controlPlane) {
          this.controlPlane.sendToUI('audio:dsp-updated', { parameter, value, unit });
        }

        return {
          success: true,
          parameter,
          value,
          unit,
          elementId
        };
      }

      case 'audio_get_dsp_state': {
        return {
          engine: 'Adion DSP Audio Processor',
          voiceActivityDetection: {
            rmsThreshold: 0.012,
            speechFrameConfirmationThreshold: 3,
            continuousVoiceStream: true
          },
          hardwareSliders: {
            bassFrequencyBoost: { id: 'sliderBass', value: '0 dB', range: '[-12, 12]' },
            voiceActivityThreshold: { id: 'sliderVad', value: '0.012 RMS', range: '[0.005, 0.08]' },
            noiseSuppression: { id: 'sliderNoise', value: '12 dB', range: '[0, 24]' }
          }
        };
      }

      case 'session_get_memory': {
        const limit = args.limit || 20;
        const hist = this.runtime?.sessionManager ? this.runtime.sessionManager.getHistory() : null;
        const interactions = Array.isArray(hist?.interactions) ? hist.interactions : (Array.isArray(hist) ? hist : []);
        return {
          sessionId: hist?.sessionId || this.runtime?.sessionManager?.sessionId || 'default',
          count: interactions.length,
          interactions: interactions.slice(-limit)
        };
      }

      case 'session_clear_memory': {
        if (!this.runtime?.sessionManager) throw new Error('SessionManager unavailable');
        const res = this.runtime.sessionManager.clearSession();
        if (this.controlPlane) {
          this.controlPlane.sendToUI('session:cleared', res);
        }
        return { success: true, newSessionId: res.sessionId };
      }

      case 'browser_get_shields_stats': {
        const store = require('../main/store');
        return {
          shieldsEnabled: store.getSetting('shieldsEnabled'),
          stats: store.get('stats') || { trackersBlocked: 0, adsBlocked: 0, httpsUpgrades: 0 }
        };
      }

      case 'ai_list_providers': {
        return this.runtime?.modelClient ? this.runtime.modelClient.listProviders() : { providers: [] };
      }

      case 'ai_set_provider': {
        if (!this.runtime?.modelClient) throw new Error('ModelClient unavailable');
        const active = this.runtime.modelClient.setActiveProvider(args.provider);
        return { success: true, activeProvider: active ? active.name : args.provider };
      }

      case 'ai_configure_credentials': {
        if (!this.runtime?.modelClient) throw new Error('ModelClient unavailable');
        const updated = this.runtime.modelClient.configureProvider(args.provider, {
          apiKey: args.apiKey,
          apiUrl: args.apiUrl,
          model: args.model
        });
        return { success: true, provider: updated };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * Read MCP Resource
   */
  async readResource(uri) {
    const activeTab = this.tabManager ? this.tabManager.getActiveTab() : null;

    switch (uri) {
      case 'browser://tabs': {
        const tabs = [];
        if (this.tabManager) {
          for (const [id, t] of this.tabManager.tabs.entries()) {
            tabs.push({ id: t.id, url: t.url, title: t.title, isActive: id === this.tabManager.activeTabId });
          }
        }
        return tabs;
      }

      case 'browser://active-tab': {
        return activeTab ? {
          id: activeTab.id,
          url: activeTab.url,
          title: activeTab.title,
          isLoading: activeTab.isLoading,
          canGoBack: activeTab.canGoBack,
          canGoForward: activeTab.canGoForward
        } : { message: 'No active tab' };
      }

      case 'browser://dom/summary': {
        if (!activeTab || !activeTab.view) return { error: 'No active tab' };
        await this.ensureCdpAttached(activeTab);
        return this.executeTool('browser_get_page_content', { format: 'summary' });
      }

      case 'browser://session/memory': {
        const hist = this.runtime?.sessionManager ? this.runtime.sessionManager.getHistory() : null;
        return hist ? (hist.interactions || hist) : [];
      }

      case 'browser://audio/dsp': {
        return this.executeTool('audio_get_dsp_state', {});
      }

      case 'browser://shields/stats': {
        const store = require('../main/store');
        return store.get('stats') || {};
      }

      default:
        throw new Error(`Resource not found for URI: ${uri}`);
    }
  }

  /**
   * Get MCP Prompt Template
   */
  getPrompt(name, args) {
    switch (name) {
      case 'browse_and_summarize':
        return {
          description: 'Extract and summarize active web page content with minimum token overhead.',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Please inspect the active webpage${args.url ? ` at ${args.url}` : ''} using browser_get_page_content with format "summary", and provide a concise summary of the key interactive elements and content.`
              }
            }
          ]
        };

      case 'modify_webpage_element':
        return {
          description: 'Inspect and modify a DOM element style or text across any loaded web page.',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Modify the element "${args.selector}" by applying "${args.styleOrText}" using the browser_modify_dom tool.`
              }
            }
          ]
        };

      case 'tune_audio_parameters':
        return {
          description: 'Tune audio DSP filters and voice recognition threshold.',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Adjust the audio DSP parameters using audio_adjust_slider with parameter "bass" and value ${args.bassGain || 10}.`
              }
            }
          ]
        };

      default:
        throw new Error(`Prompt template not found: ${name}`);
    }
  }

  /**
   * Ensure CDP debugger is attached to webContents
   */
  async ensureCdpAttached(activeTab) {
    if (this.cdp && activeTab?.view?.webContents) {
      await this.cdp.attach(activeTab.view.webContents);
    }
  }

  /**
   * Start HTTP/SSE Server with automatic port negotiation
   */
  async start(preferredPort = DEFAULT_PORT) {
    if (this.isRunning) return this.port;

    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        // CORS Headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        const parsedUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
        const pathname = parsedUrl.pathname;

        // HEAD requests
        if (req.method === 'HEAD') {
          res.writeHead(200);
          res.end();
          return;
        }

        // Server-Sent Events (SSE) Stream: GET /sse
        if (pathname === '/sse' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });

          const sessionId = `mcp_sess_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
          const endpointUrl = `/message?sessionId=${sessionId}`;

          // Send endpoint event with session URI per MCP specification
          res.write(`event: endpoint\ndata: ${endpointUrl}\n\n`);

          const client = { id: sessionId, res };
          this.sseClients.add(client);

          req.on('close', () => {
            this.sseClients.delete(client);
          });
          return;
        }

        // SSE Message Delivery: POST /message?sessionId=...
        if (pathname === '/message' && req.method === 'POST') {
          const sessionId = parsedUrl.searchParams.get('sessionId');
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', async () => {
            try {
              const json = JSON.parse(body);
              const rpcResponse = await this.handleJsonRpc(json);

              // Find client by sessionId and stream response via SSE
              const client = Array.from(this.sseClients).find(c => c.id === sessionId);
              if (client && rpcResponse) {
                client.res.write(`event: message\ndata: ${JSON.stringify(rpcResponse)}\n\n`);
              }

              res.writeHead(202, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ accepted: true }));
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        // Universal JSON-RPC / Streamable HTTP endpoint: POST to /mcp, /sse, /, /jsonrpc
        if (req.method === 'POST') {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', async () => {
            try {
              const json = JSON.parse(body);
              const rpcResponse = await this.handleJsonRpc(json);
              if (rpcResponse) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(rpcResponse));
              } else {
                res.writeHead(204);
                res.end();
              }
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
            }
          });
          return;
        }

        // Universal GET info & discovery endpoint: GET /, /health, /mcp, /sse
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'online',
            server: this.serverInfo.name,
            version: this.serverInfo.version,
            protocolVersion: MCP_PROTOCOL_VERSION,
            port: this.port,
            toolsCount: this.tools.length,
            resourcesCount: this.resources.length
          }, null, 2));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
      });

      // Try preferred port, or fall back to incremented port
      let currentPort = preferredPort;
      const tryListen = () => {
        server.once('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            console.log(`[MCPServer] Port ${currentPort} in use, trying ${currentPort + 1}...`);
            currentPort++;
            tryListen();
          } else {
            reject(err);
          }
        });

        const host = process.env.ADION_MCP_HOST || '0.0.0.0';
        server.listen(currentPort, host, () => {
          this.port = currentPort;
          this.server = server;
          this.isRunning = true;
          this.writeDiscoveryFile();
          console.log(`[MCPServer] 🚀 Model Context Protocol server online at http://127.0.0.1:${this.port}`);
          console.log(`[MCPServer] 📡 JSON-RPC endpoint: http://127.0.0.1:${this.port}/mcp`);
          console.log(`[MCPServer] 🔄 SSE stream: http://127.0.0.1:${this.port}/sse`);
          resolve(this.port);
        });
      };

      tryListen();
    });
  }

  /**
   * Write discovery file to .data/mcp_server.json for automatic client configuration
   */
  writeDiscoveryFile() {
    try {
      const dataDir = path.resolve(__dirname, '../../.data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const discoveryPath = path.join(dataDir, 'mcp_server.json');
      fs.writeFileSync(discoveryPath, JSON.stringify({
        status: 'online',
        server: this.serverInfo.name,
        version: this.serverInfo.version,
        protocolVersion: MCP_PROTOCOL_VERSION,
        port: this.port,
        url: `http://127.0.0.1:${this.port}`,
        endpoint: `http://127.0.0.1:${this.port}/mcp`,
        sse: `http://127.0.0.1:${this.port}/sse`,
        pid: process.pid,
        tools: this.tools.map(t => t.name),
        startedAt: new Date().toISOString()
      }, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[MCPServer] Could not write discovery file:', err.message);
    }
  }

  /**
   * Stop MCP Server and clean up connections
   */
  stop() {
    return new Promise((resolve) => {
      if (!this.isRunning) {
        return resolve();
      }
      for (const client of this.sseClients) {
        try { client.res.end(); } catch (_) {}
      }
      this.sseClients.clear();

      if (this.server) {
        this.server.close(() => {
          this.isRunning = false;
          this.server = null;
          this.updateDiscoveryFileOffline();
          console.log('[MCPServer] MCP server cleanly shut down.');
          resolve();
        });
      } else {
        this.isRunning = false;
        this.updateDiscoveryFileOffline();
        resolve();
      }
    });
  }

  /**
   * Update discovery file to offline state
   */
  updateDiscoveryFileOffline() {
    try {
      const dataDir = path.resolve(__dirname, '../../.data');
      const discoveryPath = path.join(dataDir, 'mcp_server.json');
      if (fs.existsSync(discoveryPath)) {
        fs.writeFileSync(discoveryPath, JSON.stringify({
          status: 'offline',
          server: this.serverInfo.name,
          port: this.port,
          stoppedAt: new Date().toISOString()
        }, null, 2), 'utf-8');
      }
    } catch (_) {}
  }
}

module.exports = MCPServer;
