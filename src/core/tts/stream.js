'use strict';
/**
 * Speaks a reply while it is still being written.
 *
 * The model streams text at roughly 90ms to the first token but takes a second
 * or two to finish, and synthesis of a whole paragraph is slower still. Waiting
 * for both means several seconds of silence. Feeding the running text in here
 * instead means the first sentence is spoken as soon as it is complete, and the
 * rest follows behind the model.
 *
 * Order matters more than throughput: a reply read out of order is worse than a
 * slow one, so synthesis is strictly serialized even though Piper could be
 * asked for the next sentence sooner.
 */
const { speakableSummary } = require('./piper');

/** Sentence end followed by whitespace: the point at which a clause is safe to read. */
const BOUNDARY = /[.!?](?:["'’”)\]]+)?(?=\s)/g;

/**
 * The longest prefix of `text` that ends on a sentence boundary.
 * Returns 0 when nothing is complete yet, so the caller keeps waiting.
 */
function completeLength(text) {
  BOUNDARY.lastIndex = 0;
  let end = 0;
  let m;
  while ((m = BOUNDARY.exec(text)) !== null) end = m.index + m[0].length;
  return end;
}

class SpeechStream {
  /**
   * @param {object} opts
   * @param {{synthesizeBase64: Function}} opts.tts
   * @param {(clip: {data: string, voice: string, seq: number}) => void} opts.emit
   * @param {number} [opts.maxChars] how much of a long reply to read aloud
   *   before stopping. The full text is on screen; reading an essay is not what
   *   anyone wants.
   * @param {number} [opts.minFirstChars] a very short opening fragment ("Yes.")
   *   is held back briefly so the first clip is not a single word.
   */
  constructor({ tts, emit, maxChars = 320, minFirstChars = 24, speed, logger = console } = {}) {
    this.tts = tts;
    this.emit = emit;
    this.maxChars = maxChars;
    this.minFirstChars = minFirstChars;
    this.speed = speed;
    this.logger = logger;

    /** Characters of the incoming text already handed to synthesis. */
    this.consumed = 0;
    /** Characters actually spoken, against which maxChars is measured. */
    this.spokenChars = 0;
    this.seq = 0;
    this.cancelled = false;
    /** Bumped by reset(), so clips queued under an abandoned text are dropped. */
    this.generation = 0;
    /** Serializes synthesis so clips are emitted in order. */
    this.tail = Promise.resolve();
  }

  /**
   * Forgets everything fed so far.
   *
   * The model sometimes writes a line of preamble and then decides to call a
   * tool instead, which retracts what it wrote. Without this the character
   * offset would still point into the abandoned text, so the real answer would
   * be sliced from the wrong place and read out mangled.
   */
  reset() {
    this.consumed = 0;
    this.spokenChars = 0;
    this.generation++;
  }

  /** Feed the running text; speaks whatever sentences are now complete. */
  push(full) {
    if (this.cancelled) return;
    const text = String(full || '');
    if (text.length <= this.consumed) return;

    const rest = text.slice(this.consumed);
    const end = completeLength(rest);
    if (!end) return;
    // Hold back a one-word opener so the first clip is worth playing.
    if (this.seq === 0 && end < this.minFirstChars && text.length - this.consumed < this.minFirstChars * 2) return;

    this.consumed += end;
    this.enqueue(rest.slice(0, end));
  }

  /** Speaks whatever is left and resolves once every clip has been emitted. */
  async finish(full) {
    if (!this.cancelled) {
      const text = String(full || '');
      if (text.length > this.consumed) {
        const rest = text.slice(this.consumed);
        this.consumed = text.length;
        this.enqueue(rest);
      }
    }
    await this.tail.catch(() => {});
    return this.seq;
  }

  /** Stops at the next clip boundary; anything already playing is the caller's. */
  cancel() {
    this.cancelled = true;
  }

  enqueue(chunk) {
    const line = speakableSummary(chunk, { maxChars: Infinity });
    if (!line) return;
    if (this.spokenChars >= this.maxChars) return;

    // Count the budget at queue time, not at synthesis time, or several
    // sentences queued together would all pass the check.
    this.spokenChars += line.length;
    const seq = this.seq++;
    const gen = this.generation;

    this.tail = this.tail.then(async () => {
      if (this.cancelled || gen !== this.generation) return;
      try {
        const audio = await this.tts.synthesizeBase64(line, { speed: this.speed });
        if (this.cancelled || gen !== this.generation) return;
        this.emit({ data: audio.data, voice: audio.voice, seq });
      } catch (err) {
        // Never fatal: the answer is already on screen.
        this.logger.warn?.(`[tts] ${err.message}`);
      }
    });
  }
}

module.exports = { SpeechStream, completeLength };
