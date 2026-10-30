'use strict';
/**
 * Learned shortcuts and taught phrases.
 *
 * Two kinds, kept in one file:
 *
 *   learned  An ask the model answered by calling only quick, repeatable
 *            tools (open an app, move a window, play something). The calls
 *            are kept, and the same ask next time replays them with no model:
 *            instant, and free.
 *   taught   "When I say focus mode, close Discord and open my to-do list."
 *            The phrase is kept with the sentences it stands for; saying it
 *            runs each sentence as its own ask, and those become learned
 *            shortcuts in turn.
 *
 * Matching is on the normalised words, not on meaning: "open spotify" and
 * "Open Spotify, please" are the same ask; "start spotify" is a new one and
 * goes to the model once. A wrong shortcut is dropped by saying "no" or by
 * Try again, so it cannot keep doing the wrong thing.
 */
const fs = require('fs');
const path = require('path');

/** Tools whose effect is the whole answer, so replaying them is safe and enough. */
const REPLAYABLE = new Set([
  'open_app', 'open_url', 'close_app', 'arrange_window', 'press_button',
  'control_playback', 'play_search', 'set_volume', 'set_brightness', 'tidy_downloads'
]);

const FILLER = /\b(please|pls|plz|jarvis|hey|ok(ay)?|could you|can you|would you|for me|now|thanks|thank you)\b/g;

/** The words that decide whether two asks are the same ask. */
function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(FILLER, ' ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

class Shortcuts {
  constructor({ file, logger = console } = {}) {
    this.file = file;
    this.logger = logger;
    this.items = [];
    this.load();
  }

  load() {
    try { this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')).items || []; } catch { this.items = []; }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ items: this.items }, null, 2));
    } catch (err) { this.logger.warn?.(`[shortcuts] could not save: ${err.message}`); }
  }

  /** The shortcut for this ask, if there is one. */
  match(text) {
    const key = normalise(text);
    if (!key) return null;
    return this.items.find((s) => s.key === key) || null;
  }

  /**
   * Keeps a model answer as a shortcut when every call it made was quick,
   * repeatable and worked. Anything that read something (email, the web, the
   * screen) is not kept: its answer is different every time.
   */
  learn(question, calls) {
    if (!calls.length || calls.length > 6) return null;
    if (!calls.every((c) => REPLAYABLE.has(c.name) && c.ok)) return null;
    const key = normalise(question);
    if (!key || key.split(' ').length > 14) return null;
    const existing = this.items.find((s) => s.key === key);
    if (existing && existing.kind === 'taught') return null;
    const entry = { kind: 'learned', key, said: String(question).trim(), steps: calls.map(({ name, args }) => ({ tool: name, args })), at: Date.now(), uses: 0 };
    this.items = this.items.filter((s) => s.key !== key).concat(entry);
    this.save();
    this.logger.info?.(`[shortcuts] learned "${key}" -> ${entry.steps.map((s) => s.tool).join(', ')}`);
    return entry;
  }

  /** "When I say <phrase>, <do these>." */
  teach(phrase, sentences) {
    const key = normalise(phrase);
    const list = (Array.isArray(sentences) ? sentences : [sentences]).map((s) => String(s || '').trim()).filter(Boolean).slice(0, 8);
    if (!key || !list.length) return null;
    const entry = { kind: 'taught', key, said: String(phrase).trim(), sentences: list, at: Date.now(), uses: 0 };
    this.items = this.items.filter((s) => s.key !== key).concat(entry);
    this.save();
    return entry;
  }

  /**
   * Drops the shortcut for this ask. Said by the user ("forget focus mode")
   * it also drops ones containing those words; exact is for corrections,
   * which must not take other shortcuts with them.
   */
  forget(textOrWords, { exact = false } = {}) {
    const key = normalise(textOrWords);
    if (!key) return 0;
    const before = this.items.length;
    this.items = this.items.filter((s) => s.key !== key && !(!exact && key.length > 3 && s.key.includes(key)));
    if (this.items.length !== before) this.save();
    return before - this.items.length;
  }

  used(entry) {
    entry.uses = (entry.uses || 0) + 1;
    entry.last = Date.now();
    this.save();
  }

  list() { return this.items.slice(); }
}

module.exports = { Shortcuts, normalise, REPLAYABLE };
