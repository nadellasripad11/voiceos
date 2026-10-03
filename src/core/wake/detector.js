'use strict';
/**
 * "Hey Jarvis" — listening for its name without burning the machine.
 *
 * Transcribing everything the microphone hears, continuously, with Whisper
 * would work and would be a terrible idea: it would cost a core to run and
 * would send every word spoken near the machine through a speech recogniser.
 *
 * openWakeWord does the job properly. It is three small ONNX models in a
 * chain, about 3.6MB in total, designed to run on a Raspberry Pi:
 *
 *   audio  -> melspectrogram  -> mel frames
 *   mels   -> embedding model -> a 96-number summary of 76 frames
 *   embeds -> "hey jarvis"    -> how much the last 16 embeddings sound like it
 *
 * Only the last stage knows what the wake word is; the first two are generic.
 * Nothing is recognised, stored or sent anywhere — the audio becomes numbers
 * immediately and the numbers are thrown away as the window slides.
 *
 * Audio arrives as 16kHz mono, 1280 samples (80ms) at a time, which is the
 * frame size the embedding model was trained against.
 */
const fs = require('fs');
const path = require('path');

const FRAME = 1280;             // 80ms at 16kHz
const MEL_WINDOW = 76;          // mel frames the embedding model expects
const MEL_BINS = 32;
const EMBED_WINDOW = 16;        // embeddings the wake model expects
const MELS_PER_FRAME = 5;       // mel frames one 80ms audio frame produces
const MEL_STRIDE = 8;           // mel frames between consecutive embeddings
const EMBED_SIZE = 96;

class WakeDetector {
  /**
   * @param {object} opts
   * @param {string} opts.modelDir where the three .onnx files live
   * @param {string} [opts.word] which wake model to load
   * @param {number} [opts.threshold] score above which it counts as heard
   * @param {number} [opts.refractoryMs] silence after a hit, so one phrase
   *   does not fire several times as the window slides over it
   */
  constructor({ modelDir, word = 'hey_jarvis_v0.1', threshold = 0.5, refractoryMs = 2500, logger = console } = {}) {
    this.modelDir = modelDir;
    this.word = word;
    this.threshold = threshold;
    this.refractoryMs = refractoryMs;
    this.logger = logger;

    this.sessions = null;
    this.loading = null;

    /** Leftover audio that did not fill a frame. */
    this.pending = new Float32Array(0);
    /** Rolling mel frames and embeddings. */
    this.mels = [];
    this.embeds = [];
    this.melsSinceEmbed = 0;
    this.lastHit = 0;
    this.lastScore = 0;
  }

  static modelsPresent(dir) {
    return ['melspectrogram.onnx', 'embedding_model.onnx'].every((f) => fs.existsSync(path.join(dir, f)));
  }

  available() {
    try { require.resolve('onnxruntime-node'); } catch { return false; }
    return WakeDetector.modelsPresent(this.modelDir) &&
      fs.existsSync(path.join(this.modelDir, `${this.word}.onnx`));
  }

  async load() {
    if (this.sessions) return this.sessions;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const ort = require('onnxruntime-node');
      const t0 = Date.now();
      const open = (f) => ort.InferenceSession.create(path.join(this.modelDir, f), {
        // One thread each: this runs forever in the background and must not
        // compete with transcription or speech for cores.
        intraOpNumThreads: 1,
        interOpNumThreads: 1
      });
      const [mel, embed, wake] = await Promise.all([
        open('melspectrogram.onnx'),
        open('embedding_model.onnx'),
        open(`${this.word}.onnx`)
      ]);
      this.ort = ort;
      this.sessions = { mel, embed, wake };
      this.logger.info?.(`[wake] "${this.word.replace(/_v.*$/, '').replace(/_/g, ' ')}" listening (${Date.now() - t0}ms)`);
      return this.sessions;
    })();

    try { return await this.loading; } finally { this.loading = null; }
  }

  /**
   * Feeds audio and returns a score when there is a complete window.
   *
   * @param {Float32Array} samples 16kHz mono, any length
   * @returns {Promise<{score: number, hit: boolean}>}
   */
  async push(samples) {
    if (!this.sessions) await this.load();
    const { mel, embed, wake } = this.sessions;
    const ort = this.ort;

    // Join whatever is left over from last time.
    const joined = new Float32Array(this.pending.length + samples.length);
    joined.set(this.pending, 0);
    joined.set(samples, this.pending.length);

    let offset = 0;
    while (joined.length - offset >= FRAME) {
      const frame = joined.subarray(offset, offset + FRAME);
      offset += FRAME;

      // 1. Mels. The model wants the raw 16-bit range, not normalised floats.
      const pcm = new Float32Array(FRAME);
      for (let i = 0; i < FRAME; i++) pcm[i] = frame[i] * 32767;
      const melOut = await mel.run({ input: new ort.Tensor('float32', pcm, [1, FRAME]) });
      const melData = melOut[mel.outputNames[0]].data;

      // openWakeWord applies this transform before the embedding model; it is
      // part of the model chain rather than a choice.
      for (let i = 0; i < melData.length; i += MEL_BINS) {
        const row = new Float32Array(MEL_BINS);
        for (let b = 0; b < MEL_BINS; b++) row[b] = melData[i + b] / 10 + 2;
        this.mels.push(row);
      }
      this.melsSinceEmbed += MELS_PER_FRAME;
      if (this.mels.length > MEL_WINDOW * 2) this.mels = this.mels.slice(-MEL_WINDOW * 2);

      // 2. Embeddings, every MEL_STRIDE mel frames.
      //
      // The stride matters and is not a free choice: the wake model was
      // trained on embeddings eight mel frames apart, so sixteen of them span
      // about 1.6 seconds — the length of the spoken phrase. Computing one per
      // audio frame instead, as five-frame steps, makes the same words look
      // time-compressed to the model and the score never leaves zero.
      let computed = false;
      while (this.melsSinceEmbed >= MEL_STRIDE && this.mels.length >= MEL_WINDOW) {
        this.melsSinceEmbed -= MEL_STRIDE;
        const window = this.mels.slice(-MEL_WINDOW);
        const flat = new Float32Array(MEL_WINDOW * MEL_BINS);
        for (let r = 0; r < MEL_WINDOW; r++) flat.set(window[r], r * MEL_BINS);
        const embedOut = await embed.run({
          input_1: new ort.Tensor('float32', flat, [1, MEL_WINDOW, MEL_BINS, 1])
        });
        this.embeds.push(Float32Array.from(embedOut[embed.outputNames[0]].data));
        computed = true;
      }
      if (this.embeds.length > EMBED_WINDOW * 2) this.embeds = this.embeds.slice(-EMBED_WINDOW * 2);

      // 3. The wake model, once there are enough embeddings.
      if (!computed || this.embeds.length < EMBED_WINDOW) continue;
      const recent = this.embeds.slice(-EMBED_WINDOW);
      const stacked = new Float32Array(EMBED_WINDOW * EMBED_SIZE);
      for (let r = 0; r < EMBED_WINDOW; r++) stacked.set(recent[r], r * EMBED_SIZE);
      const wakeOut = await wake.run({
        'x.1': new ort.Tensor('float32', stacked, [1, EMBED_WINDOW, EMBED_SIZE])
      });
      const score = wakeOut[wake.outputNames[0]].data[0];
      this.lastScore = score;

      if (score >= this.threshold) {
        const now = Date.now();
        // One spoken phrase covers several windows, so it would otherwise
        // fire repeatedly as the window slides across it.
        if (now - this.lastHit > this.refractoryMs) {
          this.lastHit = now;
          this.reset();
          this.pending = new Float32Array(0);
          return { score, hit: true };
        }
      }
    }

    this.pending = joined.slice(offset);
    return { score: this.lastScore, hit: false };
  }

  /** Forgets the rolling windows, so a new phrase starts clean. */
  reset() {
    this.mels = [];
    this.embeds = [];
    this.melsSinceEmbed = 0;
    // Including the last score: it is reported back on frames that are still
    // filling the window, and a stale one reads as a detection that never
    // happened.
    this.lastScore = 0;
  }

  close() {
    this.sessions = null;
    this.reset();
    this.pending = new Float32Array(0);
  }
}

module.exports = { WakeDetector, FRAME };
