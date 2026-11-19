/**
 * Adion Browse — PC grounding (coordinates, matching, reconciliation)
 *
 * Adapted from nus-companion's guide/verify.js and guide/chooser.js
 * (Apache-2.0, potlakai/nus-companion v0.1.21), merged and renamed.
 *
 * Two jobs:
 *   1. Map between the three coordinate spaces a screenshot introduces
 *      (normalized fractions <-> physical screen pixels <-> overlay DIPs).
 *   2. Reconcile what the model claims ("this box, labelled Save") with what
 *      Windows actually reports, and refuse when two controls are too close to
 *      call. A wrong pointer is worse than no pointer.
 *
 * Pure functions; no Electron.
 */

'use strict';

const GENERIC_WORDS = new Set([
  'the', 'a', 'an', 'button', 'icon', 'menu', 'item', 'field', 'link', 'tab',
  'option', 'box', 'click', 'press', 'open', 'on', 'in', 'to', 'at', 'of'
]);

const NEAR_RADIUS_PX = 90;
const PICK_THRESHOLD = 0.55;
const AMBIGUOUS_MARGIN = 0.05;
const MAX_CONTROL_AREA = 400 * 200;

function tokens(text) {
  const out = new Set();
  for (const word of String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []) {
    const trimmed = word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
    if (trimmed.length > 1 && !GENERIC_WORDS.has(trimmed)) out.add(trimmed);
  }
  return out;
}

/** Fraction of the shorter token set found in the other, 0..1. */
function tokenOverlap(a, b) {
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size || !right.size) return 0;
  const [small, big] = left.size <= right.size ? [left, right] : [right, left];
  let hits = 0;
  for (const token of small) if (big.has(token)) hits++;
  return hits / small.size;
}

function iou(a, b) {
  if (!a || !b) return 0;
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - intersection;
  return union > 0 ? intersection / union : 0;
}

/** Physical rect -> fractions of the captured display. */
function normRect(rect, capture, originPhys) {
  return {
    x: (rect.x - originPhys.x) / capture.pxWidth,
    y: (rect.y - originPhys.y) / capture.pxHeight,
    w: rect.w / capture.pxWidth,
    h: rect.h / capture.pxHeight
  };
}

/** Fractions of the captured display -> physical rect. */
function physRect(box, capture, originPhys) {
  return {
    x: Math.round(originPhys.x + box.x * capture.pxWidth),
    y: Math.round(originPhys.y + box.y * capture.pxHeight),
    w: Math.round(box.w * capture.pxWidth),
    h: Math.round(box.h * capture.pxHeight)
  };
}

function rectCentre(rect) {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function containsPoint(rect, point) {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
}

/**
 * 0..1: how likely `element` is what `label` means, given a point.
 * 0.6 words + 0.25 nearness + 0.15 "the point is inside it".
 */
function scoreElement(label, point, element, radius = NEAR_RADIUS_PX) {
  const centre = rectCentre(element.rect);
  const distance = point ? Math.hypot(centre.x - point.x, centre.y - point.y) : radius;
  const nearness = Math.max(0, 1 - distance / radius);
  const inside = point && containsPoint(element.rect, point) ? 1 : 0;
  return 0.6 * tokenOverlap(label, element.name) + 0.25 * nearness + 0.15 * inside;
}

/**
 * The clear winner, or null.
 * elements: [{ id, name, type, rect }]; point: { x, y } in physical px.
 * -> { element, score, margin } | null
 */
function chooseElement(label, point, elements, options = {}) {
  const radius = options.radius || NEAR_RADIUS_PX;
  const threshold = options.threshold != null ? options.threshold : PICK_THRESHOLD;
  const maxArea = options.maxArea || MAX_CONTROL_AREA;
  if (!String(label || '').trim()) return null;
  const pool = (elements || []).filter(
    (element) => element && element.rect && element.rect.w > 0 && element.rect.h > 0 &&
      element.rect.w * element.rect.h <= maxArea
  );
  if (!pool.length) return null;
  const scored = pool
    .map((element) => ({ element, score: scoreElement(label, point, element, radius) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (best.score < threshold) return null;
  const margin = scored.length > 1 ? best.score - scored[1].score : best.score;
  if (scored.length > 1 && margin < AMBIGUOUS_MARGIN) return null;
  return { element: best.element, score: best.score, margin };
}

/**
 * Turn a validated model target into a physical rect, or null.
 *   target:   { kind:'element', id } | { kind:'bbox', x,y,w,h,label }
 *   elements: probe list, each { id, name, type, rect (physical) }
 * When Windows cannot confirm the box, the model's box is kept but flagged
 * `verified: false`, so the caller can say "best guess" instead of pretending.
 */
function reconcileTarget({ target, elements, bboxPhys, fromPoint, found }) {
  if (!target) return null;
  if (target.kind === 'element') {
    const element = (elements || []).find((candidate) => Number(candidate.id) === Number(target.id));
    return element && element.rect
      ? { rect: element.rect, name: element.name || '', type: element.type || '', source: 'element', verified: true }
      : null;
  }
  if (target.kind !== 'bbox' || !bboxPhys) return null;
  const label = target.label || '';

  if (fromPoint && fromPoint.rect) {
    const nameOk = label && tokenOverlap(fromPoint.name, label) >= 0.5;
    const boxOk = iou(fromPoint.rect, bboxPhys) >= 0.3;
    if (nameOk || boxOk) {
      return {
        rect: fromPoint.rect,
        name: fromPoint.name || label,
        type: fromPoint.type || '',
        source: nameOk ? 'frompoint-name' : 'frompoint-box',
        verified: true
      };
    }
  }
  if (found && found.rect && iou(found.rect, bboxPhys) >= 0.3) {
    return { rect: found.rect, name: found.name || label, type: found.type || '', source: 'find', verified: true };
  }
  return { rect: bboxPhys, name: label, type: '', source: 'model', verified: false };
}

/** A stable signature of a control list, for "has this screen settled". */
function controlSignature(elements, grid = 16) {
  const rows = (elements || [])
    .filter((element) => element && element.rect)
    .map((element) => {
      const name = String(element.name || '').replace(/\d+/g, '#').trim().toLowerCase();
      const rect = element.rect;
      return `${element.type || ''}|${name}|${Math.round(rect.x / grid)},${Math.round(rect.y / grid)}`;
    });
  rows.sort();
  return rows.join('\n');
}

module.exports = {
  tokens,
  tokenOverlap,
  iou,
  normRect,
  physRect,
  rectCentre,
  containsPoint,
  scoreElement,
  chooseElement,
  reconcileTarget,
  controlSignature,
  GENERIC_WORDS,
  NEAR_RADIUS_PX,
  PICK_THRESHOLD,
  AMBIGUOUS_MARGIN
};
