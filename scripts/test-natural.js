'use strict';
/**
 * Verifies that what people actually say gets routed.
 *
 *   node scripts/test-natural.js
 *
 * Every sentence in the first block is a verbatim transcript from the log,
 * including the mishearings. All of them used to fall through to the model —
 * the first took 57 seconds and answered with a question.
 */
const { matchIntent, stripChatter } = require('../src/core/agent/intents');
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
  console.log('\nReal sentences from the log, which all took the slow path:');
  const real = [
    ['Oh hey Darris, so can you open Spotify from my apps and play some white film music I like?', 'control_playback'],
    ["Just bro, play some wide grown music. That's good. Oh my god. Just play something, right?", 'control_playback'],
    ['My girl music, yes play some white girl music, select anything you want, just some good stuff.', 'control_playback'],
    ['hey jarvis can you check my email please', 'list_email'],
    ['um so what is the weather like today', 'weather'],
    ['ok so could you just open canvas for me', 'open_url']
  ];
  for (const [text, want] of real) {
    const r = route(text);
    check(`"${text.slice(0, 48)}…" -> ${want}`, r && r.tool === want, JSON.stringify(r));
  }

  console.log('\nThe player is named when it is mentioned:');
  check('"play music on spotify" names Spotify',
    (route('play music on spotify') || {}).args.app === 'spotify', JSON.stringify(route('play music on spotify')));
  check('a sentence naming Spotify still names it',
    /spotify/i.test(String((route('open Spotify and play some music') || {}).args.app)),
    JSON.stringify(route('open Spotify and play some music')));
  check('"play some music" names nothing',
    (route('play some music') || {}).args.app === null, JSON.stringify(route('play some music')));

  console.log('\nStripping chatter leaves the request:');
  const strips = [
    ['Oh hey Darris, so can you just play some music, right?', 'play some music'],
    ['hey jarvis check my email', 'check my email'],
    ['um, so, what is the weather', 'what is the weather'],
    ['please could you open canvas for me', 'open canvas']
  ];
  for (const [from, to] of strips) {
    check(`"${from.slice(0, 40)}…" -> "${to}"`, stripChatter(from) === to, JSON.stringify(stripChatter(from)));
  }

  console.log('\nNothing that already worked is broken:');
  // The second pass must not change a sentence that already routed, and must
  // not turn a bare greeting into nothing.
  const unchanged = [
    ['hey', 'small_talk'],
    ['hi', 'small_talk'],
    ['thanks', 'small_talk'],
    ['what can you do', 'small_talk'],
    ['check my email', 'list_email'],
    ['what is the weather', 'weather'],
    ['pause the music', 'control_playback'],
    ['next song', 'control_playback'],
    ['open notepad', 'open_app'],
    ['go to canvas', 'open_url'],
    ['what do I have due', 'list_coursework']
  ];
  for (const [text, want] of unchanged) {
    const r = route(text);
    check(`"${text}" still routes to ${want}`, r && r.tool === want, JSON.stringify(r));
  }

  console.log('\nA question about music is not a command to play it:');
  const questions = [
    'what is playing right now',
    "what's playing",
    'what song is this',
    'tell me what song this is',
    'who sings this'
  ];
  for (const q of questions) {
    const r = route(q);
    check(`"${q}" asks rather than plays`, r && r.tool === 'now_playing', JSON.stringify(r));
  }

  console.log('\nThe loose rule does not swallow unrelated sentences:');
  const notMusic = [
    ['play devil’s advocate for me', null],
    ['what did the play review say', null]
  ];
  for (const [text] of notMusic) {
    const r = route(text);
    check(`"${text}" is not a play command`, !r || r.tool !== 'control_playback', JSON.stringify(r));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
