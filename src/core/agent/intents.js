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

/**
 * Sites worth opening by name.
 *
 * Canvas is deliberately the generic entry point: every school runs its own
 * instance, so the right address is a per-user setting rather than something
 * guessable. Override any of these, or add your own, under ui.sites.
 */
const { normalizeSlang } = require('./slang');

const SITES = {
  canvas: 'https://canvas.instructure.com',
  classroom: 'https://classroom.google.com',
  'google classroom': 'https://classroom.google.com',
  gmail: 'https://mail.google.com',
  mail: 'https://mail.google.com',
  email: 'https://mail.google.com',
  inbox: 'https://mail.google.com',
  drive: 'https://drive.google.com',
  'google drive': 'https://drive.google.com',
  docs: 'https://docs.google.com',
  'google docs': 'https://docs.google.com',
  sheets: 'https://sheets.google.com',
  slides: 'https://slides.google.com',
  calendar: 'https://calendar.google.com',
  youtube: 'https://www.youtube.com',
  google: 'https://www.google.com',
  github: 'https://github.com',
  whatsapp: 'https://web.whatsapp.com',
  reddit: 'https://www.reddit.com',
  wikipedia: 'https://www.wikipedia.org',
  chatgpt: 'https://chat.openai.com',
  claude: 'https://claude.ai',
  notion: 'https://www.notion.so',
  twitter: 'https://x.com',
  x: 'https://x.com',
  instagram: 'https://www.instagram.com',
  netflix: 'https://www.netflix.com',
  amazon: 'https://www.amazon.com',
  'khan academy': 'https://www.khanacademy.org',
  desmos: 'https://www.desmos.com/calculator'
};

/** The address for a spoken site name, or null. */
function siteUrl(name, config) {
  const key = String(name || '').trim().toLowerCase().replace(/[.?!]+$/, '');
  if (!key) return null;
  const overrides = (config && config.get && config.get('ui.sites', null)) || {};
  const merged = { ...SITES, ...overrides };
  return merged[key] || null;
}

/**
 * Removes the conversational wrapping around a request.
 *
 * People do not speak in commands. They open with a greeting, say the
 * assistant's name (which transcription mangles — "Darris" for "Jarvis"),
 * hedge with "can you", pad with "just" and "so", and trail off with "right?".
 * None of it changes what they asked for.
 *
 * Applied repeatedly because these stack: "oh hey Jarvis, so can you just...".
 */
function stripChatter(text) {
  let out = String(text || '').trim();
  const passes = [
    // Greetings and hesitation at the front.
    /^(?:oh|ok|okay|um|uh|erm|so|well|alright|right|yeah|yo|hey|hi|hello|excuse me|bro|dude|man)\b[\s,]*/i,
    // The assistant's name, however it came out of transcription.
    /^(?:jarvis|darris|jarvis[,.]|voice ?os|assistant|computer|siri|alexa)\b[\s,]*/i,
    // Politeness and hedging.
    /^(?:please\s+)?(?:can|could|would|will|wo)\s+(?:you|u)\s+(?:please\s+)?/i,
    /^(?:i\s+(?:want|need|would like)\s+(?:you\s+)?to|i'?d like you to|go ahead and|try to|help me|let'?s)\s+/i,
    /^(?:please|just|maybe|perhaps|kindly)\s+/i
  ];
  for (let round = 0; round < 6; round++) {
    const before = out;
    for (const re of passes) out = out.replace(re, '').trim();
    if (out === before) break;
  }
  // Trailing filler: "right?", "ok?", "that's good", "thanks".
  out = out
    .replace(/[\s,]*\b(?:right|ok|okay|yeah|yes|please|thanks|thank you|cheers|if you can|will you|would you|for me)\b[\s.!?]*$/i, '')
    .replace(/[\s,]*\bthat'?s (?:good|fine|great|it)\b[\s.!?]*$/i, '')
    .replace(/[\s,]*\boh my god\b[\s.!?]*$/i, '')
    .trim();
  return out;
}

/**
 * What to search for, from a sentence asking to play something.
 *
 * People name the thing last and pad everything before it: "play some music on
 * Spotify bro play like Drake" is a request for Drake. So the text after the
 * final "play" wins, and the filler around it is stripped. Returns null when
 * what is left is a generic word like "music", which is a request to resume,
 * not a search for an artist of that name.
 */
function musicQuery(text) {
  let out = String(text || '').trim();

  // Anything after the final play-verb is the subject: people name the thing
  // last and pad everything before it.
  const verbs = /\b(?:play|put on|throw on|listen to)\b/gi;
  let last = null;
  let m;
  while ((m = verbs.exec(out)) !== null) last = m.index + m[0].length;
  if (last !== null) out = out.slice(last);

  out = out
    // "... on Spotify" names the player, not the music.
    .replace(/\b(?:on|in|with|from)\s+(?:spotify|youtube|apple music|itunes|vlc)\b.*$/i, '')
    .replace(/\b(?:bro|dude|man|please|pls|bruh)\b/gi, ' ')
    .trim();

  // Leading and trailing filler, stripped repeatedly because it stacks.
  for (let i = 0; i < 6; i++) {
    const before = out;
    out = out
      .replace(/^(?:like|some|the|a|an|me|my|us|by|any)\b/i, '')
      .replace(/[\s,]*\b(?:right|ok|okay|yeah|please|thanks|i like|i want|for me|or something)\b[\s.,!?]*$/i, '')
      .replace(/^[\s,]+/, '')
      .replace(/[\s,.!?]+$/, '')
      .trim();
    if (out === before) break;
  }

  out = out.replace(/\s+/g, ' ').trim();
  if (!out || out.length < 2 || out.length > 60) return null;

  // A generic music word anywhere means a vibe rather than a name — "some
  // music", "white film music I like", "something". Those belong to the
  // player, which resumes or starts it, not to a search that would look for
  // an artist of that name.
  if (/\b(?:music|songs?|tunes?|tracks?|playlists?|something|anything|stuff|whatever)\b/i.test(out)) return null;
  if (/^(?:it|that|this|one)$/i.test(out)) return null;

  return out;
}

/** Each entry: { re, tool, args?, guard? }. */
/**
 * Words that follow "in", "for" or "at" without naming a place.
 *
 * The weather intent used to require a capital letter to decide something was
 * a place name, which quietly excluded every typed question: "weather in
 * cauley creek park" found no place and was answered for wherever the user
 * was. Matching case-insensitively finds the park, and this list is what stops
 * it finding "the morning" as well.
 */
const NOT_A_PLACE = /^(?:the|a|an|my|your|our|this|that|these|here|there|now|today|tomorrow|tonight|tmrw?|tmo|morning|afternoon|evening|night|celsius|fahrenheit|degrees|fact|general|short|detail|case|advance|total|particular)\b/i;

/**
 * Words that end a place name.
 *
 * A question does not stop after the town: "in georgia tmr during 8 to 4"
 * carries three more words that are not part of Georgia. Trimming one word
 * off the end was not enough — that left "georgia tmr during", which is why
 * the gazetteer found nothing and the answer quietly came back for somewhere
 * else. So the name ends at the first word that cannot be part of one.
 */
const ENDS_A_PLACE = new Set([
  'tomorrow', 'tmr', 'tmrw', 'tmo', 'today', 'tonight', 'now', 'later',
  'morning', 'afternoon', 'evening', 'night', 'weekend',
  'during', 'between', 'from', 'to', 'until', 'till', 'around', 'about',
  'before', 'after', 'at', 'on', 'in', 'for', 'and', 'or',
  'please', 'pls', 'thanks', 'thx', 'rn', 'fr', 'ngl'
]);

/**
 * The place name out of a captured phrase, or null when there is not one.
 *
 * @param {string|null} raw up to four words following "in", "for" or "at"
 */
function placeFrom(raw) {
  if (!raw) return null;
  const words = [];
  for (const word of raw.trim().split(/\s+/)) {
    if (ENDS_A_PLACE.has(word.toLowerCase().replace(/[.,]$/, ''))) break;
    words.push(word);
  }
  const place = words.join(' ').trim();
  if (!place || NOT_A_PLACE.test(place)) return null;
  return place;
}

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
    args: (_m, text) => ({ question: text }),
    // "Summarize this: <the text itself>" brings its own "this". Typed into
    // the console with pasted text, it was reading the screen instead.
    guard: (_m, text) => !/:\s*\S[\s\S]{24,}$/.test(text)
  },
  {
    re: /^(?:what|who|where|how much|how many)\b.*\b(?:this|that)\b.*$/i,
    tool: 'point_and_ask',
    args: (_m, text) => ({ question: text }),
    // Skip when another noun already carries the question, so "what song is
    // this" still reaches the media tool.
    guard: (_m, text) =>
      !/\b(playing|song|sings|singing|artist|band|album|track|music|open|reminder|file|time|weather|due|homework|quiz|quizzes|test|tests|exam|exams|assignment|assignments|volume|windows?|email|inbox|calendar)\b/i.test(text)
  },

  // --- Canvas --------------------------------------------------------------
  // Naming a system means that system. Answering "my grades on Canvas" out of
  // Google Classroom produced a different course's marks under a Canvas logo,
  // which is worse than no answer. When Canvas is not connected the guard
  // fails and the next rule explains that, rather than quietly substituting.
  {
    re: /\bcanvas\b[^?]{0,40}\b(grades?|marks?|scores?|gpa)\b|\b(grades?|marks?|scores?|gpa)\b[^?]{0,40}\bcanvas\b/i,
    tool: 'canvas_grades',
    args: () => ({})
  },
  {
    re: /\bcanvas\b[^?]{0,40}\b(due|assignments?|homework|quiz|quizzes|tests?|exams?)\b|\b(due|assignments?|homework|quiz|quizzes|tests?|exams?)\b[^?]{0,40}\bcanvas\b/i,
    tool: 'canvas_assignments',
    args: () => ({})
  },

  // --- Doing a piece of work ------------------------------------------------
  // A goal rather than a question: something to produce, not something to look
  // up. Before the school rules, so "do my homework" is work while "what
  // homework do I have" is still a question — and before the web lookup, which
  // would otherwise search for advice about doing it and report that as the
  // answer. Both verbs are anchored at the start so "what do I have due" is
  // not read as an instruction to do it.
  {
    re: /^(?:please\s+)?(?:write|draft|compose|create|generate|rewrite|outline|summari[sz]e)\s+(.{3,})$/i,
    tool: 'do_task',
    // Summarising the news, the day or the inbox is looking something up,
    // not writing: sent here, it "wrote" a news summary with no news in it.
    guard: (_m, text) => !/^(?:please\s+)?summari[sz]e\s+(?:me\s+)?(?:(?:the|my|today'?s|this\s+week'?s|world|latest|top)\s+)*(?:news|headlines|day|inbox|e?mails?|mail|calendar|schedule|week)\b/i.test(text),
    args: (_m, text) => ({ goal: text })
  },
  {
    re: /^(?:please\s+)?(?:do|answer|finish|complete|solve)\s+(?:my|the|these|this|all)\s+(?:homework|assignment|assignments|essay|worksheet|questions|problems|quiz)\b/i,
    tool: 'do_task',
    args: (_m, text) => ({ goal: text })
  },

  // --- The camera ----------------------------------------------------------------
  {
    re: /\b(?:what am i holding|what(?:'?s| is) in my hand|look at (?:me|this thing|what i(?:'m| am) holding)|how do i look|what do you see|can you see (?:me|this)|(?:through|on|with) (?:the |my )?(?:web)?cam(?:era)?|use (?:the |my )?(?:web)?cam(?:era)?)\b/i,
    tool: 'look',
    args: (_m, text) => ({ question: text })
  },

  // --- Memory ------------------------------------------------------------------
  {
    re: /^(?:(?:hey\s+)?jarvis,?\s+)?(?:please\s+)?remember\s+(?:that\s+)?(.{4,})$/i,
    tool: 'remember',
    guard: (_m, text) => !/^remember\s+(?:when|what|who|where|how|to\s+remind)/i.test(text),
    args: (m) => ({ fact: m[1].trim().replace(/[.!]+$/, '') })
  },
  {
    re: /\bwhat\s+(?:do\s+you|have\s+you)\s+(?:remember|know|learn(?:ed|t))\s+about\s+me\b/i,
    tool: 'recall',
    args: () => ({})
  },
  {
    re: /^(?:(?:hey\s+)?jarvis,?\s+)?(?:please\s+)?forget\s+(?:that\s+|about\s+)?(.{3,})$/i,
    tool: 'forget',
    args: (m) => ({ about: m[1].trim().replace(/[.!]+$/, '') })
  },

  // --- Signing in, once, in the assistant's browser ---------------------------
  {
    re: /^(?:(?:can|could) you\s+)?(?:please\s+)?(?:sign|log)\s*(?:me\s+)?(?:in|into|on)\s+(?:to\s+)?(?:my\s+)?(?:account\s+(?:on|at)\s+)?([a-z0-9][a-z0-9.\- ]{1,40}?)(?:\s+account)?[.!?]*$/i,
    tool: 'browser_signin',
    args: (m) => ({ site: m[1].trim() })
  },

  // --- Using a website ---------------------------------------------------------
  // Things that live on a site rather than in a search snippet. These went to
  // the web search, which returned a page title and no price, or to the
  // model, which said it had no tool for websites.
  {
    re: /^(?:(?:can|could|will) you\s+)?(?:please\s+)?(?:go|get|hop)\s+(?:on|to|onto)\s+\S+.*\b(?:and|to)\b\s+\S+/i,
    tool: 'browse',
    args: (_m, text) => ({ goal: text })
  },
  {
    re: /\b(?:on|from|at)\s+(?:amazon|ebay|walmart|target|best ?buy|etsy|costco|newegg|craigslist|zillow|expedia|kayak|booking\.com|airbnb|google flights|espn|youtube|reddit|wikipedia|imdb|yelp)\b/i,
    tool: 'browse',
    guard: (_m, text) => !/^(?:play|pause|open)\b/i.test(text),
    args: (_m, text) => ({ goal: text })
  },
  {
    re: /\b(?:cheap(?:est)?|flights?|hotels?|book(?:ing)? a|price of|prices? for|how much (?:is|are|does|do)|in stock|deals? on|score of|scores?\b.*\bgame|who won|track (?:my|a) (?:package|order))\b/i,
    tool: 'browse',
    guard: (_m, text) => !/\b(?:my (?:grades?|calendar|email|inbox)|weather)\b/i.test(text),
    args: (_m, text) => ({ goal: text })
  },

  // --- The news ------------------------------------------------------------
  // Headlines, from a news feed rather than a web search: "summarize world
  // news" was a search that found nothing, or the writing agent composing
  // news from no news at all.
  {
    re: /\b(?:news|headlines)\b|\bwhat(?:'?s| is| has)?\s+(?:been\s+)?(?:happening|happened|going on)\s+in the world\b/i,
    tool: 'news',
    guard: (_m, text) => !/\b(?:play|podcast|channel|open|watch|newsletter)\b/i.test(text),
    args: (_m, text) => ({ topic: newsTopic(text) })
  },

  // --- Mail, calendar and school -------------------------------------------
  {
    re: /\b(?:we|i)\s+(?:have|got|need to do)\b[^?]{0,24}\btomorrow\b|\bwhat(?:'?s| is)\s+(?:on|up|happening)\s+(?:for\s+)?tomorrow\b|\bplan\s+(?:my\s+|for\s+)?tomorrow\b|\b(?:brief me|summari[sz]e)\b[^?]{0,12}\btomorrow\b|\bhow does tomorrow look\b/i,
    tool: 'my_day',
    guard: (_m, text) => !/\b(email|inbox|mail|weather|playing)\b/i.test(text),
    args: () => ({ day: 'tomorrow' })
  },
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
    args: (_m, text) => (/week/i.test(text) ? { days: 7 } : { day: /tomorrow/i.test(text) ? 'tomorrow' : 'today' })
  },
  {
    re: /\b(?:am i free|do i have anything|what'?s? (?:on )?today)\b/i,
    tool: 'list_events',
    args: (_m, text) => ({ day: /tomorrow/i.test(text) ? 'tomorrow' : 'today' })
  },
  {
    re: /\b(?:due|homework|quiz|quizzes|test|tests|exam|exams|assignment|assignments|assignments?|coursework)\b/i,
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
    // The apostrophe is optional throughout: transcription returns "whats
    // playing" as often as "what's playing", and requiring one meant the
    // command simply did nothing.
    // "tell me what song this is" asks exactly what "what song is this" asks.
    re: /^(?:(?:tell me |do you know )?what(?:'?s| is)?\s+(?:this\s+)?(?:song|track|playing|music)|(?:tell me )?who sings this|what am i listening to|what song is this)/i,
    tool: 'now_playing'
  },
  {
    re: /^(?:pause|stop)\s*(?:the\s*)?(?:music|song|playback|spotify|it)?\s*$/i,
    tool: 'control_playback',
    args: () => ({ action: 'pause' })
  },
  {
    // "play some music", "put something on", "play music on spotify". The
    // player name is captured so it can be started if it is not running.
    re: /^(?:please\s+)?(?:play|put on|start|resume)\b(?:\s+(?:some|the|my|a))?(?:\s+(?:music|song|songs|tunes|playlist|something|anything|track))?(?:\s+(?:on|in|with|from)\s+(\w+))?[\s.!?]*$/i,
    tool: 'control_playback',
    args: (m) => ({ action: 'play', app: m[1] || null })
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

  {
    // A named artist, song or album: "play Drake", "play some Drake on
    // Spotify", "put on Bohemian Rhapsody". Must precede the loose rule below,
    // which would otherwise hear only the word "play".
    re: /\b(?:play|put on|throw on)\b(?:\s+(?:some|the|a|me))?\s+(?:music\s+)?(?:by\s+)?(.+?)(?:\s+(?:on|in|with|from)\s+(?:spotify|youtube|apple music|itunes))?[\s.!?]*$/i,
    tool: 'play_search',
    // Both of these read the whole sentence rather than the capture: people
    // name the thing last and pad everything before it.
    guard: (_m, text) => Boolean(musicQuery(text)),
    args: (_m, text) => ({ query: musicQuery(text) })
  },

  {
    // A loose music request: "open Spotify from my apps and play some music",
    // "put something on". Matched anywhere in the sentence, because this is
    // the single most common thing asked in a full sentence rather than a
    // command. Guarded against "what is playing", which is a question.
    re: /\b(?:play|put on|throw on)\b/i,
    tool: 'control_playback',
    guard: (_m, text) =>
      /\b(?:music|song|songs|tunes|playlist|something|anything|spotify|track|album)\b/i.test(text) &&
      !/\b(?:what|which|who|whats|what'?s)\b/i.test(text) &&
      !/\bplaying\b/i.test(text),
    args: (_m, text) => ({
      action: 'play',
      app: (/\b(?:on|in|with|from|using)\s+(spotify|youtube|apple music|itunes|vlc)\b/i.exec(text) || [])[1] ||
           (/\b(spotify|itunes|vlc)\b/i.exec(text) || [])[1] || null
    })
  },

  // --- Apps and pages -----------------------------------------------------
  // A site by name: "go to canvas", "open my email". Guarded on the name being
  // one we know, so "open spotify" still reaches the desktop app and anything
  // unrecognised falls through rather than being guessed at.
  {
    // "show" is in the list because the slang pass rewrites "pull up" to it,
    // and "show me google drive" is ordinary English this should have
    // understood anyway. The original verbs stay for text that skips that pass.
    re: /^(?:open|go to|goto|visit|take me to|bring up|pull up|show me|show|navigate to)\s+(?:my\s+|the\s+)?(.+?)[.?!]?$/i,
    tool: 'open_url',
    guard: (m, _text, config) => Boolean(siteUrl(m[1], config)),
    args: (m, _text, config) => ({ url: siteUrl(m[1], config) })
  },
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
    re: /\b(?:read (?:the|my) screen|what(?:'?s| is) on (?:my |the )?screen)\b/i,
    tool: 'read_screen'
  },
  {
    re: /\b(?:read (?:the|my) selection|what did i select|what(?:'?s| is) selected)\b/i,
    tool: 'read_selection'
  },
  {
    re: /\b(?:what(?:'?s| is)? open|list (?:my )?windows|what apps are open)\b/i,
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
  // --- Pictures ------------------------------------------------------------
  // Asked for a picture outright, so there is nothing to search or summarise.
  {
    re: /^(?:please\s+)?(?:show|find|get)\s+(?:me\s+)?(?:a\s+|an\s+|some\s+)?(?:pictures?|photos?|images?)\s+of\s+(.+?)[\s.!?]*$/i,
    tool: 'show_image',
    args: (m) => ({ subject: m[1].trim() })
  },
  {
    re: /^(?:what\s+)?(?:does|do)\s+(?:a\s+|an\s+|the\s+)?(.+?)\s+look\s+like[\s.!?]*$/i,
    tool: 'show_image',
    args: (m) => ({ subject: m[1].trim() })
  },

  // --- The day -------------------------------------------------------------
  // "What do we have today" is a question about this person's day, and was
  // being answered from the web: "Today is celebrated on National Today."
  // Guarded so that naming one of the parts still goes to that part — asking
  // what is on the calendar should not return a whole briefing.
  {
    re: /\bsummari[sz]e\s+(?:my|the|to)?\s*day\b|\b(?:what(?:'?s| is| do| have)?\s+)?(?:do\s+)?(?:we|i)\s+(?:have|got|need to do)\b[^?]{0,24}\b(?:today|on today|going on)\b|\bbrief me\b|\bcatch me up\b|\bwhat(?:'?s| is)\s+(?:my\s+)?day\s+look\s+like\b|\bhow does (?:my|the) day look\b|\bwhat(?:'?s| is) (?:on|up) today\b/i,
    tool: 'my_day',
    guard: (_m, text) =>
      !/\b(calendar|email|inbox|mail|homework|assignment|quiz|test|exam|grade|weather|playing)\b/i.test(text),
    args: () => ({})
  },

  // --- The user's own data -------------------------------------------------
  // These must come before the open-ended web lookup. The web does not know
  // the user's grades, and a model given search results about grades will
  // produce something that reads exactly like an answer.
  {
    re: /\b(?:my|our)\b[^?]{0,20}\b(grades?|marks?|gpa|scores?|transcript)\b/i,
    tool: 'list_grades',
    args: () => ({})
  },
  {
    // Named a service we have no connection to, so say that rather than guess.
    re: /\b(?:my|our)\b[^?]{0,24}\b(grades?|marks?|gpa|assignments?|homework|classes|courses|schedule|timetable|account|balance|orders?)\b/i,
    tool: 'personal_data',
    args: (m, text) => ({
      topic: m[1].toLowerCase(),
      app: (/\b(canvas|blackboard|schoology|powerschool|moodle|classroom)\b/i.exec(text) || [])[1] || null
    })
  },

  // --- Weather -------------------------------------------------------------
  // One of the most common questions anyone asks, and the one most likely to
  // be answered with an invented number, so it is routed deterministically to
  // a forecast API and never reaches the model.
  {
    // "text maya that i'm running late", "message dad dinner is off".
    //
    // The name is at most two words and the rest is the message. Without a
    // bound on the name the pattern swallowed the whole sentence as a contact,
    // which is how a misdirected message happens.
    // A two-word name is only taken when something separates it from the
    // message — "coach dan saying ...", "maya, ...". Otherwise the name is one
    // word and the rest is what to say. Allowing two words unconditionally
    // turned "text dad dinner is off" into a contact called "dad dinner",
    // and a message sent to the wrong person is not a recoverable mistake.
    re: /^(?:text|message|whatsapp|sms|msg|dm)\s+(?:([a-z][\w.'-]*(?:\s+[a-z][\w.'-]*)?)\s*(?:,|\s(?:that|saying|and\s+say))\s+|([a-z][\w.'-]*)\s+)(.+)$/i,
    tool: 'send_message',
    args: (m, text) => ({
      to: (m[1] || m[2]).trim(),
      text: m[3].trim().replace(/[.?!]+$/, ''),
      // Said plainly, the verb picks the route. "message" is left unset so the
      // configured default decides.
      channel: /^\s*(?:whatsapp|wa)\b/i.test(text) ? 'whatsapp'
        : /^\s*(?:text|sms)\b/i.test(text) ? 'sms'
        : undefined
    })
  },
  {
    re: /\b(?:weather|forecast|temperature|how (?:hot|cold|warm)|is it (?:going to )?(?:rain|snow)|will it (?:rain|snow))\b/i,
    tool: 'weather',
    args: (_m, text) => {
      const when = /\b(?:tomorrow|tmrw?|tmo)\b/i.test(text) ? 'tomorrow'
        : /\b(?:today|this afternoon|tonight|this evening)\b/i.test(text) ? 'today'
        : 'now';

      // "in Paris", "for London", "in cauley creek park" — anything else is
      // taken as here.
      //
      // Case-insensitive, because the old pattern required a capital letter
      // and a typed question rarely has one: "weather in cauley creek park"
      // matched no place at all, so it quietly answered for wherever the user
      // was instead. The stop-list now does the job the capital letter was
      // doing badly — "in the morning" was never a place, capitalised or not.
      const raw = (/\b(?:in|for|at)\s+([a-z][\w.'-]*(?:[ -][a-z][\w.'-]*){0,3})/i.exec(text) || [])[1] || null;
      return { place: placeFrom(raw), when };
    }
  },

  // --- Small talk ----------------------------------------------------------
  // Must precede the open-ended web lookup below: "what's up?" starts with
  // "what", so without these it was being answered with a web search.
  // Deliberately tight — anchored, short, and nothing that could be a real
  // question — because swallowing a genuine request is far worse than
  // searching the web for a greeting.
  {
    re: /^(?:(?:hey\s+)?jarvis,?\s+)?(?:what(?:'?s| is)\s+the\s+time|what\s+time\s+is\s+it|what(?:'?s| is)\s+(?:the\s+|today'?s\s+)?date|what\s+day\s+is\s+(?:it|today)|what(?:'?s| is)\s+today)(?:\s+(?:right\s+)?now|\s+today)?[\s?!.]*$/i,
    tool: 'clock',
    args: (_m, text) => ({ what: /\b(?:date|day|today)\b/i.test(text) && !/\btime\b/i.test(text) ? 'date' : 'time' })
  },
  {
    re: /^(?:hi|hey|hello|yo|hiya|howdy)\b[\s!.,]*$/i,
    tool: 'small_talk',
    args: () => ({ kind: 'greeting' })
  },
  {
    re: /^good\s+morning\b[\s!.,]*$/i,
    tool: 'small_talk',
    args: () => ({ kind: 'morning' })
  },
  {
    re: /^good\s+afternoon\b[\s!.,]*$/i,
    tool: 'small_talk',
    args: () => ({ kind: 'afternoon' })
  },
  {
    re: /^good\s+(?:evening|night)\b[\s!.,]*$/i,
    tool: 'small_talk',
    args: () => ({ kind: 'evening' })
  },
  {
    re: /^(?:what(?:'s|s)? up|sup|how(?:'s|s| is) it going|how are (?:you|things)|how(?:'re|re) you(?: doing)?|you (?:there|awake|up))\b[\s!.,?]*$/i,
    tool: 'small_talk',
    args: () => ({ kind: 'howAreYou' })
  },
  {
    re: /^(?:thanks|thank you|thanks a lot|cheers|ta|nice one|appreciate it)\b[\s!.,]*$/i,
    tool: 'small_talk',
    args: () => ({ kind: 'thanks' })
  },
  {
    re: /^(?:who are you|what are you|what(?:'s|s| is) your name|introduce yourself)\b[\s!.,?]*$/i,
    tool: 'small_talk',
    args: () => ({ kind: 'identity' })
  },
  {
    // Asked of a person this is small talk, and it was going to web search —
    // the screenshot said "I could not find anything for 'what are you
    // doing'", which is the assistant looking up its own conversation online.
    // Separate from the capability question below, which "what do you do"
    // also matches but means something quite different.
    re: /^(?:what(?:'s| is|s)? ?(?:are )?you (?:doing|up to)|you busy|are you busy|you awake|are you awake)\b[\s!.,?]*$/i,
    tool: 'small_talk',
    args: () => ({ kind: 'howAreYou' })
  },
  {
    re: /^(?:what can you do|what do you do|what are you able to do|help me|help|how do (?:i|you) (?:use|work) (?:this|you))\b[\s!.,?]*$/i,
    tool: 'small_talk',
    args: () => ({ kind: 'capability' })
  },
  {
    re: /^(?:bye|goodbye|good bye|see you|see ya|that(?:'s|s)? all|nothing|never mind|nevermind)\b[\s!.,]*$/i,
    tool: 'small_talk',
    args: () => ({ kind: 'goodbye' })
  },
  {
    re: /^(?:sorry|my bad|oops|whoops|ignore that)\b[\s!.,]*$/i,
    tool: 'small_talk',
    args: () => ({ kind: 'sorry' })
  },

  {
    // The optional "s" matters: \b after "what" does not match "whats", so
    // every question with the apostrophe dropped — which is most of them, as
    // transcribed — missed this pattern and fell through to the model.
    re: /^(?:what|who|when|where|why|how)(?:'?s)?\b.+$/i,
    tool: 'answer_from_web',
    args: (_m, text) => ({ query: searchableQuery(text) })
  }
];

/**
 * What a news question is about, or '' for the top stories.
 *
 * "latest news about the james webb telescope" -> "james webb telescope";
 * "tech news" -> "technology"; "what's the news", "world news",
 * "summarize today's headlines" -> top stories.
 */
const NEWS_SECTIONS = {
  tech: 'technology', technology: 'technology', science: 'science', sports: 'sports', sport: 'sports',
  business: 'business', money: 'business', finance: 'business', health: 'health',
  entertainment: 'entertainment', politics: 'politics', political: 'politics', ai: 'artificial intelligence'
};
function newsTopic(text) {
  const t = String(text || '').toLowerCase().replace(/[?.!]+$/, '').trim();
  const about = t.match(/\b(?:news|headlines)\s+(?:about|on|regarding|for|from|in|around)\s+(?:the\s+)?(.+)$/) ||
    t.match(/\b(?:latest|recent|updates?)\s+(?:on|about)\s+(?:the\s+)?(.+)$/);
  if (about) {
    const topic = about[1].replace(/\b(?:today|tonight|right now|this week|please)\b/g, '').replace(/\s+/g, ' ').trim();
    if (topic && !/^(?:the )?(?:world|today)$/.test(topic)) return topic;
  }
  const section = t.match(/\b([a-z]+)\s+(?:news|headlines)\b/);
  if (section && NEWS_SECTIONS[section[1]]) return NEWS_SECTIONS[section[1]];
  return '';
}

/**
 * The part of a spoken question a search engine can actually use.
 *
 * People do not speak in queries. "What's going around in the news today? Can
 * you research and give me a brief summary of what's going on in the news?"
 * went to the web verbatim, matched nothing, and came back as "I could not
 * find anything for <the entire sentence>".
 *
 * Two cuts. The first sentence is the question; anything after it is the user
 * restating it or saying how they want it answered. Then the asking-phrases
 * come off the front, because "can you research" is not part of the subject.
 */
function searchableQuery(text) {
  let out = String(text || '').trim();

  // The first question is the question. A second sentence is almost always
  // "can you summarise it", which is an instruction, not a search term.
  const firstQuestion = out.match(/^[^?]{8,}\?/);
  if (firstQuestion) out = firstQuestion[0];

  out = out
    .replace(/[?!.]+\s*$/, '')
    // Asking-phrases, however they are stacked: "hey jarvis can you please
    // look up and tell me about ...".
    .replace(/^(?:hey |ok |okay )?jarvis[,\s]+/i, '')
    .replace(/^(?:could|can|will|would)\s+you\s+(?:please\s+)?/i, '')
    .replace(/^(?:please\s+)?(?:research|look\s*up|search\s+(?:for|up)|find|google|check|tell\s+me|give\s+me)\s+(?:me\s+)?(?:about\s+)?/i, '')
    .replace(/^(?:a\s+)?(?:brief|short|quick)\s+(?:summary|rundown|overview)\s+(?:of|on|about)\s+/i, '')
    .replace(/\s+(?:please|thanks|thank you)$/i, '')
    .trim();

  // Having stripped everything, fall back rather than searching for nothing.
  return out.length >= 3 ? out : String(text || '').replace(/[?]+$/, '').trim();
}

/**
 * Returns the tool and arguments for a recognised command, or null.
 * @param {string} text what the user said
 * @param {Array<{name:string}>} tools the tools currently available
 */
function matchIntent(text, tools, config = null) {
  // Curly quotes and dashes are normalised first. Whisper emits both forms
  // depending on the sentence, and a pattern written with a straight
  // apostrophe would match one and silently miss the other.
  const straight = String(text || '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .trim();
  if (!straight) return null;

  // And then into the plainer English these patterns were written in. Nobody
  // says "play music"; they say "bump some music", "pull up my grades", "yo
  // what's the move". Those missed, or matched the wrong thing entirely —
  // "bet play some music" was pausing the track. Only the routing decision
  // uses this; the user's own words are what gets shown and spoken.
  const clean = normalizeSlang(straight);
  if (!clean) return null;
  const byName = new Map(tools.map((t) => [t.name, t]));

  const tryAll = (text) => {
    for (const intent of INTENTS) {
      const m = intent.re.exec(text);
      if (!m) continue;
      if (intent.guard && !intent.guard(m, text, config)) continue;
      const tool = byName.get(intent.tool);
      if (!tool) continue; // the owning app is switched off
      return { tool, args: intent.args ? intent.args(m, text, config) : {} };
    }
    return null;
  };

  const direct = tryAll(clean);
  if (direct) return direct;

  // Nothing matched as spoken. Strip the greeting, the name and the politeness
  // and try once more. Second pass rather than first, so a sentence that
  // already routed cannot start routing differently — and so that a bare
  // "hey", which strips to nothing, stays a greeting.
  const stripped = stripChatter(clean);
  if (stripped && stripped !== clean) {
    const loose = tryAll(stripped);
    if (loose) return loose;
  }
  return null;
}

module.exports = { matchIntent, INTENTS, SITES, siteUrl, stripChatter, musicQuery };
