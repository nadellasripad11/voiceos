'use strict';
/**
 * Browser automation over the Chrome DevTools Protocol.
 *
 * Used for the services with no free API left — WhatsApp Web, X, LinkedIn — by
 * driving a browser the user is already signed into. Chrome and Edge are
 * already on the machine, so there is no Playwright download and no hosted
 * connector.
 *
 * Sessions live in a dedicated VoiceOS browser profile rather than the user's
 * everyday one. They sign in once per service and it persists, while their
 * normal browsing, cookies and open tabs are left completely alone.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { paths } = require('../paths');

/**
 * A WebSocket that exists wherever this runs.
 *
 * Standalone Node 24 has a global one, which is why every test of this file
 * passed. The app does not run on standalone Node: Electron 33 bundles Node
 * 20.18, where the global is undefined — so in the app every CDP call failed
 * with "WebSocket is not defined", taking Canvas and the Spotify player with
 * it, while the tests stayed green.
 *
 * The global is preferred when present so nothing changes for the tests; ws
 * fills in otherwise. Hand-rolling one was the alternative, and CDP sends page
 * text in frames well over 64KB, which is exactly where a hand-rolled
 * implementation goes subtly wrong.
 */
const WebSocketImpl = (() => {
  if (typeof WebSocket !== 'undefined') return WebSocket;
  try { return require('ws'); }
  catch { return null; }
})();

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
];

function findBrowser() {
  if (process.env.VOICEOS_BROWSER && fs.existsSync(process.env.VOICEOS_BROWSER)) {
    return process.env.VOICEOS_BROWSER;
  }
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One WebSocket connection to a CDP target, with request/response correlation. */
class CdpSession {
  constructor(wsUrl, { logger = console } = {}) {
    this.wsUrl = wsUrl;
    this.logger = logger;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      if (!WebSocketImpl) {
        return reject(new Error('No WebSocket available; run "npm install" to add ws.'));
      }
      const ws = new WebSocketImpl(this.wsUrl);
      const timer = setTimeout(() => reject(new Error('CDP connect timed out')), 15000);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve(this);
      });
      ws.addEventListener('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`CDP socket error: ${e.message || 'unknown'}`));
      });
      ws.addEventListener('close', () => {
        for (const [, p] of this.pending) p.reject(new Error('CDP connection closed'));
        this.pending.clear();
        this.ws = null;
      });
      ws.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej, timer: t } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(t);
          if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`));
          else res(msg.result);
        } else if (msg.method) {
          for (const fn of this.listeners.get(msg.method) || []) {
            try { fn(msg.params); } catch { /* a listener must not break the socket */ }
          }
        }
      });
    });
  }

  send(method, params = {}, { timeoutMs = 30000 } = {}) {
    if (!this.ws) return Promise.reject(new Error('CDP not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
    return () => {
      const arr = this.listeners.get(method) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  close() {
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
  }
}

/** Chrome's default profile location for the current user. */
function systemProfileDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
  }
  if (process.platform === 'darwin') {
    return path.join(process.env.HOME || '', 'Library', 'Application Support', 'Google', 'Chrome');
  }
  return path.join(process.env.HOME || '', '.config', 'google-chrome');
}

class BrowserController {
  constructor({ logger = console, headless = false, profile = 'voiceos' } = {}) {
    this.logger = logger;
    this.headless = headless;
    this.profile = profile;
    this.proc = null;
    this.port = null;
    this.starting = null;
  }

  /**
   * 'voiceos' is an isolated profile: the user's own tabs, cookies and logins
   * are untouched, at the cost of signing in once per service.
   * 'system' reuses their everyday Chrome so they are already signed in.
   */
  get profileDir() {
    return this.profile === 'system'
      ? systemProfileDir()
      : path.join(paths.userData, 'browser-profile');
  }

  /**
   * Chrome refuses a second instance on a profile that is already open, and an
   * already running Chrome cannot be given a debugging port retroactively. Catch
   * that here so the user gets a clear instruction instead of a silent failure.
   */
  async checkProfileConflict() {
    if (this.profile !== 'system') return null;
    const lock = path.join(this.profileDir, 'SingletonLock');
    const running = await new Promise((resolve) => {
      require('child_process').execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', "(Get-Process chrome -ErrorAction SilentlyContinue | Measure-Object).Count"],
        (err, stdout) => resolve(!err && Number(String(stdout).trim()) > 0)
      );
    });
    if (running || fs.existsSync(lock)) {
      return 'Chrome is already running with your everyday profile. Close Chrome first, ' +
             'or switch browser automation to the separate VoiceOS profile in Settings.';
    }
    return null;
  }
  get running() { return Boolean(this.proc && this.port); }

  status() {
    const exe = findBrowser();
    return {
      ready: Boolean(exe),
      exe,
      running: this.running,
      port: this.port,
      profileDir: this.profileDir,
      problems: exe ? [] : ['No Chrome or Edge installation found']
    };
  }

  async launch() {
    if (this.running) return this;
    if (this.starting) return this.starting;

    const exe = findBrowser();
    if (!exe) throw new Error('No Chrome or Edge found. Install either one (both are free).');

    this.starting = (async () => {
      const conflict = await this.checkProfileConflict();
      if (conflict) throw new Error(conflict);

      const port = await freePort();
      fs.mkdirSync(this.profileDir, { recursive: true });

      const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${this.profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,OptimizationHints',
        // Keeps the automation profile from restoring a crash bubble on every run.
        '--hide-crash-restore-bubble'
      ];
      if (this.headless) args.push('--headless=new');
      args.push('about:blank');

      this.proc = spawn(exe, args, { windowsHide: false, detached: false, stdio: 'ignore' });
      this.proc.on('exit', () => { this.proc = null; this.port = null; });

      // Wait for the DevTools endpoint to answer.
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
          if (res.ok) {
            this.port = port;
            const info = await res.json();
            this.logger.info?.(`[browser] ready: ${info.Browser} on port ${port}`);
            return this;
          }
        } catch { /* not up yet */ }
        await sleep(350);
      }
      throw new Error('Browser did not expose its DevTools endpoint in time');
    })();

    try { return await this.starting; } finally { this.starting = null; }
  }

  async targets() {
    if (!this.running) await this.launch();
    const res = await fetch(`http://127.0.0.1:${this.port}/json/list`);
    if (!res.ok) throw new Error(`Could not list targets (HTTP ${res.status})`);
    const all = await res.json();
    return all.filter((t) => t.type === 'page');
  }

  /** Opens a new tab and returns an attached Page. */
  async newTab(url = 'about:blank') {
    if (!this.running) await this.launch();
    // Newer Chrome requires PUT for /json/new and rejects GET.
    const res = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (!res.ok) throw new Error(`Could not open a tab (HTTP ${res.status})`);
    const target = await res.json();
    return this.attach(target);
  }

  /** Attaches to an existing tab, by target object or by URL substring. */
  async attach(targetOrMatch) {
    let target = targetOrMatch;
    if (typeof targetOrMatch === 'string') {
      const list = await this.targets();
      target = list.find((t) => t.url.includes(targetOrMatch));
      if (!target) throw new Error(`No open tab matching '${targetOrMatch}'`);
    }
    const session = new CdpSession(target.webSocketDebuggerUrl, { logger: this.logger });
    await session.connect();
    const page = new Page(session, target, this);
    await page.init();
    return page;
  }

  /** Reuses a tab on the given URL if one is open, otherwise opens one. */
  async openOrReuse(url, matchFragment) {
    const list = await this.targets();
    const existing = list.find((t) => t.url.includes(matchFragment || new URL(url).hostname));
    if (existing) {
      const page = await this.attach(existing);
      return { page, reused: true };
    }
    const page = await this.newTab(url);
    await page.waitForLoad();
    return { page, reused: false };
  }

  async closeTab(targetId) {
    await fetch(`http://127.0.0.1:${this.port}/json/close/${targetId}`);
  }

  stop() {
    if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; this.port = null; }
  }
}

/** A single tab. */
class Page {
  constructor(session, target, controller) {
    this.session = session;
    this.target = target;
    this.controller = controller;
  }

  get id() { return this.target.id; }

  async init() {
    await this.session.send('Page.enable');
    await this.session.send('Runtime.enable');
    await this.session.send('DOM.enable');
  }

  async navigate(url, { waitForLoad = true } = {}) {
    await this.session.send('Page.navigate', { url });
    if (waitForLoad) await this.waitForLoad();
    return this.url();
  }

  /** Resolves once the page reports load, or after the timeout either way. */
  waitForLoad({ timeoutMs = 25000 } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; off(); clearTimeout(timer); resolve(); } };
      const off = this.session.on('Page.loadEventFired', finish);
      const timer = setTimeout(finish, timeoutMs);
    });
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const res = await this.session.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise
    });
    if (res.exceptionDetails) {
      throw new Error(`Page script failed: ${res.exceptionDetails.text || res.exceptionDetails.exception?.description}`);
    }
    return res.result && res.result.value;
  }

  url() { return this.evaluate('location.href'); }
  title() { return this.evaluate('document.title'); }
  text({ max = 20000 } = {}) {
    return this.evaluate(`(document.body && document.body.innerText || '').slice(0, ${max})`);
  }

  /** Waits for a selector to exist, polling in the page. */
  async waitForSelector(selector, { timeoutMs = 15000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await this.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
      if (found) return true;
      await sleep(250);
    }
    throw new Error(`Timed out waiting for '${selector}'`);
  }

  async click(selector) {
    await this.waitForSelector(selector);
    // Dispatch through the element so framework handlers fire as they would for
    // a real click.
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })()`);
  }

  async focus(selector) {
    await this.waitForSelector(selector);
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      return true;
    })()`);
  }

  /**
   * Types into the focused element as real key events, so sites that listen for
   * keystrokes (chat composers, rich text editors) register the input. Pass
   * delayMs to pace it; 0 is as fast as the browser will accept.
   */
  async type(text, { delayMs = 0 } = {}) {
    for (const ch of text) {
      if (ch === '\n') {
        await this.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await this.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      } else {
        await this.session.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
        await this.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      }
      if (delayMs) await sleep(delayMs);
    }
  }

  /** Inserts text in one shot. Much faster, but not keystroke-by-keystroke. */
  insertText(text) {
    return this.session.send('Input.insertText', { text });
  }

  async pressKey(key) {
    const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38 };
    const vk = codes[key] || 0;
    await this.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: vk });
    await this.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk });
  }

  async screenshot(filePath) {
    const { data } = await this.session.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
    return filePath;
  }

  /** Structured link/field extraction, for the agent to reason over. */
  links({ max = 60 } = {}) {
    return this.evaluate(`[...document.querySelectorAll('a[href]')]
      .map(a => ({ text: (a.innerText||'').trim().slice(0,90), href: a.href }))
      .filter(a => a.text)
      .slice(0, ${max})`);
  }

  close() {
    this.session.close();
    return this.controller.closeTab(this.id);
  }
}

let shared = null;
function getBrowser(opts) {
  if (!shared) shared = new BrowserController(opts);
  return shared;
}

module.exports = { BrowserController, Page, CdpSession, getBrowser, findBrowser };
