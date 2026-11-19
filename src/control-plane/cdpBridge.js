/**
 * Chrome DevTools Protocol (CDP) Bridge
 * Provides direct, hardware-accelerated control over the active Chromium BrowserView.
 * Handles synthetic input dispatch, viewport capture for VLM grounding, and DOM introspection.
 */

class CDPBridge {
  constructor() {
    this.currentWebContents = null;
    this.isAttached = false;
  }

  /**
   * Attach CDP debugger to a target webContents instance
   */
  async attach(webContents) {
    if (this.currentWebContents === webContents && this.isAttached) {
      return;
    }

    if (this.currentWebContents && this.isAttached) {
      this.detach();
    }

    this.currentWebContents = webContents;

    try {
      if (!this.currentWebContents.debugger.isAttached()) {
        this.currentWebContents.debugger.attach('1.3');
        this.isAttached = true;

        // Enable necessary CDP domains
        await this.sendCommand('Page.enable');
        await this.sendCommand('DOM.enable');
        await this.sendCommand('Runtime.enable');
        try { await this.sendCommand('Accessibility.enable'); } catch (_) {}

        this.currentWebContents.debugger.on('detach', (event, reason) => {
          this.isAttached = false;
          this.currentWebContents = null;
        });
      } else {
        this.isAttached = true;
      }
    } catch (err) {
      console.error('[CDPBridge] Failed to attach debugger:', err.message);
      this.isAttached = false;
    }
  }

  /**
   * Detach debugger cleanly
   */
  detach() {
    if (this.currentWebContents && this.isAttached) {
      try {
        if (this.currentWebContents.debugger.isAttached()) {
          this.currentWebContents.debugger.detach();
        }
      } catch (err) {
        // Ignore detach errors on tab closure
      }
    }
    this.isAttached = false;
    this.currentWebContents = null;
  }

  /**
   * Send a CDP command to the attached Chromium session with timeout safety
   */
  async sendCommand(method, params = {}, timeoutMs = 4000) {
    if (!this.isAttached || !this.currentWebContents) {
      throw new Error(`CDP not attached. Cannot send command: ${method}`);
    }
    return Promise.race([
      this.currentWebContents.debugger.sendCommand(method, params),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`CDP command timed out: ${method}`)), timeoutMs))
    ]);
  }

  /**
   * Dispatch real hardware text insertion via Chrome DevTools Protocol.
   * Universal across React 18, Lexical, Draft.js, ProseMirror, Slate, standard HTML inputs.
   */
  async dispatchInsertText(text) {
    if (!this.isAttached) throw new Error('CDP not attached');
    await this.sendCommand('Input.insertText', { text: String(text) });
    return { text, inserted: true };
  }

  /**
   * Dispatch synthetic mouse click at exact pixel coordinates.
   * Scrolls element into view first if it is below the viewport fold,
   * then dispatches the full hardware-equivalent CDP event sequence.
   */
  async dispatchClick(x, y, button = 'left', clickCount = 1) {
    if (!this.isAttached) throw new Error('CDP not attached');

    const cx = Math.round(x);
    const cy = Math.round(y);

    // Scroll element into view if below/above the visible fold before clicking.
    // This prevents clicks landing on empty space when the page has scrolled.
    try {
      const layout = await this.sendCommand('Page.getLayoutMetrics', {}, 2000).catch(() => null);
      const viewport = layout && layout.cssVisualViewport;
      if (viewport) {
        const { pageY, clientHeight } = viewport;
        if (cy < pageY || cy > pageY + clientHeight) {
          await this.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: cx,
            y: Math.min(Math.max(cy, 0), clientHeight),
            deltaX: 0,
            deltaY: cy - (pageY + clientHeight / 2)
          });
          // Brief settle after scroll
          await new Promise(r => setTimeout(r, 120));
        }
      }
    } catch (_) {}

    // 1. Move to coordinates
    await this.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: cx,
      y: cy,
      button: 'none',
      buttons: 0
    });

    // 2. Mouse Press
    await this.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: cx,
      y: cy,
      button,
      buttons: 1,
      clickCount
    });

    // Brief settle between press and release (matches real hardware timing)
    await new Promise(r => setTimeout(r, 30));

    // 3. Mouse Release
    await this.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: cx,
      y: cy,
      button,
      buttons: 0,
      clickCount
    });

    return { x: cx, y: cy, clicked: true };
  }

  /**
   * Smooth natural scrolling via synthetic mouse wheel delta events
   */
  async dispatchScroll(deltaY, steps = 5, delayMs = 16) {
    if (!this.isAttached) throw new Error('CDP not attached');

    const stepDelta = deltaY / steps;
    try {
      for (let i = 0; i < steps; i++) {
        await this.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: 400,
          y: 400,
          deltaX: 0,
          deltaY: Math.round(stepDelta)
        }, 1500);
        if (delayMs > 0 && i < steps - 1) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    } catch (err) {
      // Fallback: If CDP Input.dispatchMouseEvent times out or gets blocked (e.g. by payment iframes/overlays),
      // smoothly scroll via window.scrollBy so execution never stalls.
      if (this.currentWebContents) {
        await this.currentWebContents.executeJavaScript(`
          try { window.scrollBy({ top: ${deltaY}, left: 0, behavior: 'smooth' }); } catch(_) {}
        `).catch(() => {});
      }
    }
    return { scrolled: deltaY };
  }

  /**
   * Capture high-definition viewport screenshot as base64 PNG
   * Used for the local Multimodal Vision Grounder
   */
  async captureScreenshot() {
    if (!this.isAttached) throw new Error('CDP not attached');
    const result = await this.sendCommand('Page.captureScreenshot', {
      format: 'png',
      quality: 90,
      fromSurface: true
    });
    return result.data; // Base64 encoded string
  }

  /**
   * Capture the ENTIRE scrollable page (beyond the viewport) — D:\help's
   * full-screen grab equivalent. captureBeyondViewport stitches the full
   * document height; may be large on infinite-scroll pages, so callers
   * should downscale before use.
   */
  async captureFullPageScreenshot(maxWidth = 1280) {
    if (!this.isAttached) throw new Error('CDP not attached');
    const metrics = await this.sendCommand('Page.getLayoutMetrics', {}, 3000).catch(() => null);
    const css = metrics && metrics.cssContentSize ? metrics.cssContentSize : null;
    const clip = css && css.width && css.height
      ? { x: 0, y: 0, width: Math.min(css.width, maxWidth * 2), height: Math.min(css.height, 16000), scale: 1 }
      : undefined;
    const result = await this.sendCommand('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: true,
      ...(clip ? { clip } : {})
    }, 15000);
    return result.data;
  }

  /**
   * Execute isolated JavaScript inside the page context
   */
  async evaluate(expression) {
    if (!this.isAttached) throw new Error('CDP not attached');
    const response = await this.sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    return response.result?.value;
  }

  /**
   * Locate an interactive element matching a query or selector across standard DOM and Shadow DOM trees
   */
  async findElementCoordinates(target) {
    const expr = `
      (() => {
        const query = ${JSON.stringify(target.toLowerCase().trim())};

        // Helper: Strip emojis, zero-width chars, and punctuation for pure phonetic/semantic comparison
        function stripSymbols(s) {
          if (!s) return '';
          return s
            .replace(/[\\u00A0\\u1680\\u2000-\\u200B\\u202F\\u205F\\u3000\\uFEFF]/g, ' ')
            .replace(/[\\u00AD\\u200B\\u200C\\u200D]/g, '')
            .replace(/[\\u{1F600}-\\u{1F64F}\\u{1F300}-\\u{1F5FF}\\u{1F680}-\\u{1F6FF}\\u{1F1E0}-\\u{1F1FF}\\u{2600}-\\u{26FF}\\u{2700}-\\u{27BF}\\u{FE00}-\\u{FE0F}]/gu, '')
            .replace(/[^\\p{L}\\p{N}\\s]/gu, ' ')
            .replace(/\\s+/g, ' ')
            .trim()
            .toLowerCase();
        }

        // Helper: Strip all spaces and punctuation to create canonical compact token (e.g. "sign   up" -> "signup")
        function compactNormalize(s) {
          if (!s) return '';
          return stripSymbols(s).replace(/[\\s\\-_\\.\\/\\\\:;,'"\`!?()\\[\\]{}]+/g, '');
        }

        const cleanQuery = stripSymbols(query);
        const compactQuery = compactNormalize(query);
        const isSignUpQuery = ['signup', 'register', 'createaccount', 'join'].some(k => compactQuery.includes(k));
        const isSignInQuery = ['signin', 'login', 'loginto', 'enter'].some(k => compactQuery.includes(k));

        // Extract meaningful semantic tokens for conceptual & fuzzy matching
        const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'for', 'in', 'on', 'at', 'to', 'from', 'by', 'with', 'link', 'website', 'page', 'site', 'button', 'click', 'open', 'tap', 'please', 'can', 'you']);
        const rawTokens = (cleanQuery || query).replace(/[^\\w\\s\\.-]/g, ' ').split(/\\s+/).filter(Boolean);
        const meaningfulTokens = rawTokens.filter(t => !stopWords.has(t) && t.length > 1);

        // Recursive tree walker traversing both standard DOM and Shadow DOM
        function getAllElements(root = document.body) {
          let elements = [];
          if (!root) return elements;

          const treeWalker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_ELEMENT,
            null,
            false
          );

          let node = treeWalker.currentNode;
          while (node) {
            elements.push(node);
            if (node.shadowRoot) {
              elements = elements.concat(getAllElements(node.shadowRoot));
            }
            node = treeWalker.nextNode();
          }
          return elements;
        }

        const all = getAllElements();
        let bestMatch = null;
        let highestScore = 0;

        for (const el of all) {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;

          let score = 0;
          const text = (el.innerText || el.textContent || '').trim().toLowerCase();
          const valueAttr = (el.value || el.getAttribute('value') || '').trim().toLowerCase();
          const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
          const title = (el.getAttribute('title') || '').toLowerCase();
          const alt = (el.getAttribute('alt') || '').toLowerCase();
          const href = (el.getAttribute('href') || el.src || '').toLowerCase();
          const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
          const id = (el.id || '').toLowerCase();

          // Context from parent card or search result container
          const parentCard = el.closest('article, [class*="result" i], [class*="snippet" i], [class*="card" i], li, [data-sitelink]');
          const parentCardText = parentCard ? (parentCard.innerText || '').slice(0, 350).toLowerCase() : '';
          const combined = (text + ' ' + valueAttr + ' ' + ariaLabel + ' ' + title + ' ' + alt + ' ' + href + ' ' + parentCardText).toLowerCase();

          // Clean phonetic/emoji-stripped strings & compact normalized strings
          const cleanText = stripSymbols(text);
          const cleanValue = stripSymbols(valueAttr);
          const cleanTitle = stripSymbols(title);
          const cleanAria = stripSymbols(ariaLabel);
          const compactText = compactNormalize(text);
          const compactValue = compactNormalize(valueAttr);
          const compactAria = compactNormalize(ariaLabel);
          const compactTitle = compactNormalize(title);

          // 1. Exact string matches & Compact matching (resolves "sign   up", "sign-up", "signup")
          if (compactQuery && (compactText === compactQuery || compactValue === compactQuery || compactAria === compactQuery || compactTitle === compactQuery)) {
            score = 160;
            if (cleanText.length > 0 && Math.abs(cleanText.length - cleanQuery.length) <= 5) {
              score += 50; // Leaf-level specificity bonus
            }
          } else if (ariaLabel === query || title === query || text === query || alt === query || cleanText === cleanQuery || cleanValue === cleanQuery || cleanTitle === cleanQuery || cleanAria === cleanQuery) {
            score = 150;
            if (cleanText.length > 0 && Math.abs(cleanText.length - cleanQuery.length) <= 5) {
              score += 50; // Leaf-level specificity bonus
            }
          } else if (ariaLabel.includes(query) || title.includes(query) || alt.includes(query) || (cleanTitle && cleanTitle.includes(cleanQuery))) {
            score = 100;
          } else if (compactQuery && (compactText.includes(compactQuery) || compactValue.includes(compactQuery))) {
            score = 95;
          } else if (text.length < 120 && text.includes(query)) {
            score = 90;
          } else if (text.includes(query) || (cleanText && cleanText.includes(cleanQuery))) {
            score = 75;
          } else if (combined.includes(query)) {
            score = 65;
          }

          // Antonym protection: Never mistakenly click "Sign In" when user requested "Sign Up"
          if (isSignUpQuery) {
            const isSignInEl = ['signin', 'login', 'loginto', 'logon'].some(k => compactText === k || compactValue === k || compactAria === k || compactTitle === k);
            if (isSignInEl) score -= 2500;
          } else if (isSignInQuery) {
            const isSignUpEl = ['signup', 'register', 'createaccount', 'join'].some(k => compactText === k || compactValue === k || compactAria === k || compactTitle === k);
            if (isSignUpEl) score -= 2500;
          }

          // 2. Cognitive Multi-Token Semantic Coverage (what it could be)
          if (meaningfulTokens.length > 0) {
            let matchedTokens = 0;
            let hrefDomainMatches = 0;
            for (const tok of meaningfulTokens) {
              if (text.includes(tok) || ariaLabel.includes(tok) || title.includes(tok) || alt.includes(tok)) {
                matchedTokens++;
              } else if (href.includes(tok)) {
                matchedTokens++;
                hrefDomainMatches++;
              } else if (parentCardText.includes(tok)) {
                matchedTokens += 0.8;
              }
            }
            const tokenCoverage = matchedTokens / meaningfulTokens.length;
            if (tokenCoverage >= 0.99) {
              score = Math.max(score, 90 + (meaningfulTokens.length * 5) + (hrefDomainMatches * 20));
            } else if (tokenCoverage >= 0.65) {
              score = Math.max(score, 65 + (matchedTokens * 5) + (hrefDomainMatches * 15));
            } else if (tokenCoverage >= 0.45 && meaningfulTokens.length >= 3) {
              score = Math.max(score, 45 + (matchedTokens * 4));
            }
          }

          if (placeholder.includes(query) || id.includes(query)) {
            score = Math.max(score, 50);
          }

          // Bias towards clickable elements
          const isClickable = el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link' || el.onclick != null || window.getComputedStyle(el).cursor === 'pointer';
          if (isClickable && score > 0) {
            score += 30;
          }

          // Bias towards search result headings and titles
          const isHeading = el.tagName === 'H1' || el.tagName === 'H2' || el.tagName === 'H3' || el.tagName === 'H4';
          if (isHeading && score > 0) {
            score += 20;
          }

          if (score > highestScore) {
            highestScore = score;
            bestMatch = el;
          }
        }

        if (bestMatch && highestScore >= 35) {
          // If bestMatch is inside or contains an interactive container, target the clickable container
          let clickable = bestMatch.closest('a, button, [role="button"], [role="link"], [role="listitem"], [role="row"], [tabindex], [data-testid^="list-item"]');
          if (!clickable) {
            clickable = bestMatch.querySelector('a, button, [role="button"], [role="link"]') || bestMatch;
          }
          try {
            clickable.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
          } catch(e) {}
          const newRect = clickable.getBoundingClientRect();

          // Dispatch dual-tier DOM pointer and mouse events
          try {
            const ev = { bubbles: true, cancelable: true, view: window };
            bestMatch.dispatchEvent(new PointerEvent('pointerdown', ev));
            bestMatch.dispatchEvent(new MouseEvent('mousedown', ev));
            if (bestMatch.focus) bestMatch.focus();
            bestMatch.dispatchEvent(new PointerEvent('pointerup', ev));
            bestMatch.dispatchEvent(new MouseEvent('mouseup', ev));
            bestMatch.dispatchEvent(new MouseEvent('click', ev));

            if (clickable && clickable !== bestMatch) {
              clickable.dispatchEvent(new PointerEvent('pointerdown', ev));
              clickable.dispatchEvent(new MouseEvent('mousedown', ev));
              clickable.dispatchEvent(new PointerEvent('pointerup', ev));
              clickable.dispatchEvent(new MouseEvent('mouseup', ev));
              try { clickable.click(); } catch(_) {}
            }
          } catch(e) {}

          return {
            found: true,
            score: highestScore,
            x: Math.round(newRect.left + newRect.width / 2),
            y: Math.round(newRect.top + newRect.height / 2),
            width: Math.round(newRect.width),
            height: Math.round(newRect.height),
            tag: bestMatch.tagName,
            label: (bestMatch.getAttribute('title') || bestMatch.innerText || bestMatch.getAttribute('aria-label') || clickable.innerText || '').slice(0, 50)
          };
        }

        return { found: false };
      })()
    `;

    return this.evaluate(expr);
  }

  /**
   * Inject temporary visual highlight around target bounding box
   */
  async highlightElement(x, y, width, height, label = 'AI Target') {
    const expr = `
      (() => {
        let overlay = document.getElementById('__adion_target_overlay__');
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.id = '__adion_target_overlay__';
          overlay.style.position = 'fixed';
          overlay.style.pointerEvents = 'none';
          overlay.style.zIndex = '9999999';
          overlay.style.border = '2px solid #00f2fe';
          overlay.style.backgroundColor = 'rgba(0, 242, 254, 0.15)';
          overlay.style.borderRadius = '6px';
          overlay.style.transition = 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)';
          overlay.style.boxShadow = '0 0 16px rgba(0, 242, 254, 0.6)';
          
          const tag = document.createElement('div');
          tag.id = '__adion_target_tag__';
          tag.style.position = 'absolute';
          tag.style.top = '-24px';
          tag.style.left = '0';
          tag.style.background = '#00f2fe';
          tag.style.color = '#000';
          tag.style.fontSize = '11px';
          tag.style.fontWeight = '700';
          tag.style.padding = '2px 6px';
          tag.style.borderRadius = '4px';
          tag.style.whiteSpace = 'nowrap';
          overlay.appendChild(tag);

          document.body.appendChild(overlay);
        }

        overlay.style.left = '${x - width / 2}px';
        overlay.style.top = '${y - height / 2}px';
        overlay.style.width = '${width}px';
        overlay.style.height = '${height}px';
        overlay.style.display = 'block';
        overlay.querySelector('#__adion_target_tag__').innerText = ${JSON.stringify(label)};

        setTimeout(() => {
          if (overlay) overlay.style.display = 'none';
        }, 2200);
      })()
    `;
    return this.evaluate(expr);
  }

  /**
   * Modify the Document Object Model (DOM) of the active page/local file in real-time
   * Supports smart fuzzy selector resolution, text, innerHTML, style properties,
   * CSS gradient overrides, and attributes with instant render verification.
   */
  async modifyDOM(selector, action = 'setText', value = '', attribute = '') {
    if (!this.isAttached) throw new Error('CDP not attached to active tab');

    const expr = `
      (() => {
        const rawSelector = ${JSON.stringify(selector || '')}.trim();
        const actionType = ${JSON.stringify(action || 'setText')};
        const val = ${JSON.stringify(value || '')};
        const attr = ${JSON.stringify(attribute || '')};

        // High-Precision Scored DOM Element Targeting & Validation Engine across ANY webpage
        function resolveElement(sel) {
          if (!sel) return document.body;
          const s = sel.trim();

          // 0. Body / Document / HTML
          if (/^(body|document|page|screen|window)$/i.test(s)) return document.body;
          if (/^html$/i.test(s)) return document.documentElement;

          // 1. Exact CSS querySelector (across standard DOM)
          try {
            const el = document.querySelector(s);
            if (el) return el;
          } catch(e) {}

          // 2. Direct ID or Class lookup (strip leading # or .)
          const cleanId = s.replace(/^[#\\.]/, '').trim();
          const elById = document.getElementById(cleanId);
          if (elById) return elById;

          // 3. Data attributes lookup
          try {
            const dataMatch = document.querySelector(
              '[data-id="' + cleanId + '"], [data-testid="' + cleanId + '"], [name="' + cleanId + '"], [data-action="' + cleanId + '"]'
            );
            if (dataMatch) return dataMatch;
          } catch(e) {}

          // 4. Semantic landmarks across any website
          if (/^(header|navbar|nav)$/i.test(s)) {
            const landmark = document.querySelector('header, nav, [role="banner"], [role="navigation"]');
            if (landmark) return landmark;
          }
          if (/^footer$/i.test(s)) {
            const landmark = document.querySelector('footer, [role="contentinfo"]');
            if (landmark) return landmark;
          }
          if (/^(sidebar|aside)$/i.test(s)) {
            const landmark = document.querySelector('aside, .sidebar, #sidebar, [role="complementary"]');
            if (landmark) return landmark;
          }
          if (/^(search|search\\s*bar|search\\s*box|search\\s*input)$/i.test(s)) {
            const landmark = document.querySelector('input[type="search"], input[name="q"], input[name="query"], input[placeholder*="search" i], [role="searchbox"]');
            if (landmark) return landmark;
          }
          if (/^(title|main\\s*heading|h1)$/i.test(s)) {
            const landmark = document.querySelector('h1, [role="heading"][aria-level="1"]');
            if (landmark) return landmark;
          }

          // 4b. Notification, Banner, Alert & Pop-up Matching across web apps
          if (/(notification|pop\\s*up|banner|alert|modal|dialog)/i.test(s)) {
            const banners = Array.from(document.querySelectorAll('div, section, aside, [role="alert"], [role="banner"], [role="dialog"]'));
            const banner = banners.find(el => {
              const t = (el.innerText || '').toLowerCase();
              return (
                t.includes('message and call notification') ||
                t.includes('notifications are off') ||
                (s.includes('notification') && t.includes('notification'))
              ) && t.length > 5 && t.length < 500;
            });
            if (banner) {
              if (actionType === 'click') {
                const closeBtn = banner.querySelector('button, [role="button"], span[data-icon="x"], [aria-label*="close" i]');
                if (closeBtn) return closeBtn;
              }
              return banner;
            }
          }

          // 5. High-Precision Scored Semantic Matching across interactive & leaf elements
          const wantsButton = /\b(button|btn|submit|toggle|reset|play|playback)\b/i.test(s);
          const wantsInput = /\b(input|field|search|textbox|textarea)\b/i.test(s);
          const wantsHeading = /\b(heading|title|header|h1|h2|h3)\b/i.test(s);
          const wantsSlider = /\b(slider|range|boost|bass|base|treble|frequency|eq|decibels?|volume|gain|threshold|noise|vad)\b/i.test(s);

          // Phonetic and acoustic stemming map (e.g. Whisper STT "base" -> "bass")
          function getAcousticVariants(tok) {
            const map = {
              'base': ['base', 'bass'],
              'bass': ['bass', 'base'],
              'db': ['db', 'decibel', 'decibels'],
              'decibel': ['decibel', 'decibels', 'db'],
              'decibels': ['decibels', 'decibel', 'db'],
              'vad': ['vad', 'voice'],
              'freq': ['freq', 'frequency'],
              'boost': ['boost', 'gain', 'slider']
            };
            return map[tok.toLowerCase()] || [tok.toLowerCase()];
          }

          // Normalize search tokens
          const cleanQuery = s
            .toLowerCase()
            .replace(/^[#\.]/, '')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/[-_]/g, ' ')
            .replace(/\b(the|button|btn|input|field|link|div|element|selector|node|from|to|into)\b/gi, '')
            .trim();

          const rawTokens = cleanQuery.split(/\s+/).filter(t => t.length > 1);
          const qTokens = [];
          for (const tok of rawTokens) {
            for (const v of getAcousticVariants(tok)) {
              if (!qTokens.includes(v)) qTokens.push(v);
            }
          }

          // Query candidate elements, prioritizing leaf interactive elements over large containers
          const candidates = Array.from(document.querySelectorAll(
            'button, input, [role="button"], a, select, textarea, h1, h2, h3, h4, h5, h6, label, p, span, div'
          ));

          let bestMatch = null;
          let highestScore = 0;

          for (const el of candidates) {
            const tag = el.tagName;
            const isButtonNode = tag === 'BUTTON' || el.getAttribute('role') === 'button' || tag === 'INPUT' && /^(button|submit|reset)$/i.test(el.type) || el.classList.contains('btn');
            const isInputNode = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
            const isRangeNode = tag === 'INPUT' && el.type === 'range';
            const isHeadingNode = /^(H1|H2|H3|H4|H5|H6)$/i.test(tag);
            const isContainer = (tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE' || tag === 'MAIN') && !isButtonNode;

            const text = (el.innerText || el.textContent || '').trim().toLowerCase();
            const valAttr = (el.value || '').trim().toLowerCase();
            const id = (el.id || '').toLowerCase();
            const name = (el.getAttribute('name') || '').toLowerCase();
            const title = (el.getAttribute('title') || '').toLowerCase();
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            const testid = (el.getAttribute('data-testid') || el.getAttribute('data-id') || '').toLowerCase();

            // Skip large containers if user explicitly targets a button, input, or slider
            if (isContainer && (wantsButton || wantsInput || wantsSlider) && text.length > 160) continue;

            let score = 0;

            // Role alignment weighting
            if (wantsButton) {
              if (isButtonNode) score += 300;
              else if (isContainer) score -= 250;
            } else if (wantsSlider) {
              if (isRangeNode) score += 400;
              else if (el.closest('.eq-bar, .slider-container') || el.parentElement?.querySelector('input[type="range"]')) score += 300;
            } else if (wantsInput) {
              if (isInputNode) score += 300;
              else if (isContainer) score -= 250;
            } else if (wantsHeading) {
              if (isHeadingNode) score += 300;
              else if (isContainer) score -= 200;
            }

            // Exact text, ID, or attribute match (highest confidence)
            if (cleanQuery && (text === cleanQuery || valAttr === cleanQuery || id === cleanQuery || aria === cleanQuery || testid === cleanQuery)) {
              score += 600;
            } else if (qTokens.length > 0) {
              // Token matching across all identifiers with phonetic variants
              let matchedCount = 0;
              const combined = [text, valAttr, id, name, title, aria, testid].join(' ');
              for (const tok of qTokens) {
                if (combined.includes(tok)) matchedCount++;
              }
              const ratio = matchedCount / Math.max(rawTokens.length, 1);
              score += ratio * 450;

              // Proximity bonus: shorter text closer to query length wins over huge ancestor containers
              if (text && rawTokens.every(tok => {
                const variants = getAcousticVariants(tok);
                return variants.some(v => text.includes(v));
              })) {
                score += 250;
                const lenDiff = Math.abs(text.length - cleanQuery.length);
                if (lenDiff < 10) score += 200;
                else if (lenDiff < 30) score += 100;
                else score -= 100;
              }
            }

            if (score > highestScore) {
              highestScore = score;
              if (isButtonNode) {
                bestMatch = el;
              } else if (isRangeNode) {
                bestMatch = el;
              } else {
                bestMatch = (el.closest('button, [role="button"]') || el);
              }
            }
          }

          // Validation Threshold: Minimum score required to prevent false-positive hijacking
          if (bestMatch && highestScore >= 320) {
            return bestMatch;
          }

          return null;
        }

        const el = resolveElement(rawSelector);
        if (!el) {
          return {
            success: false,
            error: 'Element not found on active page for: ' + rawSelector,
            triedSelector: rawSelector
          };
        }

        const prevContent = el.innerText || el.value || el.innerHTML || '';
        const prevStyle = el.getAttribute('style') || '';

        // Helper: Inject floating visible input editor overlay over static text node for reliable visual editing
        function injectVisibleInputEditor(targetEl, newValue) {
          try {
            const rect = targetEl.getBoundingClientRect();
            const computed = window.getComputedStyle(targetEl);

            // Remove any existing overlay
            const existing = document.querySelectorAll('.__adion_inline_editor__');
            existing.forEach(e => e.remove());

            const overlay = document.createElement('div');
            overlay.className = '__adion_inline_editor__';
            overlay.style.position = 'fixed';
            overlay.style.top = Math.max(0, rect.top - 6) + 'px';
            overlay.style.left = Math.max(0, rect.left - 6) + 'px';
            overlay.style.minWidth = Math.max(rect.width + 16, 140) + 'px';
            overlay.style.zIndex = '2147483647';
            overlay.style.display = 'flex';
            overlay.style.alignItems = 'center';
            overlay.style.gap = '8px';
            overlay.style.background = 'rgba(15, 17, 23, 0.96)';
            overlay.style.border = '2px solid #00f2fe';
            overlay.style.borderRadius = '8px';
            overlay.style.padding = '5px 10px';
            overlay.style.boxShadow = '0 8px 24px rgba(0, 242, 254, 0.45), 0 0 15px rgba(0, 0, 0, 0.8)';
            overlay.style.backdropFilter = 'blur(8px)';
            overlay.style.transition = 'all 0.35s cubic-bezier(0.16, 1, 0.3, 1)';
            overlay.style.opacity = '1';

            const badge = document.createElement('span');
            badge.innerText = 'AI Edit';
            badge.style.fontSize = '10px';
            badge.style.textTransform = 'uppercase';
            badge.style.letterSpacing = '1px';
            badge.style.background = 'linear-gradient(135deg, #00f2fe, #4facfe)';
            badge.style.color = '#0f1117';
            badge.style.fontWeight = '800';
            badge.style.padding = '2px 6px';
            badge.style.borderRadius = '4px';

            const input = document.createElement('input');
            input.type = 'text';
            input.value = newValue;
            input.style.background = 'transparent';
            input.style.border = 'none';
            input.style.outline = 'none';
            input.style.color = '#00f2fe';
            input.style.fontFamily = computed.fontFamily || 'sans-serif';
            input.style.fontSize = Math.max(parseFloat(computed.fontSize) || 14, 13) + 'px';
            input.style.fontWeight = 'bold';
            input.style.flex = '1';
            input.style.minWidth = '60px';

            overlay.appendChild(badge);
            overlay.appendChild(input);
            document.body.appendChild(overlay);

            // Animate highlight on target element
            const origOutline = targetEl.style.outline;
            targetEl.style.outline = '3px solid #00f2fe';
            targetEl.style.outlineOffset = '2px';

            // Auto-fade and clean up after 1.5 seconds
            setTimeout(() => {
              overlay.style.opacity = '0';
              overlay.style.transform = 'translateY(-6px)';
              targetEl.style.outline = origOutline;
              setTimeout(() => {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
              }, 400);
            }, 1500);
          } catch (_) {}
        }

        // 1. Detect if target or its context involves an input[type="range"] slider
        let targetSlider = null;
        let pairedValueNode = null;

        if (el.tagName === 'INPUT' && el.type === 'range') {
          targetSlider = el;
          pairedValueNode = el.parentElement?.querySelector('[id*="val" i], span:last-child') ||
                            document.getElementById('val' + el.id.replace(/^slider/i, ''));
        } else {
          // Check if inside an .eq-bar or slider container
          const eqContainer = el.closest('.eq-bar, .slider-container, div');
          if (eqContainer) {
            targetSlider = eqContainer.querySelector('input[type="range"]');
            pairedValueNode = eqContainer.querySelector('[id*="val" i], span:last-child');
          }
          if (!targetSlider && (rawSelector.toLowerCase().includes('bass') || rawSelector.toLowerCase().includes('base'))) {
            targetSlider = document.getElementById('sliderBass') || document.querySelector('input[type="range"][id*="bass" i]');
            pairedValueNode = document.getElementById('valBass');
          }
        }

        const isSliderAction = actionType === 'setValue' || actionType === 'setSlider' ||
          (targetSlider && /(-?\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|twelve)/i.test(val));

        // Apply Dynamic DOM Action
        if (actionType === 'remove' || actionType === 'delete') {
          el.remove();
        } else if (actionType === 'hide') {
          el.style.setProperty('display', 'none', 'important');
        } else if (actionType === 'show') {
          el.style.removeProperty('display');
        } else if (actionType === 'toggle') {
          el.style.display = (el.style.display === 'none') ? '' : 'none';
        } else if (isSliderAction && targetSlider) {
          // Range Slider Manipulation: Parse numeric value (including acoustic word forms)
          const wordNums = { 'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10, 'twelve': 12 };
          let numVal = null;

          const toMatch = val.match(/(?:to|into)\s+(-?\d+(?:\.\d+)?|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\b)/i);
          if (toMatch) {
            const rawNum = toMatch[1].toLowerCase();
            numVal = wordNums[rawNum] !== undefined ? wordNums[rawNum] : parseFloat(rawNum);
          } else {
            const directMatch = val.match(/-?\d+(?:\.\d+)?/);
            if (directMatch) {
              numVal = parseFloat(directMatch[0]);
            } else {
              for (const [w, n] of Object.entries(wordNums)) {
                if (new RegExp('\\b' + w + '\\b', 'i').test(val)) {
                  numVal = n;
                  break;
                }
              }
            }
          }

          if (numVal !== null && !isNaN(numVal)) {
            targetSlider.value = numVal;
            targetSlider.setAttribute('value', numVal);
            targetSlider.dispatchEvent(new Event('input', { bubbles: true }));
            targetSlider.dispatchEvent(new Event('change', { bubbles: true }));

            targetSlider.style.outline = '3px solid #00f2fe';
            setTimeout(() => { targetSlider.style.outline = ''; }, 1500);

            if (pairedValueNode) {
              const currentText = pairedValueNode.innerText || '';
              const unit = currentText.includes('RMS') ? ' RMS' : (currentText.includes('Hz') ? ' Hz' : ' dB');
              const displayStr = numVal + unit;
              pairedValueNode.innerText = displayStr;
              pairedValueNode.textContent = displayStr;
              pairedValueNode.dispatchEvent(new Event('change', { bubbles: true }));
              injectVisibleInputEditor(pairedValueNode, displayStr);
            }
          }
        } else if (actionType === 'setText' || actionType === 'text' || actionType === 'setValue') {
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            el.value = val;
          } else {
            // Static text node (h1-h6, p, span, label, div, button):
            // Inject visible floating input field over the static text node for reliable visual editing
            el.innerText = val;
            el.textContent = val;
            injectVisibleInputEditor(el, val);
          }
        } else if (actionType === 'setHTML' || actionType === 'html') {
          el.innerHTML = val;
        } else if (actionType === 'setStyle' || actionType === 'style' || actionType === 'setColor' || actionType === 'setBackground') {
          const isButton = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.classList.contains('btn');
          const isRawColor = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(val.trim()) ||
            /^(yellow|red|green|blue|orange|purple|pink|cyan|white|black|gold|crimson|lime|emerald|teal)$/i.test(val.trim()) ||
            val.trim().startsWith('rgb');

          if (isRawColor || actionType === 'setColor' || actionType === 'setBackground') {
            let color = val.trim().replace(/;$/, '');
            if (color === 'green') color = '#10b981'; // Modern vivid emerald
            if (color === 'yellow') color = '#ffeb3b';

            el.style.setProperty('background', color, 'important');
            el.style.setProperty('background-color', color, 'important');
            el.style.setProperty('background-image', 'none', 'important');
            if (/yellow|gold|#ff|#fe|white|cyan|lime/i.test(color)) {
              el.style.setProperty('color', '#0f1117', 'important');
            } else {
              el.style.setProperty('color', '#ffffff', 'important');
            }
            el.style.setProperty('box-shadow', '0 0 20px ' + color, 'important');
          } else {
            // Parse CSS property declarations into a structured map
            const declarations = val.split(';').map(s => s.trim()).filter(Boolean);
            const propMap = {};
            for (const decl of declarations) {
              const colonIdx = decl.indexOf(':');
              if (colonIdx > 0) {
                const prop = decl.slice(0, colonIdx).trim().toLowerCase();
                const rawV = decl.slice(colonIdx + 1).replace(/!important/g, '').trim();
                propMap[prop] = rawV;
              }
            }

            let bgVal = propMap['background'] || propMap['background-color'] || null;
            let textVal = propMap['color'] || null;

            // If user commanded a color on a button without specifying "background" (e.g. only passed "color: red")
            if (!bgVal && textVal && isButton) {
              bgVal = textVal;
              textVal = null;
            }

            // Apply background color if present
            if (bgVal) {
              if (bgVal === 'green') bgVal = '#10b981';
              if (bgVal === 'yellow') bgVal = '#ffeb3b';
              el.style.setProperty('background', bgVal, 'important');
              el.style.setProperty('background-color', bgVal, 'important');
              el.style.setProperty('background-image', 'none', 'important');
              el.style.setProperty('box-shadow', '0 0 20px ' + bgVal, 'important');

              // If no explicit text color was requested, ensure high-contrast legibility
              if (!textVal) {
                if (/yellow|gold|#ffeb|white|cyan|lime/i.test(bgVal)) {
                  el.style.setProperty('color', '#0f1117', 'important');
                } else {
                  el.style.setProperty('color', '#ffffff', 'important');
                }
              }
            }

            // Apply explicit text color if provided
            if (textVal) {
              el.style.setProperty('color', textVal, 'important');
            }

            // Apply all other CSS declarations (e.g. font-size, border, padding)
            for (const [prop, rawV] of Object.entries(propMap)) {
              if (prop !== 'background' && prop !== 'background-color' && prop !== 'color') {
                el.style.setProperty(prop, rawV, 'important');
              }
            }
          }
        } else if (actionType === 'setAttribute' || actionType === 'attr') {
          el.setAttribute(attr || 'data-ai-modified', val);
        } else if (actionType === 'append') {
          el.innerHTML += val;
        }

        // Trigger reactive DOM updates & dispatch events
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));

        // DevTools Console Integration: Log structured mutation details into page DevTools
        try {
          console.group('%c[Adion DevTools]%c DOM Element Modified: <' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '>', 'background:#00f2fe;color:#000;font-weight:bold;padding:2px 6px;border-radius:3px;', 'font-weight:bold;');
          console.log('Action:', actionType);
          console.log('Value:', val);
          console.log('Target Node:', el);
          console.log('Final Applied Style:', el.getAttribute('style'));
          console.groupEnd();
        } catch (_) {}

        // Scroll into center view smoothly so the user sees the modification
        try {
          el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        } catch(e) {}

        // Flash visual highlight pulse to confirm render update
        const origOutline = el.style.outline;
        const origTransition = el.style.transition;
        el.style.transition = 'all 0.3s ease';
        el.style.outline = '3px solid #00f2fe';
        setTimeout(() => {
          el.style.outline = origOutline;
          el.style.transition = origTransition;
        }, 1500);

        return {
          success: true,
          resolvedSelector: el.id ? '#' + el.id : el.tagName.toLowerCase(),
          elementId: el.id || '',
          renderedTag: el.tagName,
          action: actionType,
          appliedValue: val,
          finalStyle: el.getAttribute('style') || '',
          finalOuterHTML: el.outerHTML,
          previous: prevContent.slice(0, 80),
          current: (el.innerText || el.value || el.innerHTML || '').slice(0, 80),
          computedBackground: window.getComputedStyle(el).backgroundColor,
          computedColor: window.getComputedStyle(el).color
        };
      })()
    `;

    return this.evaluate(expr);
  }

  /**
   * Inspect a specific DOM element and return bounding box, tag name, and classes
   */
  async inspectElement(selector) {
    if (!this.isAttached) throw new Error('CDP not attached to active tab');

    const expr = `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { found: false };
        const rect = el.getBoundingClientRect();
        return {
          found: true,
          tagName: el.tagName,
          id: el.id,
          className: el.className,
          text: (el.innerText || '').slice(0, 100),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      })()
    `;

    const result = await this.evaluate(expr);
    if (result && result.found) {
      await this.highlightElement(result.x, result.y, result.width, result.height, `Inspect: ${selector}`);
    }
    return result;
  }

  /**
   * Extract lightweight structural summary of the active page (title, url, top headings, interactive buttons, inputs)
   * Provided to LLM planning to ground dynamic DOM actions to actual elements on the loaded page.
   */
  async getPageSummary() {
    if (!this.isAttached) return null;
    const expr = `
      (() => {
        const title = document.title || '';
        const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
          .slice(0, 8)
          .map(h => (h.innerText || '').trim())
          .filter(t => t.length > 0 && t.length < 80);

        const interactive = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"], [role="button"]'))
          .slice(0, 12)
          .map(el => (el.innerText || el.value || el.getAttribute('aria-label') || el.id || '').trim())
          .filter(t => t.length > 0 && t.length < 50);

        return {
          title,
          headings: headings.slice(0, 5),
          buttons: interactive.slice(0, 8)
        };
      })()
    `;
    try {
      return await this.evaluate(expr);
    } catch (_) {
      return null;
    }
  }

  /**
   * Full accessibility tree — the browser equivalent of D:\help's UIA screen
   * map. One CDP call returns every semantic node (role, name, states) that
   * Chromium exposes to assistive tech. Fast (~50-200ms) vs multi-second
   * DOM-grounding scripts.
   */
  async getAXTree() {
    if (!this.isAttached) throw new Error('CDP not attached');
    const res = await this.sendCommand('Accessibility.getFullAXTree', {}, 6000);
    return res && Array.isArray(res.nodes) ? res.nodes : [];
  }

  /**
   * Viewport-center coordinates of an AX node, resolved via its backend DOM
   * node. Returns {x, y} in CSS pixels or null when the node has no box.
   */
  async getNodeCenter(backendNodeId) {
    if (!this.isAttached || !backendNodeId) return null;
    try {
      const res = await this.sendCommand('DOM.getContentQuads', { backendNodeId }, 3000);
      const quads = res && res.quads;
      if (!quads || !quads.length) return null;
      // quads are flat [x1,y1,x2,y2,...] arrays in root-frame CSS px
      const q = quads[0];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i + 1 < q.length; i += 2) {
        minX = Math.min(minX, q[i]); maxX = Math.max(maxX, q[i]);
        minY = Math.min(minY, q[i + 1]); maxY = Math.max(maxY, q[i + 1]);
      }
      if (!Number.isFinite(minX)) return null;
      return { x: Math.round((minX + maxX) / 2), y: Math.round((minY + maxY) / 2), w: Math.round(maxX - minX), h: Math.round(maxY - minY) };
    } catch (_) {
      return null;
    }
  }
}

module.exports = CDPBridge;

