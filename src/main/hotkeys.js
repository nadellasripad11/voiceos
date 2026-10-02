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
  constructor({ onStart, onStop, logger = console, armMs = 220, bindings } = {}) {
    // Keyed by modifier, not by mode: modeForHeld looks up which mode a held
    // modifier means. Keying it the other way round silently returned
    // undefined for every chord, so nothing ever started.
    // Ctrl+Shift is the chord people reach for first, so it drives the agent.
    this.bindings = bindings || { shift: 'agent', alt: 'dictation' };
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

    // Hands-free: a quick double-tap latches recording on until the next tap,
    // so a long dictation does not mean holding a chord for a minute.
    this.lastTapAt = 0;
    this.lastTapMode = null;
    this.handsFree = null;
    this.doubleTapMs = 420;
    this.latchedAt = 0;
    // A release later than this is a hold being let go, not a tap. Generous,
    // because the only thing it gates is a deliberate chord.
    this.tapMaxMs = Math.max(400, armMs + 200);
    // Stops the second half of the latching double-tap from immediately
    // ending what it just started.
    this.latchGuardMs = 250;
    // Set when a real key lands during a hold, so the combination is treated as
    // an ordinary shortcut rather than a request to talk.
    this.poisoned = false;
  }

  /** The mode the currently held modifiers correspond to, if any. */
  modeForHeld() {
    if (!this.held.has('ctrl')) return null;
    const hasShift = this.held.has('shift');
    const hasAlt = this.held.has('alt');
    // Exactly one of the two, so Ctrl+Shift+Alt is not read as either.
    if (hasShift && !hasAlt) return this.bindings.shift || null;
    if (hasAlt && !hasShift) return this.bindings.alt || null;
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
          this.logger.info?.(
          `[hotkeys] hold-to-talk active: Ctrl+Shift ${this.bindings.shift}, Ctrl+Alt ${this.bindings.alt}`
        );
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
    // A latched session is deliberate, so ordinary typing must not end it;
    // only a chord held at the same time does.
    if (this.activeMode && !this.handsFree) this.stop('another key was pressed');
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
    // Read the chord before forgetting this key, so a release knows what was
    // being held a moment ago.
    const modeBefore = this.modeForHeld();
    const downAt = this.pressedAt.get(mod);
    const heldMs = downAt ? Date.now() - downAt : Infinity;

    this.held.delete(mod);
    this.pressedAt.delete(mod);
    if (this.armTimer && this.modeForHeld() === null) this.cancelArm();

    if (this.handsFree) {
      // Latched on. One quick tap of the same chord finishes it; releasing the
      // keys does not, which is the whole point of latching.
      const ending = modeBefore === this.handsFree &&
        !this.poisoned &&
        heldMs < this.tapMaxMs &&
        Date.now() - this.latchedAt > this.latchGuardMs;
      if (ending) this.endHandsFree();
    } else if (this.activeMode) {
      // A hold ends when the chord is released.
      this.stop('released');
    } else if (modeBefore && !this.poisoned && heldMs < this.tapMaxMs) {
      // Released before arming elapsed: a tap, which may be half a double-tap.
      this.handleTap(modeBefore);
    }

    if (!this.held.size) this.poisoned = false;
  }

  /**
   * A tap on its own does nothing; two in quick succession latch hands-free on.
   *
   * A lone tap must stay inert, or brushing the modifiers would start recording
   * at random. Ending a latched session is handled on release, not here, since
   * by then nothing is arming.
   */
  handleTap(mode) {
    const now = Date.now();
    const isDouble = mode === this.lastTapMode && (now - this.lastTapAt) < this.doubleTapMs;
    this.lastTapAt = now;
    this.lastTapMode = mode;
    if (!isDouble) return;

    this.lastTapAt = 0;
    this.lastTapMode = null;
    this.handsFree = mode;
    this.activeMode = mode;
    this.latchedAt = now;
    this.logger.info?.(`[hotkeys] hands-free started: ${mode}`);
    try { this.onStart?.(mode, { handsFree: true }); } catch (err) { this.logger.error?.(err.message); }
  }

  endHandsFree() {
    const ending = this.handsFree;
    this.handsFree = null;
    this.lastTapAt = 0;
    this.lastTapMode = null;
    this.activeMode = ending;
    this.stop('tapped to finish');
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
    this.handsFree = null;
    this.lastTapAt = 0;
    this.lastTapMode = null;
    this.latchedAt = 0;
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
      bindings: {
        dictation: `Ctrl + ${this.bindings.shift === 'dictation' ? 'Shift' : 'Alt'}`,
        agent: `Ctrl + ${this.bindings.shift === 'agent' ? 'Shift' : 'Alt'}`
      },
      mode: 'hold',
      handsFree: Boolean(this.handsFree)
    };
  }
}

module.exports = { HoldToTalk };
