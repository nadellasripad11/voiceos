'use strict';
/**
 * Unit tests for the deterministic cleanup pass. No model, no network, instant.
 *
 *   node scripts/test-polish.js
 */
const { cleanup, removeFillers, stripWrapping } = require('../src/core/modes/polish');

let pass = 0;
let fail = 0;

function eq(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.log(`  FAIL  ${label}`);
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        actual:   ${JSON.stringify(actual)}`);
    fail++;
  }
}

console.log('\nFiller removal:');
eq('leading filler',
  cleanup('um so I think we should ship it'),
  'So I think we should ship it.');
eq('stutter collapse',
  cleanup('send send the report'),
  'Send the report.');
eq('keeps meaningful "actually" mid-sentence',
  cleanup('I actually tested it'),
  'I actually tested it.');

console.log('\nSpoken punctuation:');
eq('question mark',
  cleanup('can you find his LinkedIn question mark'),
  'Can you find his LinkedIn?');
eq('new paragraph inserts a real paragraph break',
  cleanup('first thought new paragraph second thought'),
  'First thought\n\nSecond thought.');
eq('new line inserts a single break',
  cleanup('first line new line second line'),
  'First line\nSecond line.');
eq('does not eat the noun "period"',
  cleanup('the period after the war was calm'),
  'The period after the war was calm.');

console.log('\nCapitalisation:');
eq('standalone i becomes I',
  cleanup('i think i am right'),
  'I think I am right.');
eq('sentence after terminal punctuation',
  cleanup('done. next item'),
  'Done. Next item.');
eq('abbreviation does not trigger a new sentence',
  cleanup('approx. five people came'),
  'Approx. five people came.');

console.log('\nVocabulary and replacements:');
eq('vocabulary casing',
  cleanup('i use voiceos daily', { vocabulary: ['VoiceOS'] }),
  'I use VoiceOS daily.');
eq('replacement substitution',
  cleanup('send it to my email', { replacements: [{ from: 'my email', to: 'me@example.com' }] }),
  'Send it to me@example.com.');

console.log('\nModel output unwrapping:');
eq('strips code fence', stripWrapping('```\nHello there\n```'), 'Hello there');
eq('strips smart quotes', stripWrapping('“Hello there”'), 'Hello there');
eq('strips preamble', stripWrapping("Here's the cleaned text: Hello there"), 'Hello there');

console.log('\nEdge cases:');
eq('empty input', cleanup(''), '');
eq('whitespace only', cleanup('   \n  '), '');
eq('raw filler-only utterance', removeFillers('um uh hmm'), '');
eq('already clean text is left alone',
  cleanup('The report is ready for review.'),
  'The report is ready for review.');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
