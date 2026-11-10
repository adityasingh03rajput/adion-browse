const EventEmitter = require('events');
const { AgentState, ActionType } = require('./protocol');

/**
 * Asynchronous Agent Runtime
 * Decoupled execution engine that interprets natural language and speech intents,
 * grounds them against the DOM/CDP pipeline, and dispatches actions to Chromium.
 */
class AgentRuntime extends EventEmitter {
  constructor(tabManager, cdpBridge, contextEngine, visionGrounder, securityVault) {
    super();
    this.tabManager = tabManager;
    this.cdp = cdpBridge;
    this.context = contextEngine;
    this.vision = visionGrounder;
    this.vault = securityVault;
    this.state = AgentState.IDLE;
    this.currentTask = null;
    this.actionHistory = [];
  }

  setState(newState, metadata = {}) {
    this.state = newState;
    this.emit('state-change', {
      state: this.state,
      timestamp: Date.now(),
      ...metadata
    });
  }

  /**
   * Process incoming voice or natural language text command
   */
  async processCommand(rawInput) {
    if (!rawInput || typeof rawInput !== 'string') return;
    const text = rawInput.trim();
    if (!text) return;

    this.setState(AgentState.PARSING_INTENT, { input: text });
    this.emit('feedback', { message: `Interpreting command: "${text}"`, level: 'info' });

    try {
      // 1. Parse intent
      const intent = await this.parseIntent(text);

      if (!intent) {
        this.setState(AgentState.IDLE);
        this.emit('feedback', { message: `Could not determine action for: "${text}"`, level: 'warning' });
        return;
      }

      // 2. Execute parsed intent
      await this.executeIntent(intent);
    } catch (err) {
      console.error('[AgentRuntime] Execution error:', err);
      this.setState(AgentState.ERROR, { error: err.message });
      this.emit('feedback', { message: `Execution failed: ${err.message}`, level: 'error' });
      setTimeout(() => this.setState(AgentState.IDLE), 2500);
    }
  }

  /**
   * Local Edge Intent Parser
   * Evaluates natural language commands using fast acoustic-semantic rule sets and regex patterns.
   * Can be augmented with local small LLM (e.g. Phi-3 / Qwen-2.5 / llama.cpp) or Grok/Mercury APIs.
   */
  async parseIntent(text) {
    const lower = text.toLowerCase().trim();

    // Scroll operations
    if (/(scroll down|page down|move down)/i.test(lower)) {
      return { type: ActionType.SCROLL, direction: 'down', amount: 450 };
    }
    if (/(scroll up|page up|move up)/i.test(lower)) {
      return { type: ActionType.SCROLL, direction: 'up', amount: -450 };
    }
    if (/(scroll to top|go to top|top of page)/i.test(lower)) {
      return { type: ActionType.SCROLL, direction: 'top' };
    }
    if (/(scroll to bottom|go to bottom)/i.test(lower)) {
      return { type: ActionType.SCROLL, direction: 'bottom' };
    }

    // Navigation controls
    if (/(go back|navigate back|previous page)/i.test(lower)) {
      return { type: ActionType.GO_BACK };
    }
    if (/(go forward|forward page)/i.test(lower)) {
      return { type: ActionType.GO_FORWARD };
    }
    if (/(reload|refresh|reload page)/i.test(lower)) {
      return { type: ActionType.RELOAD };
    }

    // Tab Management
    if (/(close this tab|close tab|shut tab)/i.test(lower)) {
      return { type: ActionType.CLOSE_TAB };
    }
    const openMatch = lower.match(/(open|launch|navigate to|go to)\s+(https?:\/\/[^\s]+|[a-z0-9\-]+\.[a-z]{2,}[^\s]*|youtube|google|reddit|github|wikipedia|twitter|x\.com)/i);
    if (openMatch) {
      let target = openMatch[2];
      if (target === 'youtube') target = 'https://www.youtube.com';
      else if (target === 'google') target = 'https://www.google.com';
      else if (target === 'reddit') target = 'https://www.reddit.com';
      else if (target === 'github') target = 'https://www.github.com';
      else if (target === 'wikipedia') target = 'https://www.wikipedia.org';
      else if (target === 'x.com' || target === 'twitter') target = 'https://x.com';
      return { type: ActionType.NEW_TAB, url: target };
    }
    if (/(new tab|open new tab|create tab)/i.test(lower)) {
      return { type: ActionType.NEW_TAB, url: 'adion://newtab' };
    }

    // Search intent
    const searchMatch = lower.match(/(search for|search|look up|google|find)\s+(.+)/i);
    if (searchMatch && !lower.startsWith('find image')) {
      const query = searchMatch[2];
      return { type: ActionType.NAVIGATE, query };
    }

    // Click / Element targeting
    const clickMatch = lower.match(/(click on|click|tap on|tap|press)\s+(.+)/i);
    if (clickMatch) {
      const targetQuery = clickMatch[2].replace(/button|link|icon|input/gi, '').trim();
      return { type: ActionType.CLICK_SELECTOR, target: targetQuery || clickMatch[2] };
    }

    // Screenshot capture
    if (/(screenshot|capture screen|capture page|take snapshot)/i.test(lower)) {
      return { type: ActionType.CAPTURE_VIEWPORT };
    }

    // Semantic Image Search / Filter
    const imageMatch = lower.match(/(find images? of|show images? of|download images? of)\s+(.+)/i);
    if (imageMatch) {
      return { type: ActionType.ANALYZE_IMAGES, criteria: imageMatch[2] };
    }

    return null;
  }

  /**
   * Execute parsed intent against Chromium TabManager & CDP Bridge
   */
  async executeIntent(intent) {
    this.setState(AgentState.EXECUTING_ACTION, { action: intent });
    this.emit('action-started', intent);

    const activeTab = this.tabManager.getActiveTab();
    if (!activeTab && intent.type !== ActionType.NEW_TAB) {
      throw new Error('No active browser tab found');
    }

    // Ensure CDP is attached to active tab if needed for DOM actions
    if (activeTab && activeTab.view && [
      ActionType.SCROLL,
      ActionType.CLICK_SELECTOR,
      ActionType.CLICK_COORDINATE,
      ActionType.CAPTURE_VIEWPORT,
      ActionType.ANALYZE_IMAGES
    ].includes(intent.type)) {
      await this.cdp.attach(activeTab.view.webContents);
    }

    switch (intent.type) {
      case ActionType.SCROLL: {
        if (intent.direction === 'top') {
          await this.cdp.evaluate('window.scrollTo({ top: 0, behavior: "smooth" })');
        } else if (intent.direction === 'bottom') {
          await this.cdp.evaluate('window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })');
        } else {
          await this.cdp.dispatchScroll(intent.amount);
        }
        this.emit('feedback', { message: `Scrolled ${intent.direction}`, level: 'success' });
        break;
      }

      case ActionType.NEW_TAB: {
        this.tabManager.createTab(intent.url || 'adion://newtab');
        this.emit('feedback', { message: `Opened new tab: ${intent.url}`, level: 'success' });
        break;
      }

      case ActionType.CLOSE_TAB: {
        if (activeTab) {
          this.tabManager.closeTab(activeTab.id);
          this.emit('feedback', { message: 'Closed active tab', level: 'success' });
        }
        break;
      }

      case ActionType.GO_BACK: {
        this.tabManager.goBackActiveTab();
        this.emit('feedback', { message: 'Navigated back', level: 'success' });
        break;
      }

      case ActionType.GO_FORWARD: {
        this.tabManager.goForwardActiveTab();
        this.emit('feedback', { message: 'Navigated forward', level: 'success' });
        break;
      }

      case ActionType.RELOAD: {
        this.tabManager.reloadActiveTab();
        this.emit('feedback', { message: 'Reloaded page', level: 'success' });
        break;
      }

      case ActionType.NAVIGATE: {
        this.tabManager.navigateActiveTab(intent.query);
        this.emit('feedback', { message: `Navigating to: ${intent.query}`, level: 'success' });
        break;
      }

      case ActionType.CLICK_SELECTOR: {
        this.setState(AgentState.GROUNDING_UI, { target: intent.target });
        this.emit('feedback', { message: `Grounding target: "${intent.target}"...`, level: 'info' });

        const match = this.vision ? await this.vision.groundElement(intent.target) : await this.cdp.findElementCoordinates(intent.target);
        if (match && (match.found || match.success)) {
          // Highlight target visual box first
          await this.cdp.highlightElement(match.x, match.y, match.width, match.height, `Target: ${intent.target}`);
          await new Promise((r) => setTimeout(r, 200));

          // Dispatch synthetic click at exact hardware coordinates
          await this.cdp.dispatchClick(match.x, match.y);
          this.emit('feedback', { message: `Clicked "${match.label || match.text || intent.target}" at (${match.x}, ${match.y})`, level: 'success' });
        } else {
          this.emit('feedback', { message: `Could not locate element matching: "${intent.target}"`, level: 'warning' });
        }
        break;
      }

      case ActionType.CAPTURE_VIEWPORT: {
        const screenshotData = this.vision ? await this.vision.captureViewportFrame() : await this.cdp.captureScreenshot();
        this.emit('feedback', { message: 'Viewport captured for visual grounding', level: 'success' });
        this.emit('action-finished', { type: ActionType.CAPTURE_VIEWPORT, screenshot: screenshotData });
        break;
      }

      case ActionType.ANALYZE_IMAGES: {
        this.setState(AgentState.GROUNDING_UI, { criteria: intent.criteria });
        this.emit('feedback', { message: `Analyzing page images for: "${intent.criteria}"...`, level: 'info' });

        const images = this.vision ? await this.vision.extractSemanticImages(intent.criteria) : [];
        if (images && images.length > 0) {
          await this.vision.highlightCandidates(images.slice(0, 4));
          this.emit('feedback', { message: `Found ${images.length} matching visual elements on page`, level: 'success' });
          this.emit('action-finished', { type: ActionType.ANALYZE_IMAGES, count: images.length, candidates: images });
        } else {
          this.emit('feedback', { message: `No images matched criteria: "${intent.criteria}"`, level: 'warning' });
        }
        break;
      }

      default:
        console.warn('[AgentRuntime] Unhandled intent type:', intent.type);
    }

    this.actionHistory.push({ intent, timestamp: Date.now() });
    this.emit('action-finished', intent);
    this.setState(AgentState.IDLE);
  }
}

module.exports = AgentRuntime;

