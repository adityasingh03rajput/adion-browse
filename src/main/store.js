const fs = require('fs');
const path = require('path');
const electron = require('electron');

class Store {
  constructor() {
    this.initialized = false;
    this.data = this.getDefaults();
  }

  init() {
    if (this.initialized) return;
    try {
      const app = electron.app;
      this.userDataPath = (app && app.getPath) ? app.getPath('userData') : path.join(process.cwd(), '.data');
    } catch (e) {
      this.userDataPath = path.join(process.cwd(), '.data');
    }

    if (!fs.existsSync(this.userDataPath)) {
      try {
        fs.mkdirSync(this.userDataPath, { recursive: true });
      } catch (e) {}
    }

    this.filePath = path.join(this.userDataPath, 'adion-profile.json');
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
        showBookmarksBar: true
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
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        return Object.assign(this.getDefaults(), JSON.parse(content));
      }
    } catch (e) {
      console.error('Failed to load store, using defaults:', e);
    }
    return this.getDefaults();
  }

  save() {
    this.init();
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (e) {
      console.error('Failed to save store:', e);
    }
  }

  get(key) {
    this.init();
    return this.data[key];
  }

  set(key, val) {
    this.init();
    this.data[key] = val;
    this.save();
  }

  getSetting(name) {
    this.init();
    return this.data.settings[name];
  }

  setSetting(name, val) {
    this.init();
    this.data.settings[name] = val;
    this.save();
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
    this.data.siteShields[domain] = Object.assign(this.getSiteShield(domain), options);
    this.save();
  }

  recordBlocked(count = 1) {
    this.data.stats.totalBlocked += count;
    this.data.stats.estimatedBandwidthSavedKB += count * 50; // ~50 KB per blocked ad/tracker
    this.data.stats.estimatedTimeSavedSec += count * 0.05; // ~50ms per ad/tracker
    this.save();
  }

  addBookmark(item) {
    const exists = this.data.bookmarks.find(b => b.url === item.url);
    if (!exists) {
      this.data.bookmarks.push({
        id: Date.now().toString(),
        title: item.title || item.url,
        url: item.url,
        createdAt: Date.now()
      });
      this.save();
      return true;
    }
    return false;
  }

  removeBookmark(url) {
    this.data.bookmarks = this.data.bookmarks.filter(b => b.url !== url);
    this.save();
  }

  isBookmarked(url) {
    return this.data.bookmarks.some(b => b.url === url);
  }

  addHistory(item) {
    if (!item.url || item.url.startsWith('file://') || item.url.startsWith('about:')) return;
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
