'use strict';
/**
 * Verifies answering from the web rather than listing links, and the weather.
 *
 *   node scripts/test-web.js          offline: cleaning, routing, parsing
 *   node scripts/test-web.js --live   also hits DuckDuckGo and Open-Meteo
 *
 * The cleaning cases are the ones that matter. "I'm sorry, but I can't access
 * the internet to check the weather forecast" is what the assistant actually
 * said while holding the fetched page in its context, and it must never be
 * spoken as if it were an answer.
 */
const { cleanAnswer, describeCode, stripHtml, decodeDdgUrl } = require('../src/core/agent/web');
const { matchIntent, siteUrl, SITES } = require('../src/core/agent/intents');
const { buildTools } = require('../src/core/agent/tools');
const { config } = require('../src/core/config');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};

const tools = buildTools({
  config, bridge: {}, browser: null, provider: null,
  connections: { tokenFor: async () => null }, logger: { info() {}, warn() {}, debug() {} }
});
const route = (text) => {
  const r = matchIntent(text, tools, config);
  return r ? { tool: r.tool.name, args: r.args } : null;
};

(async () => {
  console.log('\nA refusal is never an answer:');
  const refusals = [
    "I'm sorry, but I can't access the internet to check the weather forecast.",
    'I am sorry, but I cannot access the internet to check the weather.',
    'Unfortunately, I do not have access to real-time data.',
    'As an AI, I am unable to browse the internet.',
    "Sorry, I can't retrieve up-to-date information."
  ];
  for (const r of refusals) check(`"${r.slice(0, 44)}…" is discarded`, cleanAnswer(r) === '', cleanAnswer(r));

  console.log('\nAn answer that merely mentions the internet survives:');
  const keep = [
    'You can access the library from the main hall.',
    'The internet was invented in 1983.',
    'Oracle shares rose 3.3% to $142.58 on strong AI-cloud demand.',
    'Lima is the capital of Peru.'
  ];
  for (const k of keep) check(`"${k.slice(0, 44)}" is kept`, cleanAnswer(k) === k, cleanAnswer(k));

  console.log('\nThe wrapper a small model adds is stripped:');
  check('markdown links read as their text',
    cleanAnswer('See [the docs](https://x.y/z) for more.') === 'See the docs for more.',
    cleanAnswer('See [the docs](https://x.y/z) for more.'));
  check('bold markers go', cleanAnswer('**Lima** is the capital.') === 'Lima is the capital.',
    cleanAnswer('**Lima** is the capital.'));
  check('"Here is the answer:" goes',
    cleanAnswer('Here is the answer: Lima.') === 'Lima.', cleanAnswer('Here is the answer: Lima.'));
  check('"in the sources provided" goes',
    !/sources/i.test(cleanAnswer('The answer can be found in the sources provided, Lima is the capital.')),
    cleanAnswer('The answer can be found in the sources provided, Lima is the capital.'));
  check('bullets go', cleanAnswer('- Lima\n- Peru').startsWith('Lima'), cleanAnswer('- Lima\n- Peru'));

  console.log('\nWeather is routed to the forecast, never to the model:');
  const weather = [
    ['what is the weather today', 'today', null],
    ['will it rain tomorrow', 'tomorrow', null],
    ['how hot is it', 'now', null],
    ['what is the temperature', 'now', null],
    ["what's the weather in London tomorrow", 'tomorrow', 'London'],
    ['is it going to snow', 'now', null],
    ['what is the forecast for New York', 'now', 'New York']
  ];
  for (const [text, when, place] of weather) {
    const r = route(text);
    check(`"${text}" -> weather (${when}${place ? ', ' + place : ''})`,
      r && r.tool === 'weather' && r.args.when === when && r.args.place === place,
      JSON.stringify(r));
  }
  check('"whether to go" is not a forecast', (route('whether to go or not') || {}).tool !== 'weather',
    JSON.stringify(route('whether to go or not')));

  console.log('\nWMO codes read as English:');
  check('0 is clear', describeCode(0) === 'clear');
  check('61 is light rain', describeCode(61) === 'light rain');
  check('95 is a thunderstorm', describeCode(95) === 'a thunderstorm');
  check('an unknown code still reads', describeCode(999) === 'unsettled');

  console.log('\nA question about your own data never goes to the web:');
  // The web does not know the user's grades, and a model handed search results
  // about grades will produce something that reads exactly like an answer —
  // which is what happened: 64 seconds to invent "[1] Overall grade average
  // [2] No grades assigned". That is worse than no answer at all.
  const personal = [
    // Names Canvas, so it must reach Canvas. This previously asserted
    // list_grades, which is Google Classroom — a different system, a
    // different course, a different number, shown under a Canvas logo.
    ['Hey, um, can you go to Google and check my grades on Canvas?', 'canvas_grades'],
    ['what are my grades', 'list_grades'],
    ["what's my gpa", 'list_grades'],
    ['check my marks', 'list_grades'],
    ['my balance on paypal', 'personal_data']
  ];
  for (const [text, want] of personal) {
    const r = route(text);
    check(`"${text.slice(0, 44)}" -> ${want}`, r && r.tool === want, JSON.stringify(r));
  }
  check('and none of them is a web lookup',
    personal.every(([text]) => (route(text) || {}).tool !== 'answer_from_web'),
    'one of them still searches the web');

  console.log('\nSites open by name:');
  const sites = [
    ['go to canvas', 'canvas.instructure.com'],
    ['open my email', 'mail.google.com'],
    ['take me to youtube', 'youtube.com'],
    ['go to classroom', 'classroom.google.com'],
    ['pull up google drive', 'drive.google.com']
  ];
  for (const [text, host] of sites) {
    const r = route(text);
    check(`"${text}" opens ${host}`, r && r.tool === 'open_url' && r.args.url.includes(host), JSON.stringify(r));
  }
  check('a real desktop app is launched, not its web page',
    (route('open spotify') || {}).tool === 'open_app', JSON.stringify(route('open spotify')));
  check('an unknown place falls through to the model', route('go to the kitchen') === null,
    JSON.stringify(route('go to the kitchen')));
  check('a settings override wins over the built-in',
    siteUrl('canvas', { get: () => ({ canvas: 'https://school.edu/canvas' }) }) === 'https://school.edu/canvas',
    siteUrl('canvas', { get: () => ({ canvas: 'https://school.edu/canvas' }) }));
  check('every built-in site is a real https address',
    Object.values(SITES).every((u) => /^https:\/\/[\w.-]+/.test(u)),
    JSON.stringify(Object.entries(SITES).filter(([, u]) => !/^https:\/\//.test(u))));

  console.log('\nOpening things no longer asks permission:');
  for (const name of ['open_url', 'open_app', 'open_file']) {
    const t = tools.find((x) => x.name === name);
    if (!t) { console.log(`  note  ${name} is not registered`); continue; }
    check(`${name} runs without a prompt`, !t.mutating, `mutating: ${t.mutating}`);
  }

  console.log('\nParsing helpers:');
  check('tags are stripped', stripHtml('<p>Hello <b>there</b></p>') === 'Hello there', stripHtml('<p>Hello <b>there</b></p>'));
  check('entities are decoded', stripHtml('What&#x27;s &amp; more') === "What's & more", stripHtml('What&#x27;s &amp; more'));
  check('a DuckDuckGo redirect is unwrapped',
    decodeDdgUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x') === 'https://example.com/a',
    decodeDdgUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x'));

  if (process.argv.includes('--live')) {
    console.log('\nLive (network):');
    const { getWeather, search } = require('../src/core/agent/web');
    const t0 = Date.now();
    const w = await getWeather({});
    check('the forecast comes back', w.ok && /\d/.test(w.spoken), JSON.stringify(w.spoken));
    check('it names somewhere', Boolean(w.place), JSON.stringify(w.place));
    check('nothing unreadable is spoken', !/[°]/.test(w.spoken), JSON.stringify(w.spoken));
    console.log(`        ${Date.now() - t0}ms — "${w.spoken}"`);

    const named = await getWeather({ place: 'London', when: 'tomorrow' });
    check('a named place works', named.ok && /London/.test(named.spoken), JSON.stringify(named.spoken));

    const results = await search('capital of peru');
    check('search returns results', results.length > 0, `${results.length}`);
    check('results carry real URLs', results.every((r) => /^https?:\/\//.test(r.url)),
      JSON.stringify(results.slice(0, 2).map((r) => r.url)));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
