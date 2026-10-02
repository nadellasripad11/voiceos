'use strict';
/**
 * Agent tools.
 *
 * Each tool pairs a JSON schema the model can call with an executor that does
 * the real work through the native bridge, the browser controller, or the
 * filesystem. Tools declare `mutating: true` when they send, create, change or
 * delete; the agent must get the user's approval before running those.
 *
 * Only tools whose app is enabled and whose platform matches are exposed, so
 * the model is never offered something that cannot run.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { paths } = require('../paths');
const { googleTools } = require('./tools-google');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Shorthand for a JSON-schema object. */
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });

// --- This PC --------------------------------------------------------------

const systemTools = (ctx) => [
  {
    name: 'open_app',
    appId: 'system',
    description: 'Open an application on this computer by name, for example Spotify, Chrome, Notepad.',
    parameters: obj({ name: str('The application name') }, ['name']),
    mutating: true,
    confirm: (args) => ({ title: `Open ${args.name}?`, detail: 'Launches the application.' }),
    run: async ({ name }) => {
      const r = await ctx.bridge.openApp(name);
      return { ok: true, summary: `Opened ${r.name || name}.`, found: [{ glyph: '🖥️', title: name, subtitle: 'Launched' }] };
    }
  },
  {
    name: 'open_url',
    appId: 'system',
    description: 'Open a web page in the default browser.',
    parameters: obj({ url: str('The full URL to open') }, ['url']),
    mutating: true,
    confirm: (args) => ({ title: 'Open this page?', detail: args.url }),
    run: async ({ url }) => {
      const safe = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      await ctx.bridge.openUrl(safe);
      return { ok: true, summary: `Opened ${safe}.`, found: [{ glyph: '🌐', title: safe, subtitle: 'Opened in your browser' }] };
    }
  },
  {
    name: 'list_windows',
    appId: 'system',
    description: 'List the windows currently open on this computer.',
    parameters: obj({}),
    run: async () => {
      const wins = await ctx.bridge.listWindows();
      return {
        ok: true,
        summary: wins.length
          ? `${wins.length} windows open: ${wins.map((w) => w.process).join(', ')}.`
          : 'No windows are open.',
        found: wins.slice(0, 8).map((w) => ({ glyph: '🪟', title: w.title || w.process, subtitle: w.process }))
      };
    }
  },
  {
    name: 'read_screen',
    appId: 'system',
    description: 'Read the text currently visible on screen. Use when the user asks about what they are looking at.',
    parameters: obj({}),
    run: async () => {
      if (ctx.config.get('privacy.privateMode')) {
        return { ok: false, summary: 'Private Mode is on, so I cannot read the screen.' };
      }
      const shot = path.join(paths.tmp, `screen-${Date.now()}.png`);
      try {
        const r = await ctx.bridge.ocrScreen(shot);
        const text = (r.text || '').replace(/\s+/g, ' ').trim();
        return {
          ok: true,
          summary: text ? text.slice(0, 4000) : 'I could not read any text on screen.',
          found: [{ glyph: '👁️', title: 'Screen text', subtitle: `${(r.lines || []).length} lines read` }]
        };
      } finally {
        fs.rmSync(shot, { force: true });
      }
    }
  },
  {
    name: 'point_and_ask',
    appId: 'system',
    description:
      'Identify or explain whatever is under the mouse cursor right now. Use this whenever the user says ' +
      '"this", "that", "him", "her", or "it" without naming what they mean, for example "who is that", ' +
      '"what is this", "what does that say".',
    parameters: obj({ question: str('What the user actually asked') }),
    run: async ({ question } = {}) => {
      if (ctx.config.get('privacy.privateMode')) {
        return { ok: false, summary: 'Private Mode is on, so I cannot look at the screen.' };
      }

      const context = await readCursorContext(ctx);
      if (!context.element && !context.text) {
        return { ok: false, summary: 'I could not tell what is under your cursor.' };
      }

      // With a model available the agent reasons over this; without one, saying
      // exactly what is under the cursor is still a useful answer.
      const parts = [];
      if (context.element && context.element.name) {
        parts.push(`Under the cursor: "${context.element.name}" (${context.element.controlType || 'element'}).`);
      }
      if (context.element && context.element.value) {
        parts.push(`Its contents: ${String(context.element.value).slice(0, 600)}`);
      }
      if (context.text) {
        parts.push(`Text around the cursor:
${context.text.slice(0, 2500)}`);
      }
      if (context.window) {
        parts.push(`Window: ${context.window.title} (${context.window.process}).`);
      }

      return {
        ok: true,
        summary: parts.join('\n\n'),
        found: [{
          glyph: '🎯',
          title: (context.element && context.element.name) || 'What you pointed at',
          subtitle: context.window ? `${context.window.process} · ${context.lines} lines read` : `${context.lines} lines read`
        }],
        context
      };
    }
  },
  {
    name: 'read_selection',
    appId: 'system',
    description: 'Read the text the user currently has selected.',
    parameters: obj({}),
    run: async () => {
      const sel = await ctx.bridge.selection();
      return {
        ok: true,
        summary: sel.text ? sel.text.slice(0, 4000) : 'Nothing is selected.',
        found: sel.text ? [{ glyph: '✂️', title: 'Selected text', subtitle: `${sel.text.length} characters` }] : []
      };
    }
  },
  {
    name: 'set_volume',
    appId: 'system',
    description: 'Turn the system volume up, down, or mute it.',
    parameters: obj({ direction: { type: 'string', enum: ['up', 'down', 'mute'], description: 'Which way to change the volume' },
                      steps: num('How many steps, default 4') }),
    mutating: true,
    autoConfirm: true,
    run: async ({ direction, steps = 4 }) => {
      const key = { up: 'volume_up', down: 'volume_down', mute: 'volume_mute' }[direction] || 'volume_up';
      const times = direction === 'mute' ? 1 : Math.max(1, Math.min(20, steps));
      for (let i = 0; i < times; i++) await ctx.bridge.mediaKey(key);
      return { ok: true, summary: direction === 'mute' ? 'Toggled mute.' : `Turned the volume ${direction}.` };
    }
  }
];

/**
 * Gathers what is under the mouse pointer.
 *
 * Three sources, cheapest first: the accessibility element under the point,
 * which gives exact text when the app exposes it; the window it belongs to; and
 * an OCR pass over a region around the cursor, which works even when the app
 * exposes nothing. The OCR region is deliberately a crop rather than the whole
 * screen, both because it is far faster and because it keeps unrelated parts of
 * the display out of the context.
 */
async function readCursorContext(ctx, { radiusX = 620, radiusY = 380 } = {}) {
  const out = { element: null, window: null, text: '', lines: 0, at: null };

  const pos = await ctx.bridge.cursorPos();
  out.at = pos;

  try {
    out.element = await ctx.bridge.elementAt(pos.x, pos.y);
  } catch { /* some surfaces expose nothing */ }

  try {
    out.window = await ctx.bridge.windowAt(pos.x, pos.y);
  } catch {}

  const shot = path.join(paths.tmp, `point-${Date.now()}.png`);
  try {
    const region = {
      x: Math.max(0, pos.x - radiusX),
      y: Math.max(0, pos.y - radiusY),
      width: radiusX * 2,
      height: radiusY * 2
    };
    const r = await ctx.bridge.ocrScreen(shot, region);
    out.text = (r.text || '').replace(/\s+/g, ' ').trim();
    out.lines = (r.lines || []).length;
  } catch (err) {
    ctx.logger.warn?.(`[point] OCR failed: ${err.message}`);
  } finally {
    fs.rmSync(shot, { force: true });
  }

  return out;
}

// --- Small talk -----------------------------------------------------------

/**
 * Replies to the things people say that are not requests.
 *
 * "What's up?" was being routed to a web lookup, because it starts with "what"
 * and the open-ended web pattern is the last resort. Searching the web for a
 * greeting is both slow and faintly absurd, so the handful of conversational
 * openers are answered outright: no network, no model, no wait.
 *
 * Several replies per kind, chosen at random, because an assistant that says
 * the same seven words every single morning gets old fast.
 */
const SMALL_TALK = {
  greeting: ['Hello.', 'Hello there.', 'Hi.'],
  morning: ['Good morning.'],
  afternoon: ['Good afternoon.'],
  evening: ['Good evening.'],
  howAreYou: ['Running well, thank you. What do you need?', 'All good here. What can I do?'],
  thanks: ['Any time.', 'My pleasure.', 'Of course.'],
  identity: ["I'm VoiceOS. I listen, I type, and I run things on this machine."],
  capability: [
    'Hold Ctrl and Alt to dictate anywhere, or Ctrl and Shift to ask me something. ' +
    'Select text first and tell me how to change it, and I will rewrite it in place.'
  ],
  goodbye: ['Goodbye.', 'Talk soon.'],
  sorry: ['No harm done.']
};

const smallTalkTools = () => [
  {
    name: 'small_talk',
    appId: 'system',
    description: 'Reply to a greeting, thanks, or a question about what you are. No lookup.',
    parameters: obj({
      kind: { type: 'string', description: Object.keys(SMALL_TALK).join(' | ') }
    }),
    run: async ({ kind }) => {
      const options = SMALL_TALK[kind] || SMALL_TALK.greeting;
      const line = options[Math.floor(Math.random() * options.length)];
      return { ok: true, summary: line, spoken: line };
    }
  }
];

// --- Media ----------------------------------------------------------------

const mediaTools = (ctx) => [
  {
    name: 'now_playing',
    appId: 'spotify',
    description: 'Find out what music or video is currently playing.',
    parameters: obj({}),
    run: async () => {
      const r = await ctx.bridge.mediaStatus();
      if (!r.current) return { ok: true, summary: 'Nothing is playing right now.' };
      const c = r.current;
      const who = c.artist ? ` by ${c.artist}` : '';
      return {
        ok: true,
        summary: `${c.status === 'Playing' ? 'Playing' : c.status}: ${c.title}${who}.`,
        found: [{
          icon: 'spotify.webp',
          title: c.title || 'Unknown track',
          subtitle: [c.artist, c.album, c.app].filter(Boolean).join(' · ')
        }]
      };
    }
  },
  {
    name: 'control_playback',
    appId: 'spotify',
    description: 'Play, pause, skip to the next track, or go back to the previous track.',
    parameters: obj({
      action: { type: 'string', enum: ['play', 'pause', 'toggle', 'next', 'previous'], description: 'What to do' },
      app: str('Optional player name, e.g. Spotify')
    }, ['action']),
    mutating: true,
    autoConfirm: true,
    run: async ({ action, app }) => {
      const r = await ctx.bridge.mediaControl(action, { app });
      if (!r.ok) return { ok: false, summary: r.error || 'Nothing is playing.' };
      const s = r.state || {};
      const verb = { play: 'Playing', pause: 'Paused', toggle: 'Toggled', next: 'Skipped to', previous: 'Went back to' }[action];
      return {
        ok: true,
        summary: s.title ? `${verb} ${s.title}${s.artist ? ` by ${s.artist}` : ''}.` : `${verb}.`,
        found: s.title ? [{ icon: 'spotify.webp', title: s.title, subtitle: [s.artist, s.status].filter(Boolean).join(' · ') }] : []
      };
    }
  }
];

// --- Web search -----------------------------------------------------------

const webTools = (ctx) => [
  {
    name: 'search_web',
    appId: 'web-search',
    description: 'Search the web and get a short list of results with sources. Use for current facts.',
    parameters: obj({ query: str('What to search for') }, ['query']),
    run: async ({ query }) => {
      const results = await duckDuckGo(query);
      if (!results.length) return { ok: true, summary: `I found nothing for "${query}".` };
      return {
        ok: true,
        summary: results.slice(0, 5).map((r, i) => `${i + 1}. ${r.title} — ${r.snippet}`).join('\n'),
        found: results.slice(0, 5).map((r) => ({ glyph: '🔍', title: r.title, subtitle: r.url }))
      };
    }
  },
  {
    name: 'answer_from_web',
    appId: 'web-search',
    description: 'Look up a direct factual answer, such as a definition, a conversion, or who someone is.',
    parameters: obj({ query: str('The question to look up') }, ['query']),
    run: async ({ query }) => {
      const instant = await duckDuckGoInstant(query);
      if (instant) {
        return {
          ok: true,
          summary: instant.text,
          found: [{ glyph: '📘', title: instant.heading || query, subtitle: instant.source || 'DuckDuckGo' }]
        };
      }
      const results = await duckDuckGo(query);
      if (!results.length) return { ok: true, summary: `I could not find an answer for "${query}".` };
      return {
        ok: true,
        summary: results[0].snippet || results[0].title,
        found: results.slice(0, 3).map((r) => ({ glyph: '🔍', title: r.title, subtitle: r.url }))
      };
    }
  },
  {
    name: 'fetch_page',
    appId: 'web-search',
    description: 'Read the text of a specific web page.',
    parameters: obj({ url: str('The page URL') }, ['url']),
    run: async ({ url }) => {
      const safe = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      const res = await fetch(safe, {
        headers: { 'User-Agent': 'Mozilla/5.0 VoiceOS' },
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) return { ok: false, summary: `That page returned HTTP ${res.status}.` };
      const html = await res.text();
      const text = stripHtml(html).slice(0, 6000);
      return {
        ok: true,
        summary: text,
        found: [{ glyph: '📄', title: new URL(safe).hostname, subtitle: `${text.length} characters read` }]
      };
    }
  }
];

/** DuckDuckGo's HTML endpoint: no API key, no quota, no cost. */
async function duckDuckGo(query) {
  const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) return [];
  const html = await res.text();
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 8) {
    out.push({
      url: decodeDdgUrl(m[1]),
      title: stripHtml(m[2]).trim(),
      snippet: stripHtml(m[3]).trim()
    });
  }
  return out;
}

/** DuckDuckGo's Instant Answer API, for definitions and quick facts. */
async function duckDuckGoInstant(query) {
  try {
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return null;
    const d = await res.json();
    const text = d.AbstractText || d.Answer || (d.RelatedTopics && d.RelatedTopics[0] && d.RelatedTopics[0].Text);
    if (!text) return null;
    return { text, heading: d.Heading, source: d.AbstractSource };
  } catch {
    return null;
  }
}

function decodeDdgUrl(href) {
  const m = /uddg=([^&]+)/.exec(href);
  return m ? decodeURIComponent(m[1]) : href;
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Files ----------------------------------------------------------------

/** Folders the agent may look in. Everything else is off limits. */
function allowedRoots(ctx) {
  const configured = ctx.config.get('apps.files.config.roots', null);
  if (Array.isArray(configured) && configured.length) return configured;
  const home = os.homedir();
  return ['Documents', 'Downloads', 'Desktop', 'Pictures'].map((d) => path.join(home, d));
}

function insideAllowedRoot(ctx, target) {
  const resolved = path.resolve(target);
  return allowedRoots(ctx).some((root) => resolved.startsWith(path.resolve(root)));
}

const fileTools = (ctx) => [
  {
    name: 'search_files',
    appId: 'files',
    description: 'Find a file by name in the user\'s documents, downloads, desktop or pictures.',
    parameters: obj({ query: str('Part of the file name'), limit: num('Max results, default 10') }, ['query']),
    run: async ({ query, limit = 10 }) => {
      const needle = String(query).toLowerCase();
      const hits = [];
      for (const root of allowedRoots(ctx)) {
        walk(root, 4, (file, stat) => {
          if (hits.length >= limit) return false;
          if (path.basename(file).toLowerCase().includes(needle)) {
            hits.push({ file, size: stat.size, mtime: stat.mtime });
          }
          return true;
        });
        if (hits.length >= limit) break;
      }
      if (!hits.length) return { ok: true, summary: `I could not find any file matching "${query}".` };
      return {
        ok: true,
        summary: `Found ${hits.length} file${hits.length === 1 ? '' : 's'} matching "${query}".`,
        found: hits.map((h) => ({
          glyph: '📄',
          title: path.basename(h.file),
          subtitle: `${path.dirname(h.file)} · ${formatSize(h.size)}`
        }))
      };
    }
  },
  {
    name: 'open_file',
    appId: 'files',
    description: 'Open a file in its default application.',
    parameters: obj({ filePath: str('Full path to the file') }, ['filePath']),
    mutating: true,
    confirm: (args) => ({ title: 'Open this file?', detail: args.filePath }),
    run: async ({ filePath }) => {
      if (!insideAllowedRoot(ctx, filePath)) {
        return { ok: false, summary: 'That file is outside the folders I am allowed to open.' };
      }
      await ctx.bridge.openPath(filePath);
      return { ok: true, summary: `Opened ${path.basename(filePath)}.` };
    }
  }
];

function walk(dir, depth, visit) {
  if (depth < 0) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, depth - 1, visit);
    } else {
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (visit(full, stat) === false) return;
    }
  }
}

function formatSize(bytes) {
  if (bytes > 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB';
  if (bytes > 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

// --- Notes and reminders --------------------------------------------------

const noteTools = (ctx) => [
  {
    name: 'take_note',
    appId: 'notes',
    description: 'Save a note for the user.',
    parameters: obj({ text: str('The note content'), title: str('Optional title') }, ['text']),
    mutating: true,
    autoConfirm: true,
    run: async ({ text, title }) => {
      const dir = path.join(paths.userData, 'notes');
      fs.mkdirSync(dir, { recursive: true });
      const name = (title || `Note ${new Date().toLocaleString()}`).replace(/[^\w\s-]/g, '').trim();
      const file = path.join(dir, `${name || 'note'}.md`);
      fs.appendFileSync(file, `${text}\n\n`, 'utf8');
      return { ok: true, summary: 'Saved the note.', found: [{ glyph: '📝', title: name, subtitle: 'Saved to your notes' }] };
    }
  },
  {
    name: 'create_reminder',
    appId: 'todo',
    description: 'Remind the user about something at a given time.',
    parameters: obj({ text: str('What to be reminded about'), when: str('When, e.g. "in 20 minutes" or "tomorrow 9am"') }, ['text']),
    mutating: true,
    autoConfirm: true,
    run: async ({ text, when }) => {
      const at = parseWhen(when);
      const store = path.join(paths.userData, 'reminders.json');
      let list = [];
      try { list = JSON.parse(fs.readFileSync(store, 'utf8')); } catch {}
      list.push({ id: Date.now(), text, at: at ? at.toISOString() : null, created: new Date().toISOString(), done: false });
      fs.writeFileSync(store, JSON.stringify(list, null, 2), 'utf8');
      return {
        ok: true,
        summary: at ? `I will remind you ${when} — ${text}.` : `Saved the reminder: ${text}.`,
        found: [{ glyph: '⏰', title: text, subtitle: at ? at.toLocaleString() : 'No time set' }]
      };
    }
  },
  {
    name: 'list_reminders',
    appId: 'todo',
    description: 'List the user\'s reminders.',
    parameters: obj({}),
    run: async () => {
      const store = path.join(paths.userData, 'reminders.json');
      let list = [];
      try { list = JSON.parse(fs.readFileSync(store, 'utf8')); } catch {}
      const open = list.filter((r) => !r.done);
      if (!open.length) return { ok: true, summary: 'You have no reminders.' };
      return {
        ok: true,
        summary: `You have ${open.length} reminder${open.length === 1 ? '' : 's'}.`,
        found: open.slice(0, 8).map((r) => ({
          glyph: '⏰',
          title: r.text,
          subtitle: r.at ? new Date(r.at).toLocaleString() : 'No time set'
        }))
      };
    }
  }
];

/** Parses the handful of time phrasings people actually say out loud. */
function parseWhen(when) {
  if (!when) return null;
  const s = String(when).toLowerCase().trim();
  const now = new Date();

  let m = /in\s+(\d+)\s*(second|sec|minute|min|hour|hr|day)s?/.exec(s);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const ms = unit.startsWith('sec') ? n * 1000
      : unit.startsWith('min') ? n * 60000
      : unit.startsWith('hour') || unit.startsWith('hr') ? n * 3600000
      : n * 86400000;
    return new Date(now.getTime() + ms);
  }

  m = /(tomorrow|today)?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(s);
  if (m && m[2]) {
    const d = new Date(now);
    if (m[1] === 'tomorrow') d.setDate(d.getDate() + 1);
    let hour = Number(m[2]);
    if (m[4] === 'pm' && hour < 12) hour += 12;
    if (m[4] === 'am' && hour === 12) hour = 0;
    d.setHours(hour, Number(m[3] || 0), 0, 0);
    if (d <= now && !m[1]) d.setDate(d.getDate() + 1);
    return d;
  }
  return null;
}

/**
 * What to say while a tool runs.
 *
 * Spoken before the work starts, so the reply begins immediately instead of
 * after the round trip. Deliberately vague about the outcome: it has not
 * happened yet, and promising a result that might fail would be worse than
 * silence.
 */
const OPENINGS = {
  list_email: 'Checking your email.',
  read_email: 'Finding that message.',
  send_email: 'Drafting that.',
  list_events: 'Looking at your calendar.',
  create_event: 'Adding that.',
  list_coursework: 'Checking what is due.',
  search_drive: 'Searching your Drive.',
  search_web: 'Searching the web.',
  answer_from_web: 'Looking that up.',
  fetch_page: 'Reading that page.',
  search_files: 'Looking through your files.',
  read_screen: 'Reading your screen.',
  point_and_ask: 'Having a look.',
  now_playing: null,          // instant; an opening line would arrive after it
  control_playback: null,
  set_volume: null,
  list_reminders: null,
  create_reminder: null,
  take_note: null,
  list_windows: null,
  open_app: null,
  open_url: null
};

/** The line to speak while a tool runs, or null when it is not worth one. */
function openingFor(toolName) {
  return OPENINGS[toolName] || null;
}

// --- Registry -------------------------------------------------------------

/**
 * Builds the tool list for this run.
 *
 * Filters to apps the user has enabled so the model is never offered something
 * that would fail, and so a disabled integration genuinely cannot be reached.
 */
function buildTools(ctx) {
  const all = [
    ...systemTools(ctx),
    ...smallTalkTools(),
    // Only offered when a connection manager is present to resolve tokens.
    ...(ctx.connections ? googleTools(ctx) : []),
    ...mediaTools(ctx),
    ...webTools(ctx),
    ...fileTools(ctx),
    ...noteTools(ctx)
  ];

  const apps = ctx.config.get('apps', {});
  const alwaysOn = new Set(['system', 'web-search']);

  return all.filter((t) => {
    if (alwaysOn.has(t.appId)) return true;
    const entry = apps[t.appId];
    return entry ? entry.enabled !== false : true;
  });
}

/** The schema list handed to the model. */
function toolSchemas(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }));
}

module.exports = {
  readCursorContext,
  SMALL_TALK,
  openingFor,
  OPENINGS,
  buildTools,
  toolSchemas,
  duckDuckGo,
  duckDuckGoInstant,
  stripHtml,
  parseWhen,
  allowedRoots
};
