'use strict';
/**
 * Main-process side of the notch changes: focus on demand, a draggable island
 * that remembers where it was put, typed queries, and speech diagnostics.
 */
const fs = require('fs');

// --- main.js --------------------------------------------------------------
const mp = 'src/main/main.js';
let m = fs.readFileSync(mp, 'utf8');

// Remember where the user drags it, and stop fighting them about it.
m = m.replace(
  /function positionNotch\(\) \{[\s\S]*?\n\}/,
  `function positionNotch({ force = false } = {}) {
  const win = windows.notch;
  if (!win || win.isDestroyed()) return;

  // Once the island has been dragged somewhere, that is where it belongs.
  // Re-centring it on every session would undo the user's choice.
  const saved = config.get('ui.notchBounds', null);
  if (saved && !force) {
    const visible = screen.getAllDisplays().some((d) =>
      saved.x + saved.width > d.bounds.x &&
      saved.x < d.bounds.x + d.bounds.width &&
      saved.y + saved.height > d.bounds.y &&
      saved.y < d.bounds.y + d.bounds.height);
    // Unless that position is now off-screen, which happens when a monitor is
    // unplugged; falling back beats leaving it somewhere unreachable.
    if (visible) {
      win.setBounds({ x: saved.x, y: saved.y, width: NOTCH_WIDTH, height: NOTCH_HEIGHT });
      return;
    }
  }

  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const position = config.get('ui.notchPosition', 'top');

  // bounds, not workArea: docked at the top the island has to meet the
  // physical edge, and workArea is inset by the taskbar.
  const { x, y, width, height } = display.bounds;
  const left = Math.round(x + (width - NOTCH_WIDTH) / 2);
  const top = position === 'top' ? y : y + height - NOTCH_HEIGHT;

  win.setBounds({ x: left, y: top, width: NOTCH_WIDTH, height: NOTCH_HEIGHT });
}

/** Tells the renderer whether it is parked against an edge or floating free. */
function reportDocking() {
  const win = windows.notch;
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const display = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + 10 });
  const docked = Math.abs(b.y - display.bounds.y) < 6 ? 'top' : 'free';
  win.webContents.send('notch-docked', docked);
}`
);

// Persist the position as it is dragged.
m = m.replace(
  "  win.on('closed', () => { windows.notch = null; });",
  `  // The island is draggable, so its position is the user's to set.
  let saveTimer = null;
  win.on('move', () => {
    clearTimeout(saveTimer);
    // Debounced: 'move' fires continuously while dragging.
    saveTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const b = win.getBounds();
      config.set('ui.notchBounds', { x: b.x, y: b.y, width: b.width, height: b.height });
      reportDocking();
    }, 300);
  });

  win.on('closed', () => { windows.notch = null; });`
);

// Tell the renderer its docking state once it is up.
m = m.replace(
  "  windows.notch = win;\n  positionNotch();\n  return win;",
  "  windows.notch = win;\n  positionNotch();\n  win.webContents.once('did-finish-load', () => reportDocking());\n  return win;"
);

// --- IPC ------------------------------------------------------------------
m = m.replace(
  "  ipcMain.on('voiceos:request-idle', () => idleNotch());",
  `  ipcMain.on('voiceos:request-idle', () => idleNotch());

  /**
   * Focus for the compose field only.
   *
   * The overlay is created non-focusable so dictation lands in the user's own
   * text field. Typing needs focus, so it is granted for exactly as long as
   * the field is being used and handed straight back.
   */
  ipcMain.on('voiceos:set-focusable', (_e, focusable) => {
    const win = windows.notch;
    if (!win || win.isDestroyed()) return;
    win.setFocusable(Boolean(focusable));
    if (focusable) {
      win.setIgnoreMouseEvents(false);
      win.focus();
    } else {
      win.setIgnoreMouseEvents(true, { forward: true });
      win.blur();
    }
  });

  /** A typed question takes the same path as a spoken one. */
  ipcMain.handle('voiceos:ask', async (_e, text) => {
    const question = String(text || '').trim();
    if (!question) return { ok: false };
    if (session.phase !== PHASE.IDLE) return { ok: false, reason: 'busy' };

    session = {
      phase: PHASE.PROCESSING, mode: 'agent', startedAt: Date.now(),
      abort: new AbortController(), watchdog: null
    };
    armWatchdog();
    showNotch();

    try {
      const result = await services.agent.run(question, {
        signal: session.abort.signal,
        onStage: (stage, detail) => broadcast('session-stage', { stage, detail })
      });
      broadcast('agent-result', result);
      speak(result.answer);
      if (services.transcripts) {
        services.transcripts.append({ mode: 'agent', text: result.answer, raw: question, ms: result.ms })
          .catch(() => {});
      }
      return result;
    } catch (err) {
      logger.error(\`typed question failed: \${err.message}\`);
      broadcast('session-error', { message: 'Something went wrong', detail: err.message });
      return { ok: false, reason: err.message };
    } finally {
      resetSession('finished');
    }
  });

  /** Speaks a line on demand, for the replay button. */
  ipcMain.handle('voiceos:speak', async (_e, text) => {
    await speak(String(text || ''), { force: true });
    return { ok: true };
  });

  /** The renderer reports whether playback actually started. */
  ipcMain.on('voiceos:speech-status', (_e, status) => {
    if (status && status.ok) logger.debug('[tts] playback started');
    else logger.warn(\`[tts] playback did not start: \${status && status.error}\`);
  });`
);

// speak() gains a force flag for replay, and says why it stayed silent.
m = m.replace(
  /async function speak\(text\) \{[\s\S]*?\n\}/,
  `async function speak(text, { force = false } = {}) {
  if (!force) {
    if (!config.get('tts.enabled', true)) return logger.debug('[tts] disabled');
    if (!config.get('tts.speakAgentReplies', true)) return logger.debug('[tts] agent replies muted');
  }
  const line = speakableSummary(text);
  if (!line) return logger.debug('[tts] nothing worth speaking');

  try {
    const audio = await services.tts.synthesizeBase64(line, { speed: config.get('tts.speed', 1) });
    logger.info(\`[tts] speaking \${line.length} chars (\${audio.ms}ms to synthesize)\`);
    broadcast('speak', { data: audio.data, voice: audio.voice });
  } catch (err) {
    // Never fatal: the answer is already on screen.
    logger.warn(\`[tts] \${err.message}\`);
  }
}`
);

fs.writeFileSync(mp, m);

// --- preload --------------------------------------------------------------
const pp = 'src/preload/notch.js';
let p = fs.readFileSync(pp, 'utf8');
if (!p.includes('setFocusable')) {
  p = p.replace(
    "  startMode: (mode) => ipcRenderer.send('voiceos:start-mode', mode),",
    [
      "  startMode: (mode) => ipcRenderer.send('voiceos:start-mode', mode),",
      "  setFocusable: (v) => ipcRenderer.send('voiceos:set-focusable', v),",
      "  ask: (text) => ipcRenderer.invoke('voiceos:ask', text),",
      "  speak: (text) => ipcRenderer.invoke('voiceos:speak', text),",
      "  speechStatus: (s) => ipcRenderer.send('voiceos:speech-status', s),",
      "  onDocked: (fn) => on('notch-docked', fn),"
    ].join('\n')
  );
  fs.writeFileSync(pp, p);
}

// --- renderer: docking state ---------------------------------------------
const np = 'src/renderer/notch/notch.js';
let n = fs.readFileSync(np, 'utf8');
if (!n.includes('onDocked')) {
  n = n.replace(
    'drawWave();\nsetState(',
    [
      '// Square against a bezel, rounded when floating free.',
      "bridge.onDocked((docked) => { document.documentElement.dataset.docked = docked || 'top'; });",
      '',
      'drawWave();',
      'setState('
    ].join('\n')
  );
  fs.writeFileSync(np, n);
}

const checks = {
  'position memory': m.includes("config.get('ui.notchBounds'"),
  'move persistence': m.includes("win.on('move'"),
  'focus ipc': m.includes("voiceos:set-focusable"),
  'ask ipc': m.includes("voiceos:ask"),
  'speak ipc': m.includes("voiceos:speak'"),
  'speech status': m.includes('voiceos:speech-status'),
  'preload': p.includes('setFocusable'),
  'docking': n.includes('onDocked')
};
for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'ok  ' : 'MISS'} ${k}`);
