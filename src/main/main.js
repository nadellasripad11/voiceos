'use strict';
/**
 * VoiceOS main process.
 *
 * Owns the service singletons (native bridge, speech engine, LLM provider,
 * transcript store), the global hotkeys, the tray, and every window.
 *
 * The one hard rule here: the notch window must never take keyboard focus. The
 * whole product depends on the user's own text field staying focused while they
 * speak, so the notch is created with `focusable: false` and nothing is ever
 * allowed to call focus() on it.
 */
const { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, screen, shell, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const { config } = require('../core/config');
const { paths, ensureDirs } = require('../core/paths');
const { getBridge } = require('../core/native/bridge');
const { WhisperEngine } = require('../core/stt/whisper');
const { createProvider } = require('../core/llm/provider');
const { TranscriptStore } = require('../core/memory/transcripts');
const { DictationMode } = require('../core/modes/dictation');
const { Agent } = require('../core/agent/agent');
const { PiperTts, speakableSummary } = require('../core/tts/piper');
const { getBrowser } = require('../core/browser/cdp');
const { ConnectionManager } = require('../core/connect/manager');
const { createLogger } = require('./logger');
const { HoldToTalk } = require('./hotkeys');

const isDev = process.argv.includes('--dev');
const logger = createLogger({ dir: paths.logs, level: isDev ? 'debug' : 'info' });

/** Single place holding everything long-lived. */
const services = {
  bridge: null,
  stt: null,
  provider: null,
  transcripts: null,
  dictation: null,
  agent: null,
  tts: null,
  browser: null,
  connections: null
};

const windows = {
  notch: null,
  settings: null,
  rail: null,
  onboarding: null
};

let tray = null;

/**
 * Session state machine.
 *
 * Explicit phases rather than a single boolean, because the failure that matters
 * is getting stuck: if the renderer never submits audio (no microphone,
 * permission denied, a crashed capture) a boolean 'active' flag would stay set
 * forever and every later hotkey press would be read as another stop. The
 * watchdog guarantees a return to idle no matter what the renderer does.
 */
const PHASE = { IDLE: 'idle', LISTENING: 'listening', PROCESSING: 'processing' };
const WATCHDOG_MS = 90000;

let session = { phase: PHASE.IDLE, mode: null, startedAt: 0, abort: null, watchdog: null };

/**
 * Confirmations awaiting the user's decision in the notch, keyed by id.
 * Agent Mode parks a promise here before running anything consequential.
 */
const pendingConfirms = new Map();

/** Asks the user to approve an action and resolves with their answer. */
function requestConfirmation({ title, detail, timeoutMs = 120000 }) {
  const id = `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // No answer means no action. Defaulting to "yes" on a timeout would be
      // exactly the wrong failure mode for something that sends or deletes.
      if (pendingConfirms.delete(id)) {
        logger.warn(`confirmation ${id} timed out; treating as declined`);
        resolve(false);
      }
    }, timeoutMs);
    pendingConfirms.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); }
    });
    broadcast('agent-confirm', { id, title, detail });
  });
}

function resetSession(reason) {
  if (session.watchdog) clearTimeout(session.watchdog);
  if (reason && session.phase !== PHASE.IDLE) {
    logger.debug(`session reset (${reason}) from phase ${session.phase}`);
  }
  session = { phase: PHASE.IDLE, mode: null, startedAt: 0, abort: null, watchdog: null };
}

function armWatchdog() {
  if (session.watchdog) clearTimeout(session.watchdog);
  session.watchdog = setTimeout(() => {
    logger.warn(`session watchdog fired after ${WATCHDOG_MS}ms in phase ${session.phase}; returning to idle`);
    broadcast('session-error', {
      message: 'Timed out',
      detail: 'No audio arrived. Check that a microphone is connected and permitted.'
    });
    resetSession('watchdog');
    setTimeout(idleNotch, 2500);
  }, WATCHDOG_MS);
}

// --- Service wiring -------------------------------------------------------

function buildStt() {
  const cfg = config.all();
  return new WhisperEngine({
    model: cfg.stt.model,
    language: cfg.stt.language,
    threads: cfg.stt.threads,
    translate: cfg.stt.translate,
    beamSize: cfg.stt.beamSize,
    bestOf: cfg.stt.bestOf,
    noFallback: cfg.stt.noFallback,
    audioCtx: cfg.stt.audioCtx,
    logger
  });
}

function buildProvider() {
  const cfg = config.all();
  const credentials = readCredentials();
  return createProvider(cfg.llm.provider, {
    baseUrl: cfg.llm.baseUrl,
    keepAlive: cfg.llm.keepAlive,
    numCtx: cfg.llm.numCtx,
    apiKey: credentials[cfg.llm.provider] || '',
    logger
  });
}

/**
 * API keys live outside config.json so that exporting or sharing settings never
 * leaks a key. Only ever read and written locally.
 */
function readCredentials() {
  try { return JSON.parse(fs.readFileSync(paths.credentials, 'utf8')); }
  catch { return {}; }
}

function writeCredentials(next) {
  fs.writeFileSync(paths.credentials, JSON.stringify(next, null, 2), 'utf8');
  try { fs.chmodSync(paths.credentials, 0o600); } catch { /* best effort on Windows */ }
}

async function initServices() {
  ensureDirs();
  services.bridge = getBridge({ logger });
  services.stt = buildStt();
  services.provider = buildProvider();
  services.transcripts = new TranscriptStore({ config, logger });
  services.tts = new PiperTts({
    voice: config.get('tts.voice'),
    speed: config.get('tts.speed'),
    logger
  });
  services.browser = getBrowser({
    logger,
    profile: config.get('browser.profile', 'voiceos'),
    headless: config.get('browser.headless', false)
  });
  services.connections = new ConnectionManager({
    config,
    bridge: services.bridge,
    browser: services.browser,
    logger,
    credentials: { read: readCredentials, write: writeCredentials }
  });

  services.agent = new Agent({
    provider: services.provider,
    config,
    bridge: services.bridge,
    browser: services.browser,
    tts: services.tts,
    connections: services.connections,
    logger,
    requestConfirmation
  });

  services.dictation = new DictationMode({
    stt: services.stt,
    provider: services.provider,
    config,
    bridge: services.bridge,
    transcripts: services.transcripts,
    logger
  });

  // Start the native bridge eagerly: its first call otherwise pays ~7s of
  // PowerShell and assembly loading, which would land on the user's first
  // dictation instead of on app launch.
  services.bridge.start()
    .then(() => logger.info('native bridge ready'))
    .catch((err) => logger.error(`native bridge failed to start: ${err.message}`));

  services.transcripts.prune()
    .then((r) => r.removed && logger.info(`pruned ${r.removed} expired transcript file(s)`))
    .catch(() => {});

  const sttStatus = services.stt.status();
  if (!sttStatus.ready) {
    logger.warn(`speech engine not ready: ${sttStatus.problems.join('; ')}`);
  } else {
    logger.info(`speech engine ready: ${path.basename(sttStatus.model)} on ${sttStatus.threads} threads`);
  }
}

/** Rebuilds the services whose construction depends on settings. */
function reloadServices() {
  services.stt = buildStt();
  services.provider = buildProvider();
  services.tts = new PiperTts({ voice: config.get('tts.voice'), speed: config.get('tts.speed'), logger });
  services.agent = new Agent({
    provider: services.provider,
    config,
    bridge: services.bridge,
    browser: services.browser,
    tts: services.tts,
    logger,
    requestConfirmation
  });
  services.dictation = new DictationMode({
    stt: services.stt,
    provider: services.provider,
    config,
    bridge: services.bridge,
    transcripts: services.transcripts,
    logger
  });
  registerHotkeys();
  broadcast('settings-changed', config.all());
}

// --- Windows --------------------------------------------------------------

const NOTCH_WIDTH = 600;
const NOTCH_HEIGHT = 520;

function createNotch() {
  if (windows.notch && !windows.notch.isDestroyed()) return windows.notch;

  const win = new BrowserWindow({
    width: NOTCH_WIDTH,
    height: NOTCH_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // The entire product depends on the user's own field keeping focus while
    // they dictate. A focusable overlay would break insertion.
    focusable: false,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'notch.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Lets getUserMedia run without a user gesture inside our own overlay.
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // The overlay is on screen permanently, so it must not swallow clicks aimed
  // at whatever is underneath. forward: true still delivers mouse movement to
  // the renderer, which asks for input only while the pointer is on the pill.
  win.setIgnoreMouseEvents(true, { forward: true });
  pipeConsole(win, 'notch');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'notch', 'index.html'));

  win.on('closed', () => { windows.notch = null; });
  windows.notch = win;
  positionNotch();
  return win;
}

function positionNotch() {
  const win = windows.notch;
  if (!win || win.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const position = config.get('ui.notchPosition', 'top');

  // bounds, not workArea: the island has to be flush with the physical edge of
  // the display. workArea is inset by the taskbar and would leave a gap that
  // makes the overlay read as a floating window instead of part of the screen.
  const { x, y, width, height } = display.bounds;
  const left = Math.round(x + (width - NOTCH_WIDTH) / 2);
  const top = position === 'top' ? y : y + height - NOTCH_HEIGHT;

  win.setBounds({ x: left, y: top, width: NOTCH_WIDTH, height: NOTCH_HEIGHT });
}

function showNotch() {
  const win = createNotch();
  positionNotch();
  // showInactive, never show(): show() would focus the overlay and the text
  // would land in the wrong place.
  win.showInactive();
}

/**
 * Returns the overlay to its resting state.
 *
 * The notch is a permanent fixture while VoiceOS runs rather than something
 * that appears per dictation, so this collapses it back to the idle pill
 * instead of hiding the window. It is only actually hidden when the user turns
 * the overlay off in Settings.
 */
function idleNotch() {
  if (!windows.notch || windows.notch.isDestroyed()) return;
  if (!config.get('ui.alwaysShowNotch', true)) {
    windows.notch.hide();
    return;
  }
  positionNotch();
  windows.notch.showInactive();
  broadcast('session-idle', { hotkeys: activeHotkeys, position: config.get('ui.notchPosition', 'top') });
}

function hideNotch() { idleNotch(); }

const RAIL_WIDTH = 340;

/**
 * The left-edge history rail.
 *
 * Spans the full height of the screen and is wide enough for the open panel,
 * but starts click-through so it never blocks the app underneath. The renderer
 * asks for input only while the panel is open.
 */
function createRail() {
  if (windows.rail && !windows.rail.isDestroyed()) return windows.rail;

  const display = screen.getPrimaryDisplay();
  const { x, y, height } = display.workArea;

  const win = new BrowserWindow({
    x,
    y,
    width: RAIL_WIDTH,
    height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'rail.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // forward: true keeps delivering mouse movement to the renderer while clicks
  // pass through, which is what lets the strip notice the pointer.
  win.setIgnoreMouseEvents(true, { forward: true });
  pipeConsole(win, 'rail');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'rail', 'index.html'));

  win.on('closed', () => { windows.rail = null; });
  windows.rail = win;
  return win;
}

function showRail() {
  if (!config.get('ui.showHistoryRail', true)) return;
  const win = createRail();
  win.showInactive();
}

function createOnboarding() {
  if (windows.onboarding && !windows.onboarding.isDestroyed()) {
    windows.onboarding.show();
    windows.onboarding.focus();
    return windows.onboarding;
  }
  const win = new BrowserWindow({
    width: 720,
    height: 760,
    minWidth: 620,
    minHeight: 620,
    title: 'Welcome to VoiceOS',
    backgroundColor: '#f6f9ff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'onboarding.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });
  pipeConsole(win, 'onboarding');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'onboarding', 'index.html'));
  win.on('closed', () => { windows.onboarding = null; });
  windows.onboarding = win;
  return win;
}

function createSettings() {
  if (windows.settings && !windows.settings.isDestroyed()) {
    windows.settings.show();
    windows.settings.focus();
    return windows.settings;
  }
  const win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    title: 'VoiceOS Settings',
    backgroundColor: '#0b0b0f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'settings.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  pipeConsole(win, 'settings');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'settings', 'index.html'));
  win.on('closed', () => { windows.settings = null; });
  windows.settings = win;
  return win;
}

/**
 * Surfaces renderer errors in the main log.
 *
 * Without this a thrown error in a renderer is invisible unless DevTools is
 * open, which is how an empty Dashboard looked like a layout problem rather
 * than an exception.
 */
function pipeConsole(win, name) {
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) {
      logger.error(`[${name}] ${message} (${String(sourceId).split('/').pop()}:${line})`);
    } else if (isDev && level === 1) {
      logger.debug(`[${name}] ${message}`);
    }
  });
  win.webContents.on('render-process-gone', (_e, details) =>
    logger.error(`[${name}] render process gone: ${details.reason}`));
}

function broadcast(channel, payload) {
  for (const win of Object.values(windows)) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

// --- Hotkeys --------------------------------------------------------------

/**
 * Electron's globalShortcut has no key-up event, so true hold-to-talk needs the
 * optional native hook. Toggle shortcuts are always registered as the dependency
 * free path, and `fn` is not interceptable on Windows at all (the keyboard
 * firmware consumes it before the OS sees it), which is why the default differs
 * from the Mac product.
 */
/** The hold-to-talk hook. Modifier-only chords, press and release. */
let holdToTalk = null;

/** What the UI should display. Kept in the shape the renderers already expect. */
let activeHotkeys = { dictation: 'Ctrl+Shift', agent: 'Ctrl+Alt', edit: null };

function registerHotkeys() {
  globalShortcut.unregisterAll();

  if (!holdToTalk) {
    holdToTalk = new HoldToTalk({
      logger,
      onStart: (mode) => startSession(mode),
      onStop: () => stopSession()
    });
  }

  const ok = holdToTalk.running || holdToTalk.start();
  if (ok) {
    activeHotkeys = { dictation: 'Ctrl+Shift', agent: 'Ctrl+Alt', edit: null };
    return;
  }

  // The keyboard hook could not start, so fall back to accelerators. They need
  // a real key on the end, and they toggle rather than hold.
  logger.warn('falling back to toggle shortcuts; hold-to-talk needs the keyboard hook');
  const fallbacks = [
    ['dictation', 'Control+Shift+Space'],
    ['agent', 'Control+Alt+A']
  ];
  activeHotkeys = { dictation: null, agent: null, edit: null };
  for (const [mode, accelerator] of fallbacks) {
    try {
      if (globalShortcut.register(accelerator, () => toggleSession(mode))) {
        activeHotkeys[mode] = accelerator;
        logger.info(`hotkey ${mode}: ${accelerator}`);
      }
    } catch (err) {
      logger.warn(`could not bind ${mode}: ${err.message}`);
    }
  }
}

function toggleSession(mode) {
  // While listening, the same key stops and submits. While processing, further
  // presses are ignored so a held or repeated hotkey cannot pile up.
  if (session.phase === PHASE.LISTENING) return stopSession();
  if (session.phase === PHASE.PROCESSING) return;
  return startSession(mode);
}

function startSession(mode) {
  if (session.phase !== PHASE.IDLE) return;
  const status = services.stt.status();
  if (!status.ready) {
    showNotch();
    broadcast('session-error', {
      message: 'Speech engine not installed',
      detail: status.problems.join(' ')
    });
    setTimeout(idleNotch, 4000);
    return;
  }
  session = {
    phase: PHASE.LISTENING,
    mode,
    startedAt: Date.now(),
    abort: new AbortController(),
    watchdog: null
  };
  armWatchdog();
  showNotch();
  broadcast('session-start', { mode, config: config.all(), position: config.get('ui.notchPosition', 'top') });
  logger.info(`session start: ${mode}`);
}

function stopSession() {
  if (session.phase !== PHASE.LISTENING) return;
  session.phase = PHASE.PROCESSING;
  armWatchdog();
  logger.info(`session stop after ${Date.now() - session.startedAt}ms listening`);
  broadcast('session-stop', { mode: session.mode });
}

function cancelSession() {
  if (session.phase === PHASE.IDLE) return;
  if (session.abort) session.abort.abort();
  resetSession('cancelled');
  broadcast('session-cancel', {});
  idleNotch();
  logger.info('session cancelled');
}

// --- IPC ------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('voiceos:get-config', () => config.all());

  ipcMain.handle('voiceos:set-config', (_e, patch) => {
    config.patch(patch);
    reloadServices();
    return config.all();
  });

  ipcMain.handle('voiceos:set-config-value', (_e, { key, value }) => {
    config.set(key, value);
    reloadServices();
    return config.all();
  });

  ipcMain.handle('voiceos:reset-config', () => {
    config.reset();
    reloadServices();
    return config.all();
  });

  /**
   * The renderer hands over captured audio here. Transferred as an ArrayBuffer
   * of 16-bit PCM, which is what Whisper wants and keeps the IPC payload small.
   */
  ipcMain.handle('voiceos:submit-audio', async (_e, { pcm, sampleRate, mode }) => {
    if (session.phase === PHASE.IDLE) {
      logger.warn('audio submitted with no active session; ignoring');
      return { ok: false, reason: 'no active session' };
    }
    // Capture ended, so we are definitely processing now even if the renderer
    // stopped on its own (silence detected, max length) rather than via a hotkey.
    session.phase = PHASE.PROCESSING;
    armWatchdog();
    const samples = pcm16ToFloat32(Buffer.from(pcm));
    const activeMode = mode || session.mode || 'dictation';
    const signal = session.abort ? session.abort.signal : undefined;

    try {
      if (activeMode === 'dictation') {
        const result = await services.dictation.run(samples, {
          sampleRate,
          signal,
          onStage: (stage, detail) => broadcast('session-stage', { stage, detail })
        });
        broadcast('session-result', result);
        return result;
      }
      if (activeMode === 'agent') {
        // Agent Mode needs the raw words, not polished prose, so it transcribes
        // without the dictation formatting pass.
        const transcript = await transcribeOnly(samples, sampleRate, signal);
        if (!transcript) {
          broadcast('session-error', { message: 'No speech heard', detail: 'Try again a little closer to the microphone.' });
          return { ok: false, reason: 'silence' };
        }

        broadcast('agent-result', { question: transcript, answer: '', found: [], pending: true });
        const result = await services.agent.run(transcript, {
          signal,
          onStage: (stage, detail) => broadcast('session-stage', { stage, detail })
        });

        broadcast('agent-result', result);
        speak(result.answer);

        if (services.transcripts) {
          services.transcripts.append({
            mode: 'agent', text: result.answer, raw: transcript, ms: result.ms
          }).catch(() => {});
        }
        return result;
      }

      broadcast('session-error', {
        message: `${activeMode} mode is not wired up yet`,
        detail: 'Dictation and Agent are available now.'
      });
      return { ok: false, reason: `${activeMode} not implemented` };
    } catch (err) {
      logger.error(`session failed: ${err.stack || err.message}`);
      broadcast('session-error', { message: 'Something went wrong', detail: err.message });
      return { ok: false, reason: err.message };
    } finally {
      resetSession('finished');
      setTimeout(idleNotch, 2200);
    }
  });

  ipcMain.handle('voiceos:cancel', () => { cancelSession(); return { ok: true }; });

  ipcMain.on('voiceos:level', (_e, level) => {
    // Forwarded so the settings window can show a live input meter.
    if (windows.settings && !windows.settings.isDestroyed()) {
      windows.settings.webContents.send('voiceos:level', level);
    }
  });

  ipcMain.handle('voiceos:status', async () => {
    const sttStatus = services.stt.status();
    let llmAvailable = false;
    let llmModels = [];
    try {
      llmAvailable = await services.provider.available();
      if (llmAvailable) llmModels = await services.provider.listModels();
    } catch (err) {
      logger.debug(`llm status check failed: ${err.message}`);
    }
    return {
      version: app.getVersion(),
      platform: process.platform,
      stt: sttStatus,
      llm: {
        provider: services.provider.name,
        available: llmAvailable,
        models: llmModels,
        configured: config.get('llm.model')
      },
      bridge: { available: services.bridge.available, running: Boolean(services.bridge.proc) },
      tts: services.tts.status(),
      hotkeys: activeHotkeys,
      holdToTalk: holdToTalk ? holdToTalk.status() : { available: false },
      paths: { userData: paths.userData, models: paths.models, logs: paths.logs }
    };
  });

  ipcMain.handle('voiceos:transcripts', async (_e, { action, query, limit, format } = {}) => {
    switch (action) {
      case 'list': return services.transcripts.list({ limit });
      case 'search': return services.transcripts.search(query, { limit });
      case 'stats': return services.transcripts.stats();
      case 'export': return services.transcripts.export(format);
      case 'clear': {
        const { response } = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['Cancel', 'Delete everything'],
          defaultId: 0,
          cancelId: 0,
          title: 'Delete all transcripts?',
          message: 'Delete every saved transcript and audio file?',
          detail: 'This cannot be undone.'
        });
        if (response !== 1) return { cancelled: true };
        return services.transcripts.clearAll();
      }
      default: throw new Error(`Unknown transcript action '${action}'`);
    }
  });

  ipcMain.handle('voiceos:credentials', (_e, { action, provider, key } = {}) => {
    const creds = readCredentials();
    if (action === 'set') {
      creds[provider] = key;
      writeCredentials(creds);
      reloadServices();
      return { ok: true };
    }
    if (action === 'clear') {
      delete creds[provider];
      writeCredentials(creds);
      reloadServices();
      return { ok: true };
    }
    // Never return the key itself to the renderer; only whether one is present.
    return Object.fromEntries(Object.keys(creds).map((p) => [p, Boolean(creds[p])]));
  });

  ipcMain.handle('voiceos:open-path', (_e, which) => {
    const target = { userData: paths.userData, models: paths.models, logs: paths.logs }[which];
    if (!target) throw new Error(`Unknown path '${which}'`);
    return shell.openPath(target);
  });

  ipcMain.handle('voiceos:preview-voice', async (_e, text) => {
    const audio = await services.tts.synthesizeBase64(String(text || 'This is how I will sound.'), {
      speed: config.get('tts.speed', 1)
    });
    broadcast('speak', { data: audio.data, voice: audio.voice });
    return { ok: true };
  });

  ipcMain.handle('voiceos:open-settings', () => { createSettings(); return { ok: true }; });

  ipcMain.handle('voiceos:complete-onboarding', () => {
    config.set('onboarded', true);
    if (windows.onboarding && !windows.onboarding.isDestroyed()) windows.onboarding.close();
    createSettings();
    return { ok: true };
  });

  ipcMain.handle('voiceos:open-onboarding', () => { createOnboarding(); return { ok: true }; });

  ipcMain.on('voiceos:notch-interactive', (_e, interactive) => {
    const win = windows.notch;
    if (!win || win.isDestroyed()) return;
    // Never made focusable: the user's own text field must keep focus.
    win.setIgnoreMouseEvents(!interactive, { forward: true });
  });

  ipcMain.on('voiceos:start-mode', (_e, mode) => {
    toggleSession(mode || 'dictation');
  });

  ipcMain.on('voiceos:rail-interactive', (_e, interactive) => {
    const win = windows.rail;
    if (!win || win.isDestroyed()) return;
    // Taking input requires the window to be focusable, otherwise the search
    // field could never receive typing.
    win.setIgnoreMouseEvents(!interactive, { forward: true });
    win.setFocusable(Boolean(interactive));
  });

  ipcMain.handle('voiceos:insert-text', async (_e, text) => {
    await services.bridge.insertText(String(text || ''), { mode: config.get('dictation.insertMode') });
    return { ok: true };
  });

  ipcMain.on('voiceos:request-idle', () => idleNotch());

  // Resolves a pending Agent confirmation. The agent loop awaits this before
  // anything that sends, creates or changes is allowed to run.
  ipcMain.handle('voiceos:resolve-confirm', (_e, { id, approved }) => {
    const pending = pendingConfirms.get(id);
    if (!pending) return { ok: false, reason: 'no such confirmation' };
    pendingConfirms.delete(id);
    pending.resolve(Boolean(approved));
    logger.info(`confirmation ${id} ${approved ? 'approved' : 'declined'}`);
    return { ok: true };
  });

  ipcMain.handle('voiceos:copy-text', async (_e, text) => {
    await services.bridge.writeClipboard(String(text || ''));
    return { ok: true };
  });

  ipcMain.handle('voiceos:open-external', (_e, url) => {
    // Only ever a provider's own console, never a URL from model output.
    if (!String(url).toLowerCase().startsWith('https://')) {
      throw new Error('Refusing to open a non-https URL');
    }
    return shell.openExternal(url);
  });

  ipcMain.handle('voiceos:connections', () => services.connections.status());

  ipcMain.handle('voiceos:connect', async (_e, { provider, input }) => {
    try {
      return await services.connections.connect(provider, input || {});
    } catch (err) {
      // A missing client ID is a setup step, not a failure; hand the UI the
      // instructions so it can walk the user through it.
      if (err.needsSetup) {
        return { ok: false, needsSetup: err.needsSetup, provider: err.providerId, error: err.message };
      }
      logger.warn(`[connect] ${provider} failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('voiceos:disconnect', (_e, { provider, accountId }) =>
    services.connections.disconnect(provider, accountId));

  ipcMain.handle('voiceos:set-oauth-client', (_e, { provider, clientId, clientSecret }) =>
    services.connections.setClient(provider, { clientId, clientSecret }));

  ipcMain.handle('voiceos:set-app-account', (_e, { appId, key }) => {
    services.connections.accounts.setAppAccount(appId, key);
    return { ok: true };
  });

  ipcMain.handle('voiceos:pick-folder', async (_e, { multiple } = {}) => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', ...(multiple ? ['multiSelections'] : [])]
    });
    return { cancelled: result.canceled, paths: result.filePaths || [] };
  });

  ipcMain.handle('voiceos:apps', () => {
    const catalog = require('../core/apps/catalog');
    const enabled = config.get('apps', {});
    const platformLabel = (platforms) => platforms
      .map((p) => ({ darwin: 'macOS', win32: 'Windows' }[p] || p))
      .join(' · ');

    // Every entry is returned, including the Apple-only ones, so the store reads
    // the same as the real product. `available` tells the UI which can run here.
    const shape = (app) => ({
      id: app.id,
      name: app.name,
      icon: app.icon,
      glyph: app.glyph || null,
      category: app.category,
      description: app.description,
      auth: app.auth,
      authNote: app.authNote,
      beta: Boolean(app.beta),
      extra: Boolean(app.extra),
      replaces: app.replaces || null,
      windowsEquivalent: app.windowsEquivalent || null,
      platforms: app.platforms,
      platformLabel: platformLabel(app.platforms),
      available: app.platforms.includes(process.platform),
      actionCount: app.actions.length,
      mutatingCount: app.actions.filter((a) => a.mutating).length,
      enabled: Boolean(enabled[app.id] && enabled[app.id].enabled),
      connection: services.connections.appStatus(app.id)
    });

    return {
      official: catalog.official().map(shape),
      extras: catalog.WINDOWS_EXTRAS.filter((a) => a.platforms.includes(process.platform)).map(shape),
      categories: catalog.CATEGORIES,
      summary: catalog.summary(process.platform)
    };
  });

  ipcMain.handle('voiceos:set-app-enabled', (_e, { id, enabled }) => {
    const apps = { ...config.get('apps', {}) };
    apps[id] = { ...(apps[id] || {}), enabled, connectedAt: enabled ? new Date().toISOString() : null };
    config.set('apps', apps);
    return { ok: true };
  });
}

/**
 * Transcribes captured audio and returns the plain text.
 *
 * Agent Mode wants what was actually said. Running it through the dictation
 * polish pass would rewrite the request before the agent ever sees it.
 */
async function transcribeOnly(samples, sampleRate, signal) {
  const { writeWav, floatToPcm16, trimSilence } = require('../core/audio/wav');
  const trimmed = trimSilence(samples, { threshold: config.get('stt.vad.threshold'), sampleRate });
  if (!trimmed.length) return '';

  const wavPath = path.join(paths.tmp, `agent-${Date.now()}.wav`);
  writeWav(wavPath, floatToPcm16(trimmed), { sampleRate });
  try {
    const vocabulary = config.get('dictation.vocabulary', []);
    const result = await services.stt.transcribe(wavPath, {
      language: config.get('stt.language') === 'auto' ? undefined : config.get('stt.language'),
      prompt: vocabulary.length ? `Vocabulary: ${vocabulary.slice(0, 60).join(', ')}.` : undefined,
      signal
    });
    return result.text;
  } finally {
    fs.rmSync(wavPath, { force: true });
  }
}

/**
 * Speaks a reply aloud.
 *
 * Synthesis happens here and the audio is handed to the overlay to play, so
 * playback stays in the browser audio stack and needs no native dependency.
 * Failure is never fatal: the answer is already on screen.
 */
async function speak(text) {
  if (!config.get('tts.enabled', true)) return;
  if (!config.get('tts.speakAgentReplies', true)) return;
  const line = speakableSummary(text);
  if (!line) return;
  try {
    const audio = await services.tts.synthesizeBase64(line, { speed: config.get('tts.speed', 1) });
    broadcast('speak', { data: audio.data, voice: audio.voice });
  } catch (err) {
    logger.warn(`[tts] ${err.message}`);
  }
}

/** Mirror of floatToPcm16 in core/audio/wav.js. */
function pcm16ToFloat32(buf) {
  const out = new Float32Array(buf.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = buf.readInt16LE(i * 2);
    out[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
  }
  return out;
}

// --- Tray -----------------------------------------------------------------

function buildTrayIcon() {
  const iconPath = path.join(__dirname, '..', 'renderer', 'shared', 'tray.png');
  if (fs.existsSync(iconPath)) return nativeImage.createFromPath(iconPath);
  // A tray icon is required on Windows or the item is invisible, so fall back
  // to a generated dot rather than shipping nothing.
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - size / 2 + 0.5;
      const dy = y - size / 2 + 0.5;
      const inside = Math.sqrt(dx * dx + dy * dy) < size / 2 - 1.5;
      const i = (y * size + x) * 4;
      canvas[i] = inside ? 0x7c : 0;      // B
      canvas[i + 1] = inside ? 0x5c : 0;  // G
      canvas[i + 2] = inside ? 0xff : 0;  // R
      canvas[i + 3] = inside ? 0xff : 0;  // A
    }
  }
  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

function buildTray() {
  tray = new Tray(buildTrayIcon());
  tray.setToolTip('VoiceOS');
  const refresh = () => {
    const keys = config.get('hotkeys');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Dictate  (${keys.dictationToggle})`, click: () => toggleSession('dictation') },
      { label: `Agent  (${keys.agentToggle})`, click: () => toggleSession('agent') },
      { label: `Edit selection  (${keys.editToggle})`, click: () => toggleSession('edit') },
      { type: 'separator' },
      { label: 'Settings…', click: () => createSettings() },
      { label: 'Run setup again…', click: () => createOnboarding() },
      { label: 'Open data folder', click: () => shell.openPath(paths.userData) },
      { label: 'Open logs', click: () => shell.openPath(paths.logs) },
      { type: 'separator' },
      { label: `VoiceOS ${app.getVersion()}`, enabled: false },
      { label: 'Quit', click: () => app.quit() }
    ]));
  };
  refresh();
  config.onChange(refresh);
  tray.on('click', () => createSettings());
}

// --- Lifecycle ------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  // Another copy already holds the hotkeys. Exiting quietly here is what made
  // a stale build look like "the shortcuts stopped working": the new code never
  // ran and the old one kept responding.
  console.log('VoiceOS is already running. Bringing the existing window forward.');
  console.log('If you just rebuilt, quit it from the tray first, or run: npm run restart');
  app.quit();
} else {
  app.on('second-instance', () => {
    logger.info('second instance launched; focusing the existing window');
    createSettings();
  });

  app.whenReady().then(async () => {
    await initServices();
    registerIpc();
    registerHotkeys();
    buildTray();
    createNotch();
    showRail();
    // The overlay is visible from launch, not only while dictating.
    setTimeout(idleNotch, 600);

    // Microphone access for our own windows only.
    const session_ = require('electron').session;
    session_.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'media' || permission === 'audioCapture');
    });

    if (!config.get('onboarded')) createOnboarding();

    logger.info(`VoiceOS ${app.getVersion()} ready`);
  });

  app.on('window-all-closed', () => {
    // A tray app stays alive with no windows open; that is the point.
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (holdToTalk) holdToTalk.shutdown();
    if (services.bridge) services.bridge.stop();
  });
}

module.exports = { services, windows };
