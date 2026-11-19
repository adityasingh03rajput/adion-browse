'use strict';

/**
 * In-Memory BM25 Lexical Search for Open Tabs & History
 * Adapted from companion/src/recall/bm25.js
 * 
 * Provides instantaneous, dependency-free ranking across all open tabs,
 * headings, and browsing history entries in <1ms without network calls.
 */

const STOP = new Set(('a an and are as at be been but by can could did do does doing for from had has have how i if in into is it its '
  + 'just me my of on or our so than that the their them then there these they this to too us was we were what when where which who '
  + 'why will with would you your').split(/\s+/));

const ASK_STOP = new Set(('about across all any ask asked chat chats conversation conversations tell told '
  + 'say said know show give find look week month year today yesterday last ago working work worked thing things stuff something '
  + 'note notes file files two both these those merge combine compare gap between talk talked talking '
  + 'remember recall search mention mentioned ever before tab tabs switch go open').split(/\s+/));

function tokenize(text) {
  const out = [];
  const words = String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9][a-z0-9'+#.-]*/g) || [];
  for (let w of words) {
    w = w.replace(/^[.'-]+|[.'-]+$/g, '').replace(/'s$/, '');
    if (w.length < 2 || w.length > 40 || STOP.has(w)) continue;
    if (w.length > 4 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
    out.push(w);
  }
  return out;
}

function queryTerms(text) {
  return Array.from(new Set(tokenize(text).filter((t) => !ASK_STOP.has(t))));
}

function createTabSearchIndex({ k1 = 1.2, b = 0.75 } = {}) {
  let lens = [], metas = [], alive = [];
  const keys = new Map();
  const idOf = [];
  let postings = new Map();
  let totalLen = 0, live = 0, dead = 0;

  function remove(id) {
    const d = keys.get(id);
    if (d == null) return false;
    keys.delete(id);
    alive[d] = false; metas[d] = null; totalLen -= lens[d]; live--; dead++;
    return true;
  }

  function add(id, text, meta = {}) {
    remove(id);
    const tokens = tokenize(text);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    const d = lens.length;
    lens.push(tokens.length); metas.push(meta); alive.push(true); idOf.push(id);
    keys.set(id, d);
    for (const [term, n] of tf) {
      const list = postings.get(term);
      if (!list) postings.set(term, [d, n]);
      else if (Array.isArray(list)) list.push(d, n);
      else { const grown = Array.from(list); grown.push(d, n); postings.set(term, grown); }
    }
    totalLen += tokens.length; live++;
  }

  function search(query, { limit = 5 } = {}) {
    const terms = Array.isArray(query) ? query : queryTerms(query);
    if (!live || !terms.length) return [];
    const avg = totalLen / live || 1;
    const scores = new Map();
    const matched = new Map();
    for (const term of terms) {
      const list = postings.get(term);
      if (!list) continue;
      let df = 0;
      for (let i = 0; i < list.length; i += 2) if (alive[list[i]]) df++;
      if (!df) continue;
      const idf = Math.log(1 + (live - df + 0.5) / (df + 0.5));
      for (let i = 0; i < list.length; i += 2) {
        const d = list[i];
        if (!alive[d]) continue;
        const tf = list[i + 1];
        scores.set(d, (scores.get(d) || 0) + idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * lens[d] / avg)));
        matched.set(d, (matched.get(d) || 0) + 1);
      }
    }
    return Array.from(scores, ([d, score]) => ({ id: idOf[d], score, matched: matched.get(d), meta: metas[d] }))
      .sort((x, y) => y.score - x.score || String(x.id).localeCompare(String(y.id)))
      .slice(0, limit);
  }

  return { add, remove, search, get live() { return live; } };
}

module.exports = { createTabSearchIndex, tokenize, queryTerms };
