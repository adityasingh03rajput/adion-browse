/**
 * Adion Reflex - Fast Decision Engine for Browser Automation
 * Inspired by D:\help Jev (System One) classifier-based decisions
 * 
 * Makes decisions at classifier speed (<100ms) for common browser intents
 * without waiting for full LLM round-trips
 */

const REFLEX_INTENTS = {
  // Project/Document specific opens (high confidence)
  PROJECT_OPEN: { confidence: 0.88, keywords: ['open', 'click', 'view', 'launch', 'start'] },
  // Navigation & Browsing
  NAVIGATE_TO: { confidence: 0.75, keywords: ['open', 'go to', 'navigate to', 'visit', 'browse', 'load'] },
  SEARCH_WEB: { confidence: 0.7, keywords: ['search for', 'google', 'look up', 'find', 'web search'] },
  BROWSER_NAVIGATION: { confidence: 0.85, keywords: ['back', 'forward', 'refresh', 'reload', 'stop', 'home'] },
  
  // Tab Management
  NEW_TAB: { confidence: 0.8, keywords: ['new tab', 'open tab', 'create tab'] },
  CLOSE_TAB: { confidence: 0.8, keywords: ['close tab', 'shut tab', 'x tab', 'destroy tab'] },
  NEXT_TAB: { confidence: 0.8, keywords: ['next tab', 'tab next', 'switch tab', 'next window'] },
  PREVIOUS_TAB: { confidence: 0.8, keywords: ['previous tab', 'tab previous', 'switch back', 'back tab'] },
  
  // Scrolling & Navigation
  SCROLL_UP: { confidence: 0.85, keywords: ['scroll up', 'page up', 'up page', 'scroll backwards'] },
  SCROLL_DOWN: { confidence: 0.85, keywords: ['scroll down', 'page down', 'down page', 'scroll forward'] },
  SCROLL_TOP: { confidence: 0.8, keywords: ['scroll to top', 'top of page', 'go top', 'start page'] },
  SCROLL_BOTTOM: { confidence: 0.8, keywords: ['scroll to bottom', 'bottom of page', 'go bottom', 'end page'] },
  
  // Element Interaction
  CLICK_ELEMENT: { confidence: 0.6, keywords: ['click', 'press', 'tap', 'hit', 'select', 'open it'] },
  TYPE_TEXT: { confidence: 0.75, keywords: ['type', 'write', 'enter', 'fill in', 'input', 'type in'] },
  FILL_FORM: { confidence: 0.7, keywords: ['fill', 'complete', 'submit', 'form'] },
  
  // Browser Commands
  DEVTOOLS: { confidence: 0.85, keywords: ['devtools', 'developer tools', 'inspect', 'check code'] },
  BOOKMARK: { confidence: 0.8, keywords: ['bookmark', 'save page', 'add bookmark', 'star'] },
  HISTORY: { confidence: 0.75, keywords: ['history', 'past', 'previous', 'ago'] },
  
  // Appearance
  THEME_DARK: { confidence: 0.85, keywords: ['dark mode', 'dark theme', 'darken', 'night mode'] },
  THEME_LIGHT: { confidence: 0.85, keywords: ['light mode', 'light theme', 'lighten', 'day mode'] },
  ZOOM_IN: { confidence: 0.8, keywords: ['zoom in', 'zoom up', 'magnify', 'enlarge'] },
  ZOOM_OUT: { confidence: 0.8, keywords: ['zoom out', 'zoom down', 'shrink', 'reduce'] },
  
  // Copy/Paste
  COPY: { confidence: 0.8, keywords: ['copy', 'copy that', 'duplicate'] },
  PASTE: { confidence: 0.8, keywords: ['paste', 'insert', 'put here'] },
  SELECT_ALL: { confidence: 0.8, keywords: ['select all', 'select everything', 'whole page', 'full selection'] },
  
  // Page Actions
  DOWNLOAD: { confidence: 0.7, keywords: ['download', 'save file', 'get file', 'fetch'] },
  PRINT: { confidence: 0.75, keywords: ['print', 'printer', 'print page'] },
  SHARE: { confidence: 0.6, keywords: ['share', 'email', 'forward'] }
};

function preprocessText(text) {
  const cleaned = String(text || '').toLowerCase().trim();
  return cleaned
    .replace(/^(can you|could you|please|hey adion|adion)\s*/i, '')
    .replace(/[\?\!\.,]+$/, '')
    .trim();
}

/**
 * Make a reflex decision for browser automation
 * Returns: { intent, confidence, action, text }
 */
function decide(text, pageContext = {}) {
  const processed = preprocessText(text);
  const lower = processed.toLowerCase();
  
  // Check each intent type
  for (const [intentName, intentData] of Object.entries(REFLEX_INTENTS)) {
    for (const keyword of intentData.keywords) {
      if (lower.includes(keyword)) {
        // PROJECT_OPEN needs special handling for multi-word project names
        if (intentName === 'PROJECT_OPEN') {
          // Pattern: "open [project name]", "click [project name]", etc.
          const projectMatch = lower.match(/(?:open|click|view|launch|start)\s+(.+)$/i);
          if (projectMatch) {
            const projectName = projectMatch[1].trim();
            // Skip if too short or just a keyword
            if (projectName.length > 2 && !['it', 'this', 'that', 'one', 'the', 'a', 'an'].includes(projectName)) {
              return {
                intent: 'PROJECT_OPEN',
                confidence: 0.88,
                text: processed,
                action: getIntentAction(intentName, processed, pageContext)
              };
            }
          }
          // Not a clear project name - fall through to generic CLICK_ELEMENT
        }
        return {
          intent: intentName,
          confidence: intentData.confidence,
          text: processed,
          action: getIntentAction(intentName, processed, pageContext)
        };
      }
    }
  }
  
  // No reflex decision - will go to full agent
  return { intent: 'NONE', confidence: 0, text: processed, action: null };
}

/**
 * Generate the action for an intent
 */
function getIntentAction(intent, text, pageContext = {}) {
  const lower = text.toLowerCase();
  
  switch (intent) {
    case 'PROJECT_OPEN': {
      // Extract project name from command
      const projectMatch = text.match(/(?:open|click|view|launch|start)\s+(.+)$/i);
      if (projectMatch) {
        const projectName = projectMatch[1].trim();
        // Try to resolve common context references
        const contextMap = {
          'it': pageContext.lastTarget || 'submit',
          'this': pageContext.lastTarget || 'submit',
          'that': pageContext.lastTarget || 'submit',
        };
        const resolved = contextMap[projectName.toLowerCase()] || projectName;
        // High-confidence project open action with semantic verification
        return { 
          type: 'CLICK_SELECTOR', 
          target: resolved,
          clickMethod: 'semantic', // Use accessibility, aria-label, text content matching
          maxSearchDepth: 3,
          verifySelector: `[aria-label*="${resolved}" i], [title*="${resolved}" i], a[href*="${resolved}" i], [data-project*="${resolved}" i]`
        };
      }
      break;
    }
    
    case 'NAVIGATE_TO': {
      // Extract domain
      const domainMatch = text.match(/(?:open|go to|navigate to|visit)\s+([a-zA-Z0-9][a-zA-Z0-9.\-]*\.[a-zA-Z]{2,})/i);
      if (domainMatch) {
        const domain = domainMatch[1].toLowerCase();
        const urlMap = {
          'canva': 'https://www.canva.com',
          'github': 'https://github.com',
          'youtube': 'https://www.youtube.com',
          'google': 'https://www.google.com',
          'gmail': 'https://mail.google.com',
          'chatgpt': 'https://chatgpt.com',
          'claude': 'https://claude.ai',
          'reddit': 'https://www.reddit.com',
          'instagram': 'https://www.instagram.com',
          'twitter': 'https://x.com',
          'x': 'https://x.com',
          'facebook': 'https://www.facebook.com',
          'linkedin': 'https://www.linkedin.com',
          'netflix': 'https://www.netflix.com',
          'spotify': 'https://open.spotify.com',
          'amazon': 'https://www.amazon.com',
        };
        
        for (const [key, url] of Object.entries(urlMap)) {
          if (domain.includes(key)) return { type: 'NAVIGATE', url };
        }
        return { type: 'NAVIGATE', url: `https://${domain}` };
      }
      break;
    }
    
    case 'SEARCH_WEB': {
      const searchMatch = text.match(/(?:search for|google|look up|find)\s+(.+)/i);
      if (searchMatch) {
        const query = searchMatch[1].trim();
        return { type: 'NAVIGATE', url: `https://search.brave.com/search?q=${encodeURIComponent(query)}` };
      }
      break;
    }
    
    case 'BROWSER_NAVIGATION': {
      if (lower.includes('back')) return { type: 'GO_BACK' };
      if (lower.includes('forward')) return { type: 'GO_FORWARD' };
      if (lower.includes('refresh') || lower.includes('reload')) return { type: 'RELOAD' };
      if (lower.includes('stop')) return { type: 'NAVIGATE', url: 'adion://newtab' };
      if (lower.includes('home')) return { type: 'NAVIGATE', url: 'adion://newtab' };
      break;
    }
    
    case 'NEW_TAB':
      return { type: 'NEW_TAB', url: 'adion://newtab' };
      
    case 'CLOSE_TAB':
      return { type: 'CLOSE_TAB' };
      
    case 'NEXT_TAB':
    case 'PREVIOUS_TAB': {
      // Use keyboard shortcuts
      return { type: 'EXECUTE_SCRIPT', code: lower.includes('previous') || lower.includes('back') 
        ? 'document.execCommand("selectAll"); window.close();' // Simplified
        : 'window.open("", "_blank");' // Simplified
      };
    }
    
    case 'SCROLL_UP':
      return { type: 'SCROLL', direction: 'up', amount: -450 };
      
    case 'SCROLL_DOWN':
      return { type: 'SCROLL', direction: 'down', amount: 450 };
      
    case 'SCROLL_TOP':
      return { type: 'SCROLL', direction: 'top' };
      
    case 'SCROLL_BOTTOM':
      return { type: 'SCROLL', direction: 'bottom' };
      
    case 'CLICK_ELEMENT': {
      // Extract target after "click on"
      const clickMatch = text.match(/(?:click on|click|press|tap|hit|select)\s+(.+)/i);
      if (clickMatch) {
        const target = clickMatch[1].trim().replace(/[\?\!\.,]+$/, '');
        // Try to resolve common context references
        const contextMap = {
          'it': pageContext.lastTarget || 'submit',
          'this': pageContext.lastTarget || 'submit',
          'that': pageContext.lastTarget || 'submit',
        };
        const resolved = contextMap[target.toLowerCase()] || target;
        return { type: 'CLICK_SELECTOR', target: resolved };
      }
      break;
    }
    
    case 'TYPE_TEXT': {
      const typeMatch = text.match(/(?:type|write|enter|fill in|input)\s+(.+)/i);
      if (typeMatch) {
        return { type: 'INPUT_TEXT', selector: 'active', text: typeMatch[1].trim() };
      }
      break;
    }
    
    case 'THEME_DARK':
      return { type: 'MODIFY_DOM', selector: 'body', action: 'setStyle', value: 'background: #121212 !important; color: #f0f0f0 !important;' };
      
    case 'THEME_LIGHT':
      return { type: 'MODIFY_DOM', selector: 'body', action: 'setStyle', value: 'background: #ffffff !important; color: #111111 !important;' };
      
    case 'ZOOM_IN':
      return { type: 'EXECUTE_SCRIPT', code: 'document.body.style.zoom = (parseFloat(document.body.style.zoom || 1) + 0.1).toFixed(2);' };
      
    case 'ZOOM_OUT':
      return { type: 'EXECUTE_SCRIPT', code: 'document.body.style.zoom = (parseFloat(document.body.style.zoom || 1) - 0.1).toFixed(2);' };
      
    case 'SELECT_ALL':
      return { type: 'EXECUTE_SCRIPT', code: 'document.execCommand("selectAll");' };
      
    case 'COPY':
      return { type: 'EXECUTE_SCRIPT', code: 'document.execCommand("copy");' };
      
    case 'PASTE':
      return { type: 'EXECUTE_SCRIPT', code: 'document.execCommand("paste");' };
  }
  
  return null;
}

module.exports = {
  decide,
  getIntentAction,
  preprocessText,
  REFLEX_INTENTS
};