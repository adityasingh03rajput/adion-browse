const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

/**
 * Adion Browse - Jarvis Session Manager
 * 
 * A persistent AI assistant session with extended context window (200k tokens).
 * Maintains full conversation history, page context, and task state across
 * the entire browsing session for seamless back-and-forth interaction.
 * 
 * Features:
 * - 200k token context window (vs 4k default)
 * - Persistent conversation memory across browser restarts
 * - Full page context tracking
 * - Task state and progress tracking
 * - Multi-turn dialogue with coreference resolution
 */
class JarvisSession extends EventEmitter {
  constructor(dataDir = null) {
    super();
    this.dataDir = dataDir || path.resolve(process.cwd(), '.data');
    this.jarvisFilePath = path.join(this.dataDir, 'jarvis_session.json');
    
    // Jarvis session state
    this.sessionId = 'jarvis_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6);
    this.createdAt = new Date().toISOString();
    this.lastUpdatedAt = new Date().toISOString();
    
    // Extended context window (200k tokens)
    this.contextWindow = 200000;
    this.conversationHistory = [];
    this.pageContext = {};
    this.taskState = {
      currentTask: null,
      completedTasks: [],
      pendingTasks: [],
      lastAction: null,
      lastResult: null
    };
    
    // Conversation memory for coreference resolution
    this.recentEntities = {
      lastContact: null,
      lastSite: null,
      lastQuery: null,
      lastFile: null,
      lastAction: null
    };
    
    this.maxHistoryEntries = 5000; // ~200k tokens worth of conversation
    this.initStorage();
  }

  /**
   * Initialize or restore Jarvis session from disk
   */
  initStorage() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      
      this.loadFromFile();
      console.log(`[JarvisSession] Initialized with ${this.conversationHistory.length} history entries, context window: ${this.contextWindow} tokens`);
    } catch (err) {
      console.error('[JarvisSession] Failed to initialize:', err.message);
    }
  }

  /**
   * Load Jarvis session from disk
   */
  loadFromFile() {
    if (!fs.existsSync(this.jarvisFilePath)) return;
    
    try {
      const raw = fs.readFileSync(this.jarvisFilePath, 'utf8');
      if (!raw || !raw.trim()) return;
      
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.sessionId = parsed.sessionId || this.sessionId;
        this.createdAt = parsed.createdAt || this.createdAt;
        this.conversationHistory = Array.isArray(parsed.conversationHistory) ? parsed.conversationHistory : [];
        this.pageContext = parsed.pageContext || {};
        this.taskState = parsed.taskState || this.taskState;
        this.recentEntities = parsed.recentEntities || this.recentEntities;
      }
    } catch (err) {
      console.warn('[JarvisSession] Could not read session file:', err.message);
    }
  }

  /**
   * Flush session to disk
   */
  flushToFile() {
    try {
      const payload = {
        sessionId: this.sessionId,
        createdAt: this.createdAt,
        lastUpdatedAt: new Date().toISOString(),
        contextWindow: this.contextWindow,
        conversationHistory: this.conversationHistory.slice(-this.maxHistoryEntries),
        pageContext: this.pageContext,
        taskState: this.taskState,
        recentEntities: this.recentEntities,
        totalInteractions: this.conversationHistory.length
      };
      
      fs.writeFileSync(this.jarvisFilePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      console.warn('[JarvisSession] Could not flush to file:', err.message);
    }
  }

  /**
   * Add a conversation turn (user message + assistant response)
   */
  addTurn(userMessage, assistantResponse, pageContext = {}) {
    // Extract key context information for session memory
    const contextSummary = {
      url: pageContext.url || this.pageContext.url || 'adion://newtab',
      title: pageContext.title || this.pageContext.title || 'New Tab',
      buttons: pageContext.buttons?.slice(0, 10) || [],
      headings: pageContext.headings?.slice(0, 5) || [],
      hasScene: !!pageContext.scene?.length,
      isComputerUse: !!pageContext.isComputerUse
    };
    
    const turn = {
      id: 'turn_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6),
      timestamp: new Date().toISOString(),
      user: userMessage,
      assistant: assistantResponse,
      pageContext: contextSummary,
      contextSummary: `On page "${contextSummary.title}" with ${contextSummary.buttons.length} buttons, ${contextSummary.headings.length} headings`
    };
    
    this.conversationHistory.push(turn);
    
    // Trim to max history
    if (this.conversationHistory.length > this.maxHistoryEntries) {
      this.conversationHistory = this.conversationHistory.slice(-this.maxHistoryEntries);
    }
    
    // Update page context
    this.pageContext = { ...this.pageContext, ...pageContext };
    this.lastUpdatedAt = new Date().toISOString();
    
    this.flushToFile();
    this.emit('turn-added', turn);
    return turn;
  }

  /**
   * Get recent conversation turns as an array
   */
  getRecentTurns(maxTurns = 50) {
    return this.conversationHistory.slice(-maxTurns);
  }

  /**
   * Get conversation history for model context
   * Returns formatted history for prompt injection
   */
  getConversationHistory(maxTurns = 50) {
    const recent = this.conversationHistory.slice(-maxTurns);
    return recent.map(turn => {
      const pageInfo = turn.pageContext?.title ? ` [Page: ${turn.pageContext.title}]` : '';
      return `User: ${turn.user}\nAssistant: ${turn.assistant}${pageInfo}`;
    }).join('\n\n');
  }

  /**
   * Update page context
   */
  updatePageContext(url, title) {
    this.pageContext = { url, title };
    this.flushToFile();
  }

  /**
   * Update task state
   */
  updateTaskState(task) {
    this.taskState.currentTask = task;
    this.flushToFile();
  }

  /**
   * Update recent entities for coreference resolution
   */
  updateEntities({ contact, site, query, file, action }) {
    if (contact) this.recentEntities.lastContact = contact;
    if (site) this.recentEntities.lastSite = site;
    if (query) this.recentEntities.lastQuery = query;
    if (file) this.recentEntities.lastFile = file;
    if (action) this.recentEntities.lastAction = action;
    this.flushToFile();
  }

  /**
   * Get current session info
   */
  getSessionInfo() {
    return {
      sessionId: this.sessionId,
      createdAt: this.createdAt,
      lastUpdatedAt: this.lastUpdatedAt,
      contextWindow: this.contextWindow,
      totalTurns: this.conversationHistory.length,
      currentPage: this.pageContext,
      currentTask: this.taskState.currentTask,
      recentEntities: this.recentEntities
    };
  }

  /**
   * Clear Jarvis session (start fresh)
   */
  clearSession() {
    this.sessionId = 'jarvis_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6);
    this.createdAt = new Date().toISOString();
    this.conversationHistory = [];
    this.pageContext = {};
    this.taskState = {
      currentTask: null,
      completedTasks: [],
      pendingTasks: [],
      lastAction: null,
      lastResult: null
    };
    this.recentEntities = {
      lastContact: null,
      lastSite: null,
      lastQuery: null,
      lastFile: null,
      lastAction: null
    };
    this.flushToFile();
    this.emit('session-cleared', { sessionId: this.sessionId });
    console.log(`[JarvisSession] Session cleared. New session: ${this.sessionId}`);
  }
}

module.exports = JarvisSession;
