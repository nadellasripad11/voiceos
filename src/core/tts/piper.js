'use strict';
/**
 * Local text-to-speech via Piper.
 *
 * Runs entirely on this machine: no API, no key, no per-character billing.
 * Piper writes a WAV, which the renderer plays, so playback stays in the
 * browser audio stack rather than needing a native audio dependency.
 */
const fs = require('fs');
const path = require('path');
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

/** Voices present on disk, for the Settings picker. */
function listVoices() {
  const dir = path.join(paths.models, 'piper');
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.onnx'))
      .map((f) => f.replace(/\.onnx$/, ''));
  } catch {
    return [];
  }
}

class PiperTts {
  constructor({ voice = 'en_US-amy-medium', speed = 1.0, logger = console } = {}) {
    this.voice = voice;
    this.speed = speed;
    this.logger = logger;
  }

  status() {
    const exe = findPiperExe();
    const voice = findVoice(this.voice);
    return {
      ready: Boolean(exe && voice),
      engine: 'piper',
      exe,
      voice: this.voice,
      voices: listVoices(),
      problems: [
        !exe && 'Piper binary not found — run: npm run setup',
        !voice && `Voice '${this.voice}' not found — run: npm run setup -- --voice ${this.voice}`
      ].filter(Boolean)
    };
  }

  /**
   * Renders text to a WAV file and returns its path.
   *
   * @param {string} text
   * @param {object} opts
   * @param {number} opts.speed  1 is the voice's natural rate; higher is slower
   *                             because Piper expresses it as length scale.
   */
  async synthesize(text, { speed, signal } = {}) {
    const exe = findPiperExe();
    const voice = findVoice(this.voice);
    if (!exe) throw new Error('Piper is not installed. Run: npm run setup');
    if (!voice) throw new Error(`Piper voice '${this.voice}' is not installed.`);

    const clean = String(text || '').trim();
    if (!clean) throw new Error('Nothing to speak');

    const outPath = path.join(paths.tmp, `tts-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.wav`);
    // Piper's length_scale is inverse to perceived speed: larger is slower.
    const lengthScale = 1 / Math.max(0.5, Math.min(2, speed ?? this.speed));

    const args = [
      '--model', voice.model,
      '--config', voice.config,
      '--output_file', outPath,
      '--length_scale', lengthScale.toFixed(3)
    ];

    const started = Date.now();
    await new Promise((resolve, reject) => {
      const child = spawn(exe, args, { windowsHide: true, cwd: path.dirname(exe) });
      let stderr = '';

      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (signal && signal.aborted) return reject(new Error('Speech cancelled'));
        if (code !== 0) return reject(new Error(`Piper exited with code ${code}: ${stderr.slice(-400)}`));
        resolve();
      });

      if (signal) signal.addEventListener('abort', () => { try { child.kill(); } catch {} }, { once: true });

      // Piper reads the line to speak from stdin.
      child.stdin.write(clean.replace(/\s+/g, ' ') + '\n');
      child.stdin.end();
    });

    if (!fs.existsSync(outPath)) throw new Error('Piper produced no audio file');
    return { path: outPath, ms: Date.now() - started, voice: this.voice };
  }

  /** Renders and returns the audio inline, for handing straight to a renderer. */
  async synthesizeBase64(text, opts) {
    const result = await this.synthesize(text, opts);
    try {
      const data = fs.readFileSync(result.path).toString('base64');
      return { ...result, data };
    } finally {
      fs.rmSync(result.path, { force: true });
    }
  }
}

/**
 * Trims a reply down to something worth speaking aloud.
 *
 * Reading a long answer verbatim is tedious and usually unwanted; the screen
 * already has the full text. This keeps the opening sentences and drops
 * anything that only makes sense visually.
 */
function speakableSummary(text, { maxChars = 320 } = {}) {
  if (!text) return '';
  let out = String(text)
    .replace(/```[\s\S]*?```/g, ' ')          // code blocks
    .replace(/`([^`]+)`/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^[\s>*\-#]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (out.length <= maxChars) return out;

  // Cut on a sentence boundary rather than mid-word.
  const clipped = out.slice(0, maxChars);
  const lastStop = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('! '), clipped.lastIndexOf('? '));
  return lastStop > maxChars * 0.4 ? clipped.slice(0, lastStop + 1) : clipped.trimEnd() + '…';
}

module.exports = { PiperTts, findPiperExe, findVoice, listVoices, speakableSummary };
