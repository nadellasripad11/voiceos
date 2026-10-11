'use strict';
/**
 * Speech recognition via whisper.cpp.
 *
 * Runs the prebuilt whisper-cli binary against a 16 kHz mono WAV and returns
 * structured text. Entirely local: no network, no API key, no per-minute cost.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { backgroundPriority, workerThreads } = require('../priority');
const { paths } = require('../paths');

// Ordered by preference, not by whatever the directory walk happens to reach
// first. Upstream still ships a deprecated main.exe alongside whisper-cli.exe,
// and main.exe rejects several of the flags used below.
const EXE_CANDIDATES = ['whisper-cli.exe', 'whisper-cli', 'main.exe', 'main'];

function findWhisperExe() {
  if (process.env.VOICEOS_WHISPER_EXE && fs.existsSync(process.env.VOICEOS_WHISPER_EXE)) {
    return process.env.VOICEOS_WHISPER_EXE;
  }
  const root = path.join(paths.vendor, 'whisper');
  if (!fs.existsSync(root)) return null;

  const found = new Map();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        const lower = e.name.toLowerCase();
        if (EXE_CANDIDATES.includes(lower) && !found.has(lower)) found.set(lower, full);
      }
    }
  }
  for (const name of EXE_CANDIDATES) {
    if (found.has(name)) return found.get(name);
  }
  return null;
}

function findModel(modelName) {
  const direct = path.isAbsolute(modelName) ? modelName : path.join(paths.models, modelName);
  if (fs.existsSync(direct)) return direct;
  // Accept short names like 'base.en' as well as full filenames.
  const guess = path.join(paths.models, `ggml-${modelName}.bin`);
  if (fs.existsSync(guess)) return guess;
  return null;
}

class WhisperEngine {
  constructor({
    model = 'ggml-base.en.bin',
    language = 'auto',
    threads = 0,
    translate = false,
    // Decoding strategy. whisper.cpp defaults to beam search (bestOf 5,
    // beamSize 5), which costs several times more compute than greedy decoding
    // for very little gain on short, clean dictation. On a CPU-only machine
    // that difference is the gap between usable and unusable, so greedy is the
    // default here and beam search is opt-in for accuracy-critical work.
    beamSize = 1,
    bestOf = 1,
    noFallback = true,
    // Whisper always pads audio to a 30s window, so a 3s utterance makes the
    // encoder chew through 27s of silence. Shrinking the audio context skips
    // that work and measured 2x faster here. 'auto' sizes it per clip, because
    // a fixed small value silently truncates anything longer than it covers.
    audioCtx = 'auto',
    logger = console
  } = {}) {
    this.modelName = model;
    this.language = language;
    this.threads = threads || workerThreads();
    this.translate = translate;
    this.beamSize = beamSize;
    this.bestOf = bestOf;
    this.noFallback = noFallback;
    this.audioCtx = audioCtx;
    this.logger = logger;
  }

  /**
   * Sizes the encoder's audio context to the clip.
   *
   * Whisper's encoder covers 30s in 1500 frames, i.e. 50 frames per second. Any
   * context smaller than the clip needs will cut the audio off, so this adds
   * headroom and never goes below a floor where quality starts to suffer.
   * Returns 0 (full context) when the duration cannot be determined, because
   * guessing low would lose the user's words.
   */
  resolveAudioCtx(wavPath) {
    if (this.audioCtx !== 'auto') return Number(this.audioCtx) || 0;
    const ms = readWavDurationMs(wavPath);
    if (!ms) return 0;
    const FRAMES_PER_SECOND = 50;
    const MAX = 1500;
    const needed = Math.ceil(((ms / 1000) + 2) * FRAMES_PER_SECOND);
    if (needed >= MAX) return 0; // full context; no saving available anyway
    return Math.max(512, Math.min(MAX, Math.ceil(needed / 128) * 128));
  }

  /** Reports what is and is not installed, for Settings and `npm run doctor`. */
  status() {
    const exe = findWhisperExe();
    const model = findModel(this.modelName);
    return {
      ready: Boolean(exe && model),
      exe,
      model,
      threads: this.threads,
      problems: [
        !exe && 'whisper.cpp binary not found — run: npm run setup',
        !model && `model '${this.modelName}' not found in models/ — run: npm run setup -- --model base.en`
      ].filter(Boolean)
    };
  }

  /**
   * Transcribes a 16 kHz mono WAV file.
   * @returns {Promise<{text: string, segments: Array, language: string, ms: number, rtf: number}>}
   */
  async transcribe(wavPath, { language, prompt, onProgress, signal } = {}) {
    const exe = findWhisperExe();
    const model = findModel(this.modelName);
    if (!exe) throw new Error('whisper.cpp binary not found. Run: npm run setup');
    if (!model) throw new Error(`Whisper model '${this.modelName}' not found. Run: npm run setup`);
    if (!fs.existsSync(wavPath)) throw new Error(`Audio file not found: ${wavPath}`);

    const lang = language || this.language;
    const outBase = path.join(paths.tmp, `stt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    const args = [
      '-m', model,
      '-f', wavPath,
      '-t', String(this.threads),
      '-oj',                 // emit JSON next to -of
      '-of', outBase,
      '-np',                 // suppress the banner so stderr stays meaningful
      '-sns',                // suppress non-speech tokens at the decoder level
      '-bs', String(this.beamSize),
      '-bo', String(this.bestOf),
      '-l', lang === 'auto' ? 'auto' : lang
    ];
    if (this.noFallback) args.push('-nf');
    const ac = this.resolveAudioCtx(wavPath);
    if (ac > 0) args.push('-ac', String(ac));
    if (this.translate) args.push('-tr');
    // A prompt biases decoding toward the user's own vocabulary (names, jargon).
    if (prompt) args.push('--prompt', prompt);

    const started = Date.now();
    const stderr = await new Promise((resolve, reject) => {
      const child = spawn(exe, args, { windowsHide: true });
      backgroundPriority(child.pid);
      let err = '';

      child.stdout.on('data', (d) => {
        const s = d.toString();
        if (onProgress) onProgress(s);
      });
      child.stderr.on('data', (d) => {
        const s = d.toString();
        err += s;
        if (onProgress) onProgress(s);
      });

      const onAbort = () => { try { child.kill(); } catch {} };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', reject);
      child.on('close', (code) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (signal && signal.aborted) return reject(new Error('Transcription cancelled'));
        if (code !== 0) return reject(new Error(`whisper.cpp exited with code ${code}: ${err.slice(-600)}`));
        resolve(err);
      });
    });

    const jsonPath = `${outBase}.json`;
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (e) {
      throw new Error(`whisper.cpp produced no readable JSON at ${jsonPath}. stderr tail: ${stderr.slice(-400)}`);
    } finally {
      fs.rmSync(jsonPath, { force: true });
    }

    const segments = (parsed.transcription || []).map((s) => ({
      text: (s.text || '').trim(),
      from: s.offsets ? s.offsets.from : null,
      to: s.offsets ? s.offsets.to : null
    }));

    const text = segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
    const ms = Date.now() - started;
    const audioMs = segments.length ? segments[segments.length - 1].to || 0 : 0;

    return {
      text: stripNonSpeechMarkers(text),
      raw: text,
      segments,
      language: (parsed.result && parsed.result.language) || lang,
      ms,
      audioMs,
      // Real-time factor: below 1.0 means faster than the audio it transcribed.
      rtf: audioMs ? Number((ms / audioMs).toFixed(2)) : null,
      model: path.basename(model)
    };
  }
}

/**
 * Whisper emits bracketed annotations for non-speech audio, e.g. "[BLANK_AUDIO]"
 * or "(music playing)". These are never something the user said, so they must
 * not be typed into their document.
 */
function stripNonSpeechMarkers(text) {
  return text
    .replace(/\[(BLANK_AUDIO|INAUDIBLE|MUSIC|SILENCE|NOISE|SOUND)[^\]]*\]/gi, '')
    .replace(/\((music|laughter|applause|silence|inaudible)[^)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Reads duration straight from the WAV header, locating the data chunk properly. */
function readWavDurationMs(wavPath) {
  let fd;
  try {
    fd = fs.openSync(wavPath, 'r');
    const header = Buffer.alloc(4096);
    const read = fs.readSync(fd, header, 0, header.length, 0);
    if (read < 44 || header.toString('ascii', 0, 4) !== 'RIFF') return 0;
    const byteRate = header.readUInt32LE(28);
    if (!byteRate) return 0;
    let offset = 12;
    while (offset + 8 <= read) {
      const id = header.toString('ascii', offset, offset + 4);
      const size = header.readUInt32LE(offset + 4);
      if (id === 'data') {
        // A streamed WAV can carry a placeholder size, so fall back to the
        // actual file length in that case.
        const actual = fs.fstatSync(fd).size - (offset + 8);
        const bytes = size > 0 && size <= actual ? size : actual;
        return Math.round((bytes / byteRate) * 1000);
      }
      offset += 8 + size + (size % 2);
    }
    return 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

module.exports = { WhisperEngine, findWhisperExe, findModel, stripNonSpeechMarkers, readWavDurationMs };
