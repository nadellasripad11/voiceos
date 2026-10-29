'use strict';
/**
 * The link to the website: jobs asked for on myjarvis.pages.dev that only
 * the laptop can do (apps, files, volume, the screen, the browser agent,
 * Canvas, the calendar, texts) are queued there, and this picks them up.
 *
 * Outbound only: the laptop asks the site for work, so nothing on the
 * internet can reach in. It authenticates with credentials.json "webLink"
 * ({ url, token }); without it, nothing runs.
 *
 * While a job runs, approvals and the browser's live view go back to the
 * site, so the person on the website can say yes or no and watch.
 */

const POLL_MS = 1500;
const IDLE_POLL_MS = 4000;

class WebLink {
  constructor({ url, token, run, memory, logger }) {
    this.memory = memory;
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.run = run;
    this.logger = logger;
    this.job = null;
    this.stopped = false;
    this.lastFrameAt = 0;
    this.quietSince = Date.now();
  }

  start() {
    this.loop();
    if (this.memory) { this.syncMemory(); this.memoryTimer = setInterval(() => this.syncMemory(), 120000); }
    return this;
  }
  stop() { this.stopped = true; clearTimeout(this.timer); clearInterval(this.memoryTimer); }

  /**
   * One memory for the laptop and the website. A fact either side had at the
   * last sync and no longer has was forgotten there, and goes on the other.
   */
  async syncMemory() {
    try {
      const local = this.memory.facts.map((f) => f.text);
      const before = this.synced || new Set();
      const forget = [...before].filter((f) => !local.includes(f));
      // Only what is new here goes up; a fact the website dropped must not be sent back.
      const fresh = this.synced ? local.filter((f) => !before.has(f)) : local;
      const { facts } = await this.call('/api/link/memory', { facts: fresh, forget });
      const gone = local.filter((f) => before.has(f) && !facts.includes(f));
      if (gone.length) {
        this.memory.facts = this.memory.facts.filter((f) => !gone.includes(f.text));
        this.memory.save();
      }
      this.memory.add(facts.filter((f) => !local.includes(f)), 'website');
      this.synced = new Set(facts);
    } catch (err) { this.logger.debug(`[web-link] memory: ${err.message}`); }
  }

  async call(path, body) {
    const res = await fetch(this.url + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return res.json();
  }

  async loop() {
    if (this.stopped) return;
    let wait = Date.now() - this.quietSince > 60000 ? IDLE_POLL_MS : POLL_MS;
    try {
      const { job } = await this.call('/api/link/next');
      if (job) { this.quietSince = Date.now(); await this.work(job); wait = 0; }
    } catch (err) {
      this.logger.debug(`[web-link] ${err.message}`);
      wait = 15000;
    }
    this.timer = setTimeout(() => this.loop(), wait);
  }

  async work(job) {
    this.logger.info(`[web-link] job ${job.id}: ${String(job.task).slice(0, 80)}`);
    this.job = job;
    let result;
    try {
      const r = await this.run(job.task);
      result = { answer: r.answer || 'Done.', found: r.found || [] };
    } catch (err) {
      result = { answer: `That did not work on the laptop: ${err.message}`, found: [] };
    } finally {
      this.job = null;
    }
    await this.call('/api/link/done', { id: job.id, ...result }).catch(() => {});
    this.frame({ done: true });
  }

  /** Asks the website, while a website job runs. Resolves true/false, or null if no job. */
  async confirm({ title, detail }) {
    if (!this.job) return null;
    const id = this.job.id;
    try {
      await this.call('/api/link/confirm', { id, title, detail });
      const until = Date.now() + 120000;
      while (Date.now() < until && !this.stopped) {
        await new Promise((r) => setTimeout(r, 1200));
        const { answer } = await this.call(`/api/link/answer?id=${encodeURIComponent(id)}`);
        if (answer === 'yes' || answer === 'no') return answer === 'yes';
      }
    } catch (err) { this.logger.warn(`[web-link] confirm: ${err.message}`); }
    return false;
  }

  /** The browser agent's view, about once a second, while a website job runs. */
  frame(frame) {
    if (!this.job && !(frame && frame.done)) return;
    const now = Date.now();
    if (!(frame && frame.done) && now - this.lastFrameAt < 1000) return;
    this.lastFrameAt = now;
    const body = frame && frame.done ? { done: true } : { data: frame.data, url: frame.url || '', title: frame.title || '' };
    if (body.data && body.data.length > 700000) return;
    this.call('/api/link/frame', body).catch(() => {});
  }
}

module.exports = { WebLink };
