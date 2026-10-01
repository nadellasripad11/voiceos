'use strict';
/**
 * Turns raw transcript into text worth inserting.
 *
 * Two layers, deliberately separate:
 *
 *  1. `cleanup()` — deterministic, instant, no model. Filler removal, spoken
 *     punctuation, custom replacements, capitalisation. This alone covers most
 *     of what users notice, and it runs even with no LLM installed.
 *  2. `polishWithLlm()` — optional rewrite for tone and formatting. Costs a
 *     round trip, so it is skipped for very short utterances where the
 *     deterministic pass is already correct.
 */

// Hedges and verbal tics that are never intended as content.
const FILLERS = [
  'um', 'uh', 'erm', 'ah', 'eh', 'hmm', 'mmm', 'uhh', 'umm',
  'you know', 'i mean', 'like i said', 'sort of', 'kind of',
  'basically', 'literally', 'actually', 'right', 'okay so', 'so yeah'
];

// Only the unambiguous ones. "period" and "dash" are left alone because they
// appear in ordinary speech ("the period after the war", "dash of salt") far
// more often than as dictation commands.
const SPOKEN_PUNCTUATION = [
  [/\bnew paragraph\b/gi, '\n\n'],
  [/\bnew line\b/gi, '\n'],
  [/\bfull stop\b/gi, '.'],
  [/\bquestion mark\b/gi, '?'],
  [/\bexclamation (mark|point)\b/gi, '!'],
  [/\bopen (paren|parenthesis)\b/gi, '('],
  [/\bclose (paren|parenthesis)\b/gi, ')'],
  [/\bsemicolon\b/gi, ';'],
  [/\bcolon\b/gi, ':'],
  [/\bellipsis\b/gi, '…']
];

const ABBREVIATIONS = /\b(mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|approx|dept|inc|ltd|co|fig|no|vol)\.$/i;

/** Strips filler words without touching them where they carry meaning. */
function removeFillers(text) {
  let out = text;
  for (const filler of FILLERS) {
    // Only when bounded by sentence start/punctuation or commas, so "I actually
    // tested it" keeps its meaning while "um, actually, so" gets cleaned.
    const escaped = filler.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(^|[.!?,;]\\s*)${escaped}\\b[,]?\\s*`, 'gi'), '$1');
  }
  // Collapse stutters: "the the report" -> "the report".
  out = out.replace(/\b(\w+)([ \t]+\1\b)+/gi, '$1');
  // Horizontal whitespace only: \s would also eat the paragraph breaks that
  // applySpokenPunctuation just inserted.
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

function applySpokenPunctuation(text) {
  let out = text;
  for (const [pattern, replacement] of SPOKEN_PUNCTUATION) {
    out = out.replace(pattern, replacement);
  }
  // Tidy the spacing those substitutions leave behind.
  return out
    .replace(/\s+([.,;:!?)])/g, '$1')
    .replace(/([(])\s+/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n');
}

/** User-defined substitutions, e.g. "my email" -> an actual address. */
function applyReplacements(text, replacements = []) {
  let out = text;
  for (const r of replacements) {
    if (!r || !r.from) continue;
    const escaped = r.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), r.to ?? '');
  }
  return out;
}

/**
 * Corrects vocabulary terms that survived transcription in the wrong case, e.g.
 * "voiceos" -> "VoiceOS". Whisper is biased toward the term by the initial
 * prompt but does not always match the user's casing.
 */
function applyVocabularyCasing(text, vocabulary = []) {
  let out = text;
  for (const term of vocabulary) {
    if (!term) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), term);
  }
  return out;
}

function capitalizeSentences(text) {
  // Capitalise the first letter, and after terminal punctuation, while leaving
  // common abbreviations alone so "approx. five" does not become "Approx. Five".
  const parts = text.split(/([.!?]\s+|\n+)/);
  let out = '';
  let capitalizeNext = true;
  for (const part of parts) {
    if (/^[.!?]\s+$/.test(part) || /^\n+$/.test(part)) {
      out += part;
      capitalizeNext = !ABBREVIATIONS.test(out.trimEnd());
      continue;
    }
    if (capitalizeNext && part) {
      out += part.charAt(0).toUpperCase() + part.slice(1);
      capitalizeNext = false;
    } else {
      out += part;
    }
  }
  // "i" standing alone is always the pronoun.
  return out.replace(/\bi\b/g, 'I').replace(/\bi'(m|ll|ve|d)\b/gi, (m) => 'I' + m.slice(1));
}

function ensureTerminalPunctuation(text) {
  const trimmed = text.trimEnd();
  if (!trimmed) return trimmed;
  if (/[.!?;:,)"'\]…]$/.test(trimmed)) return trimmed;
  if (trimmed.endsWith('\n')) return trimmed;
  return trimmed + '.';
}

/**
 * The deterministic pass. Fast enough to be invisible and safe to run always.
 */
function cleanup(text, options = {}) {
  const {
    removeFillers: doFillers = true,
    autoPunctuate = true,
    autoCapitalize = true,
    vocabulary = [],
    replacements = [],
    terminalPunctuation = true
  } = options;

  if (!text || !text.trim()) return '';
  let out = text.trim();

  if (autoPunctuate) out = applySpokenPunctuation(out);
  if (doFillers) out = removeFillers(out);
  out = applyReplacements(out, replacements);
  out = applyVocabularyCasing(out, vocabulary);
  if (autoCapitalize) out = capitalizeSentences(out);
  if (terminalPunctuation && autoPunctuate) out = ensureTerminalPunctuation(out);

  return out.trim();
}

// --- LLM polish -----------------------------------------------------------

const STYLE_GUIDANCE = {
  auto: 'Match the tone to where the text is going, inferred from the application name.',
  email: 'Format as a short, professional email body. No greeting or signature unless dictated.',
  message: 'Format as a brief chat message. Conversational, no salutation, no sign-off.',
  notes: 'Format as concise notes. Use short lines or bullets where the content is a list.',
  code: 'The text is a code comment or a prompt to a coding tool. Keep technical terms and identifiers exactly as dictated.',
  formal: 'Use complete sentences and a formal register. No contractions.',
  raw: ''
};

function buildPolishPrompt({ style = 'auto', appName, vocabulary = [] }) {
  const guidance = STYLE_GUIDANCE[style] ?? STYLE_GUIDANCE.auto;
  return [
    'You clean up dictated speech into finished written text.',
    '',
    'Rules:',
    '- Return ONLY the cleaned text. No preamble, no quotes, no explanation.',
    '- Preserve the meaning exactly. Never add facts, opinions, greetings or sign-offs.',
    '- Remove filler words, false starts and repetitions.',
    '- Fix grammar, spelling and punctuation.',
    '- Keep the speaker\'s own wording and voice; this is tidying, not rewriting.',
    '- If the input is already clean, return it unchanged.',
    '- Never answer a question in the text. Dictation of a question stays a question.',
    guidance && `- ${guidance}`,
    appName && `- The text will be inserted into: ${appName}.`,
    vocabulary.length && `- These terms are spelled exactly: ${vocabulary.join(', ')}.`
  ].filter(Boolean).join('\n');
}

/**
 * Sends the transcript for an LLM tidy-up.
 *
 * Returns the deterministic text unchanged if the model fails or stalls: a
 * dictation tool that loses the user's words on a network hiccup is worse than
 * one that inserts slightly rougher text.
 */
async function polishWithLlm({
  text,
  provider,
  model,
  style = 'auto',
  appName,
  vocabulary = [],
  timeoutMs = 20000,
  logger = console
}) {
  if (!text || !text.trim()) return { text: '', polished: false };
  if (style === 'raw') return { text, polished: false, reason: 'style is raw' };

  // Very short utterances are almost always already correct after cleanup, and
  // the round trip would be a large share of total latency.
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount < 4) return { text, polished: false, reason: 'too short to need polish' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await provider.chat({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: buildPolishPrompt({ style, appName, vocabulary }) },
        { role: 'user', content: text }
      ],
      signal: controller.signal
    });
    const out = stripWrapping(res.text);
    if (!out) return { text, polished: false, reason: 'model returned nothing' };

    // Guard against a model that ignores instructions and answers the text or
    // monologues instead of tidying it. A large size change means it did.
    const ratio = out.length / text.length;
    if (ratio > 2.2 || ratio < 0.4) {
      logger.warn?.(`[polish] rejecting model output (length ratio ${ratio.toFixed(2)}); using deterministic text`);
      return { text, polished: false, reason: 'model output diverged too far from the dictation' };
    }
    return { text: out, polished: true, usage: res.usage };
  } catch (err) {
    logger.warn?.(`[polish] ${err.message}; falling back to deterministic cleanup`);
    return { text, polished: false, reason: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Models like to wrap answers in quotes or fences despite being told not to. */
function stripWrapping(s) {
  if (!s) return '';
  let out = s.trim();
  out = out.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith('“') && out.endsWith('”'))) {
    out = out.slice(1, -1);
  }
  out = out.replace(/^(here(?:'s| is) the (?:cleaned|polished|corrected)[^:]*:\s*)/i, '');
  return out.trim();
}

module.exports = {
  cleanup,
  removeFillers,
  applySpokenPunctuation,
  applyReplacements,
  applyVocabularyCasing,
  capitalizeSentences,
  polishWithLlm,
  buildPolishPrompt,
  stripWrapping,
  STYLE_GUIDANCE,
  FILLERS
};
