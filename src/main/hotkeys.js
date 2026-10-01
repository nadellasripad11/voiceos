'use strict';
/**
 * Modifier-only, hold-to-talk hotkeys.
 *
 * Hold Ctrl+Shift to dictate, Ctrl+Alt to ask; release to finish.
 *
 * Electron's globalShortcut cannot express this: an accelerator must end in a
 * non-modifier key and only fires on press, never on release. So this needs a
 * low-level keyboard hook — and that hook runs in a separate Node process,
 * because uiohook-napi is built against Node's N-API and faults under Electron
 * (`uiohook_to_js_event napi_define_properties`) after a handful of events.
 * Out-of-process, it is reliable, and a crash costs a restarted helper rather
 * than the whole app.
 */
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const DAEMON = path.join(__dirname, 'hotkey-daemon.js');

class HoldToTalk {
  /**
   * @param {object} opts
   * @param {(mode: string) => void} opts.onStart
   * @param {(mode: string) => void} opts.onStop
   * @param {number} [opts.armMs] how long both modifiers must be held before
   *   this counts as a hold rather than the start of an ordinary shortcut
   */
  constructor({ onStart, onStop, logger = console, armMs = 220 } = {}) {
    this.onStart = onStart;
    this.onStop = onStop;
    this.logger = logger;
    this.armMs = armMs;

    this.proc = null;
    this.available = false;
    this.running = false;
    this.restarts = 0;

    this.held = new Set();
    this.pressedAt = new Map();
    this.activeMode = null;
    this.armTimer = null;
    // Set when a real key lands during a hold, so the combination is treated as
    // an ordinary shortcut rather than a request to talk.
    this.poisoned = false;
  }

  /** The mode the currently held modifiers correspond to, if any. */
  modeForHeld() {
    if (!this.held.has('ctrl')) return null;
    if (this.held.has('shift') && !this.held.has('alt')) return 'dictation';
    if (this.held.has('alt') && !this.held.has('shift')) return 'agent';
    return null;
  }

  start() {
    if (this.running) return true;

    // Deliberately the system Node, not process.execPath: under Electron that
    // would be electron.exe, which is the environment this helper exists to
    // avoid.
    const node = process.platform === 'win32' ? 'node.exe' : 'node';

    try {
      this.proc = spawn(node, [DAEMON], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (err) {
      this.logger.warn?.(`[hotkeys] could not start the hook helper: ${err.message}`);
      return false;
    }

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this.handleLine(line));

    this.proc.stderr.on('data', (d) => {
      const text = String(d).trim();
      if (text) this.logger.debug?.(`[hotkeys:helper] ${text}`);
    });

    this.proc.on('error', (err) => {
      this.logger.warn?.(`[hotkeys] hook helper error: ${err.message}`);
      this.available = false;
      this.running = false;
    });

    this.proc.on('exit', (code) => {
      this.running = false;
      this.proc = null;
      // Drop any half-finished gesture so a restart cannot resume mid-hold.
      this.reset();
      if (this.closing) return;

      // Restart a crashed helper, but give up rather than spinning forever.
      if (this.restarts < 3) {
        this.restarts++;
        this.logger.warn?.(`[hotkeys] hook helper exited (code ${code}); restarting (${this.restarts}/3)`);
        setTimeout(() => this.start(), 800);
      } else {
        this.available = false;
        this.logger.error?.('[hotkeys] hook helper keeps exiting; hold-to-talk is off');
      }
    });

    this.running = true;
    return true;
  }

  handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    switch (msg.type) {
      case 'ready':
        this.available = true;
        this.restarts = 0;
        this.logger.info?.('[hotkeys] hold-to-talk active: Ctrl+Shift dictate, Ctrl+Alt ask');
        break;
      case 'error':
        this.available = false;
        this.logger.warn?.(`[hotkeys] ${msg.message}`);
        break;
      case 'mod-down': this.onModDown(msg.mod); break;
      case 'mod-up': this.onModUp(msg.mod); break;
      case 'other-key': this.onOtherKey(); break;
      default: break;
    }
  }

  onOtherKey() {
    if (this.held.size) this.poisoned = true;
    this.cancelArm();
    if (this.activeMode) this.stop('another key was pressed');
  }

  onModDown(mod) {
    if (this.held.has(mod)) return; // auto-repeat
    this.held.add(mod);
    this.pressedAt.set(mod, Date.now());

    if (this.activeMode || this.poisoned) return;

    const mode = this.modeForHeld();
    if (!mode) return;

    // Both modifiers must land close together to read as one deliberate
    // gesture rather than the tail of something else.
    const times = [...this.pressedAt.values()];
    if (Math.max(...times) - Math.min(...times) > 900) return;

    // Arm, do not fire. Committing the moment the second modifier lands would
    // hijack every Ctrl+Shift and Ctrl+Alt shortcut on the system, because the
    // letter in Ctrl+Shift+T arrives milliseconds later.
    this.cancelArm();
    this.armTimer = setTimeout(() => {
      this.armTimer = null;
      if (this.poisoned) return;
      if (this.modeForHeld() !== mode) return;
      this.activeMode = mode;
      this.logger.info?.(`[hotkeys] hold started: ${mode}`);
      try { this.onStart?.(mode); } catch (err) { this.logger.error?.(err.message); }
    }, this.armMs);
  }

  onModUp(mod) {
    this.held.delete(mod);
    this.pressedAt.delete(mod);
    // Released before arming elapsed: a tap, not a hold.
    if (this.armTimer && this.modeForHeld() === null) this.cancelArm();
    if (this.activeMode) this.stop('released');
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

  reset() {
    this.cancelArm();
    this.held.clear();
    this.pressedAt.clear();
    this.activeMode = null;
    this.poisoned = false;
  }

  shutdown() {
    this.closing = true;
    this.cancelArm();
    if (this.proc) {
      try { this.proc.stdin.end(); } catch {}
      const proc = this.proc;
      setTimeout(() => { try { proc.kill(); } catch {} }, 400);
      this.proc = null;
    }
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

module.exports = { HoldToTalk };
