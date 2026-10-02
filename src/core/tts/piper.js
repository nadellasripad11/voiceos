'use strict';
/**
 * Local text-to-speech via Piper, kept warm.
 *
 * Spawning piper per utterance meant reloading a 60MB model every time, which
 * dominated the measured latency: ~2900ms for a one-line reply, almost all of
 * it startup. Piper reads lines from stdin, writes one WAV per line and prints
 * the path, so one resident process serves every reply and the model is loaded
 * once. Per-line cost drops to roughly the real synthesis time.
 *
 * Entirely local: no API, no key, no per-character billing.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { paths } = require('../paths');

function findPiperExe() {
  if (process.env.VOICEOS_PIPER_EXE && fs.existsSync(process.env.VOICEOS_PIPER_EXE)) {
    return process.env.VOICEOS_PIPER_EXE;
  }
  const root = path.join(paths.vendor, 'piper');
  if (!fs.existsSync(root)) return null;
  const names = ['piper.exe', 'piper'];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (names.includes(e.name.toLowerCase())) return full;
    }
  }
  return null;
}

function findVoice(voiceName) {
  const dir = path.join(paths.models, 'piper');
  const model = path.join(dir, `${voiceName}.onnx`);
  const config = path.join(dir, `${voiceName}.onnx.json`);
  if (fs.existsSync(model) && fs.existsSync(config)) return { model, config };
  return null;
}

function listVoices() {
  const dir = path.join(paths.models, 'piper');
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.onnx')).map((f) => f.replace(/\.onnx$/, ''));
  } catch {
    return [];
  }
}

/**
 * The five voices the product offers, mapped to the closest Piper voice.
 * Jarvis is the British butler delivery, which is what people ask for by name.
 */
const VOICES = {
  jarvis:   { id: 'en_GB-alan-medium',    label: 'Jarvis',   description: 'British, measured, butler delivery' },
  midnight: { id: 'en_GB-northern_english_male-medium', label: 'Midnight', description: 'British, warmer and lower' },
  sky:      { id: 'en_US-amy-medium',     label: 'Sky',      description: 'American, bright and clear' },
  dawn:     { id: 'en_US-lessac-medium',  label: 'Dawn',     description: 'American, even and calm' },
  dusk:     { id: 'en_US-ryan-high',      label: 'Dusk',     description: 'American male, low and steady' }
};

/** Accepts either a friendly name ('jarvis') or a raw Piper voice id. */
function resolveVoice(name) {
  const key = String(name || '').toLowerCase();
  if (VOICES[key]) return VOICES[key].id;
  return name;
}

class PiperTts {
  constructor({ voice = 'jarvis', speed = 1.0, logger = console } = {}) {
    this.voice = resolveVoice(voice);
    this.speed = speed;
    this.logger = logger;

    this.proc = null;
    this.starting = null;
    /** Queued requests, resolved in the order piper emits paths. */
    this.pending = [];
    this.outDir = path.join(paths.tmp, 'tts');
  }

  get running() { return Boolean(this.proc); }

  status() {
    const exe = findPiperExe();
    const voice = findVoice(this.voice);
    return {
      ready: Boolean(exe && voice),
      engine: 'piper',
      exe,
      voice: this.voice,
      voices: listVoices(),
      resident: this.running,
      problems: [
        !exe && 'Piper binary not found — run: npm run setup',
        !voice && `Voice '${this.voice}' not found — run: npm run setup -- --voice ${this.voice}`
      ].filter(Boolean)
    };
  }

  /** Starts the resident process, or returns the one already running. */
  async start() {
    if (this.proc) return this;
    if (this.starting) return this.starting;

    const exe = findPiperExe();
    const voice = findVoice(this.voice);
    if (!exe) throw new Error('Piper is not installed. Run: npm run setup');
    if (!voice) throw new Error(`Piper voice '${this.voice}' is not installed.`);

    this.starting = (async () => {
      fs.mkdirSync(this.outDir, { recursive: true });

      // length_scale is inverse to perceived speed: larger is slower.
      const lengthScale = 1 / Math.max(0.5, Math.min(2, this.speed));

      const proc = spawn(exe, [
        '-m', voice.model,
        '-c', voice.config,
        '--output_dir', this.outDir,
        '--length_scale', lengthScale.toFixed(3),
        // Trim the tail silence piper adds after each sentence; it is dead air
        // between the reply ending and the overlay collapsing.
        '--sentence_silence', '0.1',
        '--quiet'
      ], { windowsHide: true, cwd: path.dirname(exe) });

      // One line of stdout per synthesized utterance: the path it wrote.
      const rl = readline.createInterface({ input: proc.stdout });
      rl.on('line', (line) => {
        const file = line.trim();
        if (!file.toLowerCase().endsWith('.wav')) return;
        const next = this.pending.shift();
        if (next) next.resolve(file);
      });

      proc.stderr.on('data', (d) => {
        const text = String(d).trim();
        if (text) this.logger.debug?.(`[piper] ${text}`);
      });

      proc.on('exit', (code) => {
        this.proc = null;
        // Fail anything still waiting rather than leaving it hanging.
        for (const p of this.pending) p.reject(new Error(`Piper exited (code ${code})`));
        this.pending = [];
        if (code !== 0 && code !== null) this.logger.warn?.(`[piper] exited with code ${code}`);
      });

      proc.on('error', (err) => {
        this.proc = null;
        this.logger.warn?.(`[piper] ${err.message}`);
      });

      this.proc = proc;
      this.logger.info?.(`[piper] resident on ${path.basename(voice.model)}`);
      return this;
    })();

    try { return await this.starting; } finally { this.starting = null; }
  }

  /**
   * Forces the model to load before anyone is waiting on it.
   *
   * Piper loads the voice lazily on its first line, so without this the first
   * reply of the session paid ~2800ms while every later one took ~600ms. The
   * priming line is synthesized and thrown away at launch.
   */
  async prewarm() {
    try {
      await this.start();
      const t0 = Date.now();
      const r = await this.synthesize('Ready.', { timeoutMs: 60000 });
      fs.rmSync(r.path, { force: true });
      this.logger.info?.(`[piper] warmed in ${Date.now() - t0}ms`);
    } catch (err) {
      // Not fatal: the first real reply just pays the load instead.
      this.logger.warn?.(`[piper] could not warm up: ${err.message}`);
    }
  }

  /** Restarts when the voice or speed changes, since both are process flags. */
  async setVoice(voice, speed) {
    const next = resolveVoice(voice);
    const changed = next !== this.voice || (speed !== undefined && speed !== this.speed);
    this.voice = next;
    if (speed !== undefined) this.speed = speed;
    if (changed && this.proc) {
      this.stop();
      await this.prewarm();
    }
    return this;
  }

  /**
   * Renders one line and returns the WAV path.
   *
   * Piper emits paths in the order it receives lines, so requests are matched
   * to outputs by queue position rather than by filename.
   */
  async synthesize(text, { timeoutMs = 30000 } = {}) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('Nothing to speak');

    if (!this.proc) await this.start();

    const started = Date.now();
    const file = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.pending.findIndex((p) => p.timer === timer);
        if (i >= 0) this.pending.splice(i, 1);
        reject(new Error(`Piper did not answer within ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.push({
        timer,
        resolve: (f) => { clearTimeout(timer); resolve(f); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });

      this.proc.stdin.write(clean + '\n');
    });

    return { path: file, ms: Date.now() - started, voice: this.voice };
  }

  /** Renders and returns the audio inline, for handing straight to a renderer. */
  async synthesizeBase64(text, opts) {
    const result = await this.synthesize(text, opts);
    try {
      return { ...result, data: fs.readFileSync(result.path).toString('base64') };
    } finally {
      fs.rmSync(result.path, { force: true });
    }
  }

  stop() {
    if (!this.proc) return;
    try { this.proc.stdin.end(); } catch {}
    const proc = this.proc;
    setTimeout(() => { try { proc.kill(); } catch {} }, 300);
    this.proc = null;
  }
}

/**
 * Splits a reply into speakable sentences.
 *
 * Long replies are synthesized and played a sentence at a time so speech starts
 * after the first one rather than after the whole thing, which is most of the
 * wait on anything longer than a line.
 */
function toSentences(text, { maxChars = 240 } = {}) {
  const clean = speakableSummary(text, { maxChars: Infinity });
  if (!clean) return [];

  const out = [];
  for (const piece of clean.split(/(?<=[.!?])\s+/)) {
    const sentence = piece.trim();
    if (!sentence) continue;
    if (sentence.length <= maxChars) { out.push(sentence); continue; }
    // Over-long sentence: break on clause boundaries so nothing is unbounded.
    let rest = sentence;
    while (rest.length > maxChars) {
      const cut = rest.lastIndexOf(', ', maxChars);
      const at = cut > maxChars * 0.4 ? cut + 1 : maxChars;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

/**
 * Trims a reply down to something worth speaking aloud.
 *
 * Reading a long answer verbatim is tedious and usually unwanted; the screen
 * already has the full text.
 */
function speakableSummary(text, { maxChars = 320 } = {}) {
  if (!text) return '';
  let out = String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/<[^>]+>/g, ' ')            // stray markup, e.g. email addresses in angle brackets
    .replace(/^[\s>*\-#]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (out.length <= maxChars) return out;

  const clipped = out.slice(0, maxChars);
  const lastStop = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('! '), clipped.lastIndexOf('? '));
  return lastStop > maxChars * 0.4 ? clipped.slice(0, lastStop + 1) : clipped.trimEnd() + '…';
}

module.exports = {
  PiperTts, findPiperExe, findVoice, listVoices,
  speakableSummary, toSentences, VOICES, resolveVoice
};
