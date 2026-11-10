// Adion Browse - Renderer Chrome Controller
document.addEventListener('DOMContentLoaded', () => {
  const tabsContainer = document.getElementById('tabsContainer');
  const newTabBtn = document.getElementById('newTabBtn');
  const btnBack = document.getElementById('btnBack');
  const btnForward = document.getElementById('btnForward');
  const btnReload = document.getElementById('btnReload');
  const btnHome = document.getElementById('btnHome');
  const omniboxInput = document.getElementById('omniboxInput');
  const btnBookmark = document.getElementById('btnBookmark');
  const btnShield = document.getElementById('btnShield');
  const shieldBadge = document.getElementById('shieldBadge');
  const btnBookmarksMenu = document.getElementById('btnBookmarksMenu');
  const btnHistory = document.getElementById('btnHistory');
  const btnSettings = document.getElementById('btnSettings');
  const btnDevTools = document.getElementById('btnDevTools');

  // Modals & Popups
  const shieldsOverlay = document.getElementById('shieldsOverlay');
  const btnCloseShields = document.getElementById('btnCloseShields');
  const shieldSiteDomain = document.getElementById('shieldSiteDomain');
  const shieldStatusText = document.getElementById('shieldStatusText');
  const mainShieldToggle = document.getElementById('mainShieldToggle');
  const siteBlockedCount = document.getElementById('siteBlockedCount');
  const blockScriptsToggle = document.getElementById('blockScriptsToggle');
  const lifetimeStatsText = document.getElementById('lifetimeStatsText');

  const bookmarksModal = document.getElementById('bookmarksModal');
  const btnCloseBookmarks = document.getElementById('btnCloseBookmarks');
  const bookmarksList = document.getElementById('bookmarksList');

  const historyModal = document.getElementById('historyModal');
  const btnCloseHistory = document.getElementById('btnCloseHistory');
  const historyList = document.getElementById('historyList');
  const historySearchInput = document.getElementById('historySearchInput');
  const btnClearHistory = document.getElementById('btnClearHistory');

  const settingsModal = document.getElementById('settingsModal');
  const btnCloseSettings = document.getElementById('btnCloseSettings');
  const settingSearchEngine = document.getElementById('settingSearchEngine');
  const settingShieldsDefault = document.getElementById('settingShieldsDefault');
  const settingUpgradeHttps = document.getElementById('settingUpgradeHttps');

  let currentTabs = [];
  let currentActiveTabId = null;
  let currentActiveUrl = '';
  let currentActiveTitle = '';
  let currentDomain = '';

  // --- TABS RENDERING ---
  function renderTabs(tabs, activeId) {
    currentTabs = tabs;
    currentActiveTabId = activeId;
    tabsContainer.innerHTML = '';

    tabs.forEach(tab => {
      const tabEl = document.createElement('div');
      tabEl.className = `tab-item ${tab.id === activeId ? 'active' : ''}`;
      tabEl.title = tab.title || 'New Tab';

      if (tab.isLoading) {
        const spinner = document.createElement('div');
        spinner.className = 'tab-spinner';
        tabEl.appendChild(spinner);
      } else if (tab.favicon) {
        const img = document.createElement('img');
        img.className = 'tab-favicon';
        img.src = tab.favicon;
        img.onerror = () => {
          img.replaceWith(createFaviconPlaceholder());
        };
        tabEl.appendChild(img);
      } else {
        tabEl.appendChild(createFaviconPlaceholder());
      }

      const titleEl = document.createElement('span');
      titleEl.className = 'tab-title';
      titleEl.textContent = tab.title || 'New Tab';
      tabEl.appendChild(titleEl);

      const closeEl = document.createElement('span');
      closeEl.className = 'tab-close';
      closeEl.innerHTML = '&times;';
      closeEl.title = 'Close Tab';
      closeEl.addEventListener('click', (e) => {
        e.stopPropagation();
        window.adionAPI.closeTab(tab.id);
      });
      tabEl.appendChild(closeEl);

      tabEl.addEventListener('click', () => {
        window.adionAPI.switchTab(tab.id);
      });

      tabsContainer.appendChild(tabEl);
    });
  }

  function createFaviconPlaceholder() {
    const div = document.createElement('div');
    div.className = 'tab-favicon-placeholder';
    div.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="2" y1="12" x2="22" y2="12"></line>
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
      </svg>
    `;
    return div;
  }

  // --- TAB UPDATES ---
  window.adionAPI.onTabsListUpdated(({ tabs, activeTabId }) => {
    renderTabs(tabs, activeTabId);
  });

  window.adionAPI.onTabUpdated((tab) => {
    if (tab.id === currentActiveTabId) {
      currentActiveUrl = tab.url;
      currentActiveTitle = tab.title;

      // Update Omnibox display
      if (document.activeElement !== omniboxInput) {
        if (tab.url === 'adion://newtab') {
          omniboxInput.value = '';
          currentDomain = '';
        } else {
          omniboxInput.value = tab.url;
          try {
            currentDomain = new URL(tab.url).hostname;
          } catch (e) {
            currentDomain = '';
          }
        }
      }

      // Update Navigation button states
      btnBack.disabled = !tab.canGoBack;
      btnForward.disabled = !tab.canGoForward;

      // Update Bookmark Star status
      if (tab.isBookmarked) {
        btnBookmark.classList.add('bookmarked');
      } else {
        btnBookmark.classList.remove('bookmarked');
      }

      // Update Reload / Stop icon
      const reloadIcon = document.getElementById('reloadIcon');
      if (tab.isLoading) {
        reloadIcon.innerHTML = `
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        `;
      } else {
        reloadIcon.innerHTML = `
          <polyline points="23 4 23 10 17 10"></polyline>
          <polyline points="1 20 1 14 7 14"></polyline>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
        `;
      }
    }

    // Refresh tabs header
    const tabItem = currentTabs.find(t => t.id === tab.id);
    if (tabItem) {
      tabItem.title = tab.title;
      tabItem.favicon = tab.favicon;
      tabItem.isLoading = tab.isLoading;
      renderTabs(currentTabs, currentActiveTabId);
    }
  });

  // --- SHIELD STATS UPDATE ---
  window.adionAPI.onShieldStatsUpdate(({ tabId, stats }) => {
    if (tabId === currentActiveTabId) {
      const count = stats.blockedCount || 0;
      shieldBadge.textContent = count > 99 ? '99+' : count;
      siteBlockedCount.textContent = count;
      shieldBadge.style.display = count > 0 ? 'inline-block' : 'inline-block';
    }
  });

  // --- NAVIGATION CONTROLS ---
  newTabBtn.addEventListener('click', () => {
    window.adionAPI.newTab();
  });

  btnBack.addEventListener('click', () => {
    window.adionAPI.goBack();
  });

  btnForward.addEventListener('click', () => {
    window.adionAPI.goForward();
  });

  btnReload.addEventListener('click', () => {
    window.adionAPI.reload();
  });

  btnHome.addEventListener('click', () => {
    window.adionAPI.navigate('adion://newtab');
  });

  // Omnibox submit
  omniboxInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const val = omniboxInput.value.trim();
      if (val) {
        window.adionAPI.navigate(val);
      }
    }
  });

  omniboxInput.addEventListener('focus', () => {
    omniboxInput.select();
  });

  // Bookmarking
  btnBookmark.addEventListener('click', async () => {
    if (!currentActiveUrl || currentActiveUrl === 'adion://newtab') return;
    const res = await window.adionAPI.toggleBookmark(currentActiveTitle, currentActiveUrl);
    if (res.isBookmarked) {
      btnBookmark.classList.add('bookmarked');
    } else {
      btnBookmark.classList.remove('bookmarked');
    }
  });

  // --- SHIELDS POPUP CONTROLLER ---
  btnShield.addEventListener('click', async () => {
    if (shieldsOverlay.classList.contains('show')) {
      shieldsOverlay.classList.remove('show');
      return;
    }

    // Load shields state for current domain
    shieldSiteDomain.textContent = currentDomain || 'Internal Page';

    if (!currentDomain) {
      shieldStatusText.textContent = 'Adion Shields are active';
      mainShieldToggle.checked = true;
      siteBlockedCount.textContent = '0';
    } else {
      const data = await window.adionAPI.getShieldsState(currentDomain);
      mainShieldToggle.checked = data.siteShield.enabled;
      blockScriptsToggle.checked = data.siteShield.blockScripts || false;
      shieldStatusText.textContent = data.siteShield.enabled
        ? 'Shields are UP for this site'
        : 'Shields are DOWN for this site';
      lifetimeStatsText.textContent = `Lifetime: ${data.stats.totalBlocked} trackers & ads blocked`;
    }

    shieldsOverlay.classList.add('show');
  });

  btnCloseShields.addEventListener('click', () => {
    shieldsOverlay.classList.remove('show');
  });

  mainShieldToggle.addEventListener('change', async () => {
    if (!currentDomain) return;
    const enabled = mainShieldToggle.checked;
    await window.adionAPI.toggleSiteShield(currentDomain, enabled);
    shieldStatusText.textContent = enabled
      ? 'Shields are UP for this site'
      : 'Shields are DOWN for this site';
  });

  blockScriptsToggle.addEventListener('change', async () => {
    if (!currentDomain) return;
    const blockScripts = blockScriptsToggle.checked;
    await window.adionAPI.toggleSiteScripts(currentDomain, blockScripts);
  });

  // --- BOOKMARKS MODAL ---
  btnBookmarksMenu.addEventListener('click', async () => {
    const bookmarks = await window.adionAPI.getBookmarks();
    renderBookmarks(bookmarks);
    bookmarksModal.classList.add('show');
  });

  btnCloseBookmarks.addEventListener('click', () => {
    bookmarksModal.classList.remove('show');
  });

  function renderBookmarks(bookmarks) {
    bookmarksList.innerHTML = '';
    if (!bookmarks || bookmarks.length === 0) {
      bookmarksList.innerHTML = '<li style="color:var(--text-muted); font-size:13px; text-align:center;">No bookmarks yet.</li>';
      return;
    }
    bookmarks.forEach(bm => {
      const li = document.createElement('li');
      li.className = 'list-row';
      li.innerHTML = `
        <div class="list-row-info">
          <span class="list-row-title">${bm.title}</span>
          <span class="list-row-url">${bm.url}</span>
        </div>
      `;
      li.addEventListener('click', () => {
        window.adionAPI.navigate(bm.url);
        bookmarksModal.classList.remove('show');
      });
      bookmarksList.appendChild(li);
    });
  }

  // --- HISTORY MODAL ---
  btnHistory.addEventListener('click', async () => {
    const history = await window.adionAPI.getHistory();
    renderHistory(history);
    historyModal.classList.add('show');
  });

  btnCloseHistory.addEventListener('click', () => {
    historyModal.classList.remove('show');
  });

  btnClearHistory.addEventListener('click', async () => {
    await window.adionAPI.clearHistory();
    renderHistory([]);
  });

  function renderHistory(items) {
    historyList.innerHTML = '';
    if (!items || items.length === 0) {
      historyList.innerHTML = '<li style="color:var(--text-muted); font-size:13px; text-align:center;">No browsing history yet.</li>';
      return;
    }
    items.forEach(h => {
      const li = document.createElement('li');
      li.className = 'list-row';
      li.innerHTML = `
        <div class="list-row-info">
          <span class="list-row-title">${h.title}</span>
          <span class="list-row-url">${h.url}</span>
        </div>
      `;
      li.addEventListener('click', () => {
        window.adionAPI.navigate(h.url);
        historyModal.classList.remove('show');
      });
      historyList.appendChild(li);
    });
  }

  historySearchInput.addEventListener('input', async () => {
    const query = historySearchInput.value.toLowerCase();
    const history = await window.adionAPI.getHistory();
    const filtered = history.filter(h => (h.title && h.title.toLowerCase().includes(query)) || (h.url && h.url.toLowerCase().includes(query)));
    renderHistory(filtered);
  });

  // --- SETTINGS MODAL ---
  btnSettings.addEventListener('click', async () => {
    const settings = await window.adionAPI.getSettings();
    settingSearchEngine.value = settings.searchEngine || 'brave';
    settingShieldsDefault.checked = settings.shieldsEnabled !== false;
    settingUpgradeHttps.checked = settings.upgradeHttps !== false;
    settingsModal.classList.add('show');
  });

  btnCloseSettings.addEventListener('click', () => {
    settingsModal.classList.remove('show');
  });

  settingSearchEngine.addEventListener('change', async () => {
    await window.adionAPI.updateSetting('searchEngine', settingSearchEngine.value);
  });

  settingShieldsDefault.addEventListener('change', async () => {
    await window.adionAPI.updateSetting('shieldsEnabled', settingShieldsDefault.checked);
  });

  settingUpgradeHttps.addEventListener('change', async () => {
    await window.adionAPI.updateSetting('upgradeHttps', settingUpgradeHttps.checked);
  });

  // --- DEVTOOLS TOGGLE ---
  btnDevTools.addEventListener('click', () => {
    window.adionAPI.toggleDevTools();
  });

  // Close overlays on clicking outside
  window.addEventListener('click', (e) => {
    if (shieldsOverlay.classList.contains('show') && !shieldsOverlay.contains(e.target) && !btnShield.contains(e.target)) {
      shieldsOverlay.classList.remove('show');
    }
    if (bookmarksModal.classList.contains('show') && e.target === bookmarksModal) {
      bookmarksModal.classList.remove('show');
    }
    if (historyModal.classList.contains('show') && e.target === historyModal) {
      historyModal.classList.remove('show');
    }
    if (settingsModal.classList.contains('show') && e.target === settingsModal) {
      settingsModal.classList.remove('show');
    }
  });

  // Global Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.code === 'Space') {
      e.preventDefault();
      toggleVoiceAgent();
    } else if (e.ctrlKey && e.key === 't') {
      e.preventDefault();
      window.adionAPI.newTab();
    } else if (e.ctrlKey && e.key === 'w') {
      e.preventDefault();
      if (currentActiveTabId) window.adionAPI.closeTab(currentActiveTabId);
    } else if (e.ctrlKey && e.key === 'r') {
      e.preventDefault();
      window.adionAPI.reload();
    } else if (e.ctrlKey && e.key === 'l') {
      e.preventDefault();
      omniboxInput.focus();
      omniboxInput.select();
    } else if (e.ctrlKey && e.key === 'h') {
      e.preventDefault();
      btnHistory.click();
    } else if (e.key === 'F12') {
      e.preventDefault();
      window.adionAPI.toggleDevTools();
    }
  });

  // --- AI VOICE CONTROL PLANE & AGENT HUD ---
  const btnVoiceAgent = document.getElementById('btnVoiceAgent');
  const agentHudOverlay = document.getElementById('agentHudOverlay');
  const agentHudState = document.getElementById('agentHudState');
  const agentHudMessage = document.getElementById('agentHudMessage');
  const agentHudPulse = document.getElementById('agentHudPulse');
  const agentTranscriptPreview = document.getElementById('agentTranscriptPreview');
  const btnCancelAgent = document.getElementById('btnCancelAgent');

  let isListening = false;
  let recognition = null;
  let hudHideTimeout = null;

  // Initialize Web Speech Recognition if supported by Chromium
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    try {
      recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onstart = () => {
        isListening = true;
        btnVoiceAgent.classList.add('listening');
        showAgentHud('LISTENING', 'Listening to voice command...', true);
        window.adionAPI.agent.startVoice();
      };

      recognition.onresult = (event) => {
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          transcript += event.results[i][0].transcript;
        }
        agentTranscriptPreview.innerText = `"${transcript}"`;
        agentTranscriptPreview.classList.add('has-text');

        if (event.results[0].isFinal) {
          showAgentHud('PROCESSING', `Heard: "${transcript}"`);
          window.adionAPI.agent.stopVoice(transcript);
        }
      };

      recognition.onerror = (event) => {
        console.warn('[Voice Recognition]', event.error);
        stopListening();
        if (event.error === 'not-allowed') {
          showAgentHud('ERROR', 'Microphone permission required');
        }
      };

      recognition.onend = () => {
        stopListening();
      };
    } catch (e) {
      console.warn('Speech recognition init error:', e);
    }
  }

  function showAgentHud(stateText, message, isListeningMode = false) {
    if (hudHideTimeout) clearTimeout(hudHideTimeout);
    agentHudOverlay.classList.add('visible');
    agentHudState.innerText = stateText;
    agentHudMessage.innerText = message;

    agentHudPulse.className = 'agent-hud-pulse';
    if (isListeningMode) {
      agentHudPulse.classList.add('listening');
    } else if (stateText === 'EXECUTING_ACTION' || stateText === 'PROCESSING') {
      agentHudPulse.classList.add('executing');
    }

    if (!isListeningMode && stateText !== 'EXECUTING_ACTION') {
      hudHideTimeout = setTimeout(() => {
        agentHudOverlay.classList.remove('visible');
        agentTranscriptPreview.classList.remove('has-text');
      }, 4000);
    }
  }

  function stopListening() {
    isListening = false;
    btnVoiceAgent.classList.remove('listening');
    if (recognition) {
      try { recognition.stop(); } catch(e){}
    }
  }

  function toggleVoiceAgent() {
    if (isListening) {
      stopListening();
      window.adionAPI.agent.cancelTask();
      showAgentHud('IDLE', 'Voice listening stopped');
    } else {
      if (recognition) {
        try {
          recognition.start();
        } catch (err) {
          promptManualCommand();
        }
      } else {
        // Fallback for typed natural language command
        promptManualCommand();
      }
    }
  }

  function promptManualCommand() {
    const cmd = prompt('AI Agent Command (e.g. "scroll down", "open youtube", "click search", "close tab"):');
    if (cmd && cmd.trim()) {
      showAgentHud('PARSING', `Executing: "${cmd}"`);
      window.adionAPI.agent.sendCommand(cmd.trim());
    }
  }

  if (btnVoiceAgent) {
    btnVoiceAgent.addEventListener('click', () => {
      toggleVoiceAgent();
    });
  }

  if (btnCancelAgent) {
    btnCancelAgent.addEventListener('click', () => {
      stopListening();
      window.adionAPI.agent.cancelTask();
      agentHudOverlay.classList.remove('visible');
    });
  }

  // Bind Decoupled Control Plane Event Listeners
  if (window.adionAPI && window.adionAPI.agent) {
    window.adionAPI.agent.onStateChange((data) => {
      showAgentHud(data.state, `State: ${data.state}`);
    });

    window.adionAPI.agent.onActionStarted((action) => {
      showAgentHud('EXECUTING_ACTION', `Executing: ${action.type}`);
    });

    window.adionAPI.agent.onActionFinished((action) => {
      showAgentHud('COMPLETED', `Finished: ${action.type}`);
    });

    window.adionAPI.agent.onFeedback((feedback) => {
      showAgentHud(feedback.level.toUpperCase(), feedback.message);
    });
  }
});

