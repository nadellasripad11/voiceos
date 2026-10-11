'use strict';
/**
 * Transcription on Groq, with the local engine behind it.
 *
 * Local whisper.cpp on this laptop is two seconds of every core for a short
 * sentence, and that burst is what made everything else stutter whenever the
 * user spoke. Groq runs whisper-large-v3-turbo — a far larger, more accurate
 * model than the base.en that fits here — on its own hardware, and the laptop
 * only uploads a few hundred kilobytes.
 *
 * What leaves the machine: the clip of one request, after the wake word or a
 * hotkey. Never the always-on stream; the wake word stays local. Set
 * stt.cloud to '' to keep every word on the laptop.
 *
 * Free tier: 2,000 clips and 8 hours of audio a day, against ~15 clips on the
 * heaviest day in the logs. When it is out anyway — rate limit, no network,
 * key revoked — the local engine answers instead, so the worst case is the
 * old speed rather than not being heard.
 */
const fs = require('fs');
const { stripNonSpeechMarkers, readWavDurationMs } = require('./whisper');

/**
 * What large Whisper models say when there is nothing to hear.
 *
 * Measured: two seconds of silence sent to Groq came back as "Thank you.",
 * with a no-speech probability of exactly 0 — so Whisper's usual confidence
 * test is useless here. Clips are trimmed of silence before they are sent,
 * so this only arises from a cough or a door; but when it does, the agent
 * would answer a sentence nobody said.
 *
 * A match is not thrown away — "thank you" is a real thing to say to Jarvis —
 * it is checked against the local engine, which returns nothing for silence.
 */
const PHANTOM = /^(?:thank you(?: (?:so much|very much|for watching|for listening))?|thanks(?: for watching)?|you|bye|\.+|please subscribe.*|subtitles by.*)[.!]?$/i;

/** Seconds from a 429's retry-after header, as milliseconds. */
function retryAfterMs(res) {
  const v = Number(res.headers.get('retry-after'));
  return Number.isFinite(v) && v >= 0 ? Math.ceil(v * 1000) : null;
}

class GroqWhisper {
  constructor({ apiKey = '', model = 'whisper-large-v3-turbo', language = 'en', timeoutMs = 6000,
    baseUrl = 'https://api.groq.com/openai/v1' } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.language = language;
    // A clip is a few hundred kilobytes and Groq answers in well under a
    // second; six seconds means the network is the problem, and the local
    // engine is quicker than waiting longer.
    this.timeoutMs = timeoutMs;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  status() {
    return {
      ready: Boolean(this.apiKey),
      engine: 'groq',
      model: this.model,
      problems: this.apiKey ? [] : ['No Groq key, so transcription stays local.']
    };
  }

  async transcribe(wavPath, { language, prompt, signal } = {}) {
    const started = Date.now();
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(wavPath)], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', this.model);
    // verbose_json, for the per-segment confidence the silence test needs.
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    const lang = language || this.language;
    if (lang && lang !== 'auto') form.append('language', lang);
    // Same vocabulary hint the local engine gets: names and commands it
    // would otherwise spell like ordinary words.
    if (prompt) form.append('prompt', prompt.slice(0, 800));

    const deadline = AbortSignal.timeout(this.timeoutMs);
    const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      const err = new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
      err.status = res.status;
      err.retryAfterMs = retryAfterMs(res);
      throw err;
    }

    const data = await res.json();
    const segments = Array.isArray(data.segments) ? data.segments : [];
    const raw = data.text || segments.map((seg) => seg.text).join('');
    const ms = Date.now() - started;
    const audioMs = readWavDurationMs(wavPath);
    return {
      text: stripNonSpeechMarkers(raw),
      segments,
      language: data.language || lang,
      ms,
      rtf: audioMs ? ms / audioMs : 0,
      engine: 'groq'
    };
  }
}

/**
 * Groq first, local behind it: the shape the rest of the app already talks
 * to (transcribe and status), so nothing upstream needs to know which one
 * answered.
 */
class CloudFirstStt {
  constructor({ cloud = null, local, logger = console } = {}) {
    this.cloud = cloud;
    this.local = local;
    this.logger = logger;
    /** Until when the cloud is skipped after it said no. */
    this.coolUntil = 0;
  }

  get modelName() { return this.local.modelName; }
  get threads() { return this.local.threads; }

  status() {
    const local = this.local.status();
    const cloudReady = Boolean(this.cloud && this.cloud.status().ready);
    return {
      ...local,
      // Either one is enough to hear the user.
      ready: local.ready || cloudReady,
      cloud: cloudReady ? this.cloud.model : null,
      problems: local.ready || cloudReady ? [] : local.problems
    };
  }

  async transcribe(wavPath, opts = {}) {
    if (this.cloud && this.cloud.status().ready && Date.now() >= this.coolUntil) {
      try {
        const heard = await this.cloud.transcribe(wavPath, opts);
        if (!PHANTOM.test(heard.text.trim())) return heard;
        const check = await this.local.transcribe(wavPath, opts);
        this.logger.info?.(`[stt] groq heard "${heard.text}"; local heard "${check.text}" — keeping local`);
        return { ...check, engine: 'local (checked)' };
      } catch (err) {
        // The user cancelled: that is not the cloud failing.
        if (opts.signal && opts.signal.aborted) throw err;
        // Stop asking for a while when asking again cannot help: out of quota
        // until the limit resets, a key that is wrong, a network that timed
        // out. Every skipped attempt is time the user is not kept waiting.
        const timedOut = err.name === 'TimeoutError' || /timeout|aborted/i.test(err.message);
        const pause = err.status === 429 ? Math.min(err.retryAfterMs || 60000, 10 * 60000)
          : err.status === 401 || err.status === 403 ? 10 * 60000
            : timedOut ? 60000
              : 15000;
        this.coolUntil = Date.now() + pause;
        this.logger.warn?.(`[stt] groq could not transcribe (${err.message.slice(0, 120)}); ` +
          `using the local engine for the next ${Math.round(pause / 1000)}s`);
      }
    }
    const result = await this.local.transcribe(wavPath, opts);
    return { ...result, engine: 'local' };
  }
}

module.exports = { GroqWhisper, CloudFirstStt, PHANTOM };
