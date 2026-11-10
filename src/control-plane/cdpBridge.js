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

        // Multi-tier Smart Element Resolver
        function resolveElement(sel) {
          if (!sel) return null;

          // 1. Exact CSS querySelector
          try {
            const el = document.querySelector(sel);
            if (el) return el;
          } catch(e) {}

          // 2. Direct ID or Class lookup (strip leading # or .)
          const cleanId = sel.replace(/^[#\\.]/, '').trim();
          const elById = document.getElementById(cleanId);
          if (elById) return elById;

          // 3. Data attributes lookup
          try {
            const dataMatch = document.querySelector(
              '[data-id="' + cleanId + '"], [data-testid="' + cleanId + '"], [name="' + cleanId + '"], [data-action="' + cleanId + '"]'
            );
            if (dataMatch) return dataMatch;
          } catch(e) {}

          // 4. Token-based semantic & text search across all elements
          const cleanText = sel
            .toLowerCase()
            .replace(/^[#\\.]/, '')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/[-_]/g, ' ')
            .replace(/\\b(button|btn|input|field|link|div|element|selector)\\b/gi, '')
            .trim();

          const all = Array.from(document.querySelectorAll('button, a, input, select, textarea, div, span, p, h1, h2, h3, h4, h5, h6, label, canvas, [role="button"]'));

          // 4A. Text, Title, Aria-label, or ID exact/substring match
          for (const el of all) {
            const text = (el.innerText || el.textContent || '').trim().toLowerCase();
            const id = (el.id || '').toLowerCase();
            const title = (el.getAttribute('title') || '').toLowerCase();
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            const testid = (el.getAttribute('data-testid') || '').toLowerCase();

            if (cleanText && (
              text.includes(cleanText) ||
              id.includes(cleanText.replace(/\\s+/g, '')) ||
              title.includes(cleanText) ||
              aria.includes(cleanText) ||
              testid.includes(cleanText.replace(/\\s+/g, ''))
            )) {
              return el.closest('button, a, [role="button"]') || el;
            }
          }

          // 4B. Word token matching (all keywords present)
          const tokens = cleanText.split(/\\s+/).filter(t => t.length > 1);
          if (tokens.length > 0) {
            for (const el of all) {
              const combined = [
                el.innerText || '',
                el.id || '',
                el.getAttribute('title') || '',
                el.getAttribute('aria-label') || '',
                el.getAttribute('data-testid') || ''
              ].join(' ').toLowerCase();

              if (tokens.every(token => combined.includes(token))) {
                return el.closest('button, a, [role="button"]') || el;
              }
            }
          }

          // 5. Fallback: if selector was button and there is a primary button
          if (/button|btn/i.test(sel)) {
            const firstBtn = document.querySelector('button.btn, button');
            if (firstBtn) return firstBtn;
          }

          return null;
        }

        const el = resolveElement(rawSelector);
        if (!el) {
          return {
            success: false,
            error: 'Element not found for selector: ' + rawSelector,
            triedSelector: rawSelector
          };
        }

        const prevContent = el.innerText || el.value || el.innerHTML || '';
        const prevStyle = el.getAttribute('style') || '';

        // Apply DOM Action
        if (actionType === 'setText' || actionType === 'text') {
          el.innerText = val;
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
            // Parse CSS property declarations
            const declarations = val.split(';').map(s => s.trim()).filter(Boolean);
            let hasBgChange = false;
            for (const decl of declarations) {
              const colonIdx = decl.indexOf(':');
              if (colonIdx > 0) {
                const prop = decl.slice(0, colonIdx).trim().toLowerCase();
                let rawV = decl.slice(colonIdx + 1).replace(/!important/g, '').trim();
                if (rawV === 'green') rawV = '#10b981';
                if (rawV === 'yellow') rawV = '#ffeb3b';

                // If user/LLM sets "color: green" on a button or background, make the button background that color
                if (prop === 'background' || prop === 'background-color' || (prop === 'color' && isButton)) {
                  hasBgChange = true;
                  el.style.setProperty('background', rawV, 'important');
                  el.style.setProperty('background-color', rawV, 'important');
                  el.style.setProperty('background-image', 'none', 'important');
                  if (/yellow|gold|#ff|#fe|white|cyan|lime/i.test(rawV)) {
                    el.style.setProperty('color', '#0f1117', 'important');
                  } else {
                    el.style.setProperty('color', '#ffffff', 'important');
                  }
                  el.style.setProperty('box-shadow', '0 0 20px ' + rawV, 'important');
                } else {
                  el.style.setProperty(prop, rawV, 'important');
                }
              }
            }
            if (!hasBgChange && declarations.length === 0 && val) {
              el.style.cssText += ';' + val;
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
}

module.exports = CDPBridge;

