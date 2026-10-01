'use strict';
/**
 * Speech recognition via a resident whisper.cpp server.
 *
 * Spawning whisper-cli per utterance costs a full model load each time, which
 * on a CPU-only laptop dominated the measured latency (~8s of the ~9s total for
 * a 3-second clip). whisper-server.exe loads the model once at startup and
 * keeps it in memory, so per-utterance cost drops to roughly the real inference
 * time. Same engine, same weights, same $0.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { paths } = require('../paths');
const { findModel, stripNonSpeechMarkers } = require('./whisper');

function findServerExe() {
  if (process.env.VOICEOS_WHISPER_SERVER && fs.existsSync(process.env.VOICEOS_WHISPER_SERVER)) {
    return process.env.VOICEOS_WHISPER_SERVER;
  }
  const root = path.join(paths.vendor, 'whisper');
  if (!fs.existsSync(root)) return null;
  const names = ['whisper-server.exe', 'whisper-server', 'server.exe', 'server'];
  const stack = [root];
  const found = new Map();
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        const lower = e.name.toLowerCase();
        if (names.includes(lower) && !found.has(lower)) found.set(lower, full);
      }
    }
  }
  for (const n of names) if (found.has(n)) return found.get(n);
  return null;
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

class WhisperServerEngine {
  constructor({ model = 'ggml-base.en.bin', language = 'auto', threads = 0, translate = false, logger = console } = {}) {
    this.modelName = model;
    this.language = language;
    this.threads = threads || Math.max(1, Math.min(8, os.cpus().length - 1));
    this.translate = translate;
    this.logger = logger;
    this.proc = null;
    this.port = null;
    this.starting = null;
  }

  get baseUrl() { return this.port ? `http://127.0.0.1:${this.port}` : null; }
  get running() { return Boolean(this.proc && this.port); }

  status() {
    const exe = findServerExe();
    const model = findModel(this.modelName);
    return {
      ready: Boolean(exe && model),
      mode: 'server',
      exe,
      model,
      running: this.running,
      baseUrl: this.baseUrl,
      threads: this.threads,
      problems: [
        !exe && 'whisper-server binary not found — run: npm run setup',
        !model && `model '${this.modelName}' not found — run: npm run setup`
      ].filter(Boolean)
    };
  }

  async start() {
    if (this.running) return this;
    if (this.starting) return this.starting;

    const exe = findServerExe();
    const model = findModel(this.modelName);
    if (!exe) throw new Error('whisper-server binary not found. Run: npm run setup');
    if (!model) throw new Error(`Whisper model '${this.modelName}' not found. Run: npm run setup`);

    this.starting = (async () => {
      const port = await freePort();
      const args = [
        '--host', '127.0.0.1',
        '--port', String(port),
        '-m', model,
        '-t', String(this.threads),
        '-sns'
      ];
      if (this.translate) args.push('-tr');

      this.proc = spawn(exe, args, { windowsHide: true, cwd: path.dirname(exe) });
      this.proc.stdout.on('data', (d) => this.logger.debug?.(`[whisper-server] ${d.toString().trim()}`));
      this.proc.stderr.on('data', (d) => this.logger.debug?.(`[whisper-server] ${d.toString().trim()}`));
      this.proc.on('exit', (code) => {
        if (code !== 0 && code !== null) this.logger.warn?.(`[whisper-server] exited with code ${code}`);
        this.proc = null;
        this.port = null;
      });

      // Loading the weights takes a while on a slow disk; poll until it answers.
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        if (!this.proc) throw new Error('whisper-server exited during startup');
        try {
          const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
          if (res.status < 500) {
            this.port = port;
            this.logger.info?.(`[whisper-server] ready on port ${port} with ${path.basename(model)}`);
            return this;
          }
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      throw new Error('whisper-server did not become ready within 120s');
    })();

    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async transcribe(wavPath, { language, prompt, signal } = {}) {
    if (!this.running) await this.start();
    if (!fs.existsSync(wavPath)) throw new Error(`Audio file not found: ${wavPath}`);

    const started = Date.now();
    const buf = fs.readFileSync(wavPath);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'audio/wav' }), path.basename(wavPath));
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0.0');
    const lang = language || this.language;
    if (lang && lang !== 'auto') form.append('language', lang);
    // Biases decoding toward the user's own vocabulary — names, jargon, product
    // terms — which is what otherwise gets mangled most often.
    if (prompt) form.append('prompt', prompt);

    const res = await fetch(`${this.baseUrl}/inference`, { method: 'POST', body: form, signal });
    if (!res.ok) {
      throw new Error(`whisper-server returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = await res.json();

    const segments = (data.segments || []).map((s) => ({
      text: (s.text || '').trim(),
      from: typeof s.start === 'number' ? Math.round(s.start * 1000) : null,
      to: typeof s.end === 'number' ? Math.round(s.end * 1000) : null
    }));
    const text = (data.text || segments.map((s) => s.text).join(' ')).replace(/\s+/g, ' ').trim();
    const ms = Date.now() - started;
    const audioMs = segments.length ? segments[segments.length - 1].to || 0 : wavDurationMs(buf);

    return {
      text: stripNonSpeechMarkers(text),
      raw: text,
      segments,
      language: data.language || lang,
      ms,
      audioMs,
      rtf: audioMs ? Number((ms / audioMs).toFixed(2)) : null,
      model: path.basename(findModel(this.modelName) || this.modelName)
    };
  }

  stop() {
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
      this.port = null;
    }
  }
}

/** Reads duration straight out of the WAV header, for when no segments come back. */
function wavDurationMs(buf) {
  try {
    const byteRate = buf.readUInt32LE(28);
    // Locate the data chunk rather than assuming the canonical 44-byte header.
    let offset = 12;
    while (offset + 8 <= buf.length) {
      const id = buf.toString('ascii', offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      if (id === 'data') return byteRate ? Math.round((size / byteRate) * 1000) : 0;
      offset += 8 + size + (size % 2);
    }
  } catch {}
  return 0;
}

module.exports = { WhisperServerEngine, findServerExe, wavDurationMs };
