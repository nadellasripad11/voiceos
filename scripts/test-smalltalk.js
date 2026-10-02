'use strict';
/**
 * Verifies that conversational openers are answered outright, and — far more
 * importantly — that nothing which is actually a request gets swallowed by
 * them.
 *
 *   node scripts/test-smalltalk.js
 *
 * The second half is the point. Routing "what's up?" to a web search is a minor
 * embarrassment; routing "what's up with the build?" to a canned greeting would
 * be a real bug, so the patterns are checked against things that must still
 * reach a real tool.
 */
const { matchIntent } = require('../src/core/agent/intents');
const { buildTools, SMALL_TALK } = require('../src/core/agent/tools');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};

const tools = buildTools({
  config: { get: (k, d) => (k === 'apps' ? {} : d) },
  bridge: {}, browser: null, connections: { get: () => null }, logger: { info() {}, warn() {} }
});

const routeOf = (text) => {
  const r = matchIntent(text, tools);
  return r ? { tool: r.tool.name, args: r.args } : null;
};

(async () => {
  console.log('\nConversational openers are answered without a lookup:');
  const expected = [
    ['hi', 'greeting'],
    ['hello!', 'greeting'],
    ['hey', 'greeting'],
    ['good morning', 'morning'],
    ['good evening', 'evening'],
    ["what's up?", 'howAreYou'],
    ['whats up', 'howAreYou'],
    ['how are you', 'howAreYou'],
    ['how is it going', 'howAreYou'],
    ['thanks', 'thanks'],
    ['thank you!', 'thanks'],
    ['cheers', 'thanks'],
    ['who are you', 'identity'],
    ['what can you do', 'capability'],
    ['help', 'capability'],
    ['goodbye', 'goodbye'],
    ['never mind', 'goodbye'],
    ['sorry', 'sorry']
  ];
  for (const [text, kind] of expected) {
    const r = routeOf(text);
    check(`"${text}" -> small talk (${kind})`,
      r && r.tool === 'small_talk' && r.args.kind === kind,
      JSON.stringify(r));
  }

  console.log('\nEvery kind the router asks for actually has a reply:');
  const kinds = new Set(expected.map(([, k]) => k));
  for (const kind of kinds) {
    check(`"${kind}" has at least one line`,
      Array.isArray(SMALL_TALK[kind]) && SMALL_TALK[kind].length > 0,
      JSON.stringify(SMALL_TALK[kind]));
  }

  console.log('\nReal requests must NOT be swallowed:');
  const mustNotBeSmallTalk = [
    "what's up with the build",
    'what is up with my calendar',
    'how are the numbers looking',
    'how do I write a for loop in rust',
    'who are you going to email',
    'what can you do about the error in line 40',
    'thanks for nothing, now check my email',
    'help me write an essay about the moon',
    'hi there, what is on my calendar today',
    'say hello to Priya in an email',
    'good morning everyone, draft that as a message',
    'sorry I meant check my inbox'
  ];
  for (const text of mustNotBeSmallTalk) {
    const r = routeOf(text);
    check(`"${text.slice(0, 44)}" is not small talk`,
      !r || r.tool !== 'small_talk',
      JSON.stringify(r));
  }

  console.log('\nApostrophes, which transcription drops or curls:');
  // Whisper returns "whats playing" as readily as "what's playing", and emits
  // a curly apostrophe depending on the sentence. A pattern that requires one
  // straight apostrophe silently does nothing, which is how "whats playing"
  // came to be unroutable.
  const forms = [
    ['whats playing', 'now_playing'],
    ["what's playing", 'now_playing'],
    ['what’s playing', 'now_playing'],
    ['what is playing', 'now_playing'],
    ['whats on my screen', 'read_screen'],
    ['whats selected', 'read_selection'],
    ['whats open', 'list_windows'],
    ['whats up', 'small_talk'],
    ['what’s up', 'small_talk'],
    ['whats this', 'point_and_ask'],
    // \b does not match between "what" and "s", so these missed the web
    // lookup entirely and fell through to the model.
    ['whats up with the build', 'answer_from_web'],
    ['whos the prime minister', 'answer_from_web']
  ];
  for (const [text, want] of forms) {
    const r = routeOf(text);
    check(`"${text}" -> ${want}`, r && r.tool === want, JSON.stringify(r));
  }

  console.log('\nThe small-talk tool itself:');
  const tool = tools.find((t) => t.name === 'small_talk');
  check('it is registered', Boolean(tool));
  check('it needs no network or model', tool && !tool.mutating, JSON.stringify(tool && tool.mutating));
  for (const kind of Object.keys(SMALL_TALK)) {
    const r = await tool.run({ kind });
    check(`"${kind}" answers with a spoken line`,
      r.ok && r.summary && r.spoken === r.summary && SMALL_TALK[kind].includes(r.summary),
      JSON.stringify(r));
  }
  {
    const r = await tool.run({ kind: 'nonsense' });
    check('an unknown kind still answers rather than throwing', r.ok && Boolean(r.summary), JSON.stringify(r));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
