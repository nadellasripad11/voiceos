'use strict';
/**
 * Agent tools.
 *
 * Each tool pairs a JSON schema the model can call with an executor that does
 * the real work through the native bridge, the browser controller, or the
 * filesystem. `mutating: true` means a mistake would reach other people or
 * could not be undone — sending mail, adding to a shared calendar — and only
 * those ask before running. Opening an app or a page, changing the volume or
 * writing a note to yourself is reversible and was just asked for out loud, so
 * asking again is friction with nothing behind it.
 *
 * Tools declare `mutating: true` when they send, create, change or
 * delete; the agent must get the user's approval before running those.
 *
 * Only tools whose app is enabled and whose platform matches are exposed, so
 * the model is never offered something that cannot run.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { paths } = require('../paths');
const { answerFromWeb, getWeather, search: webSearch, newsHeadlines } = require('./web');
const { pictureFor, imageSubject } = require('./images');
const { playOnWeb } = require('../music/spotify-web');
const { runTask } = require('./task');
const { runBrowse } = require('./browse');
const { looksLikeExfiltration } = require('./untrusted');
const { sendMessage } = require('./messaging');
const { canvasTools } = require('./tools-canvas');
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

    run: async ({ url }) => {
      const safe = /^https?:\/\//i.test(url) ? url : `https://${url}`;

      // Opening a link is how an assistant that reads the web would leak what
      // it read: the data rides in the query string and the request delivers
      // it whether the page loads or not. An ordinary link carries short,
      // readable terms, so this only stops the shape that is carrying a
      // payload — and it asks rather than refuses, because a long legitimate
      // URL exists too.
      const exfil = looksLikeExfiltration(safe);
      if (exfil.suspicious) {
        ctx.logger?.warn?.(`[security] refused to open a link because ${exfil.reason}: ${safe.slice(0, 120)}`);
        return {
          ok: false,
          summary: `I did not open that link: ${exfil.reason}. If you meant to, open it yourself.`,
          blocked: true
        };
      }

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

const musicSearchTools = (ctx) => [
  {
    name: 'play_search',
    appId: 'spotify',
    description: 'Play a named artist, song or album, e.g. "play Drake". Not for a bare "play music".',
    parameters: obj({ query: str('The artist, song or album to play') }, ['query']),
    run: async ({ query }) => {
      const term = String(query || '').trim();
      if (!term) return { ok: false, summary: 'Nothing to search for.' };

      // The web player is the only thing that actually starts a named artist
      // on a free account. The desktop app exposes nothing to automate — its
      // accessibility tree is empty, and four key sequences were tried against
      // the real media session without starting anything — and the Web API's
      // playback endpoints need Premium. The web player's play button is a
      // real element, so it can simply be clicked.
      if (ctx.config.get('media.useWebPlayer', true) && ctx.browser) {
        try {
          const r = await playOnWeb({ browser: ctx.browser, query: term, logger: ctx.logger });
          if (r.ok) {
            return {
              ok: true,
              summary: `Playing ${r.track || term}.`,
              spoken: `Playing ${term}.`,
              found: [{ icon: 'spotify.webp', title: r.track || term, subtitle: 'Spotify web player' }]
            };
          }
          if (r.needsLogin) {
            return { ok: false, summary: r.reason, spoken: 'Spotify needs you to log in once in the browser I opened.' };
          }
          ctx.logger.warn?.(`[music] web player: ${r.reason}`);
        } catch (err) {
          ctx.logger.warn?.(`[music] web player failed: ${err.message}`);
        }
      }

      // Falling back: open the desktop app on the search so it is one click
      // away, and say that rather than claiming to have played something.
      try {
        await ctx.bridge.openUrl(`spotify:search:${encodeURIComponent(term)}`);
      } catch {
        await ctx.bridge.openUrl(`https://open.spotify.com/search/${encodeURIComponent(term)}`).catch(() => {});
      }
      return {
        ok: true,
        summary: `I opened Spotify on "${term}" — press play on the one you want.`,
        spoken: `I found ${term} on Spotify.`
      };
    }
  }
];

const taskTools = (ctx) => [
  {
    name: 'do_task',
    appId: 'system',
    description: 'Do a piece of work: write something, answer assignment questions, summarise a page. Saves the result to a file.',
    parameters: obj({
      goal: str('What to do, in the words it was asked in'),
      url: str('A page to work from, if one was named')
    }, ['goal']),
    run: async ({ goal, url = null }, { signal } = {}) => {
      const r = await runTask({
        goal,
        url: url || null,
        browser: ctx.browser,
        provider: ctx.provider,
        model: ctx.config.get('llm.model'),
        config: ctx.config,
        logger: ctx.logger,
        signal
      });
      if (!r.ok) return { ok: false, summary: r.summary };

      // Spoken short, because the work itself is for reading. And it says
      // which it was — found or written — because those are different things
      // and only one of them has been checked against anything.
      const spoken = r.found.length
        ? 'Found it, and saved it.'
        : (r.file ? 'I wrote it and saved it. Worth checking.' : 'I wrote it. Worth checking.');

      return {
        ok: true,
        summary: r.summary,
        spoken,
        found: r.file ? [{ glyph: '📄', title: require('path').basename(r.file), subtitle: r.found.length ? 'found' : 'written by me' }] : []
      };
    }
  }
];

const imageTools = (ctx) => [
  {
    name: 'show_image',
    appId: 'web-search',
    description: 'Show a picture of something. Use for "what does X look like" or "show me a picture of X".',
    parameters: obj({ subject: str('What to show a picture of') }, ['subject']),
    run: async ({ subject }) => {
      const picture = await pictureFor(`show me pictures of ${subject}`, { logger: ctx.logger });
      if (!picture) {
        return { ok: true, summary: `I could not find a picture of ${subject}.`, spoken: `I could not find one.` };
      }
      return {
        ok: true,
        summary: [picture.title, picture.caption].filter(Boolean).join(' — '),
        spoken: `Here is ${picture.title}.`,
        image: picture,
        found: picture.link
          ? [{ glyph: '🖼️', title: picture.title, subtitle: picture.source, url: picture.link }]
          : []
      };
    }
  }
];

const personalTools = (ctx) => [
  {
    name: 'personal_data',
    appId: 'system',
    description: "Explain that something about the user's own account is not connected. Never searches the web.",
    parameters: obj({ topic: str('What was asked about, e.g. grades'), app: str('Which service, if named') }),
    run: async ({ topic = 'that', app = null } = {}) => {
      // The web cannot answer a question about the user's own data, and a
      // model handed search results about it will invent an answer that looks
      // right. Saying what is missing is more use than that.
      const named = app ? app.replace(/^\w/, (ch) => ch.toUpperCase()) : null;
      // status() returns { providers, accounts, appDefaults }. Reading it as a
      // flat map meant this never named a single connected account, so the
      // reply was always the less useful half of what it could say.
      const status = ctx.connections && ctx.connections.status ? ctx.connections.status() : {};
      const connected = Object.values((status && status.providers) || {})
        .filter((p) => p && p.connected)
        .map((p) => p.name);

      const detail = named
        ? `${named} is not connected, so I cannot see your ${topic}.`
        : `I cannot see your ${topic} — the account it lives in is not connected.`;
      const next = connected.length
        ? ` Connected right now: ${connected.join(', ')}. Open Apps to add another.`
        : ' Open Apps to connect an account.';

      return {
        ok: true,
        summary: detail + next,
        spoken: named ? `${named} is not connected, so I cannot check your ${topic}.`
          : `I cannot see your ${topic}; that account is not connected.`
      };
    }
  }
];

/**
 * Messaging, through a browser already signed in.
 *
 * Two channels: a text goes through Google Messages for Web, WhatsApp goes
 * through WhatsApp Web. Both are free and need no telephony account, which is
 * what a phone call would have cost.
 *
 * mutating, and deliberately not autoConfirm: this is the only tool that
 * speaks to other people in the user's name, and a misheard name sending to
 * the wrong person is not a mistake an apology fixes.
 */
const messagingTools = (ctx) => [
  {
    name: 'send_message',
    appId: 'whatsapp',
    description: 'Send a text message (SMS) or a WhatsApp message to someone. Use whatsapp when they say WhatsApp; sms otherwise.',
    parameters: obj({
      to: str('The contact name, as it appears in their messages'),
      text: str('What to say'),
      channel: { type: 'string', enum: ['sms', 'whatsapp'], description: 'sms for a text message, whatsapp for WhatsApp' }
    }, ['to', 'text']),
    mutating: true,
    confirm: ({ to, text, channel } = {}) => ({
      app: channel === 'whatsapp' ? 'whatsapp' : 'messages',
      // Naming the route matters: a text sent when WhatsApp was meant reaches
      // the right person the wrong way, and they may never see it.
      title: channel === 'whatsapp' ? `WhatsApp ${to}?` : `Text ${to}?`,
      // The whole message, because approving what you cannot read is not
      // approval.
      detail: String(text || '')
    }),
    run: async ({ to, text, channel } = {}) => {
      try {
        return await sendMessage({
          browser: ctx.browser,
          bridge: ctx.bridge,
          config: ctx.config,
          channel: channel === 'whatsapp'
            ? 'whatsapp'
            : (channel || ctx.config.get('messaging.defaultChannel', 'sms')),
          to,
          text,
          logger: ctx.logger
        });
      } catch (err) {
        ctx.logger?.warn?.(`[message] ${err.message}`);
        return { ok: false, summary: `I could not send that: ${err.message}` };
      }
    }
  }
];

const weatherTools = (ctx) => [
  {
    name: 'weather',
    appId: 'web-search',
    description: 'The weather or forecast, here or in a named place. Use for anything about temperature, rain or sun.',
    parameters: obj({
      place: str('A city or place name. Leave empty for where the user is.'),
      when: str('now, today or tomorrow')
    }),
    run: async ({ place, when } = {}) => {
      try {
        const args = {
          place: place || null,
          when: /tomorrow/i.test(when || '') ? 'tomorrow' : (/today/i.test(when || '') ? 'today' : 'now'),
          units: ctx.config.get('units.temperature', 'F')
        };
        // Served from the background refresher when it is the common case —
        // here, now — which turns two network round trips into a property
        // read. It falls through to the live call for anywhere else, and for
        // any caller that was not given one.
        if (ctx.ambient) return await ctx.ambient.weather(args);
        return await getWeather(args);
      } catch (err) {
        ctx.logger.warn?.(`[weather] ${err.message}`);
        return { ok: false, summary: `I could not reach the weather service: ${err.message}` };
      }
    }
  }
];

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
  // Read aloud in a British male voice, so the register matters: "Hi." landed
  // like a different person had answered. "Sir" is used sparingly on purpose —
  // JARVIS says it, but on every line it stops being character and becomes a
  // tic you want switched off.
  greeting: ['Hello, sir.', 'Hello there.', 'Yes, sir?'],
  morning: ['Good morning, sir.'],
  afternoon: ['Good afternoon, sir.'],
  evening: ['Good evening, sir.'],
  howAreYou: ['Running well, thank you. What do you need?', 'All systems nominal. What can I do?'],
  thanks: ['Any time.', 'My pleasure, sir.', 'Of course.'],
  identity: ["I'm Jarvis. I listen, I type, and I run things on this machine."],
  capability: [
    'Hold Ctrl and Alt to dictate anywhere, or Ctrl and Shift to ask me something. ' +
    'Select text first and tell me how to change it, and I will rewrite it in place.'
  ],
  goodbye: ['Goodbye, sir.', 'Until next time.'],
  sorry: ['No harm done.']
};

const smallTalkTools = () => [
  {
    name: 'clock',
    appId: 'system',
    description: 'The current local time or date. No lookup.',
    parameters: obj({ what: { type: 'string', description: 'time | date' } }),
    run: async ({ what = 'time' } = {}) => {
      const now = new Date();
      const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const date = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      const line = what === 'date' ? `It's ${date}, sir.` : `It's ${time}, sir.`;
      return { ok: true, summary: `${time} — ${date}`, spoken: line };
    }
  },
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
    autoConfirm: true,
    run: async ({ action, app }) => {
      // A media key goes nowhere when nothing is playing, so asking for music
      // with the player closed pressed play at an empty desk. Start it first.
      if (action === 'play' || action === 'toggle') {
        const status = await ctx.bridge.mediaStatus().catch(() => ({}));
        if (!status || !status.current) {
          const player = app || ctx.config.get('media.defaultPlayer', 'Spotify');
          ctx.logger.info?.(`[media] no player running; starting ${player}`);
          try {
            await ctx.bridge.openApp(player);
            // It has to register a media session before it can be told to
            // play; polling beats one long sleep, which would be dead air.
            for (let waited = 0; waited < 8000; waited += 400) {
              await new Promise((r) => setTimeout(r, 400));
              const now = await ctx.bridge.mediaStatus().catch(() => ({}));
              if (now && now.current) break;
            }
          } catch (err) {
            return { ok: false, summary: `I could not start ${player}: ${err.message}` };
          }
        }
      }

      const r = await ctx.bridge.mediaControl(action, { app });

      // Spotify only registers a media session once it has played something,
      // so a freshly started one cannot be addressed through the session API
      // at all — which is exactly what "No media session found for 'Spotify'"
      // was. The media key is the system-wide fallback the bridge already had
      // and nothing used.
      if (!r.ok) {
        const key = {
          play: 'media_play_pause', toggle: 'media_play_pause', pause: 'media_play_pause',
          next: 'media_next', previous: 'media_prev'
        }[action];
        if (!key) return { ok: false, summary: r.error || 'Nothing is playing.' };

        ctx.logger.info?.(`[media] no session; falling back to the ${key} key`);
        await ctx.bridge.mediaKey(key).catch(() => {});
        await new Promise((res) => setTimeout(res, 900));

        const after = await ctx.bridge.mediaStatus().catch(() => ({}));
        const c = after && after.current;
        if (c && c.title) {
          return {
            ok: true,
            summary: `${c.status === 'Playing' ? 'Playing' : c.status}: ${c.title}${c.artist ? ` by ${c.artist}` : ''}.`,
            spoken: `Playing ${c.title}.`,
            found: [{ icon: 'spotify.webp', title: c.title, subtitle: [c.artist, c.app].filter(Boolean).join(' · ') }]
          };
        }
        return {
          ok: true,
          summary: 'I pressed play. If nothing started, play something in the player once — it only becomes controllable after that.',
          spoken: 'I pressed play.'
        };
      }

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
    name: 'browse',
    appId: 'web-search',
    description: 'Use a real web browser like a person: open sites, search, click, type, scroll and read. For live prices, products, scores, flights, hotels, availability, or anything a search snippet cannot answer, or a task on a particular website. Pass the whole goal in the user\'s words.',
    parameters: obj({
      goal: str('What to find or do, in full, in the user\'s words'),
      url: str('A site to start on, if the user named one')
    }, ['goal']),
    run: async ({ goal, url = null }, { signal, progress } = {}) => {
      const r = await runBrowse({
        goal,
        startUrl: url && /^https?:\/\//i.test(url) ? url : (url ? `https://${url}` : null),
        browser: ctx.browser,
        provider: ctx.provider,
        model: ctx.config.get('llm.agentModel') || ctx.config.get('llm.model'),
        confirm: ctx.confirm,
        progress: progress || (() => {}),
        logger: ctx.logger,
        signal,
        maxSteps: ctx.config.get('agent.browseMaxSteps', 10),
        context: ctx.ambient && ctx.ambient.snapshot ? ctx.ambient.snapshot() : ''
      });
      let host = '';
      try { host = r.url ? new URL(r.url).hostname.replace(/^www\./, '') : ''; } catch { /* about:blank */ }
      return {
        ok: r.ok,
        summary: r.answer,
        spoken: r.answer,
        found: host ? [{ glyph: '🌐', title: host, subtitle: r.url, url: r.url }] : []
      };
    }
  },
  {
    name: 'news',
    appId: 'web-search',
    description: 'Current news headlines, optionally on a topic. Use for "what\'s the news", "headlines", "latest news about X", "summarize the news".',
    parameters: obj({ topic: str('Optional topic, e.g. "technology" or "james webb telescope"; empty for top stories') }),
    run: async ({ topic = '' } = {}) => {
      const items = await newsHeadlines(topic, { limit: 8 });
      if (!items.length) {
        return { ok: false, summary: `I could not reach the news just now${topic ? ` about ${topic}` : ''}.` };
      }
      return {
        ok: true,
        // No "spoken": the digest step turns these into a sentence or two,
        // which is the point — a list of eight headlines read aloud is not
        // a summary of the news.
        summary: `${topic ? `News about ${topic}` : 'Top stories'}:\n` +
          items.map((n, i) => `${i + 1}. ${n.title} (${n.source}${n.when ? `, ${n.when}` : ''})`).join('\n'),
        found: items.map((n) => ({ glyph: '📰', title: n.title, subtitle: [n.source, n.when].filter(Boolean).join(' · '), url: n.url }))
      };
    }
  },
  {
    name: 'answer_from_web',
    appId: 'web-search',
    description: 'Look up a direct factual answer, such as a definition, a conversion, or who someone is.',
    parameters: obj({ query: str('The question to look up') }, ['query']),
    run: async ({ query }, { signal } = {}) => {
      // The picture is fetched alongside the answer rather than after it:
      // they are independent, and waiting for one to start the other would
      // make an illustrated answer slower than a plain one.
      const wantsPicture = ctx.config.get('ui.images', true) && Boolean(imageSubject(query));
      const [answer, picture] = await Promise.all([
        answerFromWeb({
          query,
          provider: ctx.provider,
          model: ctx.config.get('llm.model'),
          logger: ctx.logger,
          signal
        }),
        wantsPicture ? pictureFor(query, { logger: ctx.logger }).catch(() => null) : Promise.resolve(null)
      ]);
      return picture ? { ...answer, image: picture } : answer;
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

/**
 * The web search every tool uses: DuckDuckGo, then Wikipedia and Google News
 * when it throttles. There used to be a second copy of the DuckDuckGo code
 * here with no fallback, which is the one search_web was calling.
 */
async function duckDuckGo(query) {
  return webSearch(query);
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
  send_message: 'Opening your messages.',
  list_events: 'Looking at your calendar.',
  create_event: 'Adding that.',
  list_coursework: 'Checking what is due.',
  my_day: 'Let me look at your day.',
  news: 'Checking the headlines.',
  browse: 'Opening the browser.',
  search_drive: 'Searching your Drive.',
  search_web: 'Searching the web.',
  answer_from_web: 'Looking that up.',
  show_image: 'Finding a picture.',
  do_task: 'Let me work on that.',
  list_grades: 'Checking your grades.',
  canvas_grades: 'Checking Canvas.',
  canvas_assignments: 'Checking Canvas.',
  personal_data: null,
  weather: 'Checking the forecast.',
  fetch_page: 'Reading that page.',
  search_files: 'Looking through your files.',
  read_screen: 'Reading your screen.',
  point_and_ask: 'Having a look.',
  // These three go through the PowerShell bridge, which is not instant: asking
  // what is playing measured 1557ms before a word was heard. They were silent
  // on the assumption that an opening line would arrive after the answer,
  // which the measurement contradicts — and since the fixed phrases are now
  // rendered at launch, an opening line costs nothing to say.
  now_playing: 'Let me see.',
  list_windows: 'Checking what is open.',
  list_reminders: 'Checking your reminders.',

  // Genuinely immediate, and the result speaks for itself: a window opening or
  // the music pausing is its own confirmation.
  control_playback: 'One moment.',
  play_search: 'Putting that on.',
  set_volume: null,
  create_reminder: null,
  take_note: null,
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
    ...weatherTools(ctx),
    ...messagingTools(ctx),
    ...personalTools(ctx),
    ...imageTools(ctx),
    ...taskTools(ctx),
    ...musicSearchTools(ctx),
    // Only offered when a connection manager is present to resolve tokens.
    ...(ctx.connections ? googleTools(ctx) : []),
    ...(ctx.connections ? canvasTools(ctx) : []),
    ...mediaTools(ctx),
    ...webTools(ctx),
    ...fileTools(ctx),
    ...noteTools(ctx),
    // Whatever MCP servers are configured, as ordinary tools. They arrive
    // already marked mutating unless their server said read-only, so they go
    // through the same confirmation as anything else that changes something.
    ...(ctx.mcp ? ctx.mcp.toolDefinitions() : [])
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
