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
}

module.exports = CDPBridge;

