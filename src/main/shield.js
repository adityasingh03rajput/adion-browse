const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const store = require('./store');
const { URL } = require('url');

class AdionShieldEngine {
  constructor() {
    this.blocker = null;
    this.tabStats = new Map(); // tabId -> { domain: string, blockedCount: number, blockedUrls: [] }
    this.onBlockedCallback = null;
  }

  async init(session) {
    try {
      console.log('[Adion Shields] Initializing tracker & ad blocking engine...');
      this.blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch);

      // Enable in the provided session
      if (session) {
        this.blocker.enableBlockingInSession(session);
      }

      // Listen for blocked requests
      this.blocker.on('request-blocked', (request) => {
        this.handleBlockedRequest(request);
      });

      this.setupCustomRules(session);
      console.log('[Adion Shields] Shields engine active with EasyList & Ghostery databases.');
    } catch (err) {
      console.error('[Adion Shields] Failed to initialize blocker:', err);
    }
  }

  setupCustomRules(session) {
    if (!session) return;

    // Custom filtering for HTTPS upgrade & Script blocking
    session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      const { url, resourceType, tabId } = details;

      // Handle HTTPS upgrade
      if (store.getSetting('upgradeHttps')) {
        if (url.startsWith('http://') && !url.includes('localhost') && !url.includes('127.0.0.1')) {
          const httpsUrl = url.replace('http://', 'https://');
          return callback({ redirectURL: httpsUrl });
        }
      }

      // Check per-site shield status against the TOP-LEVEL page: a tracker is
      // fetched from a third-party host, so keying policy off the request host
      // silently ignored the user's per-site choice.
      try {
        const parsed = new URL(url);
        let domain = parsed.hostname;
        try {
          const topUrl = this.siteResolver ? this.siteResolver(details.webContentsId) : '';
          if (topUrl) domain = new URL(topUrl).hostname;
        } catch (_) {}
        const siteConfig = store.getSiteShield(domain);

        // If scripts are blocked for this domain and resource is script
        if (siteConfig && siteConfig.blockScripts && (resourceType === 'script' || resourceType === 'mainFrame')) {
          if (resourceType === 'script') {
            this.recordBlocked(tabId, domain, url);
            return callback({ cancel: true });
          }
        }
      } catch (e) {
        // invalid url, pass through
      }

      callback({});
    });
  }

  handleBlockedRequest(request) {
    try {
      const url = request.url || '';
      const tabId = request.tabId || 0;
      let domain = '';
      try {
        domain = new URL(url).hostname;
      } catch (e) { }

      this.recordBlocked(tabId, domain, url);
    } catch (e) {
      console.error('Error handling blocked request:', e);
    }
  }

  recordBlocked(tabId, domain, url) {
    store.recordBlocked(1);

    if (tabId) {
      const stats = this.tabStats.get(tabId) || { domain, blockedCount: 0, blockedUrls: [] };
      stats.blockedCount += 1;
      if (stats.blockedUrls.length < 50) {
        stats.blockedUrls.push(url);
      }
      this.tabStats.set(tabId, stats);

      if (this.onBlockedCallback) {
        this.onBlockedCallback(tabId, stats);
      }
    }
  }

  resetTabStats(tabId, domain = '') {
    this.tabStats.set(tabId, { domain, blockedCount: 0, blockedUrls: [] });
    if (this.onBlockedCallback) {
      this.onBlockedCallback(tabId, this.tabStats.get(tabId));
    }
  }

  getTabStats(tabId) {
    return this.tabStats.get(tabId) || { domain: '', blockedCount: 0, blockedUrls: [] };
  }

  cleanTab(tabId) {
    this.tabStats.delete(tabId);
  }

  onBlocked(callback) {
    this.onBlockedCallback = callback;
  }

  /**
   * Provide a webContentsId -> top-level page URL resolver so shield policy is
   * evaluated for the site the user is actually on.
   */
  setSiteResolver(fn) {
    this.siteResolver = typeof fn === 'function' ? fn : null;
  }
}

module.exports = new AdionShieldEngine();

