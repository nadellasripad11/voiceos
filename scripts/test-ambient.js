'use strict';
/**
 * Knowing the answer before being asked.
 *
 *   node scripts/test-ambient.js
 *
 * "What's the weather" measured 3,698ms, and almost none of it was thinking:
 * it was an IP lookup to find the user, then a forecast call for those
 * coordinates, in series, on every single question — for facts that change
 * hourly at most.
 *
 * So what is tested here is not the forecast. It is that asking twice costs
 * one fetch, that a stale answer is handed over immediately rather than held
 * back for a fresher one, and that the cache never answers a question it was
 * not asked — weather for Tokyo must not come from a cache of here.
 *
 * The network is stubbed, so this runs offline and fast.
 */
const Module = require('module');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};
const quiet = { info() {}, warn() {}, debug() {}, error() {} };

// Stub web.js before ambient.js requires it, so no call ever leaves here.
const calls = { weather: [], locate: 0 };
const webPath = require.resolve('../src/core/agent/web');
require.cache[webPath] = {
  id: webPath,
  filename: webPath,
  loaded: true,
  exports: {
    async getWeather(args) {
      calls.weather.push(args);
      return { ok: true, summary: `It is 68F in Testville (call ${calls.weather.length}).` };
    },
    async locateByIp() {
      calls.locate++;
      return { name: 'Testville', region: 'Testshire', country: 'Testland', lat: 1, lon: 2 };
    }
  }
};

const { Ambient, WEATHER_TTL_MS } = require('../src/core/agent/ambient');

const config = { get: (k, d) => (k === 'units.temperature' ? 'F' : d), set: () => {} };
const fresh = () => new Ambient({ config, logger: quiet });

(async () => {
  console.log('\nAsking twice costs one fetch:');
  {
    calls.weather = [];
    const a = fresh();
    const first = await a.weather({});
    const second = await a.weather({});
    check('both answers arrive', Boolean(first && second));
    check('but the network was touched once', calls.weather.length === 1, `${calls.weather.length} calls`);
    check('and they are the same answer', first.summary === second.summary);
  }

  console.log('\nThe second answer is instant:');
  {
    calls.weather = [];
    const a = fresh();
    await a.weather({});
    const started = Date.now();
    await a.weather({});
    // A property read, not a round trip. Generous bound so a loaded machine
    // does not fail it, but a real fetch could never come in under this.
    check('served from memory, not the network', Date.now() - started < 20,
      `${Date.now() - started}ms`);
  }

  console.log('\nA stale forecast is handed over, not held back:');
  {
    calls.weather = [];
    const a = fresh();
    await a.weather({});
    // Pretend the cached forecast is older than its lifetime.
    a.weatherCache.at = Date.now() - (WEATHER_TTL_MS + 60_000);

    const started = Date.now();
    const answer = await a.weather({});
    check('the stale answer comes back immediately', Date.now() - started < 20,
      `${Date.now() - started}ms`);
    check('and it is still a real answer', /Testville/.test(answer.summary), answer.summary);

    // The refresh happens behind it.
    await new Promise((r) => setTimeout(r, 10));
    check('a refresh was started in the background', calls.weather.length === 2,
      `${calls.weather.length} calls`);
  }

  console.log('\nIt never answers a question it was not asked:');
  {
    calls.weather = [];
    const a = fresh();
    await a.weather({});                      // here, now — cacheable
    await a.weather({ place: 'Tokyo' });      // somewhere else
    await a.weather({ when: 'tomorrow' });    // another day
    check('a named place goes to the network',
      calls.weather.some((c) => c.place === 'Tokyo'), JSON.stringify(calls.weather));
    check("tomorrow's forecast goes to the network",
      calls.weather.some((c) => c.when === 'tomorrow'), JSON.stringify(calls.weather));
    check('so three different questions made three calls',
      calls.weather.length === 3, `${calls.weather.length} calls`);

    // And asking for Tokyo must not have poisoned the cache for here.
    const here = await a.weather({});
    check('the cache for here still holds',
      calls.weather.length === 3 && /Testville/.test(here.summary), `${calls.weather.length} calls`);
  }

  console.log('\nDifferent units are a different question:');
  {
    calls.weather = [];
    const a = fresh();
    await a.weather({ units: 'F' });
    await a.weather({ units: 'C' });
    check('celsius is not served from a fahrenheit cache',
      calls.weather.length === 2, `${calls.weather.length} calls`);
  }

  console.log('\nWhat the model is told:');
  {
    const a = fresh();
    const bare = a.snapshot();
    check('the time is always there', /\d/.test(bare) && /:/.test(bare), bare);

    await a.location();
    await a.weather({});
    const full = a.snapshot();
    check('where the user is appears once known', /Testville/.test(full), full);
    check('and the weather too', /68F/.test(full), full);
    check('it stays short enough to sit in every prompt',
      full.split('\n').length <= 4, `${full.split('\n').length} lines`);
  }

  console.log('\nA failing network is not a broken assistant:');
  {
    const broken = new Ambient({ config, logger: quiet });
    const web = require.cache[webPath].exports;
    const realGet = web.getWeather;
    web.getWeather = async () => { throw new Error('offline'); };
    let threw = null;
    try { await broken.refresh(); } catch (e) { threw = e; }
    check('a failed refresh is swallowed', threw === null, String(threw && threw.message));
    check('and the snapshot still gives the time', /\d/.test(broken.snapshot()));
    web.getWeather = realGet;
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
