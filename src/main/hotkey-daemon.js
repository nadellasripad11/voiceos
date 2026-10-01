'use strict';
/**
 * Keyboard hook daemon.
 *
 * Runs the low-level hook in a plain Node process and reports modifier events
 * to the parent as one JSON object per line.
 *
 * This exists because uiohook-napi is built against Node's N-API and faults
 * under Electron with `uiohook_to_js_event napi_define_properties` — it
 * delivers a few events, then kills the process. Under plain Node it is
 * reliable. Keeping the hook out of Electron entirely is cheaper and safer
 * than rebuilding the module for every Electron version, and a crash here
 * costs a restarted helper rather than the whole app.
 *
 * Spawned by hotkeys.js. Not meant to be run directly.
 */

const LEFT = { ctrl: 29, shift: 42, alt: 56 };
const RIGHT = { ctrl: 3613, shift: 54, alt: 3640 };

function modifierFor(keycode) {
  for (const [name, code] of Object.entries(LEFT)) if (code === keycode) return name;
  for (const [name, code] of Object.entries(RIGHT)) if (code === keycode) return name;
  return null;
}

function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\n');
}

let uIOhook;
try {
  ({ uIOhook } = require('uiohook-napi'));
} catch (err) {
  emit({ type: 'error', message: `uiohook-napi unavailable: ${err.message}` });
  process.exit(1);
}

// Only modifier transitions and "a real key happened" are reported. Forwarding
// every keystroke would turn this into a keylogger for no benefit: the parent
// only needs to know whether a chord is being held.
uIOhook.on('keydown', (event) => {
  const mod = modifierFor(event.keycode);
  if (mod) emit({ type: 'mod-down', mod });
  else emit({ type: 'other-key' });
});

uIOhook.on('keyup', (event) => {
  const mod = modifierFor(event.keycode);
  if (mod) emit({ type: 'mod-up', mod });
});

try {
  uIOhook.start();
  emit({ type: 'ready' });
} catch (err) {
  emit({ type: 'error', message: `could not start the keyboard hook: ${err.message}` });
  process.exit(1);
}

// Exit when the parent goes away, so a crashed app never leaves a hook running.
process.stdin.resume();
process.stdin.on('end', () => {
  try { uIOhook.stop(); } catch {}
  process.exit(0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try { uIOhook.stop(); } catch {}
    process.exit(0);
  });
}
