'use strict';
/**
 * Understanding "what about tomorrow".
 *
 * A conversation is mostly fragments. You ask what the weather is, then "what
 * about tomorrow", then "and in London" — and none of those are questions on
 * their own. The router reads each utterance fresh, so it was searching the
 * web for the literal words "what about tomorrow", which is nonsense and was
 * answered as such.
 *
 * This became worse, not better, when the microphone started reopening after
 * every answer: the whole point of a conversation is that you do not repeat
 * yourself, and fragments are what you say instead.
 *
 * The approach is to rewrite rather than to resolve. A fragment is spliced
 * onto the previous question and the result goes through the ordinary router:
 *
 *   "what's the weather"  +  "what about tomorrow"
 *     -> "what's the weather tomorrow"
 *
 * That is deliberately dumber than tracking entities and slots. It needs no
 * per-intent follow-up logic, every existing extractor keeps working untouched,
 * and when it guesses wrong the result is a slightly odd question rather than
 * a confident answer about the wrong thing.
 */

/**
 * Openers that mean "same question, different detail".
 *
 * Each is a phrase that cannot begin a standalone request — "what about X" is
 * never a first thing to say. That is what makes the rewrite safe: anything
 * that could stand alone is left alone.
 *
 * "what if" is deliberately absent. It asks a hypothetical rather than changing
 * a parameter, and splicing it produced "whats the weather it rains".
 */
const CONTINUATION = /^(?:(?:ok(?:ay)?|and|but|so|well)[,\s]+)*(?:what|how)\s+about\b|^(?:ok(?:ay)?|and|but|so)[,\s]+(?:in|for|at|on)\b|^and\s+(?:what\s+about|in|for|at|on)\b|^(?:in|for|at|on)\s+(?!the\s+(?:morning|afternoon|evening)\b)[a-z]/i;

/** Where the fragment starts, once its opener is removed. */
const OPENER = /^(?:(?:ok(?:ay)?|and|but|so|well)[,\s]+)*(?:(?:what|how)\s+about\s+|and\s+)?/i;

/**
 * How long a previous question stays available to be continued.
 *
 * A fragment half a minute later is a follow-up. The same words ten minutes
 * later are a new thought that happens to start with "and".
 */
const WINDOW_MS = 90_000;

/**
 * Rewrites a fragment into a whole question, or returns null.
 *
 * @param {string} text what was just said
 * @param {{question: string, at: number}|null} previous the last thing that routed
 * @returns {string|null} a question to route instead, or null to use the original
 */
function asFollowUp(text, previous) {
  const said = String(text || '').trim();
  if (!said || !previous || !previous.question) return null;
  if (Date.now() - previous.at > WINDOW_MS) return null;

  // Long enough to be its own question. Fragments are short by nature, and a
  // full sentence that happens to start with "and" is not asking to be
  // merged with anything.
  if (said.split(/\s+/).length > 7) return null;
  if (!CONTINUATION.test(said)) return null;

  const detail = said.replace(OPENER, '').trim().replace(/[?.!]+$/, '');
  if (!detail) return null;

  // The previous question keeps its wording; the fragment is appended, so
  // "in london" stays "in london" and the place extractor still sees its
  // preposition.
  const base = previous.question.trim().replace(/[?.!]+$/, '');
  return `${base} ${detail}`;
}

module.exports = { asFollowUp, CONTINUATION, WINDOW_MS };
