'use strict';
/**
 * Playing music: telling a named artist from a request to just put something on.
 *
 *   node scripts/test-music.js
 *
 * The sentence that prompted all this is the first case: "play some music on
 * Spotify bro play like Drake" names Drake, and it is named last, after two
 * other play-verbs and a filler word.
 */
const { matchIntent, musicQuery } = require('../src/core/agent/intents');
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
const route = (t) => {
  const r = matchIntent(t, tools, config);
  return r ? { tool: r.tool.name, args: r.args } : null;
};

(async () => {
  console.log('\nA named artist, song or album is searched for:');
  const named = [
    ['play some music on Spotify bro play like Drake', 'Drake'],
    ['play Drake', 'Drake'],
    ['play the weeknd', 'weeknd'],
    ['put on Bohemian Rhapsody', 'Bohemian Rhapsody'],
    ['play some Taylor Swift on spotify', 'Taylor Swift'],
    ['just play like some drake bro', 'drake'],
    ['play Abbey Road', 'Abbey Road']
  ];
  for (const [text, want] of named) {
    const r = route(text);
    check(`"${text.slice(0, 44)}" -> ${want}`,
      r && r.tool === 'play_search' && r.args.query.toLowerCase() === want.toLowerCase(),
      JSON.stringify(r));
  }

  console.log('\nA request with no name in it resumes the player:');
  const vibes = [
    'play some music',
    'play music',
    'play something',
    'put on some music',
    'play some tunes',
    'Oh hey Darris, so can you open Spotify from my apps and play some white film music I like?',
    "Just bro, play some wide grown music. That's good. Oh my god. Just play something, right?"
  ];
  for (const text of vibes) {
    const r = route(text);
    check(`"${text.slice(0, 44)}" resumes`, r && r.tool === 'control_playback' && r.args.action === 'play',
      JSON.stringify(r));
  }

  console.log('\nThe player is still named when it is mentioned:');
  check('"play music on spotify" names Spotify',
    (route('play music on spotify') || {}).args.app === 'spotify', JSON.stringify(route('play music on spotify')));
  check('"play Drake on spotify" searches, and does not keep the player in the query',
    !/spotify/i.test((route('play Drake on spotify') || {}).args.query || ''),
    JSON.stringify(route('play Drake on spotify')));

  console.log('\nmusicQuery directly:');
  check('the last name wins', musicQuery('play some music then play Drake') === 'Drake', musicQuery('play some music then play Drake'));
  check('trailing chatter goes', musicQuery('play drake right') === 'drake', musicQuery('play drake right'));
  check('a bare generic is not a name', musicQuery('play some music') === null, String(musicQuery('play some music')));
  check('"something" is not a name', musicQuery('play something') === null, String(musicQuery('play something')));
  check('a long ramble is not a name', musicQuery('play ' + 'x'.repeat(80)) === null);
  check('an empty string is safe', musicQuery('') === null);

  console.log('\nOther media commands are untouched:');
  for (const [text, action] of [['pause the music', 'pause'], ['next song', 'next'], ['skip this', 'next']]) {
    const r = route(text);
    check(`"${text}" -> ${action}`, r && r.tool === 'control_playback' && r.args.action === action, JSON.stringify(r));
  }
  check('"what is playing" still asks', (route('what is playing') || {}).tool === 'now_playing',
    JSON.stringify(route('what is playing')));

  console.log('\nQuizzes and tests are coursework, not a web search:');
  for (const text of [
    'what tests do i have',
    'any quizzes coming up',
    'what exams do I have this week'
  ]) {
    const r = route(text);
    check(`"${text.slice(0, 44)}" -> list_coursework`, r && r.tool === 'list_coursework', JSON.stringify(r));
  }

  // Naming a system means that system. This sentence used to be answered from
  // Google Classroom because it mentions quizzes; it mentions Canvas too, and
  // Canvas is what was asked for.
  {
    const text = 'Could it go to in Canvas and find what quizzes and tests I have this week?';
    const r = route(text);
    check('naming Canvas wins over the word "quizzes"', r && r.tool === 'canvas_assignments', JSON.stringify(r));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
