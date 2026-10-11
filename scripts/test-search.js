'use strict';
/**
 * Searching when the search engine says no, and the news.
 *
 *   node scripts/test-search.js
 *
 * DuckDuckGo's free HTML page throttles: three searches in a row returned 8,
 * 8, then 0 results, and in the app one failed outright, so "summarize world
 * news" answered that the search did not come back. These run against a fake
 * network (fetch is replaced), so they are fast, deterministic and offline.
 */
const realFetch = global.fetch;
let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};

const DDG_PAGE = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fsky">Why the sky is blue</a>
  <a class="result__snippet">Rayleigh scattering of sunlight.</a>`;
const WIKI = { query: { search: [{ title: 'Rayleigh scattering', snippet: 'The <span>scattering</span> of light by particles' }] } };
const RSS = `<rss><channel>
  <item><title>Webb finds a distant galaxy - NASA</title><link>https://news.example/1</link><pubDate>${new Date(Date.now() - 2 * 3600000).toUTCString()}</pubDate><source url="x">NASA</source></item>
  <item><title><![CDATA[Markets rise &amp; fall - Reuters]]></title><link>https://news.example/2</link><pubDate>${new Date().toUTCString()}</pubDate><source url="y">Reuters</source></item>
</channel></rss>`;

/** Fakes the network: each host answers as scripted. */
function network({ ddg = 'ok' } = {}) {
  const seen = [];
  global.fetch = async (url) => {
    const u = String(url);
    seen.push(new URL(u).hostname);
    const reply = (status, body, json = false) => ({
      ok: status >= 200 && status < 300, status,
      text: async () => (json ? JSON.stringify(body) : body),
      json: async () => body,
      headers: new Map()
    });
    if (u.includes('duckduckgo.com')) {
      if (ddg === 'throw') throw new TypeError('fetch failed');
      if (ddg === 'challenge') return reply(202, '<html>please verify you are human</html>');
      return reply(200, DDG_PAGE);
    }
    if (u.includes('wikipedia.org')) return reply(200, WIKI, true);
    if (u.includes('news.google.com')) return reply(200, RSS);
    throw new Error('unexpected host ' + u);
  };
  return seen;
}

/** A fresh copy of web.js, so its throttling memory starts empty each time. */
const freshWeb = () => {
  delete require.cache[require.resolve('../src/core/agent/web')];
  return require('../src/core/agent/web');
};

(async () => {
  console.log('\nDuckDuckGo first, when it answers:');
  {
    const seen = network();
    const r = await freshWeb().search('why is the sky blue');
    check('its results are used', r.length === 1 && r[0].url === 'https://example.com/sky', JSON.stringify(r));
    check('and nothing else is asked', seen.every((h) => h.includes('duckduckgo')), seen.join(', '));
  }

  console.log('\nWhen DuckDuckGo will not answer:');
  for (const mode of ['throw', 'challenge']) {
    network({ ddg: mode });
    const r = await freshWeb().search('why is the sky blue');
    check(`${mode === 'throw' ? 'a network failure' : 'a 202 challenge page'} falls back to Wikipedia`,
      r.length >= 1 && /Rayleigh/.test(r[0].title) && /scattering of light/.test(r[0].snippet), JSON.stringify(r[0]));
  }
  {
    network({ ddg: 'challenge' });
    const r = await freshWeb().search('latest news on the webb telescope');
    check('a time-sensitive question puts the news first', r[0] && /Webb finds/.test(r[0].title), JSON.stringify(r[0]));
  }
  {
    const web = freshWeb();
    network({ ddg: 'challenge' });
    await web.search('first question');
    const seen = network({ ddg: 'ok' });
    await web.search('second question');
    check('a throttled DuckDuckGo is skipped for a while, not retried every question',
      !seen.some((h) => h.includes('duckduckgo')), seen.join(', '));
  }

  console.log('\nHeadlines:');
  {
    network();
    const items = await freshWeb().newsHeadlines('', { limit: 5 });
    check('read from the feed', items.length === 2);
    check('the source is split off the title', items[0].title === 'Webb finds a distant galaxy' && items[0].source === 'NASA', JSON.stringify(items[0]));
    check('entities and CDATA are cleaned', items[1].title === 'Markets rise & fall', items[1].title);
    check('with how old they are', /hours? ago/.test(items[0].when), items[0].when);
  }

  console.log('\nThe news tool and its routing:');
  {
    network();
    const { buildTools } = require('../src/core/agent/tools');
    const { matchIntent } = require('../src/core/agent/agent');
    const { config } = require('../src/core/config');
    const tools = buildTools({ bridge: {}, config, connections: {}, logger: { info() {}, warn() {}, debug() {} } });
    const news = tools.find((t) => t.name === 'news');
    const r = await news.run({});
    check('lists the headlines with sources', r.ok && /Top stories/.test(r.summary) && /\(NASA/.test(r.summary), r.summary);
    check('and leaves the spoken version to the summariser', !r.spoken);
    for (const [q, topic] of [
      ['summarize world news', ''], ["what's the news", ''], ['whats in the news today', ''],
      ['summarize todays headlines', ''], ['latest news about the james webb telescope', 'james webb telescope'],
      ['tech news', 'technology'], ['any sports news', 'sports'], ['news on the election', 'election']
    ]) {
      const hit = matchIntent(q, tools, config);
      check(`"${q}" -> news${topic ? ` (${topic})` : ''}`, hit && hit.tool.name === 'news' && hit.args.topic === topic,
        hit ? `${hit.tool.name} ${JSON.stringify(hit.args)}` : 'no route');
    }
    for (const q of ['play the news podcast', 'open the news app']) {
      const hit = matchIntent(q, tools, config);
      check(`"${q}" is not a headline request`, !hit || hit.tool.name !== 'news', hit && hit.tool.name);
    }
  }

  global.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
