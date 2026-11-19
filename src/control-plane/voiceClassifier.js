'use strict';

/**
 * Voice Utterance Cleaner & Zero-Latency Classifier
 * Adapted from companion/src/guide/voice.js
 * 
 * Provides deterministic classification for voice and text commands to immediately
 * handle cancellations and continuations without burning slow model inference calls.
 */

function cleanTranscript(text) {
  const t = String(text || '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > 1 ? t : '';
}

const DISMISS_RE = /^(?:(?:ok(?:ay)?|alright|cool|thanks|nah)[,.! ]+)?(?:never ?mind|stop(?: talking| it| there| please)?|cancel|that'?s (?:all|it|enough)|enough|go away|leave me alone|dismiss|(?:be )?quiet|shh+|hush|(?:i'?ve |i )?got it(?: from here)?|i(?:'ll| can| will) take it from here|i(?:'m| am) good(?: from here)?|ruko|bas karo|band karo)[.!]?$/i;

const NEXT_RE = /^(?:ok(?:ay)?[,.! ]+)?(?:next|next step|done|go on|continue|what'?s next|and then|aage badho|chalo)[.!?]?$/i;

/**
 * Classifies an incoming utterance or command
 * @param {string} text
 * @returns {{ kind: 'dismiss' | 'next' | 'ask' | 'empty', text: string }}
 */
function classifyUtterance(text) {
  const cleaned = cleanTranscript(text);
  if (!cleaned) return { kind: 'empty', text: '' };
  if (DISMISS_RE.test(cleaned)) return { kind: 'dismiss', text: cleaned };
  if (NEXT_RE.test(cleaned)) return { kind: 'next', text: cleaned };
  return { kind: 'ask', text: cleaned };
}

module.exports = { cleanTranscript, classifyUtterance };
