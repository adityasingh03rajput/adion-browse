const fs = require('fs');
const path = require('path');
const electron = require('electron');

class Store {
  constructor() {
    this.initialized = false;
    this.data = this.getDefaults();
    this.saveTimeout = null;
    this.userDataPath = path.join(process.cwd(), '.data');
    this.filePath = path.join(this.userDataPath, 'adion-profile.json');
    this.tempFilePath = path.join(this.userDataPath, 'adion-profile.tmp');
  }

  init() {
    if (this.initialized) return;
    try {
      // Ensure workspace data directory on D: drive exists with full user permissions
      if (!fs.existsSync(this.userDataPath)) {
        fs.mkdirSync(this.userDataPath, { recursive: true });
      }
    } catch (e) {
      console.error('[Store] Failed to create data directory:', e.message);
    }

    this.data = this.loadData();
    this.initialized = true;
  }

  getDefaults() {
    return {
      settings: {
        searchEngine: 'brave', // 'brave' | 'duckduckgo' | 'google' | 'bing'
        shieldsEnabled: true,
        blockTrackersAndAds: true,
        upgradeHttps: true,
        blockScripts: false,
        theme: 'dark',
        showBookmarksBar: true,
        mcpServerEnabled: true, // Enabled for Claude Web and external agents
        diagnosticLogging: true, // Continuous structured telemetry and diagnostic monitoring
        logLevel: 'structured'   // 'structured' | 'verbose' | 'minimal'
      },
      stats: {
        totalBlocked: 0,
        estimatedBandwidthSavedKB: 0,
        estimatedTimeSavedSec: 0
      },
      siteShields: {}, // { "domain.com": { enabled: boolean, blockScripts: boolean } }
      bookmarks: [
        { id: '1', title: 'Brave Search', url: 'https://search.brave.com' },
        { id: '2', title: 'DuckDuckGo', url: 'https://duckduckgo.com' },
        { id: '3', title: 'GitHub', url: 'https://github.com' },
        { id: '4', title: 'Reddit', url: 'https://reddit.com' },
        { id: '5', title: 'Wikipedia', url: 'https://wikipedia.org' }
      ],
      history: [],
      shortcuts: [
        { title: 'Brave Search', url: 'https://search.brave.com', icon: 'search' },
        { title: 'YouTube', url: 'https://youtube.com', icon: 'youtube' },
        { title: 'GitHub', url: 'https://github.com', icon: 'github' },
        { title: 'Reddit', url: 'https://reddit.com', icon: 'reddit' },
        { title: 'Wikipedia', url: 'https://wikipedia.org', icon: 'book' },
        { title: 'DuckDuckGo', url: 'https://duckduckgo.com', icon: 'shield' }
      ]
    };
  }

  loadData() {
    const defaults = this.getDefaults();
    if (!fs.existsSync(this.filePath)) return defaults;

    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('profile root is not an object');
      }
      return this.mergeWithDefaults(defaults, parsed);
    } catch (e) {
      // Never silently throw a damaged profile away: keep a copy for recovery.
      console.error('[Store] Failed to load profile:', e.message);
      try {
        const backup = `${this.filePath}.corrupt-${Date.now()}`;
        fs.copyFileSync(this.filePath, backup);
        console.error('[Store] Corrupt profile preserved at:', backup);
      } catch (_) {}
      return defaults;
    }
  }

  /**
   * Merge a saved profile over the defaults so newly added settings survive an
   * upgrade, and reject values with the wrong shape/type instead of trusting
   * whatever is on disk.
   */
  mergeWithDefaults(defaults, saved) {
    const merged = { ...defaults };

    // settings: known keys only, same primitive type
    const settings = {};
    for (const [key, fallback] of Object.entries(defaults.settings)) {
      const value = saved.settings && typeof saved.settings === 'object' ? saved.settings[key] : undefined;
      settings[key] = typeof value === typeof fallback ? value : fallback;
    }
    merged.settings = settings;

    // stats: non-negative finite numbers only
    const stats = {};
    for (const [key, fallback] of Object.entries(defaults.stats)) {
      const value = Number(saved.stats && saved.stats[key]);
      stats[key] = Number.isFinite(value) && value >= 0 ? value : fallback;
    }
    merged.stats = stats;

    // siteShields: sanitize each per-site record
    const siteShields = {};
    if (saved.siteShields && typeof saved.siteShields === 'object' && !Array.isArray(saved.siteShields)) {
      for (const [domain, cfg] of Object.entries(saved.siteShields)) {
        if (!domain || !cfg || typeof cfg !== 'object') continue;
        siteShields[domain] = {
          enabled: cfg.enabled !== false,
          blockScripts: cfg.blockScripts === true
        };
      }
    }
    merged.siteShields = siteShields;

    // Collections: accept only arrays of well-formed entries
    const urls = (list, predicate) => Array.isArray(list) ? list.filter(predicate).slice(0, 500) : [];
    merged.bookmarks = saved.bookmarks === undefined
      ? defaults.bookmarks
      : urls(saved.bookmarks, b => b && typeof b === 'object' && typeof b.url === 'string' && b.url.length > 0);
    merged.history = urls(saved.history, h => h && typeof h === 'object' && typeof h.url === 'string' && h.url.length > 0);
    merged.shortcuts = saved.shortcuts === undefined
      ? defaults.shortcuts
      : urls(saved.shortcuts, s => s && typeof s === 'object' && typeof s.url === 'string');

    return merged;
  }

  save(immediate = false) {
    if (immediate) {
      this.flush();
    } else {
      this.scheduleSave();
    }
  }

  scheduleSave() {
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.flush();
    }, 400); // 400ms debounce prevents disk thrashing on heavy ad/tracker loads
  }

  flush() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    this.init();
    try {
      const serialized = JSON.stringify(this.data, null, 2);
      // Atomic write: write to temp file then rename to avoid corruption during interrupts/SIGINT
      fs.writeFileSync(this.tempFilePath, serialized, 'utf-8');
      fs.renameSync(this.tempFilePath, this.filePath);
    } catch (e) {
      // Fallback direct write
      try {
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
      } catch (err) {
        console.error('[Store] Failed to save profile data:', err.message);
      }
    }
  }

  get(key) {
    this.init();
    return this.data[key];
  }

  set(key, val) {
    this.init();
    this.data[key] = val;
    this.save(true);
  }

  getSetting(name) {
    this.init();
    return this.data.settings[name];
  }

  setSetting(name, val) {
    this.init();
    this.data.settings[name] = val;
    this.save(true);
  }

  getSiteShield(domain) {
    this.init();
    if (!domain) return { enabled: this.data.settings.shieldsEnabled, blockScripts: this.data.settings.blockScripts };
    return this.data.siteShields[domain] || {
      enabled: this.data.settings.shieldsEnabled,
      blockScripts: this.data.settings.blockScripts
    };
  }

  setSiteShield(domain, options) {
    if (!domain) return;
    this.init();
    this.data.siteShields[domain] = Object.assign(this.getSiteShield(domain), options);
    this.save(true);
  }

  recordBlocked(count = 1) {
    this.init();
    this.data.stats.totalBlocked += count;
    this.data.stats.estimatedBandwidthSavedKB += count * 50; // ~50 KB per blocked ad/tracker
    this.data.stats.estimatedTimeSavedSec += count * 0.05; // ~50ms per ad/tracker
    this.scheduleSave(); // Debounced
  }

  addBookmark(item) {
    this.init();
    if (!item || !item.url) return false;
    const url = String(item.url).trim();
    if (!url || url.startsWith('adion://') || url.startsWith('about:')) return false;

    if (!Array.isArray(this.data.bookmarks)) {
      this.data.bookmarks = [];
    }

    const exists = this.data.bookmarks.find(b => b.url === url);
    if (!exists) {
      this.data.bookmarks.push({
        id: Date.now().toString(),
        title: (item.title || url).trim(),
        url: url,
        createdAt: Date.now()
      });
      this.flush(); // Immediate atomic save for bookmarks
      return true;
    }
    return false;
  }

  removeBookmark(url) {
    this.init();
    if (!url || !Array.isArray(this.data.bookmarks)) return;
    this.data.bookmarks = this.data.bookmarks.filter(b => b.url !== String(url).trim());
    this.flush(); // Immediate atomic save
  }

  isBookmarked(url) {
    this.init();
    if (!url || !Array.isArray(this.data.bookmarks)) return false;
    const normalized = String(url).trim();
    return this.data.bookmarks.some(b => b.url === normalized);
  }

  addHistory(item) {
    if (!item || !item.url || item.url.startsWith('file://') || item.url.startsWith('about:')) return;
    this.init();
    if (!Array.isArray(this.data.history)) this.data.history = [];

    // SPA route changes fire did-navigate-in-page repeatedly; do not spam history.
    const previous = this.data.history[0];
    if (previous && previous.url === item.url && Date.now() - (previous.visitedAt || 0) < 2000) return;

    // Keep last 500 items
    this.data.history.unshift({
      id: Date.now().toString(),
      title: item.title || item.url,
      url: item.url,
      visitedAt: Date.now()
    });
    if (this.data.history.length > 500) {
      this.data.history.pop();
    }
    this.save();
  }

  clearHistory() {
    this.data.history = [];
    this.save();
  }
}

module.exports = new Store();
