'use strict';
/**
 * Showing a picture when a picture is the answer — and not otherwise.
 *
 *   node scripts/test-images.js          offline: what wants a picture
 *   node scripts/test-images.js --live   also fetches real ones
 *
 * The negatives are the important half. Fetching a photograph to accompany
 * "what are my grades" costs a round trip and puts a stock image next to
 * someone's marks, so the rule for looking has to be narrow.
 */
const { imageSubject } = require('../src/core/agent/images');
const { matchIntent } = require('../src/core/agent/intents');
const { buildTools } = require('../src/core/agent/tools');
const { config } = require('../src/core/config');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};

const tools = buildTools({
  config, bridge: {}, browser: null, provider: null,
  connections: { tokenFor: async () => ({ token: 'x' }), status: () => ({}) },
  logger: { info() {}, warn() {}, debug() {} }
});
const route = (text) => {
  const r = matchIntent(text, tools, config);
  return r ? { tool: r.tool.name, args: r.args } : null;
};

(async () => {
  console.log('\nQuestions that want a picture, and what of:');
  for (const [text, subject] of [
    ['what does a capybara look like', 'capybara'],
    ['show me pictures of the northern lights', 'the northern lights'],
    ['who is Ada Lovelace', 'Ada Lovelace'],
    ['where is Machu Picchu', 'Machu Picchu'],
    ['what is a quasar', 'quasar']
  ]) {
    check(`"${text}" -> ${subject}`, imageSubject(text) === subject, String(imageSubject(text)));
  }

  console.log('\nQuestions that do not:');
  for (const text of [
    'what is the weather today',
    'what are my grades',
    'how many unread emails do i have',
    'what time is it',
    'what is the capital of peru',
    'what is on my calendar today',
    "what's the point of this",
    'what is going on today',
    'what is my gpa'
  ]) {
    check(`"${text}" asks for no picture`, imageSubject(text) === null, String(imageSubject(text)));
  }

  console.log('\nAsking outright skips the search entirely:');
  for (const [text, subject] of [
    ['show me a picture of a capybara', 'a capybara'],
    ['show me photos of the eiffel tower', 'the eiffel tower'],
    ['what does a capybara look like', 'capybara']
  ]) {
    const r = route(text);
    check(`"${text}" -> show_image (${subject})`,
      r && r.tool === 'show_image' && r.args.subject === subject, JSON.stringify(r));
  }

  console.log('\nAnd the rest still route as they did:');
  for (const [text, want] of [
    ['what is the weather', 'weather'],
    ['what do we have today', 'my_day'],
    ['what are my grades', 'list_grades'],
    ['who is Ada Lovelace', 'answer_from_web']
  ]) {
    check(`"${text}" -> ${want}`, (route(text) || {}).tool === want, JSON.stringify(route(text)));
  }

  console.log('\nThe tool itself:');
  {
    const tool = tools.find((t) => t.name === 'show_image');
    check('it is registered', Boolean(tool));
    check('it changes nothing', tool && !tool.mutating, String(tool && tool.mutating));
  }

  if (process.argv.includes('--live')) {
    console.log('\nLive (network):');
    const { pictureFor } = require('../src/core/agent/images');
    for (const q of ['what does a capybara look like', 'who is Ada Lovelace']) {
      const t0 = Date.now();
      const p = await pictureFor(q, { logger: { debug() {} } });
      check(`"${q}" returns an image`, Boolean(p && p.data), 'nothing came back');
      if (p) {
        check(`  it is an image type (${p.mime})`, /^image\//.test(p.mime), p.mime);
        check(`  and a sane size (${(p.bytes / 1024).toFixed(0)}KB)`, p.bytes > 1000 && p.bytes < 500 * 1024, String(p.bytes));
        console.log(`        ${Date.now() - t0}ms — ${p.title}`);
      }
    }
    const none = await pictureFor('what are my grades', { logger: { debug() {} } });
    check('a non-visual question fetches nothing at all', none === null, JSON.stringify(none && none.title));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
