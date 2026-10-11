'use strict';
/**
 * The things that are true right now, kept ready before anyone asks.
 *
 * "What's the weather" measured 3.7 seconds, and almost none of that was
 * thinking. It was two network round trips in series — an IP lookup to find
 * out where the user is, then the forecast for those coordinates — paid in
 * full on every single question, for facts that change on the hour at most.
 *
 * So they are fetched in the background and kept. A question then costs a
 * property read. The forecast is refreshed on a timer; the location is kept
 * far longer, because it is the slower of the two calls and a laptop does not
 * usually change city between sentences.
 *
 * Stale answers are served immediately and refreshed behind the user's back.
 * Waiting for a fresher number is exactly the three seconds this exists to
 * remove, and nobody minds weather that is eight minutes old.
 */
const { getWeather, locateByIp } = require('./web');

/** How long a forecast is worth serving before it is refetched. */
const WEATHER_TTL_MS = 10 * 60 * 1000;
/** Where the user is changes rarely, and finding out is the expensive half. */
const LOCATION_TTL_MS = 12 * 60 * 60 * 1000;

class Ambient {
  constructor({ config, logger = console } = {}) {
    this.config = config;
    this.logger = logger;
    this.timer = null;
    /** { value, at, units } — the forecast for where the user is. */
    this.weatherCache = null;
    /** { value, at } — the user's own location. */
    this.locationCache = null;
    /** Set while a refresh is in flight, so ten questions cause one fetch. */
    this.inFlight = null;
  }

  get units() { return this.config.get('units.temperature', 'F'); }

  /**
   * Begins keeping the forecast current.
   *
   * Deliberately not awaited by the caller: nothing should wait on the
   * weather at launch, and a question that arrives before the first fetch
   * lands simply takes the slow path once.
   */
  start() {
    if (this.timer) return;
    this.refresh().catch(() => {});
    this.timer = setInterval(() => this.refresh().catch(() => {}), WEATHER_TTL_MS);
    // Never hold the process open for a weather refresh.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Where the user is, from cache when it is recent enough. */
  async location() {
    const c = this.locationCache;
    if (c && Date.now() - c.at < LOCATION_TTL_MS) return c.value;
    const value = await locateByIp();
    if (value) this.locationCache = { value, at: Date.now() };
    return value;
  }

  /** Fetches the forecast for wherever the user is and keeps it. */
  async refresh() {
    if (this.inFlight) return this.inFlight;
    const units = this.units;
    this.inFlight = (async () => {
      const started = Date.now();
      const value = await getWeather({ place: null, when: 'now', units });
      if (value && value.ok !== false) {
        this.weatherCache = { value, at: Date.now(), units };
        this.logger.debug?.(`[ambient] weather refreshed in ${Date.now() - started}ms`);
      }
      return value;
    })();
    try { return await this.inFlight; }
    catch (err) {
      this.logger.debug?.(`[ambient] weather refresh failed: ${err.message}`);
      return null;
    }
    finally { this.inFlight = null; }
  }

  /**
   * The forecast, instantly when it can be.
   *
   * Only the "here, now" case is cached. A named place or tomorrow's forecast
   * is a different question, and answering it from a cache of somewhere else
   * would be worse than slow — it would be wrong.
   *
   * @returns {Promise<object>} the same shape the weather tool already returns
   */
  async weather({ place = null, when = 'now', units = null } = {}) {
    const want = units || this.units;
    const cacheable = !place && when === 'now';

    if (cacheable && this.weatherCache && this.weatherCache.units === want) {
      const age = Date.now() - this.weatherCache.at;
      // Stale is still served; the refresh happens behind the answer.
      if (age > WEATHER_TTL_MS) this.refresh().catch(() => {});
      return this.weatherCache.value;
    }

    const value = await getWeather({ place, when, units: want });
    if (cacheable && value && value.ok !== false) {
      this.weatherCache = { value, at: Date.now(), units: want };
    }
    return value;
  }

  /**
   * What the model should already know when it is asked anything.
   *
   * Short on purpose. Every line here is in the prompt of every request, so
   * it buys its place by removing a tool call, and anything that does not is
   * just tokens and latency.
   */
  snapshot() {
    const now = new Date();
    const lines = [
      `Current date and time: ${now.toLocaleString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit'
      })}`
    ];

    const loc = this.locationCache && this.locationCache.value;
    if (loc && loc.name) {
      lines.push(`User's location: ${[loc.name, loc.region, loc.country].filter(Boolean).join(', ')}`);
    }

    const w = this.weatherCache && this.weatherCache.value;
    if (w && w.summary) {
      const age = Math.round((Date.now() - this.weatherCache.at) / 60000);
      lines.push(`Weather right now${age > 0 ? ` (as of ${age} min ago)` : ''}: ${w.summary}`);
    }

    return lines.join('\n');
  }
}

module.exports = { Ambient, WEATHER_TTL_MS, LOCATION_TTL_MS };
