'use strict';
/**
 * Minimal file + console logger. Rotates by size so a long-running tray app
 * cannot quietly fill the disk.
 */
const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BYTES = 2 * 1024 * 1024;

function createLogger({ dir, level = 'info', filename = 'voiceos.log' } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  let stream = null;
  let file = null;

  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, filename);
      rotateIfNeeded();
      stream = fs.createWriteStream(file, { flags: 'a' });
    } catch {
      stream = null; // console-only is an acceptable degradation
    }
  }

  function rotateIfNeeded() {
    try {
      if (file && fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
        fs.renameSync(file, file.replace(/\.log$/, '.1.log'));
      }
    } catch {}
  }

  function write(lvl, args) {
    if (LEVELS[lvl] < threshold) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${args
      .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
      .join(' ')}`;
    const consoleFn = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log;
    consoleFn(line);
    if (stream) {
      try { stream.write(line + '\n'); } catch {}
    }
  }

  return {
    debug: (...a) => write('debug', a),
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
    file
  };
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

module.exports = { createLogger };
