'use strict';
/**
 * Deterministic intent patterns.
 *
 * These cover the things people actually say to a voice assistant. Matching
 * them directly is not a fallback for a missing model: it is faster, it cannot
 * misinterpret, and it keeps the assistant useful on hardware that cannot run a
 * good local model.
 *
 * Order matters. The first match wins, so specific patterns come before general
 * ones, and the open-ended web lookup is last.
 */

/** Each entry: { re, tool, args?, guard? }. */
const INTENTS = [
  // --- Point and ask ------------------------------------------------------
  // A demonstrative with no noun behind it means the cursor is the subject:
  // "who is that" only has an answer if you know where the user is pointing.
  // These must precede the web lookup, which would otherwise search for the
  // literal words "who is that".
  {
    // The apostrophe is optional: transcription often returns "whats that".
    re: /^(?:who|what)(?:'s|s)?\s+(?:is\s+)?(?:this|that|it|he|she|him|her|they)\b[^?]*\??$/i,
    tool: 'point_and_ask',
    args: (_m, text) => ({ question: text })
  },
  {
    re: /^(?:tell me about|explain|describe|read|summarize|summarise)\s+(?:this|that|it)\b[^?]*\??$/i,
    tool: 'point_and_ask',
    args: (_m, text) => ({ question: text })
  },
  {
    re: /^(?:what|who|where|how much|how many)\b.*\b(?:this|that)\b.*$/i,
    tool: 'point_and_ask',
    args: (_m, text) => ({ question: text }),
    // Skip when another noun already carries the question, so "what song is
    // this" still reaches the media tool.
    guard: (_m, text) =>
      !/\b(playing|song|track|music|open|reminder|file|time|weather|due|volume|windows?)\b/i.test(text)
  },

  // --- Mail, calendar and school -------------------------------------------
  {
    re: /\b(?:check|read|any|new|got|show|what'?s? in)\b.*\b(?:e?mails?|inbox)\b/i,
    tool: 'list_email',
    args: (_m, text) => ({ query: /unread|new/i.test(text) ? 'is:unread' : 'in:inbox' })
  },
  {
    re: /\bread\b.*\be?mail\b.*\bfrom\b\s+(.+)/i,
    tool: 'read_email',
    args: (m) => ({ query: `from:${m[1].trim()}` })
  },
  {
    re: /\b(?:on (?:my |the )?calendar|scheduled|my meetings?|my agenda)\b/i,
    tool: 'list_events',
    args: (_m, text) => ({ days: /week/i.test(text) ? 7 : /tomorrow/i.test(text) ? 2 : 1 })
  },
  {
    re: /\b(?:am i free|do i have anything|what'?s? (?:on )?today)\b/i,
    tool: 'list_events',
    args: (_m, text) => ({ days: /tomorrow/i.test(text) ? 2 : 1 })
  },
  {
    re: /\b(?:due|homework|assignments?|coursework)\b/i,
    tool: 'list_coursework'
  },
  {
    re: /\b(?:find|search)\b.*\b(?:drive|google drive)\b|\bin my drive\b/i,
    tool: 'search_drive',
    args: (_m, text) => ({
      query: text.replace(/.*\b(?:find|search)\b\s*(?:for\s*)?/i, '')
        .replace(/\b(?:in )?(?:my )?(?:google )?drive\b/i, '').trim()
    })
  },
  // --- Media --------------------------------------------------------------
  {
    re: /^(?:what(?:'s| is)?\s+(?:this\s+)?(?:song|track|playing|music)|who sings this|what am i listening to)/i,
    tool: 'now_playing'
  },
  {
    re: /^(?:pause|stop)\s*(?:the\s*)?(?:music|song|playback|spotify|it)?\s*$/i,
    tool: 'control_playback',
    args: () => ({ action: 'pause' })
  },
  {
    re: /^(?:play|resume|unpause)\s*(?:the\s*)?(?:music|song|playback|spotify|it)?\s*$/i,
    tool: 'control_playback',
    args: () => ({ action: 'play' })
  },
  {
    re: /\b(?:next|skip)\b\s*(?:song|track|this)?\s*$/i,
    tool: 'control_playback',
    args: () => ({ action: 'next' })
  },
  {
    re: /\b(?:previous|last|go back a)\b\s*(?:song|track)/i,
    tool: 'control_playback',
    args: () => ({ action: 'previous' })
  },

  // --- Volume -------------------------------------------------------------
  {
    re: /\b(?:turn (?:it|the volume) up|louder|volume up)\b/i,
    tool: 'set_volume',
    args: () => ({ direction: 'up' })
  },
  {
    re: /\b(?:turn (?:it|the volume) down|quieter|volume down)\b/i,
    tool: 'set_volume',
    args: () => ({ direction: 'down' })
  },
  {
    re: /^(?:mute|unmute|silence)\b/i,
    tool: 'set_volume',
    args: () => ({ direction: 'mute' })
  },

  // --- Apps and pages -----------------------------------------------------
  {
    re: /^(?:open|go to|visit)\s+(\S+\.(?:com|org|net|io|dev|edu|gov)\S*)/i,
    tool: 'open_url',
    args: (m) => ({ url: m[1] })
  },
  {
    re: /^(?:open|launch|start)\s+(?:the\s+)?(?:app\s+)?(.+?)[.?!]?$/i,
    tool: 'open_app',
    args: (m) => ({ name: m[1].trim() })
  },

  // --- Screen and selection ----------------------------------------------
  {
    re: /\b(?:read (?:the|my) screen|what(?:'s| is) on (?:my |the )?screen)\b/i,
    tool: 'read_screen'
  },
  {
    re: /\b(?:read (?:the|my) selection|what did i select|what(?:'s| is) selected)\b/i,
    tool: 'read_selection'
  },
  {
    re: /\b(?:what(?:'s| is)? open|list (?:my )?windows|what apps are open)\b/i,
    tool: 'list_windows'
  },

  // --- Reminders and notes ------------------------------------------------
  {
    re: /^remind me (?:to |that )?(.+?)(?:\s+(in .+|at .+|tomorrow.*|today.*))?[.?!]?$/i,
    tool: 'create_reminder',
    args: (m) => ({ text: m[1].trim(), when: m[2] })
  },
  {
    re: /\b(?:what are my reminders|list (?:my )?reminders|what do i need to do)\b/i,
    tool: 'list_reminders'
  },
  {
    re: /^(?:take a note|note|make a note)\s*[:,-]?\s*(.+)/i,
    tool: 'take_note',
    args: (m) => ({ text: m[1].trim() })
  },

  // --- Files --------------------------------------------------------------
  {
    re: /^(?:find|search for|where is|locate)\s+(?:my\s+|the\s+)?(?:file\s+)?(.+?)(?:\s+file)?[.?!]?$/i,
    tool: 'search_files',
    args: (m) => ({ query: m[1].trim() }),
    // Only when it sounds like a file, so "find the capital of France" does not
    // become a filesystem search.
    guard: (_m, text) => /\b(file|document|pdf|photo|picture|folder|download|spreadsheet)\b/i.test(text)
  },

  // --- Web ----------------------------------------------------------------
  {
    re: /^(?:search(?: the web)?(?: for)?|google|look up)\s+(.+?)[.?!]?$/i,
    tool: 'search_web',
    args: (m) => ({ query: m[1].trim() })
  },
  {
    re: /^(?:what|who|when|where|why|how)\b.+$/i,
    tool: 'answer_from_web',
    args: (_m, text) => ({ query: text.replace(/[?]+$/, '').trim() })
  }
];

/**
 * Returns the tool and arguments for a recognised command, or null.
 * @param {string} text what the user said
 * @param {Array<{name:string}>} tools the tools currently available
 */
function matchIntent(text, tools) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  const byName = new Map(tools.map((t) => [t.name, t]));

  for (const intent of INTENTS) {
    const m = intent.re.exec(clean);
    if (!m) continue;
    if (intent.guard && !intent.guard(m, clean)) continue;
    const tool = byName.get(intent.tool);
    if (!tool) continue; // the owning app is switched off
    return { tool, args: intent.args ? intent.args(m, clean) : {} };
  }
  return null;
}

module.exports = { INTENTS, matchIntent };
