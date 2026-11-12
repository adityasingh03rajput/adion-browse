/**
 * Adion Browse — Site Registry (data, not code).
 *
 * Canonical directory of sites the agent understands: domains, aliases
 * (English + transliterated Hindi/Hinglish), and per-site sections with
 * either a direct URL or click-target labels for DOM grounding.
 *
 * To teach the agent a new site: append one entry. No parser changes needed.
 * To teach a new section: append one entry under the site. No regex needed.
 */

const SITES = [
  {
    id: 'instagram',
    domains: ['instagram.com', 'www.instagram.com'],
    aliases: ['instagram', 'insta', 'ig', 'इंस्टाग्राम'],
    sections: {
      messages: { labels: ['messages', 'message', 'dms', 'dm', 'direct', 'direct messages', 'inbox', 'chats', 'chat', 'संदेश', 'मैसेज', 'sandesh'], url: 'https://www.instagram.com/direct/inbox/' },
      home: { labels: ['home', 'feed', 'होम'], url: 'https://www.instagram.com/' },
      reels: { labels: ['reels', 'reel'], url: 'https://www.instagram.com/reels/' },
      explore: { labels: ['explore'], url: 'https://www.instagram.com/explore/' },
      notifications: { labels: ['notifications', 'notification'], url: 'https://www.instagram.com/' },
      profile: { labels: ['profile'], click: ['profile', 'avatar'] },
      search: { labels: ['search'], click: ['search'] },
    },
  },
  {
    id: 'youtube',
    domains: ['youtube.com', 'www.youtube.com', 'youtu.be'],
    aliases: ['youtube', 'yt', 'यू ट्यूब', 'यूट्यूब'],
    searchUrl: (q) => 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q),
    sections: {
      home: { labels: ['home', 'feed', 'होम'], url: 'https://www.youtube.com/' },
      search: { labels: ['search', 'खोज', 'khoj', 'सर्च'], searchUrl: (q) => 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q) },
      subscriptions: { labels: ['subscriptions', 'subscription', 'subs', 'सब्सक्रिप्शन'], url: 'https://www.youtube.com/feed/subscriptions' },
      history: { labels: ['history', 'इतिहास', 'हिस्ट्री'], url: 'https://www.youtube.com/feed/history' },
      library: { labels: ['library', 'लाइब्रेरी'], url: 'https://www.youtube.com/feed/library' },
      trending: { labels: ['trending', 'ट्रेंडिंग'], url: 'https://www.youtube.com/feed/trending' },
      messages: { labels: ['messages', 'inbox', 'संदेश'], click: ['messages', 'inbox'] },
    },
  },
  {
    id: 'whatsapp',
    domains: ['web.whatsapp.com', 'whatsapp.com'],
    aliases: ['whatsapp', 'wapp', 'वॉट्सऐप'],
    sections: {
      unread: { labels: ['unread', 'unread messages', 'unread chats'], action: 'WHATSAPP_UNREAD_CLICK' },
      chats: { labels: ['chats', 'messages', 'inbox'], action: 'WHATSAPP_UNREAD_CLICK' },
      newchat: { labels: ['new chat', 'compose'], click: ['new chat'] },
    },
  },
  {
    id: 'gmail',
    domains: ['mail.google.com', 'gmail.com'],
    aliases: ['gmail', 'google mail', 'जीमेल'],
    sections: {
      inbox: { labels: ['inbox', 'messages', 'mails', 'emails'], url: 'https://mail.google.com/mail/u/0/#inbox' },
      sent: { labels: ['sent', 'sent mail'], url: 'https://mail.google.com/mail/u/0/#sent' },
      drafts: { labels: ['drafts'], url: 'https://mail.google.com/mail/u/0/#drafts' },
      spam: { labels: ['spam'], url: 'https://mail.google.com/mail/u/0/#spam' },
      compose: { labels: ['compose', 'new mail', 'write mail'], click: ['compose'] },
    },
  },
  {
    id: 'x',
    domains: ['x.com', 'twitter.com', 'www.x.com'],
    aliases: ['x', 'twitter', 'tweet', 'ट्विटर'],
    sections: {
      messages: { labels: ['messages', 'dms', 'dm', 'inbox', 'संदेश'], url: 'https://x.com/messages' },
      home: { labels: ['home', 'feed', 'होम'], url: 'https://x.com/home' },
      notifications: { labels: ['notifications', 'सूचनाएं', 'नोटिफिकेशन'], url: 'https://x.com/notifications' },
      profile: { labels: ['profile', 'प्रोफ़ाइल', 'प्रोफाइल'], click: ['profile'] },
    },
  },
  {
    id: 'google',
    domains: ['google.com', 'www.google.com'],
    aliases: ['google', 'गूगल'],
    searchUrl: (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q),
    sections: {
      home: { labels: ['home', 'feed'], url: 'https://www.google.com/' },
      search: { labels: ['search'], searchUrl: (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q) },
    },
  },
  {
    id: 'github',
    domains: ['github.com'],
    aliases: ['github', 'git hub', 'गिटहब'],
    sections: {
      notifications: { labels: ['notifications'], url: 'https://github.com/notifications' },
      profile: { labels: ['profile'], click: ['profile', 'avatar'] },
    },
  },
  {
    id: 'reddit',
    domains: ['reddit.com', 'www.reddit.com', 'old.reddit.com'],
    aliases: ['reddit', 'रेडिट'],
    sections: {
      inbox: { labels: ['inbox', 'messages', 'संदेश'], url: 'https://www.reddit.com/message/inbox/' },
      home: { labels: ['home', 'feed', 'होम'], url: 'https://www.reddit.com/' },
    },
  },
  {
    id: 'facebook',
    domains: ['facebook.com', 'www.facebook.com', 'fb.com', 'messenger.com'],
    aliases: ['facebook', 'fb', 'messenger', 'फेसबुक'],
    sections: {
      messages: { labels: ['messages', 'messenger', 'dms', 'inbox', 'chats', 'संदेश'], url: 'https://www.messenger.com/' },
      home: { labels: ['home', 'feed', 'होम'], url: 'https://www.facebook.com/' },
      profile: { labels: ['profile', 'प्रोफ़ाइल', 'प्रोफाइल'], click: ['profile', 'avatar'] },
    },
  },
  {
    id: 'amazon',
    domains: ['amazon.in', 'amazon.com', 'www.amazon.in'],
    aliases: ['amazon', 'अमेज़न'],
    sections: {
      orders: { labels: ['orders', 'my orders'], url: 'https://www.amazon.in/gp/your-account/order-history' },
      cart: { labels: ['cart'], url: 'https://www.amazon.in/gp/cart/view.html' },
      home: { labels: ['home'], url: 'https://www.amazon.in/' },
    },
  },
  {
    id: 'canva',
    domains: ['canva.com', 'www.canva.com'],
    aliases: ['canva', 'कैनवा'],
    sections: {
      home: { labels: ['home'], url: 'https://www.canva.com/' },
      projects: { labels: ['projects', 'designs', 'my designs'], click: ['projects'] },
    },
  },
  {
    id: 'netflix',
    domains: ['netflix.com', 'www.netflix.com'],
    aliases: ['netflix', 'नेटफ्लिक्स'],
    sections: {
      home: { labels: ['home'], url: 'https://www.netflix.com/browse' },
    },
  },
];

/** Generic section synonyms used for follow-up deferral on sites NOT in the registry.
 * Includes Hindi/Roman-Hinglish forms so pure-Hindi follow-ups ("संदेश खोलो")
 * classify as OPEN_SECTION instead of UNKNOWN. */
const GENERIC_SECTIONS = new Set([
  'messages', 'message', 'dms', 'dm', 'inbox', 'chats', 'chat',
  'संदेश', 'मैसेज', 'sandesh',
  'profile', 'प्रोफ़ाइल', 'प्रोफाइल',
  'settings', 'setting', 'सेटिंग्स', 'सेटिंग',
  'history', 'इतिहास', 'हिस्ट्री',
  'search', 'खोज', 'khoj', 'सर्च',
  'orders', 'order', 'ऑर्डर',
  'cart', 'कार्ट',
  'notifications', 'notification', 'सूचनाएं', 'नोटिफिकेशन',
  'subscriptions', 'subscription', 'सब्सक्रिप्शन',
  'library', 'लाइब्रेरी', 'trending', 'ट्रेंडिंग',
  'home', 'होम', 'feed', 'explore', 'reels',
  'contacts', 'help', 'मदद', 'support', 'downloads', 'bookmarks',
]);

function norm(s) { return String(s || '').trim().toLowerCase(); }

function findSite(token) {
  const t = norm(token);
  if (!t) return null;
  for (const site of SITES) {
    if (site.domains.some(d => d === t || d === 'www.' + t || t === 'www.' + d)) return site;
    if (site.aliases.includes(t)) return site;
    if (site.domains.some(d => d.startsWith(t + '.') || t.startsWith(d))) return site;
  }
  return null;
}

/** Scan free text for any known site mention. Returns site or null. */
function siteMentioned(text) {
  const t = ' ' + norm(text).replace(/[^a-z0-9\u0900-\u097F. ]/gi, ' ') + ' ';
  for (const site of SITES) {
    for (const a of site.aliases) {
      if (t.includes(' ' + a + ' ') || t.includes(' ' + a + '.')) return site;
    }
    for (const d of site.domains) {
      const bare = d.replace(/^www\./, '');
      if (t.includes(bare) || t.includes(d)) return site;
    }
  }
  return null;
}

function findSection(site, token) {
  const t = norm(token);
  if (!site || !t) return null;
  for (const [key, sec] of Object.entries(site.sections || {})) {
    if (key === t || (sec.labels || []).includes(t)) return { key, ...sec };
  }
  return null;
}

/** Extract the registrable site for a URL, or null. */
function siteOfUrl(url) {
  const m = String(url || '').toLowerCase().match(/^https?:\/\/([^/:?#]+)/);
  if (!m) return null;
  const host = m[1].replace(/^www\./, '');
  for (const site of SITES) {
    if (site.domains.some(d => d.replace(/^www\./, '') === host || host.endsWith('.' + d.replace(/^www\./, '')))) return site;
  }
  return null;
}

function isGenericSection(token) { return GENERIC_SECTIONS.has(norm(token)); }

module.exports = { SITES, GENERIC_SECTIONS, findSite, siteMentioned, findSection, siteOfUrl, isGenericSection };
