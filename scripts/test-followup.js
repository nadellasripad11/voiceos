'use strict';
/**
 * Understanding "what about tomorrow".
 *
 *   node scripts/test-followup.js
 *
 * A conversation is mostly fragments, and the router read every utterance
 * fresh — so "what about tomorrow" became a web search for the literal words
 * "what about tomorrow". That got worse the moment the microphone started
 * reopening after each answer, because not repeating yourself is the entire
 * point of a conversation.
 *
 * The risk runs one way. Merging a fragment that was meant as a fragment costs
 * nothing if it is slightly clumsy; merging a real question turns "play some
 * drake" into gibberish attached to whatever came before. So most of this file
 * is sentences that must be left alone.
 */
const { asFollowUp, WINDOW_MS } = require('../src/core/agent/followup');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};

const after = (question) => ({ question, at: Date.now() });

(async () => {
  console.log('\nA fragment continues the question before it:');
  for (const [said, want] of [
    ['what about tomorrow', 'whats the weather tomorrow'],
    ['how about friday', 'whats the weather friday'],
    ['and in london', 'whats the weather in london'],
    ['in london', 'whats the weather in london'],
    ['ok what about london', 'whats the weather london'],
    ['what about tomorrow?', 'whats the weather tomorrow']
  ]) {
    const got = asFollowUp(said, after('whats the weather'));
    check(`"${said}"`, got === want, `got ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
  }

  console.log('\nA question that stands on its own is never merged:');
  for (const said of [
    'what is the capital of france',
    'play some drake',
    'text maya that i am running late',
    'check my grades on canvas',
    'what are you doing',
    'and i also wanted to ask about the chemistry homework due on thursday'
  ]) {
    const got = asFollowUp(said, after('whats the weather'));
    check(`"${said.slice(0, 44)}"`, got === null, `merged into ${JSON.stringify(got)}`);
  }

  console.log('\nThings that only look like fragments:');
  {
    check('a hypothetical is not a parameter change',
      asFollowUp('what if it rains', after('whats the weather')) === null,
      '"what if it rains" spliced to "whats the weather it rains"');
    check('"in the morning" is a time, not a place',
      asFollowUp('in the morning', after('whats the weather')) === null);
  }

  console.log('\nThere has to be something to continue:');
  {
    check('nothing before it', asFollowUp('what about tomorrow', null) === null);
    check('an empty previous question', asFollowUp('what about tomorrow', after('')) === null);
    check('and nothing said at all', asFollowUp('', after('whats the weather')) === null);
  }

  console.log('\nIt goes stale:');
  {
    // Ten minutes later, "and in london" is a new thought that happens to
    // start with "and", not a continuation of a conversation long finished.
    const old = { question: 'whats the weather', at: Date.now() - (WINDOW_MS + 5000) };
    check('an old question is not continued', asFollowUp('and in london', old) === null);
    const fresh = { question: 'whats the weather', at: Date.now() - 2000 };
    check('a recent one is', asFollowUp('and in london', fresh) === 'whats the weather in london');
  }

  console.log('\nIt chains, so a conversation can narrow twice:');
  {
    const first = asFollowUp('what about tomorrow', after('whats the weather'));
    const second = asFollowUp('and in london', after(first));
    check('the second fragment builds on the first',
      second === 'whats the weather tomorrow in london', JSON.stringify(second));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
