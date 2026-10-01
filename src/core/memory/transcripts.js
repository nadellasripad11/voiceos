'use strict';
/**
 * On-device transcript history.
 *
 * Stored as newline-delimited JSON, one file per day, under the user's app data
 * directory and nowhere else. Nothing is uploaded, because there is no server to
 * upload to. Writes respect the privacy switches: Private Mode and the
 * "save transcripts on this device" toggle both suppress them entirely.
 */
const fs = require('fs');
const path = require('path');
const { paths } = require('../paths');

class TranscriptStore {
  constructor({ config, logger = console }) {
    this.config = config;
    this.logger = logger;
  }

  fileFor(date = new Date()) {
    const day = date.toISOString().slice(0, 10);
    return path.join(paths.transcripts, `${day}.jsonl`);
  }

  get enabled() {
    const cfg = this.config.all();
    return cfg.privacy.saveTranscriptsOnDevice && !cfg.privacy.privateMode;
  }

  async append(record) {
    if (!this.enabled) return { written: false, reason: 'disabled by privacy settings' };
    const file = this.fileFor();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify({
      at: record.at || new Date().toISOString(),
      mode: record.mode || 'dictation',
      text: record.text,
      raw: record.raw,
      polished: record.polished,
      target: record.target,
      stt: record.stt,
      ms: record.ms
    }) + '\n';
    await fs.promises.appendFile(file, line, 'utf8');
    return { written: true, file };
  }

  /** Most recent entries first, newest day first. */
  async list({ limit = 100, days = 30 } = {}) {
    let files;
    try {
      files = fs.readdirSync(paths.transcripts).filter((f) => f.endsWith('.jsonl')).sort().reverse();
    } catch {
      return [];
    }
    const out = [];
    for (const f of files.slice(0, days)) {
      let content;
      try { content = await fs.promises.readFile(path.join(paths.transcripts, f), 'utf8'); }
      catch { continue; }
      const lines = content.split('\n').filter(Boolean).reverse();
      for (const l of lines) {
        try { out.push(JSON.parse(l)); } catch { /* skip a corrupt line, keep the rest */ }
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  async search(query, { limit = 50 } = {}) {
    const q = String(query || '').toLowerCase();
    if (!q) return [];
    const all = await this.list({ limit: 2000 });
    return all.filter((r) => (r.text || '').toLowerCase().includes(q)).slice(0, limit);
  }

  async stats() {
    const all = await this.list({ limit: 10000 });
    const words = all.reduce((n, r) => n + String(r.text || '').trim().split(/\s+/).filter(Boolean).length, 0);
    const totalMs = all.reduce((n, r) => n + (r.ms || 0), 0);
    // Compared against a sustained 40 wpm of typing, which is a realistic
    // working rate rather than a peak burst.
    const typingMinutes = words / 40;
    return {
      sessions: all.length,
      words,
      avgMs: all.length ? Math.round(totalMs / all.length) : 0,
      estimatedMinutesSaved: Math.max(0, Math.round(typingMinutes - totalMs / 60000))
    };
  }

  /** Deletes everything older than the retention window. */
  async prune() {
    const days = this.config.get('privacy.transcriptRetentionDays', 30);
    if (!days || days <= 0) return { removed: 0 };
    const cutoff = Date.now() - days * 86400000;
    let removed = 0;
    let files;
    try { files = fs.readdirSync(paths.transcripts); } catch { return { removed: 0 }; }
    for (const f of files) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (!m) continue;
      if (new Date(m[1] + 'T00:00:00Z').getTime() < cutoff) {
        try { fs.rmSync(path.join(paths.transcripts, f), { force: true }); removed++; } catch {}
      }
    }
    return { removed };
  }

  /** Irreversibly removes all transcripts and any saved audio. */
  async clearAll() {
    let transcripts = 0;
    let audio = 0;
    try {
      for (const f of fs.readdirSync(paths.transcripts)) {
        fs.rmSync(path.join(paths.transcripts, f), { force: true });
        transcripts++;
      }
    } catch {}
    try {
      for (const f of fs.readdirSync(paths.audio)) {
        fs.rmSync(path.join(paths.audio, f), { force: true });
        audio++;
      }
    } catch {}
    return { transcripts, audio };
  }

  async export(format = 'json') {
    const all = await this.list({ limit: 100000 });
    if (format === 'txt') {
      return all.map((r) => `[${r.at}] ${r.text}`).join('\n');
    }
    if (format === 'csv') {
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const rows = [['at', 'mode', 'text', 'app', 'ms'].join(',')];
      for (const r of all) {
        rows.push([r.at, r.mode, r.text, r.target && r.target.process, r.ms].map(esc).join(','));
      }
      return rows.join('\n');
    }
    return JSON.stringify(all, null, 2);
  }
}

module.exports = { TranscriptStore };
