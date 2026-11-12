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
  const statZkpRewards = document.getElementById('statZkpRewards');

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

  // Speed Dial Shortcuts
  const defaultShortcuts = [
    { title: 'Brave Search', url: 'https://search.brave.com', letter: 'B', color: '#ff5500' },
    { title: 'YouTube', url: 'https://youtube.com', letter: 'Y', color: '#ff0000' },
    { title: 'GitHub', url: 'https://github.com', letter: 'G', color: '#ffffff' },
    { title: 'Reddit', url: 'https://reddit.com', letter: 'R', color: '#ff4500' },
    { title: 'Wikipedia', url: 'https://wikipedia.org', letter: 'W', color: '#ffffff' },
    { title: 'DuckDuckGo', url: 'https://duckduckgo.com', letter: 'D', color: '#de5833' }
  ];

  function renderShortcuts() {
    shortcutsGrid.innerHTML = '';
    defaultShortcuts.forEach(sc => {
      const card = document.createElement('a');
      card.className = 'shortcut-card';
      card.href = sc.url;

      card.innerHTML = `
        <div class="shortcut-icon" style="color: ${sc.color};">
          ${sc.letter}
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
