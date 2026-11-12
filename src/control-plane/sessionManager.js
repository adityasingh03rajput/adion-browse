const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

/**
 * Adion Browse - Session Memory & Interaction State Manager
 * 
 * - Initializes an empty JSON log file on application startup, clearing previous run history.
 * - Records every user prompt (preserving exact phrasing and fidelity) and model response.
 * - Persists structured session logs to .data/session_interactions.json.
 * - Powers the Jarvis UI session memory review and new session resets.
 */
class SessionManager extends EventEmitter {
  constructor(dataDir = null) {
    super();
    this.dataDir = dataDir || path.resolve(process.cwd(), '.data');
    this.sessionFilePath = path.join(this.dataDir, 'session_interactions.json');
    this.interactions = [];
    this.maxStoredInteractions = 500;
    this.sessionId = 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6);
    this.createdAt = new Date().toISOString();

    this.initStorage();
  }

  /**
   * Restore the persisted session on startup so conversation memory survives
   * a browser restart. A brand-new session still starts empty.
   */
  initStorage() {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }

      this.interactions = this.loadFromFile();
      this.flushToFile();
      console.log(`[SessionManager] Restored ${this.interactions.length} interaction(s) from ${this.sessionFilePath}`);
    } catch (err) {
      console.error('[SessionManager] Failed to initialize session log file:', err.message);
    }
  }

  /**
   * Read existing interactions from disk, tolerating older or invalid files.
   */
  loadFromFile() {
    if (!fs.existsSync(this.sessionFilePath)) return [];
    try {
      const raw = fs.readFileSync(this.sessionFilePath, 'utf8');
      if (!raw || !raw.trim()) return [];
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed)
        ? parsed
        : (parsed && Array.isArray(parsed.interactions) ? parsed.interactions : []);
      if (parsed && !Array.isArray(parsed)) {
        if (parsed.sessionId) this.sessionId = parsed.sessionId;
        if (parsed.startedAt) this.createdAt = parsed.startedAt;
      }
      return entries
        .filter(entry => entry && typeof entry === 'object')
        .slice(-this.maxStoredInteractions);
    } catch (err) {
      console.warn('[SessionManager] Could not read session memory, starting fresh:', err.message);
      return [];
    }
  }

  /**
   * Append an interaction to the session memory and persist to JSON
   */
  recordInteraction({
    source = 'voice',
    rawPrompt = '',
    transcription = '',
    pageContext = {},
    modelResponse = null,
    status = 'success',
    feedback = ''
  }) {
    const entry = {
      id: 'int_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6),
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      source: source,
      prompt: {
        raw: rawPrompt,
        transcription: transcription || rawPrompt,
        length: rawPrompt.length
      },
      page: {
        url: pageContext.url || 'adion://newtab',
        title: pageContext.title || 'New Tab'
      },
      response: {
        thought: modelResponse?.thought || (status === 'success' ? 'Task executed successfully' : 'Action could not be completed'),
        actions: modelResponse?.actions || [],
        status: status,
        feedback: feedback || '',
        completedAt: new Date().toISOString()
      }
    };

    this.interactions.push(entry);
    if (this.interactions.length > this.maxStoredInteractions) {
      this.interactions = this.interactions.slice(-this.maxStoredInteractions);
    }
    this.flushToFile();
    this.emit('interaction-recorded', entry);
    return entry;
  }

  /**
   * Flush in-memory interactions to the session JSON file
   */
  flushToFile() {
    try {
      const payload = {
        sessionId: this.sessionId,
        startedAt: this.createdAt,
        lastUpdatedAt: new Date().toISOString(),
        totalInteractions: this.interactions.length,
        interactions: this.interactions
      };
      fs.writeFileSync(this.sessionFilePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (err) {
      console.warn('[SessionManager] Could not flush session interactions to file:', err.message);
    }
  }

  /**
   * Retrieve all interactions for the current session
   */
  getHistory() {
    return {
      sessionId: this.sessionId,
      startedAt: this.createdAt,
      totalInteractions: this.interactions.length,
      interactions: [...this.interactions]
    };
  }

  /**
   * Clear session memory and re-initialize a fresh session
   */
  clearSession() {
    this.sessionId = 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6);
    this.createdAt = new Date().toISOString();
    this.interactions = [];
    this.flushToFile();
    this.emit('session-cleared', { sessionId: this.sessionId, clearedAt: this.createdAt });
    console.log(`[SessionManager] Session memory cleared. Fresh session started: ${this.sessionId}`);
    return {
      success: true,
      sessionId: this.sessionId,
      message: 'Session memory cleared and reset to empty'
    };
  }
}

module.exports = SessionManager;

