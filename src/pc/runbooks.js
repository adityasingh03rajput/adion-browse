/**
 * Adion Browse — PC runbooks (learn once, replay)
 *
 * Adapted from nus-companion's guide/walkthroughs.js (Apache-2.0,
 * potlakai/nus-companion v0.1.21), renamed. A PC run the person chose to keep
 * is stored by app + task. The next time the same ask arrives in the same app,
 * steps are resolved by control name with no screenshot and no model call. A
 * step that cannot be resolved falls back to the live planner (with the saved
 * step as a hint); two misses across runs retire the entry.
 *
 * Local JSON only, bounded, never sent anywhere.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { tokenOverlap } = require('./grounding');

const MAX_ENTRIES = 80;
const MATCH_MIN = 0.6;

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function keyFor(processName, task) {
  return `${String(processName || '').toLowerCase()}::${slug(task)}`;
}

function createRunbooks(options = {}) {
  const file = options.file || null;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  let data = load();

  function load() {
    if (!file) return { schema_version: 1, runbooks: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.schema_version === 1 && Array.isArray(parsed.runbooks)) return parsed;
    } catch (_) {
      /* first run, or unreadable: start clean */
    }
    return { schema_version: 1, runbooks: [] };
  }

  function save() {
    if (!file) return;
    if (data.runbooks.length > MAX_ENTRIES) {
      data.runbooks.sort((a, b) => (b.lastOk || 0) - (a.lastOk || 0));
      data.runbooks.length = MAX_ENTRIES;
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(data, null, 2));
      fs.renameSync(temporary, file);
    } catch (error) {
      log(`runbooks save failed: ${error.message}`);
    }
  }

  function get(key) {
    return data.runbooks.find((entry) => entry.key === key) || null;
  }

  /** record({ task, app:{process,title}, steps:[{instruction,name,type,automationId}] }) */
  function record(rec) {
    if (!rec || !rec.app || !rec.app.process || !rec.task) return null;
    const steps = (rec.steps || [])
      .filter((step) => step && step.name)
      .map((step) => ({
        instruction: String(step.instruction || ''),
        target: {
          name: String(step.name),
          type: String(step.type || ''),
          automationId: String(step.automationId || '')
        }
      }));
    if (!steps.length) return null;

    const key = keyFor(rec.app.process, rec.task);
    let entry = get(key);
    if (entry) {
      entry.steps = steps;
      entry.runs = (entry.runs || 0) + 1;
      entry.lastOk = now();
      entry.stale = false;
      entry.misses = 0;
      entry.app.title = rec.app.title || entry.app.title || '';
    } else {
      entry = {
        key,
        task: String(rec.task),
        app: { process: String(rec.app.process).toLowerCase(), title: rec.app.title || '' },
        steps,
        runs: 1,
        misses: 0,
        stale: false,
        createdAt: now(),
        lastOk: now()
      };
      data.runbooks.push(entry);
    }
    save();
    return entry;
  }

  /** The best non-stale runbook for this app and ask, or null. */
  function find({ process: processName, title, task }) {
    const proc = String(processName || '').toLowerCase();
    if (!proc || !task) return null;
    const exact = get(keyFor(proc, task));
    if (exact && !exact.stale) return exact;
    let best = null;
    let bestScore = 0;
    for (const entry of data.runbooks) {
      if (entry.stale || entry.app.process !== proc) continue;
      let score = tokenOverlap(entry.task, task);
      if (title && entry.app.title && tokenOverlap(entry.app.title, title) < 0.5) score *= 0.5;
      if (score > bestScore) {
        best = entry;
        bestScore = score;
      }
    }
    return bestScore >= MATCH_MIN ? best : null;
  }

  /** A step could not be resolved by name. Two such misses retire the entry. */
  function miss(key) {
    const entry = get(key);
    if (!entry) return false;
    entry.misses = (entry.misses || 0) + 1;
    if (entry.misses >= 2) entry.stale = true;
    save();
    return entry.stale;
  }

  function markStale(key) {
    const entry = get(key);
    if (entry) {
      entry.stale = true;
      save();
    }
  }

  function forget(key) {
    const before = data.runbooks.length;
    data.runbooks = data.runbooks.filter((entry) => entry.key !== key);
    if (data.runbooks.length !== before) save();
  }

  function list() {
    return data.runbooks.map((entry) => ({
      key: entry.key,
      task: entry.task,
      app: entry.app,
      steps: entry.steps.length,
      runs: entry.runs,
      stale: Boolean(entry.stale),
      lastOk: entry.lastOk
    }));
  }

  return { record, find, miss, markStale, forget, list, get, keyFor, file };
}

module.exports = { createRunbooks, keyFor, slug, MATCH_MIN, MAX_ENTRIES };
