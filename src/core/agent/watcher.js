'use strict';
/**
 * "Tell me when the download is done." "Watch this page until it says shipped."
 *
 * Set up once (by the model, or straight from the router), then checked here
 * every few seconds with no model at all, so waiting costs nothing. A window
 * is read with Windows' own text recognition over the part of the screen it
 * covers, so it has to stay visible; downloads are watched on disk, so they
 * can be anywhere.
 *
 * When one fires: a notification here and on the phone, the line spoken, and
 * the follow-up run if one was asked for.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PARTIAL = /\.(crdownload|part|partial|download|tmp)$/i;
const EVERY_MS = 5000;
const GIVE_UP_MS = 3 * 60 * 60 * 1000;

class Watcher {
  constructor({ bridge, logger = console, tmpDir = os.tmpdir(), onFire = () => {} } = {}) {
    this.bridge = bridge;
    this.logger = logger;
    this.tmpDir = tmpDir;
    this.onFire = onFire;
    this.watches = new Map();
    this.timer = null;
    this.nextId = 1;
  }

  partials() {
    const dir = path.join(os.homedir(), 'Downloads');
    try { return fs.readdirSync(dir).filter((f) => PARTIAL.test(f)); } catch { return []; }
  }

  /**
   * @param {{what: 'download'|'text', text?: string, window?: string, until?: 'appears'|'disappears', then?: string}} spec
   * @returns {{ok: boolean, summary: string, id?: number}}
   */
  add(spec) {
    const what = spec.what === 'download' ? 'download' : 'text';
    if (what === 'download') {
      const now = this.partials();
      if (!now.length) return { ok: false, summary: 'Nothing is downloading right now.' };
      spec = { ...spec, files: now };
    } else if (!String(spec.text || '').trim()) {
      return { ok: false, summary: 'What should I watch for? Say the words to look for.' };
    }
    const id = this.nextId++;
    const watch = {
      id, what,
      text: String(spec.text || '').trim(),
      window: String(spec.window || '').trim(),
      until: spec.until === 'disappears' ? 'disappears' : 'appears',
      then: String(spec.then || '').trim(),
      files: spec.files || [],
      started: Date.now(),
      misses: 0
    };
    this.watches.set(id, watch);
    this.ensureTimer();
    return { ok: true, id, summary: `Watching ${this.describe(watch)}. I'll tell you when it happens.` };
  }

  describe(w) {
    if (w.what === 'download') return w.files.length === 1 ? `the download of ${w.files[0].replace(PARTIAL, '')}` : `${w.files.length} downloads`;
    const where = w.window ? ` in ${w.window}` : ' on screen';
    return w.until === 'disappears' ? `until "${w.text}" goes away${where}` : `for "${w.text}"${where}`;
  }

  list() { return [...this.watches.values()]; }

  stop(id = null) {
    const n = id == null ? this.watches.size : (this.watches.delete(Number(id)) ? 1 : 0);
    if (id == null) this.watches.clear();
    if (!this.watches.size) this.stopTimer();
    return n;
  }

  ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((err) => this.logger.warn?.(`[watch] ${err.message}`)), EVERY_MS);
  }

  stopTimer() { clearInterval(this.timer); this.timer = null; }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const w of [...this.watches.values()]) {
        if (Date.now() - w.started > GIVE_UP_MS) {
          this.watches.delete(w.id);
          this.onFire(w, `I stopped watching ${this.describe(w)} after three hours.`);
          continue;
        }
        const hit = w.what === 'download' ? this.downloadDone(w) : await this.textCheck(w);
        if (hit) {
          this.watches.delete(w.id);
          this.onFire(w, hit);
        }
      }
    } finally {
      this.busy = false;
      if (!this.watches.size) this.stopTimer();
    }
  }

  downloadDone(w) {
    const left = this.partials().filter((f) => w.files.includes(f));
    if (left.length) return null;
    const names = w.files.map((f) => f.replace(PARTIAL, ''));
    return names.length === 1 ? `Your download finished: ${names[0]}.` : `Your ${names.length} downloads finished.`;
  }

  async textCheck(w) {
    let region = null;
    if (w.window) {
      const wins = await this.bridge.listWindows().catch(() => []);
      const needle = w.window.toLowerCase();
      const win = wins.find((x) => String(x.title).toLowerCase().includes(needle)) || wins.find((x) => String(x.process).toLowerCase().includes(needle));
      if (!win || !win.bounds || win.bounds.width < 50 || win.bounds.x < -10000) {
        // Closed or minimised: say so once rather than watching nothing in silence.
        if (++w.misses === 3) this.onFire({ ...w, then: '' }, `I can't see ${w.window} any more, so I can't watch it. It has to stay open on screen.`, { keep: true });
        return null;
      }
      w.misses = 0;
      region = win.bounds;
    }
    const shot = path.join(this.tmpDir, `watch-${w.id}.png`);
    const r = await this.bridge.ocrScreen(shot, region).catch(() => null);
    try { fs.unlinkSync(shot); } catch { /* temp */ }
    if (!r) return null;
    const seen = String(r.text || '').toLowerCase().replace(/\s+/g, ' ').includes(w.text.toLowerCase());
    if (w.until === 'appears' && seen) return `"${w.text}" just appeared${w.window ? ` in ${w.window}` : ''}.`;
    if (w.until === 'disappears' && !seen) return `"${w.text}" is gone${w.window ? ` from ${w.window}` : ''}.`;
    return null;
  }
}

module.exports = { Watcher };
