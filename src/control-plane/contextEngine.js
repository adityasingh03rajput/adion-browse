const fs = require('fs');
const path = require('path');

/**
 * Local Context Engine
 * Builds a persistent, privacy-preserving semantic session graph of user navigation,
 * active tabs, and visited page contexts. Enables predictive navigation and proactive tab clustering.
 */
class ContextEngine {
  constructor(storageDir = path.join(__dirname, '../../.cache/context')) {
    this.storageDir = storageDir;
    this.sessionGraph = {
      nodes: new Map(), // url/id -> NodeMetadata
      edges: []         // { from, to, count, lastTransition }
    };
    this.tabClusters = new Map(); // clusterName -> [tabIds]
    this.pageTextIndex = new Map(); // url -> text summary
    this.MAX_INDEXED_PAGES = 200;   // bound memory: evict oldest beyond this
    this.ensureStorage();
  }

  ensureStorage() {
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }
    } catch (e) {
      console.warn('[ContextEngine] Storage dir creation fallback:', e.message);
    }
  }

  /**
   * Record a navigation event in the episodic session graph.
   * Also builds transition edges between domains for predictive suggestions.
   */
  recordNavigation(tabId, url, title) {
    if (!url || url.startsWith('adion://') || url.startsWith('file://')) return;

    let domain;
    try {
      const parsed = new URL(url);
      domain = parsed.hostname;
    } catch (e) {
      return; // Ignore invalid URL parse
    }

    const nodeKey = domain;
    if (!this.sessionGraph.nodes.has(nodeKey)) {
      this.sessionGraph.nodes.set(nodeKey, {
        domain,
        sampleTitle: title,
        visitCount: 1,
        firstSeen: Date.now(),
        lastSeen: Date.now()
      });
    } else {
      const node = this.sessionGraph.nodes.get(nodeKey);
      node.visitCount++;
      node.lastSeen = Date.now();
      if (title) node.sampleTitle = title;
    }

    // Build transition edge from the last visited domain to this one.
    // This powers predictive suggestions (getPredictiveSuggestions).
    if (this._lastDomain && this._lastDomain !== domain) {
      const existing = this.sessionGraph.edges.find(
        e => e.from === this._lastDomain && e.to === domain
      );
      if (existing) {
        existing.count++;
        existing.lastTransition = Date.now();
      } else {
        this.sessionGraph.edges.push({
          from: this._lastDomain,
          to: domain,
          count: 1,
          lastTransition: Date.now()
        });
      }
      // Cap edges to avoid unbounded growth
      if (this.sessionGraph.edges.length > 2000) {
        this.sessionGraph.edges.sort((a, b) => b.count - a.count || b.lastTransition - a.lastTransition);
        this.sessionGraph.edges.length = 1500;
      }
    }
    this._lastDomain = domain;
  }

  /**
   * Index page text for semantic query retrieval
   */
  indexPageContent(url, textContent) {
    if (!url || !textContent) return;
    const clean = textContent.replace(/\s+/g, ' ').slice(0, 4000);
    // Evict oldest entries when over cap — Map preserves insertion order, so
    // the first key is the oldest. Keeps session memory bounded.
    while (this.pageTextIndex.size >= this.MAX_INDEXED_PAGES && !this.pageTextIndex.has(url)) {
      const oldest = this.pageTextIndex.keys().next().value;
      if (oldest === undefined) break;
      this.pageTextIndex.delete(oldest);
    }
    this.pageTextIndex.delete(url); // refresh insertion order on re-visit
    this.pageTextIndex.set(url, {
      text: clean,
      timestamp: Date.now()
    });
  }

  /**
   * Compute semantic clusters across active tabs based on domains and keywords
   */
  clusterTabs(tabs) {
    const clusters = {};

    tabs.forEach((tab) => {
      if (!tab.url || tab.url.startsWith('adion://')) {
        clusters['Dashboard'] = clusters['Dashboard'] || [];
        clusters['Dashboard'].push(tab);
        return;
      }

      let category = 'General Research';
      try {
        const host = new URL(tab.url).hostname;
        if (/github|gitlab|bitbucket|stackoverflow/i.test(host)) {
          category = 'Development';
        } else if (/youtube|netflix|twitch|spotify/i.test(host)) {
          category = 'Media & Entertainment';
        } else if (/amazon|ebay|walmart|aliexpress/i.test(host)) {
          category = 'Shopping';
        } else if (/google|bing|duckduckgo|brave/i.test(host)) {
          category = 'Search';
        } else if (/twitter|x\.com|reddit|linkedin/i.test(host)) {
          category = 'Social & Community';
        }
      } catch (e) {}

      clusters[category] = clusters[category] || [];
      clusters[category].push(tab);
    });

    return clusters;
  }

  /**
   * Predictive navigation: suggest next probable destination based on current domain
   */
  getPredictiveSuggestions(currentUrl) {
    if (!currentUrl) return [];
    try {
      const host = new URL(currentUrl).hostname;
      const suggestions = [];

      // Look up edges where 'from' matches current domain
      const outgoing = this.sessionGraph.edges.filter(e => e.from === host);
      outgoing.sort((a, b) => b.count - a.count);

      outgoing.slice(0, 3).forEach(edge => {
        suggestions.push({
          target: edge.to,
          confidence: Math.min(0.95, edge.count * 0.2)
        });
      });

      return suggestions;
    } catch (e) {
      return [];
    }
  }

  /**
   * Export graph statistics for the telemetry HUD
   */
  getStats() {
    return {
      indexedPages: this.pageTextIndex.size,
      graphNodes: this.sessionGraph.nodes.size,
      edgesCount: this.sessionGraph.edges.length
    };
  }
}

module.exports = ContextEngine;

