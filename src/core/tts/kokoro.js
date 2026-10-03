'use strict';
/**
 * Kokoro: the voice that does not sound like a game character.
 *
 * Piper is fast and entirely local, but it is a small vocoder and it sounds
 * like one. Kokoro-82M is a modern neural model under Apache 2.0 — the closest
 * free equivalent of the commercial voices — and it runs on the CPU.
 *
 * The quantisation matters more than it should. Measured on this machine:
 *
 *   q8    3748ms for 2.08s of speech   1.81x realtime
 *   q4    1509ms for 2.08s of speech   0.73x realtime
 *   fp32  1450ms for 2.05s of speech   0.71x realtime
 *
 * q8 is the obvious choice and the wrong one: it is two and a half times
 * slower than q4 here, while fp32 matches q4 for speed and costs several
 * hundred megabytes more memory on a machine that does not have it. So q4.
 *
 * Still about three times slower than Piper, which is why the fixed phrases
 * are pre-rendered at launch: the opening line plays instantly and covers the
 * synthesis of the first real sentence behind it.
 *
 * Loaded lazily and kept resident, because the model load is about ten seconds
 * and must never be paid in front of the user.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { paths } = require('../paths');

/** The voices worth offering, named rather than coded. */
const VOICES = {
  heart:  { id: 'af_heart',   label: 'Heart',  description: 'Female, American, warm — the default' },
  bella:  { id: 'af_bella',   label: 'Bella',  description: 'Female, American, bright and expressive' },
  nicole: { id: 'af_nicole',  label: 'Nicole', description: 'Female, American, soft and close' },
  sarah:  { id: 'af_sarah',   label: 'Sarah',  description: 'Female, American, even and calm' },
  emma:   { id: 'bf_emma',    label: 'Emma',   description: 'Female, British' },
  michael:{ id: 'am_michael', label: 'Michael', description: 'Male, American' },
  george: { id: 'bm_george',  label: 'George', description: 'Male, British' }
};

function resolveVoice(name) {
  const key = String(name || '').toLowerCase();
  if (VOICES[key]) return VOICES[key].id;
  return name || 'af_heart';
}

/** Mirrors the WAV writer the rest of the pipeline expects: 16-bit PCM. */
function writeWav(file, samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

class KokoroTts {
  constructor({ voice = 'af_heart', speed = 1.0, dtype = 'q4', logger = console } = {}) {
    this.voice = resolveVoice(voice);
    this.speed = speed;
    this.dtype = dtype;
    this.logger = logger;

    this.tts = null;
    this.loading = null;
    this.outDir = path.join(paths.tmp, 'kokoro');
    this.cacheDir = path.join(paths.userData, 'tts-cache');
    this.cache = new Map();
    /** Synthesis is serialized: one ONNX session, and order must hold. */
    this.tail = Promise.resolve();
  }

  get running() { return Boolean(this.tts); }

  static available() {
    try { require.resolve('kokoro-js'); return true; } catch { return false; }
  }

  status() {
    const ok = KokoroTts.available();
    return {
      ready: ok,
      engine: 'kokoro',
      voice: this.voice,
      voices: Object.values(VOICES).map((v) => v.id),
      resident: this.running,
      problems: ok ? [] : ['kokoro-js is not installed — run: npm install kokoro-js']
    };
  }

  async start() {
    if (this.tts) return this;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      fs.mkdirSync(this.outDir, { recursive: true });
      const t0 = Date.now();
      // ESM-only, so it cannot be required.
      const { KokoroTTS } = await import('kokoro-js');
      this.tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
        dtype: this.dtype,
        device: 'cpu'
      });
      this.loadCache();
      this.logger.info?.(
        `[kokoro] resident on ${this.voice} (${this.dtype}) in ${Date.now() - t0}ms` +
        (this.cache.size ? `, ${this.cache.size} phrase(s) cached` : '')
      );
      return this;
    })();

    try { return await this.loading; } finally { this.loading = null; }
  }

  cacheKey(text) {
    return crypto.createHash('sha1')
      .update(`kokoro|${this.voice}|${this.speed}|${String(text).trim()}`)
      .digest('hex')
      .slice(0, 16);
  }

  loadCache() {
    this.cache.clear();
    let names;
    try { names = fs.readdirSync(this.cacheDir); } catch { return 0; }
    for (const name of names) {
      if (!name.endsWith('.wav')) continue;
      this.cache.set(name.replace(/\.wav$/, ''), path.join(this.cacheDir, name));
    }
    return this.cache.size;
  }

  cached(text) {
    const key = this.cacheKey(text);
    const file = this.cache.get(key);
    if (!file) return null;
    if (!fs.existsSync(file)) { this.cache.delete(key); return null; }
    return file;
  }

  /**
   * Renders the fixed phrases once.
   *
   * This is what makes a model slower than Piper usable: the lines said most
   * often cost nothing at all after launch, and the opening line plays while
   * the first real sentence is still being synthesized.
   */
  async warmPhrases(lines = []) {
    const wanted = [...new Set(lines.map((l) => String(l || '').trim()).filter(Boolean))];
    if (!wanted.length) return { cached: 0, rendered: 0 };

    await this.start();
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.loadCache();

    let rendered = 0;
    for (const line of wanted) {
      const key = this.cacheKey(line);
      if (this.cache.has(key) && fs.existsSync(this.cache.get(key))) continue;
      try {
        const result = await this.synthesize(line, { cache: false });
        const dest = path.join(this.cacheDir, `${key}.wav`);
        fs.copyFileSync(result.path, dest);
        fs.rmSync(result.path, { force: true });
        this.cache.set(key, dest);
        rendered++;
      } catch (err) {
        this.logger.debug?.(`[kokoro] could not cache "${line}": ${err.message}`);
      }
    }
    return { cached: this.cache.size, rendered };
  }

  async prewarm() {
    try {
      await this.start();
      const t0 = Date.now();
      const r = await this.synthesize('Ready.', { cache: false });
      fs.rmSync(r.path, { force: true });
      this.logger.info?.(`[kokoro] warmed in ${Date.now() - t0}ms`);
    } catch (err) {
      this.logger.warn?.(`[kokoro] could not warm up: ${err.message}`);
    }
  }

  async setVoice(voice, speed) {
    const next = resolveVoice(voice);
    this.voice = next;
    if (speed !== undefined) this.speed = speed;
    // The voice is a per-call argument, so nothing needs reloading; only the
    // cache keys change, which loadCache picks up.
    this.loadCache();
    return this;
  }

  async synthesize(text, { cache = true } = {}) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('Nothing to speak');

    if (cache) {
      const hit = this.cached(clean);
      if (hit) return { path: hit, ms: 0, voice: this.voice, cached: true };
    }

    if (!this.tts) await this.start();

    // One ONNX session, so calls are queued rather than run concurrently.
    const run = this.tail.then(async () => {
      const started = Date.now();
      const audio = await this.tts.generate(clean, { voice: this.voice, speed: this.speed });
      const file = path.join(this.outDir, `k-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
      writeWav(file, audio.audio, audio.sampling_rate);
      return { path: file, ms: Date.now() - started, voice: this.voice };
    });
    // Keep the chain alive even when one utterance fails.
    this.tail = run.then(() => {}, () => {});
    return run;
  }

  async synthesizeBase64(text, opts) {
    const result = await this.synthesize(text, opts);
    try {
      return { ...result, data: fs.readFileSync(result.path).toString('base64') };
    } finally {
      if (!result.cached) fs.rmSync(result.path, { force: true });
    }
  }

  stop() {
    this.tts = null;
  }
}

module.exports = { KokoroTts, VOICES, resolveVoice };
