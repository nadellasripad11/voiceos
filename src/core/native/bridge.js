'use strict';
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const { paths } = require('../paths');

const BRIDGE_PS1 = path.join(__dirname, 'bridge.ps1');
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Typed RPC channel to the native layer.
 *
 * One long-lived PowerShell host serves every request, so the ~300ms of
 * PowerShell startup and assembly loading is paid once at boot instead of on
 * every dictation. Requests are correlated by id, so callers can issue several
 * concurrently without interleaving replies.
 */
class NativeBridge {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this.proc = null;
    this.ready = null;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
  }

  get available() {
    return process.platform === 'win32';
  }

  async start() {
    if (this.ready) return this.ready;
    if (!this.available) {
      throw new Error(`The native bridge requires Windows; this is ${process.platform}. See src/core/native/README.md for the macOS plan.`);
    }

    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Native bridge did not become ready within 30s')),
        30000
      );

      this.proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', BRIDGE_PS1],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      );

      const rl = readline.createInterface({ input: this.proc.stdout });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) {
          if (trimmed) this.logger.debug?.(`[bridge] ${trimmed}`);
          return;
        }
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          this.logger.warn?.(`[bridge] unparseable line: ${trimmed.slice(0, 200)}`);
          return;
        }
        if (msg.ready) {
          clearTimeout(timer);
          resolve(this);
          return;
        }
        this._settle(msg);
      });

      let stderrBuf = '';
      this.proc.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
        // PowerShell writes multi-line error records; log them whole.
        const lines = stderrBuf.split(/\r?\n/);
        stderrBuf = lines.pop() || '';
        for (const l of lines) {
          if (l.trim()) this.logger.warn?.(`[bridge:stderr] ${l}`);
        }
      });

      this.proc.on('exit', (code, signal) => {
        clearTimeout(timer);
        const err = new Error(`Native bridge exited (code=${code} signal=${signal})`);
        for (const [, p] of this.pending) p.reject(err);
        this.pending.clear();
        this.proc = null;
        this.ready = null;
        if (!this.closed) {
          this.logger.warn?.('[bridge] exited unexpectedly; it will restart on next use');
        }
        reject(err);
      });

      this.proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    return this.ready;
  }

  _settle(msg) {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok === false) {
      entry.reject(new Error(msg.error || 'Native bridge call failed'));
    } else {
      entry.resolve(msg);
    }
  }

  /** Issues one command and resolves with the parsed response object. */
  async call(cmd, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!this.proc) await this.start();
    const id = this.nextId++;
    const payload = JSON.stringify({ id, cmd, ...params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Native call '${cmd}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(payload + '\n', (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  stop() {
    this.closed = true;
    if (this.proc) {
      try { this.proc.stdin.end(); } catch {}
      // Give the host a moment to exit its read loop before forcing it.
      const proc = this.proc;
      setTimeout(() => { try { proc.kill(); } catch {} }, 500);
      this.proc = null;
      this.ready = null;
    }
  }

  // --- Convenience wrappers -------------------------------------------------
  // These exist so call sites read as intent rather than as string commands,
  // and so the agent tool layer has one obvious place to bind to.

  ping() { return this.call('ping', {}, { timeoutMs: 5000 }); }

  /** The screen rectangle as this bridge sees it, for scale detection. */
  screenInfo() { return this.call('screenInfo'); }

  async cursorPos() {
    const r = await this.call('getCursorPos');
    return { x: r.x, y: r.y };
  }

  async foregroundWindow() { return (await this.call('getForeground')).window; }
  async windowAt(x, y) { return (await this.call('getWindowAt', { x, y })).window; }
  async focusedElement() { return (await this.call('getFocusedElement')).element; }
  async elementAt(x, y) { return (await this.call('getElementAt', { x, y })).element; }
  async listWindows() { return (await this.call('listWindows')).windows; }

  async readClipboard() { return (await this.call('getClipboard')).text; }
  writeClipboard(text) { return this.call('setClipboard', { text }); }

  /** Reads the user's current selection, preferring UIA so the clipboard is left alone. */
  async selection({ restoreClipboard = true } = {}) {
    const r = await this.call('getSelection', { restoreClipboard });
    return { text: r.text || '', via: r.via };
  }

  /**
   * Puts text where the caret is. 'paste' is fast and preserves formatting
   * behaviour; 'type' is slower but works in fields that block paste.
   */
  insertText(text, { mode = 'paste', restoreClipboard = true, waitMs } = {}) {
    return this.call('insertText', { text, mode, restoreClipboard, waitMs }, {
      // Typing is synthesized per character, so long text needs more headroom.
      timeoutMs: mode === 'type' ? Math.max(15000, text.length * 12) : DEFAULT_TIMEOUT_MS
    });
  }

  typeText(text) {
    return this.call('typeText', { text }, { timeoutMs: Math.max(15000, text.length * 12) });
  }

  /**
   * Types with human cadence rather than instantaneously.
   *
   * Some editors (Google Docs, Canvas's rich text box, certain Electron apps)
   * drop or mis-order synthesized input that arrives faster than a person could
   * produce it, and a few reject clipboard paste outright. Pacing the keystrokes
   * and pausing at word and sentence boundaries makes insertion reliable there.
   *
   * @param {string} text
   * @param {object} opts
   * @param {number} opts.cps  target characters per second (default 11, ~130wpm)
   * @param {number} opts.jitter  0-1 variation applied to each gap
   * @param {AbortSignal} opts.signal
   * @param {(done:number,total:number)=>void} opts.onProgress
   */
  async typeNatural(text, { cps = 11, jitter = 0.45, signal, onProgress } = {}) {
    const baseGap = 1000 / Math.max(1, cps);
    // Batch into short runs: one round trip per character would be dominated by
    // IPC latency rather than by the pacing we actually want.
    const RUN = 6;
    let done = 0;

    for (let i = 0; i < text.length; i += RUN) {
      if (signal && signal.aborted) throw new Error('Typing cancelled');
      const chunk = text.slice(i, i + RUN);
      await this.typeText(chunk);
      done += chunk.length;
      if (onProgress) onProgress(done, text.length);

      let gap = baseGap * chunk.length;
      gap *= 1 + (Math.random() * 2 - 1) * jitter;
      // People pause longer after sentences than between words.
      if (/[.!?]\s*$/.test(chunk)) gap += 180 + Math.random() * 220;
      else if (/[,;:]\s*$/.test(chunk)) gap += 70 + Math.random() * 110;
      else if (/\s$/.test(chunk)) gap += 20 + Math.random() * 50;

      await new Promise((r) => setTimeout(r, Math.max(0, gap)));
    }
    return { ok: true, chars: text.length };
  }

  keys(combo) { return this.call('keys', { combo }); }
  /** A real mouse click at a screen point, as opposed to a UIA invoke. */
  /** A genuine move event, which a click-through overlay can actually see. */
  mouseMove(x, y) { return this.call('mouseMove', { x, y }); }
  mouseClick(x, y, { right = false } = {}) { return this.call('mouseClick', { x, y, right }); }
  keyDown(combo) { return this.call('keyDown', { combo }); }
  keyUp(combo) { return this.call('keyUp', { combo }); }
  focusWindow(hwnd) { return this.call('focusWindow', { hwnd }); }

  screenshot(filePath, region) { return this.call('screenshot', { path: filePath, region }, { timeoutMs: 30000 }); }
  ocr(filePath) { return this.call('ocr', { path: filePath }, { timeoutMs: 30000 }); }
  ocrScreen(filePath, region) { return this.call('ocrScreen', { path: filePath, region }, { timeoutMs: 45000 }); }

  openUrl(url) { return this.call('openUrl', { url }); }
  openPath(p) { return this.call('openPath', { path: p }); }
  openApp(name) { return this.call('openApp', { name }, { timeoutMs: 30000 }); }
  listApps(filter, limit) { return this.call('listApps', { filter, limit }, { timeoutMs: 30000 }); }
  startProcess(file, args, opts = {}) { return this.call('startProcess', { file, args, ...opts }); }

  mediaStatus() { return this.call('mediaStatus', {}, { timeoutMs: 20000 }); }
  mediaControl(action, { app, value } = {}) {
    return this.call('mediaControl', { action, app, value }, { timeoutMs: 20000 });
  }
  mediaKey(key) { return this.call('mediaKey', { key }); }

  clickElement(target) { return this.call('clickElement', target, { timeoutMs: 20000 }); }
  setElementValue(target) { return this.call('setElementValue', target, { timeoutMs: 20000 }); }
  uiTree(opts = {}) { return this.call('getUiTree', opts, { timeoutMs: 30000 }); }
}

// A single shared instance: the bridge is a process, not a value object.
let shared = null;
function getBridge(opts) {
  if (!shared) shared = new NativeBridge(opts);
  return shared;
}

module.exports = { NativeBridge, getBridge, paths };
