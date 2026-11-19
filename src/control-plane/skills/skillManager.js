/**
 * Adion Browse - Autonomous AI Skills Engine
 * 
 * Implements Claude / Antigravity style extensible agent skills:
 * - Skill discovery from `skills/<name>/SKILL.md` or `.data/skills/<name>/SKILL.md`
 * - Frontmatter metadata parsing: name, title, description, trigger (/command), tags, enabled
 * - Specialized Markdown instructions injected directly into planner & runtime execution loops
 * - Dynamic CRUD: users can add ANY custom skill via UI modal, slash command, or filesystem
 * - Real-time file system hot-reloading when skills are added/edited on disk
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class SkillManager extends EventEmitter {
  constructor(runtime = null) {
    super();
    this.runtime = runtime;
    this.skills = new Map(); // id -> skill object
    this.skillsDir = path.join(process.cwd(), 'skills');
    this.userDataSkillsDir = path.join(process.cwd(), '.data', 'skills');
    this.statusFilePath = path.join(process.cwd(), '.data', 'skills_status.json');
    this.disabledSkillIds = new Set();
    this.watcher = null;
    this._reloadDebounce = null;
  }

  /**
   * Initialize skills directories, seed starter skills, and load all skills into memory.
   */
  init() {
    try {
      if (!fs.existsSync(this.skillsDir)) {
        fs.mkdirSync(this.skillsDir, { recursive: true });
      }
      if (!fs.existsSync(this.userDataSkillsDir)) {
        fs.mkdirSync(this.userDataSkillsDir, { recursive: true });
      }

      this._loadDisabledStatus();
      this._seedBuiltinSkills();
      this.reloadSkills();
      this._startWatcher();

      console.log(`[SkillManager] 🚀 Skills Engine online — ${this.skills.size} skill(s) active.`);
    } catch (err) {
      console.error('[SkillManager] Initialization error:', err.message);
    }
  }

  /**
   * Parse a SKILL.md file with YAML-style frontmatter and Markdown body.
   */
  parseSkillContent(content, filePath = null) {
    const raw = String(content || '');
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);

    let meta = {};
    let instructions = raw.trim();

    if (match) {
      const frontmatter = match[1];
      instructions = match[2].trim();

      const lines = frontmatter.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1) continue;

        const key = trimmed.slice(0, colonIdx).trim();
        let val = trimmed.slice(colonIdx + 1).trim();

        if (val.startsWith('[') && val.endsWith(']')) {
          val = val.slice(1, -1)
            .split(',')
            .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
            .filter(Boolean);
        } else {
          val = val.replace(/^['"]|['"]$/g, '');
          if (val === 'true' || val === 'false') {
            val = val === 'true';
          } else if (!isNaN(Number(val)) && val !== '') {
            val = Number(val);
          }
        }

        meta[key] = val;
      }
    }

    const basename = filePath ? path.basename(path.dirname(filePath)) : 'custom-skill';
    const name = (meta.name || basename).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const title = meta.title || meta.name || name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const trigger = (meta.trigger || `/${name}`).toLowerCase();
    const formattedTrigger = trigger.startsWith('/') ? trigger : `/${trigger}`;

    return {
      id: name,
      name,
      title,
      description: meta.description || 'Specialized autonomous AI capability.',
      trigger: formattedTrigger,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      author: meta.author || 'user',
      isBuiltin: Boolean(meta.isBuiltin),
      icon: meta.icon || 'zap',
      instructions: instructions || meta.description || '',
      enabled: !this.disabledSkillIds.has(name),
      path: filePath,
      updatedAt: Date.now()
    };
  }

  /**
   * Serialize skill metadata and markdown instructions back into SKILL.md format.
   */
  serializeSkill(meta, instructions) {
    let yaml = '---\n';
    const orderedKeys = ['name', 'title', 'description', 'trigger', 'tags', 'author', 'isBuiltin', 'icon'];
    
    for (const key of orderedKeys) {
      if (meta[key] !== undefined) {
        const val = meta[key];
        if (Array.isArray(val)) {
          yaml += `${key}: [${val.join(', ')}]\n`;
        } else if (typeof val === 'boolean' || typeof val === 'number') {
          yaml += `${key}: ${val}\n`;
        } else {
          yaml += `${key}: "${String(val).replace(/"/g, '\\"')}"\n`;
        }
      }
    }

    // Include any custom extra keys
    for (const [k, v] of Object.entries(meta)) {
      if (!orderedKeys.includes(k) && k !== 'instructions' && k !== 'path' && k !== 'enabled' && k !== 'id') {
        if (typeof v === 'boolean' || typeof v === 'number') {
          yaml += `${k}: ${v}\n`;
        } else {
          yaml += `${k}: "${String(v).replace(/"/g, '\\"')}"\n`;
        }
      }
    }

    yaml += '---\n\n';
    yaml += (instructions || '').trim() + '\n';
    return yaml;
  }

  /**
   * Scan disk and reload all skills from filesystem.
   */
  reloadSkills() {
    this.skills.clear();

    // 1. Load from workspace `skills/`
    this._scanDirectory(this.skillsDir);

    // 2. Load from user data `.data/skills/`
    this._scanDirectory(this.userDataSkillsDir);

    this.emit('updated', this.getAllSkills());
  }

  _scanDirectory(dir) {
    if (!fs.existsSync(dir)) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subDir = path.join(dir, entry.name);
          const skillFile = path.join(subDir, 'SKILL.md');
          if (fs.existsSync(skillFile)) {
            try {
              const content = fs.readFileSync(skillFile, 'utf8');
              const skill = this.parseSkillContent(content, skillFile);
              this.skills.set(skill.id, skill);
            } catch (err) {
              console.warn(`[SkillManager] Failed to read ${skillFile}:`, err.message);
            }
          }
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const filePath = path.join(dir, entry.name);
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            const skill = this.parseSkillContent(content, filePath);
            this.skills.set(skill.id, skill);
          } catch (err) {
            console.warn(`[SkillManager] Failed to read ${filePath}:`, err.message);
          }
        }
      }
    } catch (err) {
      console.warn(`[SkillManager] Error scanning directory ${dir}:`, err.message);
    }
  }

  /**
   * Start debounced file system watcher for real-time skill hot-reloading.
   */
  _startWatcher() {
    try {
      if (fs.existsSync(this.skillsDir)) {
        this.watcher = fs.watch(this.skillsDir, { recursive: true }, () => {
          if (this._reloadDebounce) clearTimeout(this._reloadDebounce);
          this._reloadDebounce = setTimeout(() => {
            console.log('[SkillManager] 🔄 File change detected in skills/ — reloading...');
            this.reloadSkills();
          }, 300);
        });
        if (this.watcher && typeof this.watcher.unref === 'function') {
          this.watcher.unref();
        }
      }
    } catch (e) {
      console.warn('[SkillManager] Filesystem watch notice:', e.message);
    }
  }

  destroy() {
    if (this._reloadDebounce) clearTimeout(this._reloadDebounce);
    if (this.watcher) {
      try { this.watcher.close(); } catch (_) {}
      this.watcher = null;
    }
  }

  /**
   * Return all skills as an array, sorted by title.
   */
  getAllSkills() {
    return Array.from(this.skills.values()).sort((a, b) => {
      if (a.isBuiltin && !b.isBuiltin) return -1;
      if (!a.isBuiltin && b.isBuiltin) return 1;
      return a.title.localeCompare(b.title);
    });
  }

  /**
   * Retrieve a skill by ID, name, or slash trigger.
   */
  getSkill(idOrTrigger) {
    if (!idOrTrigger) return null;
    const clean = String(idOrTrigger).trim().toLowerCase();

    // Check direct ID or name
    if (this.skills.has(clean)) {
      return this.skills.get(clean);
    }

    // Check trigger (with or without /)
    const trigger = clean.startsWith('/') ? clean : `/${clean}`;
    for (const skill of this.skills.values()) {
      if (skill.trigger.toLowerCase() === trigger || skill.name.toLowerCase() === clean) {
        return skill;
      }
    }

    return null;
  }

  /**
   * Check if user input starts with any active skill's slash trigger or command.
   * Returns { skill, query } or null.
   */
  findMatchingSkill(rawInput) {
    if (!rawInput) return null;
    const text = String(rawInput).trim();

    // Direct /skill or /skills command
    if (/^\/skills?\b/i.test(text)) {
      return null; // Handled as meta-skill command
    }

    // Match leading slash trigger
    const match = text.match(/^\/([a-zA-Z0-9_\-]+)(?:\s+([\s\S]*))?$/);
    if (match) {
      const trigger = `/${match[1].toLowerCase()}`;
      const query = (match[2] || '').trim();

      for (const skill of this.skills.values()) {
        if (skill.enabled && skill.trigger.toLowerCase() === trigger) {
          return { skill, query };
        }
      }
    }

    return null;
  }

  /**
   * Create a new custom skill and save it as `skills/<name>/SKILL.md`.
   */
  createSkill(skillData) {
    if (!skillData || typeof skillData !== 'object') {
      throw new Error('Invalid skill data payload');
    }

    const rawName = skillData.name || skillData.title || `skill-${Date.now()}`;
    const name = rawName.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
    if (!name) throw new Error('Skill name cannot be empty');

    const title = (skillData.title || name).trim();
    const rawTrigger = (skillData.trigger || `/${name}`).trim().toLowerCase();
    const trigger = rawTrigger.startsWith('/') ? rawTrigger : `/${rawTrigger}`;
    const description = (skillData.description || 'Custom autonomous AI skill').trim();
    const instructions = (skillData.instructions || '').trim();
    const tags = Array.isArray(skillData.tags) ? skillData.tags : ['custom'];
    const icon = skillData.icon || 'zap';

    const skillDir = path.join(this.skillsDir, name);
    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true });
    }

    const skillFilePath = path.join(skillDir, 'SKILL.md');
    const meta = {
      name,
      title,
      description,
      trigger,
      tags,
      author: 'user',
      isBuiltin: false,
      icon
    };

    const fileContent = this.serializeSkill(meta, instructions);
    fs.writeFileSync(skillFilePath, fileContent, 'utf8');

    this.disabledSkillIds.delete(name);
    this._saveDisabledStatus();

    const createdSkill = this.parseSkillContent(fileContent, skillFilePath);
    this.skills.set(createdSkill.id, createdSkill);
    this.emit('updated', this.getAllSkills());

    console.log(`[SkillManager] ✨ Created new AI Skill: ${title} (${trigger}) at ${skillFilePath}`);
    return createdSkill;
  }

  /**
   * Update an existing skill's metadata and markdown directives.
   */
  updateSkill(id, updates = {}) {
    const existing = this.getSkill(id);
    if (!existing) {
      throw new Error(`Skill "${id}" not found.`);
    }

    const meta = {
      name: existing.name,
      title: updates.title !== undefined ? updates.title : existing.title,
      description: updates.description !== undefined ? updates.description : existing.description,
      trigger: updates.trigger !== undefined ? (updates.trigger.startsWith('/') ? updates.trigger : `/${updates.trigger}`) : existing.trigger,
      tags: updates.tags !== undefined ? updates.tags : existing.tags,
      author: existing.author,
      isBuiltin: existing.isBuiltin,
      icon: updates.icon !== undefined ? updates.icon : existing.icon
    };

    const instructions = updates.instructions !== undefined ? updates.instructions : existing.instructions;
    const targetPath = existing.path || path.join(this.skillsDir, existing.name, 'SKILL.md');

    // Ensure parent directory exists
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const fileContent = this.serializeSkill(meta, instructions);
    fs.writeFileSync(targetPath, fileContent, 'utf8');

    const updated = this.parseSkillContent(fileContent, targetPath);
    this.skills.set(updated.id, updated);
    this.emit('updated', this.getAllSkills());

    console.log(`[SkillManager] 📝 Updated AI Skill: ${updated.title} (${updated.trigger})`);
    return updated;
  }

  /**
   * Delete a skill from disk (only allowed for user skills).
   */
  deleteSkill(id) {
    const skill = this.getSkill(id);
    if (!skill) throw new Error(`Skill "${id}" not found.`);

    if (skill.isBuiltin) {
      // For built-in skills, toggle disable instead of deleting source
      return this.toggleSkill(id, false);
    }

    if (skill.path && fs.existsSync(skill.path)) {
      try {
        const dir = path.dirname(skill.path);
        if (path.basename(dir) === skill.name) {
          fs.rmSync(dir, { recursive: true, force: true });
        } else {
          fs.unlinkSync(skill.path);
        }
      } catch (err) {
        console.warn(`[SkillManager] Error deleting skill file:`, err.message);
      }
    }

    this.disabledSkillIds.delete(skill.id);
    this._saveDisabledStatus();
    this.skills.delete(skill.id);
    this.emit('updated', this.getAllSkills());
    console.log(`[SkillManager] 🗑️ Deleted AI Skill: ${skill.title}`);
    return { success: true, id: skill.id };
  }

  /**
   * Toggle a skill enabled or disabled.
   */
  toggleSkill(id, enabledState = null) {
    const skill = this.getSkill(id);
    if (!skill) throw new Error(`Skill "${id}" not found.`);

    const willEnable = enabledState !== null ? Boolean(enabledState) : !skill.enabled;
    if (willEnable) {
      this.disabledSkillIds.delete(skill.id);
    } else {
      this.disabledSkillIds.add(skill.id);
    }

    skill.enabled = willEnable;
    this._saveDisabledStatus();
    this.emit('updated', this.getAllSkills());

    console.log(`[SkillManager] ⚡ Skill "${skill.title}" is now ${willEnable ? 'ENABLED' : 'DISABLED'}`);
    return { success: true, id: skill.id, enabled: willEnable };
  }

  /**
   * Import and install skills from a URL, raw Markdown link, or GitHub repository.
   * - If given a direct .md URL (e.g. Gist, raw URL), downloads and registers the skill directly.
   * - If given a GitHub repository, searches for SKILL.md definitions or synthesizes from README.
   */
  async importFromSource(sourceUrl) {
    if (!sourceUrl) throw new Error('Source URL or repository required');
    const clean = String(sourceUrl).trim();

    // 1. Direct Markdown URL import
    if (/^https?:\/\/.*\.md(\?.*)?$/i.test(clean)) {
      console.log(`[SkillManager] 🌐 Downloading direct skill definition from ${clean}...`);
      const res = await fetch(clean);
      if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to fetch ${clean}`);
      const content = await res.text();
      const parsed = this.parseSkillContent(content);
      const skillDir = path.join(this.skillsDir, parsed.name);
      if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
      const targetPath = path.join(skillDir, 'SKILL.md');
      fs.writeFileSync(targetPath, content, 'utf8');
      this.reloadSkills();
      return {
        success: true,
        source: clean,
        count: 1,
        skills: [this.getSkill(parsed.id) || parsed]
      };
    }

    // 2. GitHub repository import
    return this.importFromGitHub(clean);
  }

  /**
   * Import and install skills directly from a GitHub repository or URL.
   * Auto-detects SKILL.md files inside the repository (e.g. .agents/skills/ or skills/)
   * or synthesizes a skill from the repository's README.
   */
  async importFromGitHub(urlOrRepo) {
    if (!urlOrRepo) throw new Error('Repository URL or owner/repo required');

    // Parse owner and repo
    const clean = String(urlOrRepo).trim().replace(/\/+$/, '');
    const ghMatch = clean.match(/(?:github\.com\/|^)([a-zA-Z0-9_\-\.]+)\/([a-zA-Z0-9_\-\.]+)/i);
    if (!ghMatch) {
      throw new Error(`Invalid GitHub repository format: "${urlOrRepo}". Expected https://github.com/owner/repo or owner/repo`);
    }

    const owner = ghMatch[1];
    const repo = ghMatch[2].replace(/\.git$/i, '');

    console.log(`[SkillManager] 🌐 Fetching skills from GitHub repository: ${owner}/${repo}...`);

    let branch = 'main';
    let tree = null;

    try {
      const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`, {
        headers: { 'User-Agent': 'Adion-Browse' }
      });
      if (treeRes.ok) {
        const data = await treeRes.json();
        tree = data.tree || [];
      } else {
        // Fallback to master branch
        branch = 'master';
        const fallbackRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/master?recursive=1`, {
          headers: { 'User-Agent': 'Adion-Browse' }
        });
        if (fallbackRes.ok) {
          const data = await fallbackRes.json();
          tree = data.tree || [];
        }
      }
    } catch (e) {
      console.warn('[SkillManager] GitHub API tree fetch notice:', e.message);
    }

    // 1. Check if the repository contains pre-defined SKILL.md files
    const skillFiles = (tree || []).filter(f => f.path.endsWith('/SKILL.md') || f.path === 'SKILL.md');
    const importedSkills = [];
    const seenNames = new Set();

    if (skillFiles.length > 0) {
      for (const item of skillFiles) {
        try {
          const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${item.path}`;
          const res = await fetch(rawUrl);
          if (res.ok) {
            const content = await res.text();
            let skill = this.parseSkillContent(content, item.path);
            if (seenNames.has(skill.name)) continue;
            seenNames.add(skill.name);

            // Ensure unique, clean folder and trigger
            const skillDir = path.join(this.skillsDir, skill.name);
            if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });

            const targetPath = path.join(skillDir, 'SKILL.md');
            fs.writeFileSync(targetPath, content, 'utf8');

            skill = this.parseSkillContent(content, targetPath);
            this.skills.set(skill.id, skill);
            importedSkills.push(skill);
            console.log(`[SkillManager] ✅ Imported skill "${skill.title}" (${skill.trigger}) from ${owner}/${repo}`);
          }
        } catch (err) {
          console.warn(`[SkillManager] Error importing skill file ${item.path}:`, err.message);
        }
      }
    }

    // 2. If no SKILL.md found, synthesize a skill from the repo's README
    if (importedSkills.length === 0) {
      try {
        const readmeRes = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`);
        let readmeContent = '';
        if (readmeRes.ok) {
          readmeContent = await readmeRes.text();
        }

        let repoDesc = '';
        try {
          const repoInfoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
            headers: { 'User-Agent': 'Adion-Browse' }
          });
          if (repoInfoRes.ok) {
            const repoData = await repoInfoRes.json();
            repoDesc = repoData.description || '';
          }
        } catch (_) {}

        const skillName = repo.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        const skillTitle = repo.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const skillTrigger = `/${skillName}`;
        const description = repoDesc || `Tool & capability from https://github.com/${owner}/${repo}`;

        const instructions = `# ${skillTitle} (${owner}/${repo}) Instructions\n` +
          `You have the ${skillTitle} capability installed from https://github.com/${owner}/${repo}.\n\n` +
          `## Project Overview & Directives:\n` +
          (readmeContent.slice(0, 3000) || `Use this tool when operating on tasks related to ${skillTitle}.`);

        const created = this.createSkill({
          name: skillName,
          title: skillTitle,
          trigger: skillTrigger,
          description,
          instructions,
          tags: [owner, repo, 'github-import'],
          icon: 'zap'
        });

        importedSkills.push(created);
        console.log(`[SkillManager] ✨ Synthesized skill "${skillTitle}" (${skillTrigger}) from README`);
      } catch (err) {
        throw new Error(`Failed to import from GitHub ${owner}/${repo}: ${err.message}`);
      }
    }

    this.reloadSkills();
    return {
      success: true,
      owner,
      repo,
      count: importedSkills.length,
      skills: importedSkills
    };
  }

  _loadDisabledStatus() {
    try {
      if (fs.existsSync(this.statusFilePath)) {
        const raw = fs.readFileSync(this.statusFilePath, 'utf8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          this.disabledSkillIds = new Set(list);
        }
      }
    } catch (_) {}
  }

  _saveDisabledStatus() {
    try {
      fs.writeFileSync(this.statusFilePath, JSON.stringify(Array.from(this.disabledSkillIds), null, 2), 'utf8');
    } catch (_) {}
  }

  /**
   * Seed high-performance built-in skills if they do not yet exist in `skills/`.
   */
  _seedBuiltinSkills() {
    const defaults = [
      {
        name: 'deep-research',
        title: 'Deep Web Researcher',
        trigger: '/research',
        description: 'Systematically explore, cross-reference, and synthesize deep web intelligence across multiple sources.',
        tags: ['research', 'intelligence', 'synthesis', 'web'],
        icon: 'search',
        isBuiltin: true,
        instructions: `# Deep Web Researcher Instructions
You are an expert autonomous intelligence analyst. When this skill is active:
1. FORMULATE DIVERSE QUERIES: Never settle for one single search. Formulate 2-4 distinct keyword queries covering different angles, counter-arguments, and recent developments.
2. SYSTEMATIC EXPLORATION: Navigate through top authoritative results. Inspect page contents thoroughly, extract primary facts, figures, publication dates, and citations.
3. CROSS-REFERENCE CLAIMS: Compare claims across distinct domains. Highlight consensus, flag discrepancies, and discard unsubstantiated marketing hype.
4. STRUCTURED SYNTHESIS: In your final thought and report:
   - Executive Briefing (concise thesis)
   - Key Empirical Findings & Data Points
   - Comparative Perspectives & Counter-Arguments
   - Source Citations & Recommended Next Actions
5. INTEGRITY: Never hallucinate sources. If data is contradictory or unavailable, declare it transparently.`
      },
      {
        name: 'page-summary',
        title: 'Cognitive Page Summarizer',
        trigger: '/summarize',
        description: 'Extract core insights, executive takeaways, key facts, and action items from the current webpage.',
        tags: ['summary', 'takeaways', 'reading', 'content'],
        icon: 'book',
        isBuiltin: true,
        instructions: `# Cognitive Page Summarizer Instructions
When summarizing the active webpage:
1. COMPREHENSIVE EXTRACTION: Read the full visible page content, including headings, article body, data tables, and conclusion.
2. CORE THESIS: State the main proposition or thesis in 1-2 punchy sentences.
3. HIGH-DENSITY KEY TAKEAWAYS: Present 4-6 bullet points covering critical insights, numbers, dates, or decisions.
4. ACTION ITEMS & RELEVANCE: Conclude with practical next steps or relevance to the user's workflow.
5. NO FLUFF: Skip conversational filler, intros, or generic disclaimers. Provide pure, high-signal information.`
      },
      {
        name: 'data-extractor',
        title: 'Structured Data Extractor',
        trigger: '/extract',
        description: 'Scrape and convert page tables, product listings, prices, or datasets into structured JSON or Markdown tables.',
        tags: ['data', 'scraping', 'json', 'tables'],
        icon: 'database',
        isBuiltin: true,
        instructions: `# Structured Data Extractor Instructions
When extracting structured data from the active webpage:
1. IDENTIFY REPEATING ENTITIES: Scan DOM and interactive scene for cards, table rows, pricing grids, or list items.
2. NORMALIZE SCHEMA: Identify column headers or attribute keys (e.g. Title, Price, Rating, URL, Description, Availability).
3. CLEAN EXTRACTION: Strip CSS noise, trailing currency symbols, and whitespace artifacts.
4. OUTPUT FORMAT: Format results in a clean Markdown Table AND emit a structured JSON payload in your response.
5. PAGINATION AWARENESS: If the table has pagination, note how many entries are visible on the current page.`
      },
      {
        name: 'price-tracker',
        title: 'E-Commerce Price & Deal Tracker',
        trigger: '/price',
        description: 'Compare prices, find hidden discounts, inspect seller ratings, and verify deal legitimacy across shopping sites.',
        tags: ['shopping', 'deals', 'price', 'ecommerce'],
        icon: 'tag',
        isBuiltin: true,
        instructions: `# E-Commerce Price & Deal Tracker Instructions
When analyzing product pricing and deals:
1. EXACT PRODUCT MATCHING: Verify model numbers, storage/spec variants, and product identity to prevent comparing mismatched goods.
2. PRICE DECOMPOSITION: Extract the listed price, original MSRP, discount percentage, shipping fees, import duties, and coupon codes.
3. SELLER TRUST SCORE: Check seller name, rating percentage, return policy, and delivery timeframe.
4. COMPARATIVE VERDICT: Provide a clear verdict:
   - "Great Deal" / "Standard Price" / "Overpriced"
   - Price trend analysis if historical data is visible on page
   - Direct link to lowest verified legitimate option.`
      },
      {
        name: 'code-reviewer',
        title: 'Code & PR Reviewer',
        trigger: '/review',
        description: 'Inspect repository code, pull requests, and diffs on GitHub/GitLab for bugs, security risks, and clean architecture.',
        tags: ['code', 'github', 'review', 'security'],
        icon: 'code',
        isBuiltin: true,
        instructions: `# Code & PR Reviewer Instructions
When reviewing code or pull requests on GitHub, GitLab, or local files:
1. ARCHITECTURAL SANITY: Check for separation of concerns, DRY principles, and proper error handling.
2. SECURITY & BOUNDARIES: Scrutinize input validation, injection risks, credential exposure, and race conditions.
3. EDGE CASES & RUNWAY: Identify unhandled nulls, memory leaks, unclosed resources, and promise rejection leaks.
4. ACTIONABLE FEEDBACK: For every issue identified, provide:
   - Specific file & line reference
   - Why it is a problem
   - A drop-in, copy-pasteable code replacement.`
      },
      {
        name: 'form-autofill',
        title: 'Intelligent Form Autofill',
        trigger: '/autofill',
        description: 'Detect and sequentially fill multi-field forms, checkouts, and applications with semantic field grounding.',
        tags: ['forms', 'automation', 'inputs'],
        icon: 'edit',
        isBuiltin: true,
        instructions: `# Intelligent Form Autofill Instructions
When autofilling forms or multi-step checkout dialogs:
1. MAP ALL FIELDS: Inspect labels, placeholders, input types, and aria-attributes across standard DOM and Shadow DOM.
2. SEQUENTIAL DISPATCH: Emit INPUT_TEXT actions field-by-field. Never skip required fields.
3. CONTROLLED COMPONENT RESPECT: Dispatch real hardware keystrokes and change events so framework state machines update.
4. NO BLIND SUBMISSION: Never click the final submit/purchase button if required fields are still empty or validation errors show.`
      },
      {
        name: 'computer-use',
        title: 'Local PC & Workspace Assistant',
        trigger: '/pc_use',
        description: 'Execute terminal commands, inspect files, build projects, and diagnose system status on the host PC.',
        tags: ['terminal', 'pc', 'workspace', 'powershell'],
        icon: 'terminal',
        isBuiltin: true,
        instructions: `# Local PC & Workspace Assistant Instructions
When operating on the host PC or local workspace:
1. ENVIRONMENT RESPECT: Adapt commands specifically to the host OS and shell (PowerShell on Windows, Bash on Linux/macOS).
2. NO FAKE COMPLETION: Only claim a command succeeded if verified by terminal exit code 0 and actual output.
3. MULTI-STEP LOGIC: If a previous command checked for existence and returned empty, execute the creation step immediately.
4. CLEAN WORKING TREE: Avoid creating unnecessary temporary clutter. Clean up scratch scripts.`
      }
    ];

    for (const def of defaults) {
      const skillDir = path.join(this.skillsDir, def.name);
      const skillFile = path.join(skillDir, 'SKILL.md');

      if (!fs.existsSync(skillFile)) {
        try {
          if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
          const content = this.serializeSkill(def, def.instructions);
          fs.writeFileSync(skillFile, content, 'utf8');
        } catch (e) {
          console.warn(`[SkillManager] Failed to seed built-in skill ${def.name}:`, e.message);
        }
      }
    }
  }
}

module.exports = SkillManager;
