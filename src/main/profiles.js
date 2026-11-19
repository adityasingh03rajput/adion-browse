const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Browser profile manager.
 * Each profile maps to an isolated Chromium session partition
 * (`persist:adion-<id>`) so cookies, localStorage, and logins never leak
 * between accounts. Metadata lives in .data/profiles.json.
 */
class ProfileManager {
  constructor() {
    this.userDataPath = path.join(process.cwd(), '.data');
    this.filePath = path.join(this.userDataPath, 'profiles.json');
    this.data = { profiles: [], activeId: null };
    this.initialized = false;
  }

  init() {
    if (this.initialized) return;
    try {
      if (!fs.existsSync(this.userDataPath)) fs.mkdirSync(this.userDataPath, { recursive: true });
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        if (parsed && Array.isArray(parsed.profiles)) {
          this.data.profiles = parsed.profiles.filter(p => p && p.id && p.name);
          this.data.activeId = parsed.activeId || null;
        }
      }
    } catch (e) {
      console.error('[Profiles] Failed to load profiles:', e.message);
    }
    // Guarantee at least one profile (the existing default session data migrates naturally)
    if (this.data.profiles.length === 0) {
      this.data.profiles.push(this._createProfile('Personal'));
    }
    if (!this.data.activeId || !this.data.profiles.find(p => p.id === this.data.activeId)) {
      this.data.activeId = this.data.profiles[0].id;
    }
    this.initialized = true;
    this._save();
  }

  _createProfile(name) {
    return {
      id: 'prof_' + crypto.randomBytes(6).toString('hex'),
      name: String(name || 'Profile').slice(0, 40),
      color: ['#00f2fe', '#7c4dff', '#ff6b35', '#22c55e', '#f59e0b', '#ec4899'][Math.floor(Math.random() * 6)],
      createdAt: Date.now()
    };
  }

  _save() {
    try {
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      console.error('[Profiles] Failed to save profiles:', e.message);
    }
  }

  list() {
    this.init();
    return {
      profiles: this.data.profiles.map(p => ({ ...p, active: p.id === this.data.activeId })),
      activeId: this.data.activeId
    };
  }

  getActive() {
    this.init();
    return this.data.profiles.find(p => p.id === this.data.activeId) || this.data.profiles[0];
  }

  partitionFor(profileId) {
    this.init();
    const id = profileId || this.data.activeId;
    return `persist:adion-${id}`;
  }

  create(name) {
    this.init();
    const profile = this._createProfile(name);
    this.data.profiles.push(profile);
    this._save();
    return profile;
  }

  switch(id) {
    this.init();
    if (!this.data.profiles.find(p => p.id === id)) return null;
    this.data.activeId = id;
    this._save();
    return this.getActive();
  }

  remove(id) {
    this.init();
    if (this.data.profiles.length <= 1) return false; // never delete the last profile
    const idx = this.data.profiles.findIndex(p => p.id === id);
    if (idx === -1) return false;
    this.data.profiles.splice(idx, 1);
    if (this.data.activeId === id) this.data.activeId = this.data.profiles[0].id;
    this._save();
    return true;
  }
}

module.exports = new ProfileManager();
