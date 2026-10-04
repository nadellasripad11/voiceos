'use strict';
/**
 * A fast brain with a local one behind it.
 *
 * Groq is free and roughly ten times quicker than a 1.5B model on this
 * machine, but it is a hosted service: it needs the internet, its free tier
 * has rate limits, and both of those fail at the worst moment rather than at a
 * convenient one. Ollama is slow but it is here, and it works on a train.
 *
 * So neither replaces the other. The quick one is tried first and the local
 * one catches it, which means adding a key costs nothing and removes nothing.
 *
 * What it falls back on matters. A model that answers "I don't know" has
 * worked — asking a second model the same question would be a different
 * answer, not a better one, and would hide the first one's judgement. Only a
 * failure to get an answer at all is worth retrying: no key, no network, rate
 * limited, server error.
 */
const { LlmProvider } = require('./provider');

/** Failures that mean "ask someone else", as opposed to "that is the answer". */
function worthRetrying(err) {
  const m = String((err && err.message) || '').toLowerCase();
  return (
    /no .* api key|unauthor|forbidden|401|403/.test(m) ||      // not set up
    /429|rate.?limit|quota|too many requests/.test(m) ||       // out of allowance
    /50\d|bad gateway|unavailable|overloaded/.test(m) ||       // their end
    /fetch failed|network|econn|enotfound|etimedout|timeout|abort/.test(m) // ours
  );
}

class FallbackProvider extends LlmProvider {
  /**
   * @param {object} opts
   * @param {LlmProvider} opts.primary tried first
   * @param {LlmProvider} opts.secondary used when the first cannot answer
   */
  constructor({ primary, secondary, secondaryModel = null, logger = console } = {}) {
    super({ logger });
    this.primary = primary;
    this.secondary = secondary;
    // Model names are not portable: a Groq model id means nothing to Ollama,
    // so the pair carries the one its fallback understands.
    this.secondaryModel = secondaryModel;
    this.logger = logger;
    /** Which one answered last, for the model name on the result. */
    this.lastUsed = null;
  }

  get name() { return `${this.primary.name}+${this.secondary.name}`; }

  /** Streams only if both do, so a fallback cannot change mid-reply. */
  get streams() { return Boolean(this.primary.streams && this.secondary.streams); }

  async available() {
    if (await this.primary.available().catch(() => false)) return true;
    return this.secondary.available().catch(() => false);
  }

  async listModels() {
    try { return await this.primary.listModels(); }
    catch { return this.secondary.listModels().catch(() => []); }
  }

  /** Only the local one has anything to load. */
  async warm(model, opts) {
    if (typeof this.secondary.warm === 'function') {
      return this.secondary.warm(this.secondaryModel || model, opts);
    }
    return false;
  }

  async chat(req) {
    // The model name belongs to whichever provider is being asked, so each
    // gets its own: a Groq model id means nothing to Ollama.
    const primaryModel = req.primaryModel || req.model;
    const secondaryModel = req.secondaryModel || this.secondaryModel || req.model;

    try {
      const res = await this.primary.chat({ ...req, model: primaryModel });
      this.lastUsed = this.primary.name;
      return res;
    } catch (err) {
      if (!worthRetrying(err)) throw err;
      this.logger.info?.(`[llm] ${this.primary.name} could not answer (${err.message.slice(0, 60)}); using ${this.secondary.name}`);

      // A partial reply may already have been spoken, so the fallback starts
      // again from the beginning rather than continuing someone else's
      // sentence. The caller is told to discard what it had.
      if (req.onToken) req.onToken('', '', { restart: true });

      const res = await this.secondary.chat({ ...req, model: secondaryModel });
      this.lastUsed = this.secondary.name;
      return res;
    }
  }
}

module.exports = { FallbackProvider, worthRetrying };
