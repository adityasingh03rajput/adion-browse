'use strict';

/**
 * Deterministic Sensitive Data & Privacy Guard
 * Adapted from companion/src/guide/sensitive.js
 * 
 * Enforced unconditionally on input actions to ensure that passwords,
 * credit cards, CVVs, OTPs, and SSNs are NEVER captured, typed, or logged by the AI.
 */

const SENSITIVE_NAME_RE = /\b(password|passcode|passwd|pwd|pin|cvv|cvc|ssn|passport|otp)\b|\b(?:card|credit|debit|account|routing|social security|national id|government id|tax id|driver.?s? licen[cs]e)\s*(?:number|no|num)?\b|\b(?:security|verification|one time)\s*code\b/i;
const SENSITIVE_FIELD_TYPES = new Set(['password', 'cvv', 'pin']);

function normalizeText(text) {
  return String(text || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').toLowerCase();
}

function isSensitiveField(element = {}) {
  if (!element) return false;
  if (element.isPassword === true || element.sensitive === true) return true;
  
  const type = String(element.type || '').toLowerCase();
  if (SENSITIVE_FIELD_TYPES.has(type)) return true;

  const combined = normalizeText([
    element.name,
    element.label,
    element.placeholder,
    element.target,
    element.selector,
    element.ariaLabel,
    element.id
  ].filter(Boolean).join(' '));

  return SENSITIVE_NAME_RE.test(combined);
}

function looksLikeSecret(value) {
  const str = String(value || '');
  // 8 or more digits in a row (card numbers, SSN, OTPs)
  if (/(?:\d[\s-]?){8,}/.test(str)) return true;
  return false;
}

const PRIVACY_REFUSAL = 'This is a sensitive or private field (e.g. password, card, or verification code). Please enter it yourself, and I will continue when you are done.';

module.exports = { isSensitiveField, looksLikeSecret, PRIVACY_REFUSAL };
