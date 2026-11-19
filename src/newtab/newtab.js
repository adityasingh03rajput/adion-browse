/*__ADION_THEME_BOOT__*/(function(){try{var q=null;try{q=new URLSearchParams(location.search).get("theme");}catch(e){}var t=(q==="light"||q==="dark")?q:null;if(!t){try{t=localStorage.getItem("adion-theme");}catch(e){}}if(t!=="light"&&t!=="dark")t="dark";document.documentElement.dataset.theme=t;try{localStorage.setItem("adion-theme",t);}catch(e){}window.addEventListener("storage",function(e){if(e&&e.key==="adion-theme"&&(e.newValue==="light"||e.newValue==="dark")){document.documentElement.dataset.theme=e.newValue;}});}catch(e){}})();
// Adion Browse - New Tab Controller
document.addEventListener('DOMContentLoaded', () => {
  const clockDisplay = document.getElementById('clockDisplay');
  const dateDisplay = document.getElementById('dateDisplay');
  const searchForm = document.getElementById('searchForm');
  const searchInput = document.getElementById('searchInput');
  const shortcutsGrid = document.getElementById('shortcutsGrid');
  const statBlocked = document.getElementById('statBlocked');
  const statBandwidth = document.getElementById('statBandwidth');
  const statTime = document.getElementById('statTime');

  // Clock & Date updater
  function updateClock() {
    const now = new Date();
    let hours = now.getHours();
    const minutes = String(now.getMinutes()).padStart(2, '0');
    clockDisplay.textContent = `${hours}:${minutes}`;

    const options = { weekday: 'long', month: 'long', day: 'numeric' };
    dateDisplay.textContent = now.toLocaleDateString('en-US', options);
  }
  updateClock();
  setInterval(updateClock, 1000);

  // Speed Dial Shortcuts with Sleek Vector Icons
  const defaultShortcuts = [
    {
      title: 'Brave Search',
      url: 'https://search.brave.com',
      color: '#ff5500',
      iconSvg: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>'
    },
    {
      title: 'YouTube',
      url: 'https://youtube.com',
      color: '#ff0033',
      iconSvg: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="4" ry="4"></rect><polygon points="10 8 16 12 10 16 10 8" fill="currentColor"></polygon></svg>'
    },
    {
      title: 'GitHub',
      url: 'https://github.com',
      color: '#00f2fe',
      iconSvg: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>'
    },
    {
      title: 'Reddit',
      url: 'https://reddit.com',
      color: '#ff4500',
      iconSvg: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 12a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0zm5 0a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0z"></path><path d="M9 16c1.5 1 4.5 1 6 0"></path></svg>'
    },
    {
      title: 'Wikipedia',
      url: 'https://wikipedia.org',
      color: '#ffffff',
      iconSvg: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>'
    },
    {
      title: 'DuckDuckGo',
      url: 'https://duckduckgo.com',
      color: '#10b981',
      iconSvg: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>'
    }
  ];

  function renderShortcuts() {
    shortcutsGrid.innerHTML = '';
    defaultShortcuts.forEach(sc => {
      const card = document.createElement('a');
      card.className = 'shortcut-card';
      card.href = sc.url;

      card.innerHTML = `
        <div class="shortcut-icon" style="color: ${sc.color};">
          ${sc.iconSvg}
        </div>
        <div class="shortcut-title">${sc.title}</div>
      `;

      card.addEventListener('click', (e) => {
        e.preventDefault();
        window.location.href = sc.url;
      });

      shortcutsGrid.appendChild(card);
    });
  }
  renderShortcuts();

  // Search submission
  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const query = searchInput.value.trim();
    if (!query) return;

    // Check if it's a URL
    if (/^[a-zA-Z]+:\/\//.test(query) || /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(:\d+)?(\/.*)?$/.test(query)) {
      window.location.href = query.startsWith('http') ? query : `https://${query}`;
    } else {
      // Default to Brave Search
      window.location.href = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
    }
  });

  // Load stats from URL params or localStorage
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has('blocked')) {
      const blocked = parseInt(params.get('blocked') || '0', 10);
      const kb = parseInt(params.get('kb') || '0', 10);
      const sec = parseFloat(params.get('sec') || '0');
      statBlocked.textContent = blocked.toLocaleString();
      statBandwidth.textContent = formatBytes(kb * 1024);
      statTime.textContent = formatTime(sec);
    } else {
      const statsStr = localStorage.getItem('adion_stats');
      if (statsStr) {
        const stats = JSON.parse(statsStr);
        statBlocked.textContent = (stats.totalBlocked || 0).toLocaleString();
        statBandwidth.textContent = formatBytes(stats.estimatedBandwidthSavedKB * 1024);
        statTime.textContent = formatTime(stats.estimatedTimeSavedSec);
      }
    }
  } catch (e) {}

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 KB';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatTime(seconds) {
    if (!seconds || seconds <= 0) return '0 s';
    if (seconds < 60) return seconds.toFixed(0) + ' s';
    return (seconds / 60).toFixed(1) + ' min';
  }
});
