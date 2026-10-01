'use strict';
/**
 * Modifier-only, hold-to-talk hotkeys.
 *
 * Electron's globalShortcut cannot express "Ctrl+Shift" on its own: an
 * accelerator must end in a non-modifier key, and it only fires on press, never
 * on release. Hold-to-talk therefore needs a low-level keyboard hook, which is
 * what uiohook-napi provides.
 *
 * Behaviour: hold both modifiers to speak, release either to finish. Pressing
 * any other key while they are held cancels, so ordinary chords like Ctrl+Shift+T
 * or Ctrl+Alt+Delete pass through untouched and never start a session.
 */

const LEFT = { ctrl: 29, shift: 42, alt: 56 };
const RIGHT = { ctrl: 3613, shift: 54, alt: 3640 };

/** Maps a raw keycode to the modifier it represents, or null. */
function modifierFor(keycode) {
  for (const [name, code] of Object.entries(LEFT)) if (code === keycode) return name;
  for (const [name, code] of Object.entries(RIGHT)) if (code === keycode) return name;
  return null;
}

class HoldToTalk {
  /**
   * @param {object} opts
   * @param {(mode: string) => void} opts.onStart
   * @param {(mode: string) => void} opts.onStop
   * @param {object} opts.logger
   */
  constructor({ onStart, onStop, logger = console, armMs = 220 } = {}) {
    this.armMs = armMs;
    this.onStart = onStart;
    this.onStop = onStop;
    this.logger = logger;

    this.hook = null;
    this.available = false;
    this.running = false;

    this.held = new Set();
    this.activeMode = null;
    // Set when a non-modifier key is pressed during a hold, so the combination
    // is treated as an ordinary shortcut rather than a talk gesture.
    this.poisoned = false;
    this.armTimer = null;

    // Both modifiers must land close together to count as a deliberate gesture
    // rather than the tail of some other chord.
    this.pressedAt = new Map();
  }

  /** Which mode the currently held modifiers correspond to, if any. */
  modeForHeld() {
    const ctrl = this.held.has('ctrl');
    if (!ctrl) return null;
    if (this.held.has('shift') && !this.held.has('alt')) return 'dictation';
    if (this.held.has('alt') && !this.held.has('shift')) return 'agent';
    return null;
  }

  start() {
    if (this.running) return true;
    let uiohook;
    try {
      uiohook = require('uiohook-napi');
    } catch (err) {
      this.logger.warn?.(`[hotkeys] uiohook-napi unavailable (${err.message}); hold-to-talk is off`);
      this.available = false;
      return false;
    }

    this.hook = uiohook.uIOhook;
    this.available = true;

    this.hook.on('keydown', (event) => this.handleDown(event));
    this.hook.on('keyup', (event) => this.handleUp(event));

    try {
      this.hook.start();
      this.running = true;
      this.logger.info?.('[hotkeys] hold-to-talk active: Ctrl+Shift dictate, Ctrl+Alt ask');
      return true;
    } catch (err) {
      this.logger.error?.(`[hotkeys] could not start the keyboard hook: ${err.message}`);
      this.available = false;
      return false;
    }
  }

  handleDown(event) {
    const mod = modifierFor(event.keycode);

    if (!mod) {
      // A real key during a hold means this is an ordinary shortcut.
      if (this.held.size) this.poisoned = true;
      this.cancelArm();
      if (this.activeMode) this.stop('another key was pressed');
      return;
    }

    if (this.held.has(mod)) return; // auto-repeat
    this.held.add(mod);
    this.pressedAt.set(mod, Date.now());

    if (this.activeMode || this.poisoned) return;

    const mode = this.modeForHeld();
    if (!mode) return;

    // Require the two modifiers within a short window of each other.
    const times = [...this.pressedAt.values()];
    const spread = Math.max(...times) - Math.min(...times);
    if (spread > 900) return;

    // Wait before committing. Ctrl+Shift+T delivers its letter within a few
    // milliseconds; a person holding to speak holds for far longer. Firing
    // immediately would hijack every Ctrl+Shift and Ctrl+Alt shortcut on the
    // system, which is worse than a barely perceptible delay.
    this.armTimer = setTimeout(() => {
      this.armTimer = null;
      if (this.poisoned) return;
      if (this.modeForHeld() !== mode) return;
      this.activeMode = mode;
      this.logger.info?.(`[hotkeys] hold started: ${mode}`);
      try { this.onStart?.(mode); } catch (err) { this.logger.error?.(err.message); }
    }, this.armMs);
  }

  handleUp(event) {
    const mod = modifierFor(event.keycode);
    if (!mod) return;

    this.held.delete(mod);
    this.pressedAt.delete(mod);
    // Released before the arming window elapsed: it was a tap, not a hold.
    if (this.armTimer && this.modeForHeld() === null) this.cancelArm();

    if (this.activeMode) {
      // Releasing either modifier ends the utterance.
      this.stop('released');
    }
    if (!this.held.size) this.poisoned = false;
  }

  cancelArm() {
    if (this.armTimer) { clearTimeout(this.armTimer); this.armTimer = null; }
  }

  stop(reason) {
    const mode = this.activeMode;
    if (!mode) return;
    this.activeMode = null;
    this.logger.info?.(`[hotkeys] hold ended (${reason}): ${mode}`);
    try { this.onStop?.(mode); } catch (err) { this.logger.error?.(err.message); }
  }

  shutdown() {
    this.cancelArm();
    if (!this.running || !this.hook) return;
    try { this.hook.stop(); } catch {}
    this.running = false;
  }

  status() {
    return {
      available: this.available,
      running: this.running,
      bindings: { dictation: 'Ctrl + Shift', agent: 'Ctrl + Alt' },
      mode: 'hold'
    };
  }
}

module.exports = { HoldToTalk, modifierFor };
