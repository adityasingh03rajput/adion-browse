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
   * Send a CDP command to the attached Chromium session
   */
  async sendCommand(method, params = {}) {
    if (!this.isAttached || !this.currentWebContents) {
      throw new Error(`CDP not attached. Cannot send command: ${method}`);
    }
    return this.currentWebContents.debugger.sendCommand(method, params);
  }

  /**
   * Dispatch synthetic mouse click at exact pixel coordinates
   */
  async dispatchClick(x, y, button = 'left', clickCount = 1) {
    if (!this.isAttached) throw new Error('CDP not attached');

    // 1. Move to coordinates
    await this.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x),
      y: Math.round(y)
    });

    // 2. Mouse Press
    await this.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: Math.round(x),
      y: Math.round(y),
      button,
      clickCount
    });

    // 3. Mouse Release
    await this.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: Math.round(x),
      y: Math.round(y),
      button,
      clickCount
    });

    return { x, y, clicked: true };
  }

  /**
   * Smooth natural scrolling via synthetic mouse wheel delta events
   */
  async dispatchScroll(deltaY, steps = 5, delayMs = 16) {
    if (!this.isAttached) throw new Error('CDP not attached');

    const stepDelta = deltaY / steps;
    for (let i = 0; i < steps; i++) {
      await this.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: 400,
        y: 400,
        deltaX: 0,
        deltaY: Math.round(stepDelta)
      });
      if (delayMs > 0 && i < steps - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
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
          const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
          const title = (el.getAttribute('title') || '').toLowerCase();
          const alt = (el.getAttribute('alt') || '').toLowerCase();
          const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
          const id = (el.id || '').toLowerCase();

          // Check for keyword matches
          if (ariaLabel === query || title === query || text === query || alt === query) {
            score = 100;
          } else if (ariaLabel.includes(query) || title.includes(query) || alt.includes(query)) {
            score = 80;
          } else if (text.length < 120 && text.includes(query)) {
            score = 65;
          } else if (text.includes(query)) {
            score = 45;
          } else if (placeholder.includes(query) || id.includes(query)) {
            score = 40;
          }

          // Bias towards clickable elements
          const isClickable = el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT' || el.getAttribute('role') === 'button' || el.onclick != null || window.getComputedStyle(el).cursor === 'pointer';
          if (isClickable && score > 0) {
            score += 25;
          }

          if (score > highestScore) {
            highestScore = score;
            bestMatch = el;
          }
        }

        if (bestMatch && highestScore >= 40) {
          // If bestMatch is inside an anchor or button (e.g. video card, thumbnail image), target the clickable container
          const clickable = bestMatch.closest('a, button, [role="button"]') || bestMatch;
          try {
            clickable.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
          } catch(e) {}
          const newRect = clickable.getBoundingClientRect();

          // Dispatch synthetic DOM click as direct trigger
          try {
            clickable.focus();
            clickable.click();
          } catch(e) {}

          return {
            found: true,
            score: highestScore,
            x: Math.round(newRect.left + newRect.width / 2),
            y: Math.round(newRect.top + newRect.height / 2),
            width: Math.round(newRect.width),
            height: Math.round(newRect.height),
            tag: clickable.tagName,
            label: (clickable.getAttribute('aria-label') || clickable.innerText || clickable.title || clickable.getAttribute('alt') || '').slice(0, 50)
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

          // 5. High-Precision Scored Semantic Matching across interactive & leaf elements
          const wantsButton = /\\b(button|btn|submit|toggle|reset|play|playback)\\b/i.test(s);
          const wantsInput = /\\b(input|field|search|textbox|textarea)\\b/i.test(s);
          const wantsHeading = /\\b(heading|title|header|h1|h2|h3)\\b/i.test(s);

          // Normalize search tokens
          const cleanQuery = s
            .toLowerCase()
            .replace(/^[#\\.]/, '')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/[-_]/g, ' ')
            .replace(/\\b(the|button|btn|input|field|link|div|element|selector|node)\\b/gi, '')
            .trim();

          const qTokens = cleanQuery.split(/\\s+/).filter(t => t.length > 1);

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
            const isHeadingNode = /^(H1|H2|H3|H4|H5|H6)$/i.test(tag);
            const isContainer = (tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE' || tag === 'MAIN') && !isButtonNode;

            const text = (el.innerText || el.textContent || '').trim().toLowerCase();
            const valAttr = (el.value || '').trim().toLowerCase();
            const id = (el.id || '').toLowerCase();
            const name = (el.getAttribute('name') || '').toLowerCase();
            const title = (el.getAttribute('title') || '').toLowerCase();
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            const testid = (el.getAttribute('data-testid') || el.getAttribute('data-id') || '').toLowerCase();

            // Skip large containers if user explicitly targets a button or input
            if (isContainer && (wantsButton || wantsInput) && text.length > 150) continue;

            let score = 0;

            // Role alignment weighting
            if (wantsButton) {
              if (isButtonNode) score += 300;
              else if (isContainer) score -= 250;
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
              // Token matching across all identifiers
              let matchedCount = 0;
              const combined = [text, valAttr, id, name, title, aria, testid].join(' ');
              for (const tok of qTokens) {
                if (combined.includes(tok)) matchedCount++;
              }
              const ratio = matchedCount / qTokens.length;
              score += ratio * 400;

              // Proximity bonus: shorter text closer to query length wins over huge ancestor containers
              if (text && qTokens.every(tok => text.includes(tok))) {
                score += 200;
                const lenDiff = Math.abs(text.length - cleanQuery.length);
                if (lenDiff < 10) score += 200;
                else if (lenDiff < 30) score += 100;
                else score -= 100;
              }
            }

            if (score > highestScore) {
              highestScore = score;
              bestMatch = isButtonNode ? el : (el.closest('button, [role="button"]') || el);
            }
          }

          // Validation Threshold: Minimum score required to prevent false-positive hijacking
          if (bestMatch && highestScore >= 350) {
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

        // Apply Dynamic DOM Action
        if (actionType === 'remove' || actionType === 'delete') {
          el.remove();
        } else if (actionType === 'hide') {
          el.style.setProperty('display', 'none', 'important');
        } else if (actionType === 'show') {
          el.style.removeProperty('display');
        } else if (actionType === 'toggle') {
          el.style.display = (el.style.display === 'none') ? '' : 'none';
        } else if (actionType === 'setText' || actionType === 'text') {
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            el.value = val;
          } else {
            el.innerText = val;
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
}

module.exports = CDPBridge;

