/**
 * Adion Browse — Workflow State (dialogue state tracker).
 *
 * Structured conversational memory that replaces string-matching on raw
 * prompts ("does recentUsers include instagram?"). Tracks:
 *   - currentSite: where the user's workflow lives (with turn recency)
 *   - lastIntents: structured parses of recent turns (not raw strings)
 *   - entities: quoted names, contacts, files mentioned recently
 *
 * Resolution policy (the anti-repeat guarantee):
 *   - A section follow-up ("open messages") is resolved against the tracked
 *     workflow site FIRST. Known section+site with a direct URL executes
 *     deterministically; anything else returns null so the LLM planner —
 *     which sees live DOM + full history — decides. The fast layer NEVER
 *     guesses a web search for a follow-up again.
 */

const { SITES, findSite, findSection, siteOfUrl, isGenericSection } = require('./siteRegistry');

const SITE_TTL_TURNS = 12;

class WorkflowState {
  constructor() {
    this.reset();
  }

  reset() {
    this.currentSite = null;      // site id
    this.currentSiteTurn = -1;
    this.turn = 0;
    this.lastIntents = [];        // [{intent, site, section, raw, turn}]
    this.entities = [];           // [{value, kind, turn}]
    this.lastAction = null;       // {type, url|target, turn}
  }

  observeTurn({ parse, pageUrl, pageTitle, actionTaken }) {
    this.turn += 1;
    if (parse && parse.intent && parse.intent !== 'EMPTY') {
      this.lastIntents.push({ ...parse, turn: this.turn });
      if (this.lastIntents.length > 8) this.lastIntents.shift();
    }
    // Site tracking: explicit mention wins; otherwise adopt the live page.
    let siteId = null;
    if (parse && parse.site) siteId = parse.site;
    if (!siteId && pageUrl) {
      const s = siteOfUrl(pageUrl);
      if (s) siteId = s.id;
    }
    if (siteId) {
      this.currentSite = siteId;
      this.currentSiteTurn = this.turn;
    }
    if (actionTaken) this.lastAction = { ...actionTaken, turn: this.turn };
    if (pageTitle && /"(.*?)"|'([^']+)'/.test(pageTitle)) {
      const m = pageTitle.match(/"([^"]{2,40})"|'([^']{2,40})'/);
      const v = (m[1] || m[2] || '').trim();
      if (v) {
        this.entities.push({ value: v, kind: 'title-mention', turn: this.turn });
        if (this.entities.length > 10) this.entities.shift();
      }
    }
  }

  /** Structured context for pageContext.dialogue (planner + fast guards). */
  getContext() {
    const fresh = this.currentSite && (this.turn - this.currentSiteTurn) <= SITE_TTL_TURNS;
    return {
      site: fresh ? this.currentSite : null,
      siteStale: this.currentSite && !fresh ? this.currentSite : null,
      turn: this.turn,
      recentIntents: this.lastIntents.slice(-4).map(i => ({ intent: i.intent, site: i.site || null, section: i.section || null })),
    };
  }

  siteRecord(id) { return SITES.find(s => s.id === id) || null; }

  /**
   * Resolve a parse to a deterministic browser action.
   * Returns an ActionType-shaped {type, ...params, thought} or null (defer to LLM).
   * Safety comes from REGISTRY grounding (unknown site/section -> null), so the
   * confidence floor only filters UNKNOWN parses; context-dependent parses
   * (0.6-0.85) resolve here when the workflow state grounds them.
   */
  resolveAction(parse, pageContext = {}) {
    if (!parse || (parse.confidence || 0) < 0.6) return null;
    const liveSite = pageContext.url ? siteOfUrl(pageContext.url) : null;
    // Site precedence: mentioned > in-turn workflow override > tracked state > live page.
    const ctxSite = (pageContext.dialogue && pageContext.dialogue.site) || this.getContext().site;
    const siteIdOf = (p) => p.site || ctxSite || (liveSite && liveSite.id) || null;

    switch (parse.intent) {
      case 'NAVIGATE_SITE': {
        const rec = this.siteRecord(parse.site);
        if (!rec) return null;
        const url = 'https://' + rec.domains[0].replace(/^www\./, 'www.');
        return { type: 'NAVIGATE', url, thought: `Open ${parse.site} (dialogue layer)` };
      }
      case 'NAVIGATE_URL': {
        const url = /^https?:\/\//.test(parse.url) ? parse.url : 'https://' + parse.url;
        return { type: 'NAVIGATE', url, thought: `Navigate to ${parse.url} (dialogue layer)` };
      }
      case 'OPEN_SECTION': {
        // Prefer the workflow site: mentioned > in-turn override > tracked state > live page.
        const siteId = siteIdOf(parse);
        if (!siteId) return null; // no workflow — LLM decides (never web-search here)
        const rec = this.siteRecord(siteId);
        const sec = rec && findSection(rec, parse.section);
        if (!sec) return null; // site has no such section — LLM decides (click vs navigate)
        if (sec.url) {
          return { type: 'NAVIGATE', url: sec.url, thought: `Open ${siteId} ${parse.section} (dialogue layer)` };
        }
        if (sec.action) {
          return { type: sec.action, thought: `Open ${siteId} ${parse.section} (dialogue layer)` };
        }
        if (sec.click) {
          return { type: 'CLICK_SELECTOR', target: sec.click[0], thought: `Open ${siteId} ${parse.section} (dialogue layer)` };
        }
        return null;
      }
      case 'TAB_OP': {
        if (parse.op === 'close') return { type: 'CLOSE_TAB', thought: 'Close tab (dialogue layer)' };
        return null;
      }
      case 'SEARCH_SITE': {
        const rec = this.siteRecord(parse.site);
        if (rec && typeof rec.searchUrl === 'function' && parse.query) {
          return { type: 'NAVIGATE', url: rec.searchUrl(parse.query), thought: `Search ${parse.site} for "${parse.query}" (dialogue layer)` };
        }
        return null;
      }
      case 'SEARCH_WEB': {
        if (!parse.query) return null;
        const siteId = siteIdOf(parse);
        const rec = siteId && this.siteRecord(siteId);
        // Site-scoped search when the workflow (or mention) grounds one and it
        // declares a search URL; otherwise the LLM picks the engine (never guess).
        if (rec && typeof rec.searchUrl === 'function') {
          return { type: 'NAVIGATE', url: rec.searchUrl(parse.query), thought: `Search ${siteId} for "${parse.query}" (dialogue layer)` };
        }
        return null;
      }
      default:
        return null;
    }
  }

  /**
   * Resolve a compound utterance segment-by-segment, threading the workflow
   * site forward (segment 1 navigates to youtube → segment 2 searches youtube).
   * Returns { actions, summaries, remainder } where remainder is the raw text
   * of the first unresolvable segment onward (LLM continues from there), or
   * null remainder when everything resolved deterministically.
   */
  resolveCompound(compound, pageContext = {}) {
    if (!compound || !Array.isArray(compound.segments) || compound.segments.length < 2) return null;
    const liveSite = pageContext.url ? siteOfUrl(pageContext.url) : null;
    let site = (pageContext.dialogue && pageContext.dialogue.site)
      || this.getContext().site || (liveSite && liveSite.id) || null;
    const actions = [];
    const summaries = [];
    for (let i = 0; i < compound.segments.length; i++) {
      const seg = compound.segments[i];
      if (seg.site) site = seg.site;
      const act = this.resolveAction(seg, { ...pageContext, dialogue: { site } });
      if (!act) {
        const remainder = compound.segments.slice(i).map(s => s.raw).join(' then ');
        return { actions, summaries, remainder };
      }
      actions.push(act);
      summaries.push(act.thought || act.type);
      if (act.type === 'NAVIGATE' && act.url) {
        const s = siteOfUrl(act.url);
        if (s) site = s.id;
      } else if (seg.site) {
        site = seg.site;
      }
    }
    return { actions, summaries, remainder: null };
  }
}

module.exports = { WorkflowState };
