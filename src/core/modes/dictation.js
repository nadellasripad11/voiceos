'use strict';
/**
 * Dictation Mode: speech in, finished text at the caret.
 *
 * Pipeline: PCM -> trim -> WAV -> Whisper -> deterministic cleanup -> optional
 * LLM polish -> insert into the focused field.
 *
 * Design rule throughout: never lose the user's words. Every optional stage
 * (polish, transcript logging, LLM availability) degrades to "insert what we
 * have" rather than failing the dictation.
 */
const fs = require('fs');
const path = require('path');
const { writeWav, floatToPcm16, trimSilence, TARGET_SAMPLE_RATE } = require('../audio/wav');
const { cleanup, polishWithLlm } = require('./polish');
const { paths } = require('../paths');

class DictationMode {
  constructor({ stt, provider, config, bridge, transcripts, logger = console }) {
    this.stt = stt;
    this.provider = provider;
    this.config = config;
    this.bridge = bridge;
    this.transcripts = transcripts;
    this.logger = logger;
  }

  /**
   * Runs one dictation.
   *
   * @param {Float32Array} samples 16 kHz mono audio
   * @param {object} opts
   * @param {(stage: string, detail?: object) => void} opts.onStage progress for the notch UI
   * @returns {Promise<object>} timings and the text that was inserted
   */
  async run(samples, { onStage = () => {}, sampleRate = TARGET_SAMPLE_RATE, insert = true, signal } = {}) {
    const cfg = this.config.all();
    const t0 = Date.now();
    const timings = {};

    // Capture the target window BEFORE anything else. The notch must not steal
    // focus, but if anything shifts focus later we still know where the text
    // was meant to go.
    let target = null;
    try {
      target = await this.bridge.foregroundWindow();
    } catch (e) {
      this.logger.warn?.(`[dictation] could not read foreground window: ${e.message}`);
    }

    onStage('transcribing');

    // Trim silence so the adaptive audio context can pick a smaller window.
    const trimmed = trimSilence(samples, {
      threshold: cfg.stt.vad.threshold,
      sampleRate
    });
    if (!trimmed.length) {
      return { ok: false, reason: 'silence', text: '', timings, ms: Date.now() - t0 };
    }

    const wavPath = path.join(paths.tmp, `dictation-${Date.now()}.wav`);
    writeWav(wavPath, floatToPcm16(trimmed), { sampleRate });
    timings.prepareMs = Date.now() - t0;

    let stt;
    try {
      const tStt = Date.now();
      stt = await this.stt.transcribe(wavPath, {
        language: cfg.stt.language === 'auto' ? undefined : cfg.stt.language,
        prompt: buildVocabularyPrompt(cfg.dictation.vocabulary),
        signal
      });
      timings.sttMs = Date.now() - tStt;
    } finally {
      // Audio is only kept when the user explicitly opted in.
      if (cfg.privacy.saveAudio && !cfg.privacy.privateMode) {
        const keep = path.join(paths.audio, path.basename(wavPath));
        try { fs.renameSync(wavPath, keep); } catch { fs.rmSync(wavPath, { force: true }); }
      } else {
        fs.rmSync(wavPath, { force: true });
      }
    }

    if (!stt.text) {
      return { ok: false, reason: 'no speech detected', text: '', timings, ms: Date.now() - t0, stt };
    }

    // Deterministic cleanup always runs; it is instant and model-independent.
    const tClean = Date.now();
    let text = cleanup(stt.text, {
      removeFillers: cfg.dictation.removeFillers,
      autoPunctuate: cfg.dictation.autoPunctuate,
      autoCapitalize: cfg.dictation.autoCapitalize,
      vocabulary: cfg.dictation.vocabulary,
      replacements: cfg.dictation.replacements
    });
    timings.cleanupMs = Date.now() - tClean;

    let polished = false;
    if (cfg.dictation.polish && this.provider) {
      onStage('polishing');
      const tPolish = Date.now();
      const result = await polishWithLlm({
        text,
        provider: this.provider,
        model: cfg.llm.model,
        style: cfg.dictation.polishStyle,
        appName: target && (target.process || target.title),
        vocabulary: cfg.dictation.vocabulary,
        logger: this.logger
      });
      text = result.text;
      polished = result.polished;
      timings.polishMs = Date.now() - tPolish;
      if (!result.polished && result.reason) {
        this.logger.debug?.(`[dictation] polish skipped: ${result.reason}`);
      }
    }

    if (cfg.dictation.trailingSpace && text && !/\s$/.test(text)) text += ' ';

    let inserted = false;
    if (insert && text) {
      onStage('inserting');
      const tInsert = Date.now();
      try {
        if (cfg.dictation.insertMode === 'natural') {
          await this.bridge.typeNatural(text, {
            cps: cfg.dictation.typingSpeed || 11,
            signal,
            onProgress: (doneChars, total) => onStage('inserting', { doneChars, total })
          });
        } else {
          await this.bridge.insertText(text, { mode: cfg.dictation.insertMode });
        }
        inserted = true;
      } catch (err) {
        // Falling back to the clipboard means the user can still paste manually
        // rather than losing what they just said.
        this.logger.error?.(`[dictation] insert failed: ${err.message}`);
        try {
          await this.bridge.writeClipboard(text);
          this.logger.warn?.('[dictation] text left on the clipboard — press Ctrl+V to paste');
        } catch {}
      }
      timings.insertMs = Date.now() - tInsert;
    }

    const record = {
      ok: true,
      text,
      raw: stt.text,
      polished,
      inserted,
      target: target && { process: target.process, title: target.title },
      stt: { model: stt.model, language: stt.language, rtf: stt.rtf, audioMs: stt.audioMs },
      timings,
      ms: Date.now() - t0,
      at: new Date().toISOString()
    };

    if (this.transcripts) {
      // Logging is best-effort: a disk problem must not fail the dictation.
      try { await this.transcripts.append(record); }
      catch (e) { this.logger.warn?.(`[dictation] transcript log failed: ${e.message}`); }
    }

    return record;
  }
}

/**
 * Whisper's initial prompt biases decoding. Measured on this machine: supplying
 * the vocabulary took "Remind me to send Maya the deck" from 78% to 100%.
 * Capped because the prompt competes with the audio for context.
 */
function buildVocabularyPrompt(vocabulary = []) {
  if (!vocabulary.length) return undefined;
  const terms = vocabulary.slice(0, 60).join(', ');
  return `Vocabulary: ${terms}.`;
}

module.exports = { DictationMode, buildVocabularyPrompt };
