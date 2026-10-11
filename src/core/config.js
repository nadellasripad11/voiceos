'use strict';
const fs = require('fs');
const { paths, ensureDirs } = require('./paths');

// Defaults are tuned for a low-end machine (8GB RAM, no dGPU). Everything here
// is overridable from Settings; bigger models are a one-line change once the
// user is on hardware that can feed them.
const DEFAULTS = {
  version: 1,
  onboarded: false,

  hotkeys: {
    // Hold-to-talk, modifier only: hold both keys to speak, release to finish.
    // These are handled by a low-level keyboard hook, not by Electron
    // accelerators, which cannot express a modifier-only chord.
    dictation: 'Ctrl+Shift',
    agent: 'Ctrl+Alt',
    mode: 'hold'
  },

  // Defaults below are measured, not guessed. On this class of machine
  // (4-core CPU, no usable GPU) `npm run bench` showed:
  //   base.en  + beam search      5274ms for 3.4s of audio  (RTF 1.55)
  //   tiny.en-q5_1 + greedy + ac   1638ms for 3.4s of audio  (RTF 0.48)
  // i.e. 3.2x faster, with accuracy held at 100% once the vocabulary prompt is
  // supplied. Re-run `npm run bench` on better hardware and raise `model`.
  stt: {
    // Transcribe on Groq (whisper-large-v3-turbo) with local whisper.cpp
    // behind it. ~0.5s instead of 2-16s of every core on this laptop, and
    // more accurate. Only the clip of one request is sent, after the wake
    // word or a hotkey; '' keeps every word on the machine.
    cloud: 'groq',
    cloudModel: 'whisper-large-v3-turbo',
    engine: 'whisper.cpp',            // 'whisper.cpp' | 'whisper-server'
    model: 'ggml-base.en-q5_1.bin',   // quantized: ~2x faster, same accuracy here
    language: 'en',                 // 'auto' or an ISO code; 100 languages supported
    translate: false,
    threads: 0,                       // 0 = auto
    beamSize: 1,                      // greedy; raise to 5 for accuracy over speed
    bestOf: 1,
    noFallback: true,
    audioCtx: 'auto',                 // sized per clip so long dictation is never cut off
    vad: {
      enabled: true,
      // Silence only ends the utterance once speech has actually been heard.
      // Counting silence from the moment recording starts was cutting people
      // off while they drew breath before their first word.
      silenceMs: 900,               // a natural pause, not a pause for thought
      threshold: 0.008,             // the floor; the room is measured on top of it
      // Speech counts as this many times the measured room noise. Below about
      // 2.5 a quiet room's own hiss reads as talking; above about 5 a softly
      // spoken word reads as silence.
      noiseFactor: 3.5,
      minRecordMs: 1200,
      // Nobody speaks one command for two minutes. All that cap ever decided
      // was how long you wait once silence detection has already failed.
      maxUtteranceMs: 20000,
      warnAtMs: 15000,
    }
  },

  llm: {
    // Groq's free tier answers in about a quarter of a second; the local 1.5B
    // on this machine took fifty. Speed here is not a preference, it is the
    // difference between a voice assistant and a form you wait on.
    provider: 'groq',

    // No local brain behind Groq. It used to be Ollama, and on this laptop
    // the moment Groq was busy it loaded a 1-1.5GB model into ~1GB of free
    // memory and froze everything. A busy Groq is now waited out (it says
    // how long, usually seconds) and retried once; past that Jarvis says so.
    // Set to 'ollama' to bring the local fallback back.
    fallbackProvider: '',
    fallbackModel: 'qwen2.5:1.5b-instruct',
    baseUrl: 'http://127.0.0.1:11434',
    // Small by default so this laptop stays responsive.
    model: 'qwen/qwen3.8-27b',
    // Used for Agent Mode, where tool-calling accuracy matters most.
    // Same model for Agent Mode: it called the right tool every time in
    // scripts/bench-groq.js, and a 7B local model on this machine does not
    // finish inside a minute.
    agentModel: 'qwen/qwen3.8-27b',
    temperature: 0.2,
    numCtx: 8192,
    keepAlive: '10m',
    // Below this much free memory the model is left unloaded: holding it
    // resident costs about 1.2GB and slows speech synthesis by roughly 40%,
    // and the router answers nearly everything without it.
    warmIfFreeGb: 1.8,
    maxToolIterations: 8
  },

  tts: {
    enabled: true,
    // 'kokoro' is a neural model and sounds like one; 'piper' is a small
    // vocoder, roughly three times quicker, and sounds like one.
    //
    // Measured here: Kokoro at q4 runs at 0.87x realtime — faster than
    // speaking — while q4 is two and a half times quicker than the obvious q8
    // on this CPU, which is why the quantisation is pinned rather than left to
    // the library's default. The fixed phrases are pre-rendered at launch
    // either way, so the opening line is instant whichever engine is chosen.
    // Piper, not Kokoro, and measured rather than assumed. Of every free
    // British male voice available, alan sits almost exactly on JARVIS:
    // 97 Hz against his 100-115, and 131 words per minute against ~130.
    // Kokoro's bm_george was 138 Hz, which is well above him.
    //
    // It is also about five times quicker to synthesise here — 780ms where
    // Kokoro took four seconds — so the closest voice is also the fastest.
    engine: 'piper',              // 'kokoro' | 'piper'
    dtype: 'q4',                  // kokoro only: 'q4' | 'q8' | 'fp32'

    // Kokoro voices: heart, bella, nicole, sarah, emma (British), michael,
    // george — or any raw id such as 'af_heart'.
    // A British male voice, because that is what JARVIS is. Kokoro ships
    // four — bm_george, bm_lewis, bm_daniel, bm_fable — and they all
    // synthesise at about the same speed on this machine, so the choice is
    // purely how they sound.
    voice: 'bm_george',

    // Used only when engine is 'piper'.
    piperVoice: 'en_GB-alan-medium',
    // Left at 1. Measured: raising it shortens the audio but not the time to
    // make it — Kokoro's cost is per token, not per second — so it only
    // worsens the margin between synthesis and playback, which is what
    // decides whether streamed sentences run together or leave gaps.
    // Measured against clips of the real thing: those run at about 199 words
    // per minute, and this voice does 154 at 1.0. 1.3 puts it at 182 — brisk
    // and certain rather than careful, which is most of what separated ours
    // from the clips. 1.45 matches them exactly but starts clipping words.
    //
    // It is also cheaper: shorter audio is less audio to synthesise, so the
    // faster setting reaches the speaker sooner as well as finishing sooner.
    speed: 1.3,
    speakAgentReplies: true,

    // How much of a reply is read aloud before it stops.
    //
    // This was 320 characters, on the reasoning that nobody wants an essay
    // read at them. But a six-item news brief is nine hundred characters of
    // things the user asked for, and it was being cut off a third of the way
    // through — the answer was complete on screen and truncated in the ear,
    // which is the worst of both.
    //
    // High enough that a real answer finishes, low enough that a runaway
    // model does not talk for five minutes.
    maxSpokenChars: 2400,
    speakConfirmations: false
  },

  dictation: {
    polish: true,
    polishStyle: 'auto',          // auto | email | message | notes | code | raw
    removeFillers: true,
    autoPunctuate: true,
    autoCapitalize: true,
    // 'paste'          one shot via the clipboard, fastest
    // 'natural'        paced keystrokes, for editors that drop fast input
    // 'type'           keystrokes as fast as the OS accepts
    // 'clipboard-only' leaves it on the clipboard for you to paste
    insertMode: 'paste',
    typingSpeed: 11,              // characters per second when insertMode is 'natural'
    trailingSpace: true,
    vocabulary: [],               // ["Sripad", "Hackatime", "Rojo"]
    replacements: []              // [{ from: "my email", to: "me@example.com" }]
  },

  // Edit Mode shares the dictation chord: with text selected and an
  // instruction spoken ("make this more formal"), the selection is rewritten
  // instead of typed over. Anything that does not read as an instruction stays
  // ordinary dictation, because guessing wrong that way costs a retry while
  // guessing wrong the other way overwrites what the user selected.
  // Which player to start when music is asked for and nothing is running.
  media: {
    defaultPlayer: 'Spotify',

    // Playing a *named* artist needs the web player. The desktop app exposes
    // nothing to automate — its accessibility tree is empty and no key
    // sequence starts a search result — and the Web API's playback endpoints
    // require Premium. The web player's play button is a real element, so it
    // works on a free account.
    useWebPlayer: true,

    // Opening the player tab costs about six seconds, once. Turn this on to
    // pay it at launch instead of on the first request; it opens a browser
    // window, which is why it is not the default.
    prewarmPlayer: false
  },

  // Say "Hey Jarvis" and it answers, without touching the keyboard.
  //
  // Detection is three small ONNX models (about 3.6MB) that run on a rolling
  // window of audio at a few percent of one core. The audio becomes numbers
  // immediately and the numbers are discarded as the window slides: nothing is
  // transcribed, kept or sent anywhere unless the wake word is actually heard.
  wake: {
    enabled: true,
    // The only phrase the pretrained model knows. It has to be said at a
    // normal pace: said quickly it scores 0.12 against a threshold of 0.5.
    phrase: 'hey_jarvis_v0.1',
    // Measured: the wake phrase scores 0.91 to 0.99, and the nearest thing
    // that is not it ("Hey Travis") scores 0.13. Lowering this to catch fast
    // speech would start catching that instead.
    threshold: 0.5,
    // One spoken phrase covers several windows, so without this it would fire
    // repeatedly as the window slides across it.
    refractoryMs: 2500,
    // Spoken the instant the wake word lands, from the pre-rendered cache,
    // so it has to be short. "Hey sir" was neither the voice nor the manner.
    greeting: 'At your service, sir.',
  },

  // After it answers, it listens for a reply so you do not have to say its
  // name again. Only for followUpMs, and only after a conversation it
  // started — never open-ended.
  conversation: {
    enabled: true,
    followUpMs: 5000,
    // A conversation cannot run away: after this many turns it stops and
    // waits to be asked for again.
    maxTurns: 12
  },

  // Model Context Protocol: other people's tools, running here.
  //
  // A server is an ordinary process speaking JSON-RPC on its own stdin and
  // stdout, so adding one costs a line here and nothing else — no account, no
  // quota, no middleman holding the credentials. This is the open equivalent
  // of a hosted connector service, and the reason to prefer it: the tokens and
  // the servers stay on this machine.
  //
  // Examples, all free:
  //   { name: 'files',  command: 'npx', args: ['-y','@modelcontextprotocol/server-filesystem','C:/Users/you/Documents'] }
  //   { name: 'github', command: 'npx', args: ['-y','@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '...' } }
  //   { name: 'memory', command: 'npx', args: ['-y','@modelcontextprotocol/server-memory'] }
  mcp: {
    enabled: true,
    servers: [],
    // Servers whose read-only tools may run without asking first.
    //
    // Empty on purpose. An MCP server is someone else's code running against
    // your accounts, and the "this tool only reads" annotation is that code's
    // claim about itself — a server that wanted to act unasked would simply
    // make the claim. Naming a server here is you vouching for it, which is
    // the only signal worth trusting.
    trustedServers: []
  },

  edit: {
    enabled: true,
    maxChars: 8000               // a selection larger than this is refused
  },

  agent: {
    enabled: true,
    screenContext: true,
    cursorContext: true,          // "point anywhere on your screen"
    ocr: true,
    webSearch: true,
    confirmBeforeActions: true,   // never send/change anything unreviewed
    autoConfirmReadOnly: true,
    editSelection: true,
    reminders: true,
    rememberConversation: true,
    maxHistoryTurns: 8
  },

  privacy: {
    saveTranscriptsOnDevice: true,
    saveAudio: false,
    trainingOptOut: true,         // local-only build: nothing ever leaves the device
    diagnostics: false,
    privateMode: false,           // hard-blocks screen capture + transcript writes
    transcriptRetentionDays: 30
  },

  ui: {
    theme: 'system',
    notchPosition: 'top',         // top | bottom
    showWaveform: true,
    // The island appears when you summon it and goes away again, rather
    // than sitting on top of your windows all day. Turn it on to keep it
    // permanently on screen.
    alwaysShowNotch: false,
    // The thin strip down the left edge. Off for the same reason the island
    // is: nothing of ours sits on screen unless it was asked for.
    showHistoryRail: false,
    soundEffects: true,
    language: 'en',
    launchAtLogin: false,
    startInBackground: false,   // stay in the tray at login rather than opening the window
    showActiveAppIcon: true,    // the pill shows which app your words will land in

    // Show the words as they are spoken, in place of the level meter, and
    // hand the finished transcript back for correction before it is acted on.
    liveTranscript: true,
    // How long the transcript waits in the box before sending itself. Any
    // keystroke cancels it, so this is a grace period rather than a prompt.
    confirmMs: 2200,
    // Show a picture when the question is about something that can be seen.
    // Fetched in the main process and handed to the overlay as bytes, so the
    // overlay itself never makes a network request.
    images: true,
    // Press and hold the island this long to pick it up. Long enough that an
    // ordinary click is never mistaken for a move, short enough not to feel
    // like waiting.
    holdToMoveMs: 600
  },

  messaging: {
    // Which app an unqualified "message X" goes to.
    defaultChannel: 'sms',           // 'sms' | 'whatsapp'

    // Numbers for the people you text, because the SMS route hands Windows a
    // number rather than a name: Phone Link is driven through the sms: link
    // it registers, and that link takes a number.
    //
    // WhatsApp needs none of this — it searches your chats by name.
    //
    //   "maya": "+15551234567"
    contacts: {
      // The user's own phone, so "text me the summary" has somewhere to go.
      me: '+14706389418',
      myself: '+14706389418'
    },

    // Where a text goes when nobody is named. Only used for an unaddressed
    // "send me a text" — an unknown name is still refused rather than
    // quietly redirected here, because a message to the wrong person is the
    // one mistake this cannot take back.
    defaultNumber: '+14706389418',

    // An API key for Textbelt, which sends a text outright rather than
    // writing it into Phone Link for you to press send on.
    //
    // Empty means off, and off is the default on purpose: sending this way
    // hands the recipient's number and the message text to a third party,
    // which Phone Link does not. Nothing leaves this machine until you put a
    // key here.
    //
    // The literal string 'textbelt' is their free tier — one text a day, no
    // account. A real key is paid per text.
    textbeltKey: ''
  },

  browser: {
    // 'voiceos' keeps automation in its own Chrome profile: your real tabs,
    // cookies and logins are never touched, and you sign in once per service.
    // 'system' reuses your everyday Chrome profile so you are already signed
    // in everywhere, but Chrome must be closed first, because an already
    // running Chrome cannot be given a debugging port after the fact.
    profile: 'voiceos',
    headless: false
  },

  user: {
    firstName: '',
    lastName: ''
  },

  apps: {
    // Populated by the app registry on first run; shape is
    // { [appId]: { enabled: bool, config: {}, connectedAt: ISO } }
  },

  mcpServers: []                  // [{ name, command, args, env, enabled }]
};

function deepMerge(base, override) {
  if (Array.isArray(base)) return Array.isArray(override) ? override : base;
  if (typeof base !== 'object' || base === null) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const key of Object.keys(override || {})) {
    out[key] = key in base ? deepMerge(base[key], override[key]) : override[key];
  }
  return out;
}

function getIn(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

function setIn(obj, dotted, value) {
  const keys = dotted.split('.');
  const last = keys.pop();
  let cur = obj;
  for (const k of keys) {
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[last] = value;
  return obj;
}

class Config {
  constructor() {
    ensureDirs();
    this.data = this.load();
    this.listeners = new Set();
  }

  load() {
    try {
      const raw = fs.readFileSync(paths.config, 'utf8');
      return deepMerge(DEFAULTS, JSON.parse(raw));
    } catch {
      return structuredClone(DEFAULTS);
    }
  }

  save() {
    fs.writeFileSync(paths.config, JSON.stringify(this.data, null, 2), 'utf8');
    for (const fn of this.listeners) {
      try { fn(this.data); } catch (e) { /* listener errors must not break saves */ }
    }
    return this.data;
  }

  all() { return this.data; }
  get(dotted, fallback) {
    const v = getIn(this.data, dotted);
    return v === undefined ? fallback : v;
  }
  set(dotted, value) { setIn(this.data, dotted, value); return this.save(); }
  patch(partial) { this.data = deepMerge(this.data, partial); return this.save(); }
  reset() { this.data = structuredClone(DEFAULTS); return this.save(); }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}

module.exports = { Config, DEFAULTS, config: new Config() };
