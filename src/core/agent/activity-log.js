'use strict';
/**
 * Every action the agent took, exactly: which tool, with what, whether it was
 * approved, and what came back. One JSON line each, newest last, so the file
 * can be read in any editor and Settings can show the recent ones.
 *
 * Reading-only tools are logged too: "what did it look at" matters as much as
 * "what did it change". Anything that looks like a secret is masked first.
 */
const fs = require('fs');
const path = require('path');

const SECRETISH = /pass(word|code)?|token|secret|api[_-]?key|card|cvv|ssn/i;
const MAX_BYTES = 2 << 20;

function mask(value, key = '') {
  if (SECRETISH.test(key)) return '•••';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => mask(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v, k)]));
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  return value;
}

class ActivityLog {
  constructor({ file, logger = console } = {}) {
    this.file = file;
    this.logger = logger;
  }

  add({ tool, args, ok, summary, approved = null, via = 'agent' }) {
    const line = JSON.stringify({ at: new Date().toISOString(), via, tool, args: mask(args || {}), approved, ok: ok !== false, result: String(summary || '').slice(0, 300) });
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Kept to a couple of MB: the older half goes when it grows past that.
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_BYTES) {
        const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n');
        fs.writeFileSync(this.file, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
      }
      fs.appendFileSync(this.file, line + '\n');
    } catch (err) { this.logger.warn?.(`[activity] ${err.message}`); }
  }

  recent(n = 100) {
    try {
      return fs.readFileSync(this.file, 'utf8').trim().split('\n').slice(-n).reverse().map((l) => JSON.parse(l));
    } catch { return []; }
  }
}

module.exports = { ActivityLog, mask };
