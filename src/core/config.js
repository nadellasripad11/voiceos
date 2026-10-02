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
    engine: 'whisper.cpp',            // 'whisper.cpp' | 'whisper-server'
    model: 'ggml-tiny.en-q5_1.bin',   // quantized: ~2x faster, same accuracy here
    language: 'auto',                 // 'auto' or an ISO code; 100 languages supported
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
      silenceMs: 1500,
      threshold: 0.008,
      minRecordMs: 1200,
      maxUtteranceMs: 1200000,
      warnAtMs: 1140000
    }
  },

  llm: {
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    // Small by default so this laptop stays responsive.
    model: 'qwen2.5:3b-instruct',
    // Used for Agent Mode, where tool-calling accuracy matters most.
    agentModel: 'qwen2.5:7b-instruct',
    temperature: 0.2,
    numCtx: 8192,
    keepAlive: '10m',
    maxToolIterations: 8
  },

  tts: {
    enabled: true,
    engine: 'piper',              // 'piper' | 'system' | 'off'
    voice: 'en_US-amy-medium',
    speed: 1.0,
    speakAgentReplies: true,
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
    alwaysShowNotch: true,        // the overlay is a permanent fixture, not per-dictation
    showHistoryRail: true,        // thin strip on the left edge of the screen
    soundEffects: true,
    language: 'en',
    launchAtLogin: false,
    startInBackground: false,   // stay in the tray at login rather than opening the window
    showActiveAppIcon: true     // the pill shows which app your words will land in
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
