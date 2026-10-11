'use strict';
/**
 * Understanding how people actually talk.
 *
 * The router matches on patterns, and the patterns were written in the English
 * of a product manual: "play music", "show my grades", "what is on my
 * calendar". Nobody says that out loud. They say "bump some music", "pull up
 * my grades", "yo what's the move today" — and every one of those either
 * missed entirely or routed somewhere wrong, which is how "bet play some
 * music" ended up pausing the track instead of starting one.
 *
 * So the words are translated once, here, before anything tries to match them.
 * Two kinds of translation and they are different jobs:
 *
 *   1. Fillers carry no instruction at all — "lowkey", "ngl", "fr", "bruh".
 *      They are removed, which is safe because removing them cannot change
 *      what was asked.
 *
 *   2. Phrases that mean something the router already knows a word for —
 *      "bump" is play, "pull up" is show, "run it back" is replay. These are
 *      rewritten, which is not automatically safe, so the list is short and
 *      every entry is a phrase with one plain meaning.
 *
 * What is deliberately NOT translated: anything whose meaning depends on the
 * sentence. "cooked" is a disaster in "my grades are cooked" and a request in
 * "cook me an essay"; "bet" is agreement in "bet" and a wager elsewhere. A
 * rewrite that is right most of the time produces an assistant that does the
 * wrong thing confidently, which is worse than one that asks the model.
 *
 * The original text is always what the user sees and what the model is given.
 * This exists only to decide which tool runs.
 */

/**
 * Words that add tone and no instruction.
 *
 * Removed wherever they appear, so "lowkey what do i have due" matches the
 * same pattern as "what do i have due".
 */
const FILLERS = [
  'lowkey', 'highkey', 'ngl', 'tbh', 'imo', 'imho', 'fr fr', 'fr', 'ong',
  'deadass', 'no cap', 'frfr', 'bruh', 'bro', 'bruv', 'fam', 'dawg', 'homie',
  'sheesh', 'yo', 'ayo', 'aye', 'bet', 'word', 'facts', 'periodt', 'period',
  'literally', 'legit', 'basically', 'honestly', 'actually', 'just',
  'like i said', 'you know', 'u know', 'idk but', 'pls', 'plz', 'please',
  'rn', 'asap', 'real quick', 'quick'
];

/**
 * Phrases with one plain meaning the router already understands.
 *
 * Order matters: longer phrases first, or "pull up" would be rewritten before
 * "pull up the" ever matched.
 */
const PHRASES = [
  // Getting something shown
  [/\bpull\s+up\b/gi, 'show'],
  [/\bbring\s+up\b/gi, 'show'],
  [/\blemme\s+see\b/gi, 'show'],
  [/\blet\s+me\s+peep\b/gi, 'show'],
  [/\bpeep\b/gi, 'show'],
  [/\bhit\s+me\s+(?:up\s+)?with\b/gi, 'what is'],
  [/\bput\s+me\s+on\s+to\b/gi, 'what is'],

  // Music
  [/\bbump\b/gi, 'play'],
  [/\bthrow\s+on\b/gi, 'play'],
  [/\bput\s+on\b/gi, 'play'],
  [/\bblast\b/gi, 'play'],
  // "replay" is not a word any intent knows, so rewriting to it turned one
  // miss into another. Starting the track again is what it means.
  [/\brun\s+(?:it|that)\s+back\b/gi, 'previous track'],
  [/\bskip\s+(?:this|that|it)\s+(?:one|song|track)?\b/gi, 'next track'],
  [/\bnext\s+one\b/gi, 'next track'],
  [/\bturn\s+(?:this|that|it)\s+up\b/gi, 'turn it up'],
  [/\bcrank\s+(?:it|this|that)?\s*up\b/gi, 'turn it up'],

  // The day
  // "what's on my schedule" reads naturally but matched the personal-details
  // tool, not the day planner. "what do I have on" is the phrasing the day
  // intent actually knows — a rewrite is only useful if it lands somewhere.
  [/\bwhat'?s?\s+the\s+move\b/gi, 'what do i have on'],
  [/\bwhat'?s?\s+(?:the\s+)?(?:play|plan)\s+(?:for\s+)?today\b/gi, 'what do i have on today'],
  [/\bgotta\s+do\b/gi, 'have to do'],
  [/\bgot\s+goin'?\s*on\b/gi, 'have on'],
  [/\bwhat'?s?\s+good\s+(?:for\s+)?today\b/gi, 'what do i have on today'],

  // Weather
  [/\bwhat'?s?\s+the\s+vibe\s+(?:outside|out there)\b/gi, "what's the weather"],
  [/\bhow'?s?\s+it\s+(?:lookin'?|looking)\s+outside\b/gi, "what's the weather"],
  [/\bis\s+it\s+(?:gonna|going\s+to)\s+be\s+nice\s+out\b/gi, "what's the weather"],

  // Work it should do
  [/\bcook\s+(?:me\s+)?(?:up\s+)?(?:an?\s+)?/gi, 'write a '],
  [/\bwhip\s+up\b/gi, 'write'],
  [/\bknock\s+out\b/gi, 'finish'],

  // Spoken contractions whisper leaves in
  [/\bwanna\b/gi, 'want to'],
  [/\bgonna\b/gi, 'going to'],
  [/\bgimme\b/gi, 'give me'],
  [/\blemme\b/gi, 'let me'],
  [/\bcuz\b/gi, 'because'],
  [/\btmr?w?\b/gi, 'tomorrow'],
  [/\byesterdy\b/gi, 'yesterday'],
  [/\bu\b/gi, 'you'],
  [/\br\b/gi, 'are']
];

/** Built once: fillers as one alternation, longest first so "fr fr" beats "fr". */
const FILLER_RE = new RegExp(
  '\\b(?:' + FILLERS
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
    .join('|') + ')\\b',
  'gi'
);

/**
 * Rewrites a spoken request into the plainer English the router matches.
 *
 * Only ever used to choose a tool. The user's own words are what gets shown,
 * spoken back and sent to the model.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeSlang(text) {
  let out = String(text || '');
  if (!out.trim()) return out;

  for (const [re, to] of PHRASES) out = out.replace(re, to);

  // Fillers last: "bet play some music" needs "bet" gone, but "run it back"
  // has to be rewritten before anything starts deleting words from it.
  out = out.replace(FILLER_RE, ' ');

  return out.replace(/\s+/g, ' ').replace(/\s+([,.?!])/g, '$1').trim();
}

module.exports = { normalizeSlang, FILLERS, PHRASES };
