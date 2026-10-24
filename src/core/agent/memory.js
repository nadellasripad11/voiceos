'use strict';
/**
 * What Jarvis remembers about the user, across conversations.
 *
 * Learnt as it goes: after each exchange worth learning from, a short model
 * call pulls out anything durable — people, preferences, plans, routines —
 * and merges it in, replacing what it contradicts. The user can also say
 * "remember that...", ask what is remembered, or say "forget...".
 *
 * Kept on this laptop only (memory.json in the app's data folder), and fed
 * back into every conversation so it does not have to be repeated.
 *
 * Never stored: passwords, PINs, codes, card or account numbers, ID numbers.
 * The extraction is told so, and anything that looks like one is dropped
 * again here regardless, because a rule the model was asked to follow is not
 * the same as one that holds.
 */
const fs = require('fs');
const path = require('path');

const MAX_FACTS = 200;

/** Things that must never be written down, whatever the model returns. */
const SECRET = /\b(?:password|passcode|pass code|pin|cvv|cvc|security code|card number|account number|routing number|social security|ssn|passport number|license number|locker (?:code|combo|combination)|combination|one[- ]time code|2fa|verification code)\b|\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{3,4}\b|\b\d{3}-\d{2}-\d{4}\b/i;

const EXTRACT = `You maintain a short memory about the user of a voice assistant.
From the exchange below, return what is worth remembering long-term about the user: people in their life, preferences, plans and dates, routines, school or work details, things they asked you to remember.
Do NOT include: anything about the assistant, one-off questions, general knowledge, or any password, PIN, code, card/account/ID number.
Return ONLY JSON: {"add": ["short fact in third person, e.g. 'Their sister is Maya'"], "remove": [numbers of existing facts that are now wrong]}.
Return {"add": [], "remove": []} when there is nothing worth keeping — most exchanges.`;

class Memory {
  constructor({ file, logger = console } = {}) {
    this.file = file;
    this.logger = logger;
    this.facts = [];
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.facts = Array.isArray(data.facts) ? data.facts.filter((f) => f && f.text) : [];
    } catch { this.facts = []; }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ facts: this.facts }, null, 2));
    } catch (err) { this.logger.warn?.(`[memory] could not save: ${err.message}`); }
  }

  /** Adds facts, skipping secrets and near-duplicates. @returns {string[]} what was added */
  add(texts, source = 'learnt') {
    const added = [];
    for (const raw of [].concat(texts || [])) {
      const text = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (text.length < 4 || SECRET.test(text)) continue;
      const key = text.toLowerCase().replace(/[^a-z0-9 ]/g, '');
      if (this.facts.some((f) => f.text.toLowerCase().replace(/[^a-z0-9 ]/g, '') === key)) continue;
      this.facts.push({ text, at: new Date().toISOString(), source });
      added.push(text);
    }
    while (this.facts.length > MAX_FACTS) this.facts.shift();
    if (added.length) this.save();
    return added;
  }

  /** Forgets facts matching the words given. @returns {string[]} what was forgotten */
  forget(about) {
    const words = String(about || '').toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    if (!words.length) return [];
    const gone = this.facts.filter((f) => words.every((w) => f.text.toLowerCase().includes(w)));
    if (gone.length) {
      this.facts = this.facts.filter((f) => !gone.includes(f));
      this.save();
    }
    return gone.map((f) => f.text);
  }

  /** For the prompt: everything, newest last, as one block. */
  summary(max = 60) {
    const recent = this.facts.slice(-max);
    return recent.length ? `What you remember about the user:\n${recent.map((f) => `- ${f.text}`).join('\n')}` : '';
  }

  /**
   * Learns from one exchange, in the background. Cheap by design: short
   * commands ("what time is it", "play drake") are skipped without a model
   * call, because they never say anything about the person.
   */
  async learn({ question, answer, provider, model, signal }) {
    const q = String(question || '').trim();
    if (!provider || q.split(/\s+/).length < 5) return [];
    if (SECRET.test(q)) return [];
    const list = this.facts.slice(-60).map((f, i) => `${i + 1}. ${f.text}`).join('\n') || '(none yet)';
    try {
      const res = await provider.chat({
        model,
        temperature: 0,
        maxTokens: 200,
        signal,
        messages: [
          { role: 'system', content: EXTRACT },
          { role: 'user', content: `TODAY: ${new Date().toDateString()} — write any dates as real dates, never "next Saturday".

EXISTING FACTS:\n${list}\n\nEXCHANGE:\nUser: ${q}\nAssistant: ${String(answer || '').slice(0, 600)}` }
        ]
      });
      const m = String(res.text || '').match(/\{[\s\S]*\}/);
      if (!m) return [];
      const out = JSON.parse(m[0]);
      const recent = this.facts.slice(-60);
      const removed = (Array.isArray(out.remove) ? out.remove : [])
        .map((n) => recent[Number(n) - 1]).filter(Boolean);
      if (removed.length) {
        this.facts = this.facts.filter((f) => !removed.includes(f));
        this.save();
      }
      const added = this.add(Array.isArray(out.add) ? out.add : []);
      if (added.length || removed.length) {
        this.logger.info?.(`[memory] +${added.length} -${removed.length}: ${added.join(' | ').slice(0, 160)}`);
      }
      return added;
    } catch (err) {
      this.logger.debug?.(`[memory] could not learn: ${err.message}`);
      return [];
    }
  }
}

module.exports = { Memory, SECRET };
