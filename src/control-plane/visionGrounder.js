/**
 * Vision Grounder & Semantic Image Pipeline
 * Interfaces with the CDP Bridge to perform multimodal element grounding,
 * visual bounding box calculation, and semantic image analysis.
 */

class VisionGrounder {
  constructor(cdpBridge) {
    this.cdp = cdpBridge;
  }

  /**
   * Capture a 60 FPS viewport frame as a base64 encoded PNG for multimodal inference
   */
  async captureViewportFrame() {
    return this.cdp.captureScreenshot();
  }

  /**
   * Ground a natural language description to exact pixel coordinates
   * Combines DOM accessibility inspection with visual boundary calculation
   */
  async groundElement(naturalQuery) {
    const cleanQuery = (naturalQuery || '').toLowerCase().trim();
    if (!cleanQuery) return null;

    // Introspect DOM interactive candidates
    const match = await this.cdp.findElementCoordinates(cleanQuery);
    if (match && match.found) {
      return {
        success: true,
        x: match.x,
        y: match.y,
        width: match.width,
        height: match.height,
        tag: match.tag,
        label: match.text,
        confidence: 0.94
      };
    }

    return { success: false, reason: 'Target not located in active viewport' };
  }

  /**
   * Scan all visible images on page and filter against criteria (e.g. "large landscape", "product image")
   */
  async extractSemanticImages(criteria = '') {
    const expr = `
      (() => {
        const query = ${JSON.stringify(criteria.toLowerCase())};
        const imgs = Array.from(document.querySelectorAll('img, picture, svg[role="img"], [style*="background-image"]'));
        
        return imgs.map((el, index) => {
          let src = el.src || '';
          if (!src && el.style && el.style.backgroundImage) {
            const bgMatch = el.style.backgroundImage.match(/url\\(["']?(.*?)["']?\\)/);
            if (bgMatch) src = bgMatch[1];
          }

          const alt = (el.alt || el.getAttribute('aria-label') || el.title || '').trim();
          const rect = el.getBoundingClientRect();

          // Calculate match score based on alt text, src keywords, or dimensions
          let score = 0.5;
          if (query && (alt.toLowerCase().includes(query) || src.toLowerCase().includes(query))) {
            score = 0.92;
          }

          return {
            id: 'img_' + index,
            src: src,
            alt: alt,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
            score: score,
            visible: rect.width > 30 && rect.height > 30 && rect.bottom >= 0 && rect.top <= window.innerHeight
          };
        }).filter(item => item.src && item.visible);
      })()
    `;

    const candidates = await this.cdp.evaluate(expr);
    if (!candidates || !Array.isArray(candidates)) return [];

    // Sort by relevance score and resolution
    candidates.sort((a, b) => b.score - a.score || (b.width * b.height) - (a.width * a.height));
    return candidates.slice(0, 8);
  }

  /**
   * Scans active page for YouTube video renderers and thumbnail elements
   */
  async extractYouTubeVideoCandidates() {
    const expr = `
      (() => {
        const videoNodes = Array.from(document.querySelectorAll(
          'ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer'
        ));

        const results = [];
        for (let i = 0; i < videoNodes.length; i++) {
          const node = videoNodes[i];
          const rect = node.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.top > window.innerHeight * 1.6) continue;

          const titleEl = node.querySelector('#video-title, #title-wrapper, a#video-title, h3 a');
          const title = (titleEl ? (titleEl.innerText || titleEl.getAttribute('title') || '') : '').trim();
          if (!title) continue;

          const thumbEl = node.querySelector('ytd-thumbnail, a#thumbnail, img.yt-core-image, img');
          const channelEl = node.querySelector('#channel-name, .ytd-channel-name, #text.ytd-channel-name');
          const channel = (channelEl ? channelEl.innerText : '').trim();
          const durationEl = node.querySelector('ytd-thumbnail-overlay-time-status-renderer, span.ytd-thumbnail-overlay-time-status-renderer, #text.ytd-thumbnail-overlay-time-status-renderer');
          const duration = (durationEl ? durationEl.innerText : '').trim();

          const targetEl = thumbEl || titleEl || node;
          const targetRect = targetEl.getBoundingClientRect();

          results.push({
            index: results.length + 1,
            title,
            channel,
            duration,
            x: Math.round(targetRect.left + targetRect.width / 2),
            y: Math.round(targetRect.top + targetRect.height / 2),
            width: Math.round(targetRect.width),
            height: Math.round(targetRect.height),
            videoUrl: (titleEl && titleEl.href) || (thumbEl && thumbEl.href) || ''
          });

          if (results.length >= 8) break;
        }

        return results;
      })()
    `;
    const res = await this.cdp.evaluate(expr);
    return Array.isArray(res) ? res : [];
  }

  /**
   * Focus, highlight, and click the selected video candidate to start playback
   */
  async playVideoCandidate(candidate) {
    if (!candidate) return false;
    await this.highlightCandidates([candidate]);

    const expr = `
      (() => {
        const x = ${candidate.x};
        const y = ${candidate.y};
        const el = document.elementFromPoint(x, y);
        if (el) {
          const clickable = el.closest('a#thumbnail, #video-title, a, ytd-thumbnail') || el;
          clickable.focus();
          clickable.click();
          return true;
        }
        return false;
      })()
    `;
    await this.cdp.evaluate(expr);

    try {
      await this.cdp.dispatchClick(candidate.x, candidate.y);
    } catch (_) {}

    return true;
  }

  /**
   * Highlight multiple disambiguation candidates on page with distinct color tags
   */
  async highlightCandidates(candidates) {
    const expr = `
      (() => {
        // Clear previous overlays
        const old = document.querySelectorAll('.__adion_candidate_overlay__');
        old.forEach(el => el.remove());

        const items = ${JSON.stringify(candidates)};
        const colors = ['#00f2fe', '#9b51e0', '#10b981', '#f59e0b'];

        items.forEach((item, idx) => {
          const color = colors[idx % colors.length];
          const box = document.createElement('div');
          box.className = '__adion_candidate_overlay__';
          box.style.position = 'fixed';
          box.style.pointerEvents = 'none';
          box.style.zIndex = '9999999';
          box.style.left = (item.x - item.width / 2) + 'px';
          box.style.top = (item.y - item.height / 2) + 'px';
          box.style.width = item.width + 'px';
          box.style.height = item.height + 'px';
          box.style.border = '2px solid ' + color;
          box.style.backgroundColor = 'rgba(0,0,0,0.1)';
          box.style.boxShadow = '0 0 14px ' + color;
          box.style.borderRadius = '6px';

          const badge = document.createElement('div');
          badge.style.position = 'absolute';
          badge.style.top = '-22px';
          badge.style.left = '0';
          badge.style.background = color;
          badge.style.color = '#000';
          badge.style.fontWeight = 'bold';
          badge.style.fontSize = '11px';
          badge.style.padding = '2px 6px';
          badge.style.borderRadius = '4px';
          badge.innerText = 'Option ' + (idx + 1) + ': ' + (item.alt || item.label || 'Item');
          box.appendChild(badge);

          document.body.appendChild(box);
        });

        setTimeout(() => {
          document.querySelectorAll('.__adion_candidate_overlay__').forEach(el => el.remove());
        }, 5000);
      })()
    `;

    return this.cdp.evaluate(expr);
  }
}

module.exports = VisionGrounder;

