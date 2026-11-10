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
   * Locate an interactive element matching a query or selector and return its bounding box coordinates
   */
  async findElementCoordinates(target) {
    const expr = `
      (() => {
        const query = ${JSON.stringify(target.toLowerCase())};
        // Check for exact CSS selector first
        let el = null;
        try { el = document.querySelector(query); } catch(e){}

        if (!el) {
          // Search through buttons, links, inputs, and clickable elements
          const candidates = Array.from(document.querySelectorAll('button, a, input, [role="button"], h1, h2, h3, p, span'));
          el = candidates.find(item => {
            const text = (item.innerText || item.getAttribute('aria-label') || item.getAttribute('placeholder') || item.value || '').trim().toLowerCase();
            return text.includes(query);
          });
        }

        if (el) {
          const rect = el.getBoundingClientRect();
          // Ensure element is visible
          if (rect.width > 0 && rect.height > 0) {
            return {
              found: true,
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
              width: rect.width,
              height: rect.height,
              tag: el.tagName,
              text: (el.innerText || '').slice(0, 50)
            };
          }
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

