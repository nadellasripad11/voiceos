'use strict';
/**
 * Saying what matters instead of reading out a list.
 *
 *   node scripts/test-digest.js
 *
 * The router answers without the model, which is what makes it quick — and it
 * meant whatever a tool returned was what got spoken. Asked "check my email
 * and tell me what I need to do", it read out all 815 characters of the inbox:
 * every sender and subject, about fifty seconds of talking, and not an answer
 * to the question.
 *
 * The model is stubbed here, so what is under test is not how well it writes.
 * It is the three things around it: that a short answer is left alone, that a
 * failure never costs the user their answer, and that the text is handed over
 * as data rather than as instructions.
 */
const { digest, worthDigesting } = require('../src/core/agent/digest');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};
const quiet = { info() {}, warn() {}, debug() {}, error() {} };

const INBOX = [
  'Maya Patel — Re: Day 19 deck, can you send the slides tonight?',
  'Fulton Schools — Chemistry lab report due Thursday 9am',
  'LinkedIn — 7 new jobs for you',
  'Canvas — New announcement in Honors Chemistry',
  'Mum — dinner sunday?',
  'GitHub — 3 new issues',
  'Spotify — Your Discover Weekly is ready'
].join('\n');

/** A model that answers, stalls, or fails. */
function stub(behaviour = {}) {
  const calls = [];
  return {
    calls,
    async chat(req) {
      calls.push(req);
      if (behaviour.throws) throw new Error(behaviour.throws);
      if (behaviour.hangMs) {
        // A real provider aborts when the signal fires; a stub that ignores it
        // would make the timeout look broken when it is working.
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, behaviour.hangMs);
          req.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('The operation was aborted due to timeout'));
          }, { once: true });
        });
      }
      return { text: behaviour.text ?? 'Two things need doing: the deck tonight and the lab report Thursday.' };
    }
  };
}

(async () => {
  console.log('\nWhat is worth condensing:');
  for (const [label, text, want] of [
    ['a full inbox', INBOX, true],
    ['a one-line answer', 'Paused: Make Them Cry by Drake.', false],
    ['a short forecast', 'Marietta, Georgia: 69F, overcast.', false],
    ['a long paragraph', 'x'.repeat(420), true],
    ['nothing at all', '', false]
  ]) {
    check(`${label} -> ${want ? 'condense' : 'leave alone'}`, worthDigesting(text) === want);
  }

  console.log('\nA list becomes a sentence:');
  {
    const provider = stub();
    const out = await digest({
      question: 'check my email and tell me what I need to do',
      text: INBOX, provider, model: 'stub', logger: quiet
    });
    check('it produced a spoken line', Boolean(out), String(out));
    check('and it is shorter than the list', out.length < INBOX.length, `${out.length} vs ${INBOX.length}`);
  }

  console.log('\nThe tool output is handed over as data, not orders:');
  {
    // An inbox is written by strangers. This is the one place their words
    // reach the model without the user having asked for them.
    const provider = stub();
    await digest({ question: 'what do I need to do', text: INBOX, provider, model: 'stub', logger: quiet });
    const sent = JSON.stringify(provider.calls[0].messages);
    check('it is fenced as untrusted', /UNTRUSTED/.test(sent));
    check('and the model is told not to follow it',
      /not to follow|not yours to follow|not be followed/i.test(sent), sent.slice(0, 200));
    check('the question is included, so it answers that',
      /what do I need to do/.test(sent));
  }

  console.log('\nA short answer is never sent to the model at all:');
  {
    const provider = stub();
    const out = await digest({
      question: "what's playing", text: 'Paused: Make Them Cry by Drake.',
      provider, model: 'stub', logger: quiet
    });
    check('nothing is returned, so the original is spoken', out === null);
    check('and the model was not called', provider.calls.length === 0,
      'a round trip to improve a one-line answer is pure latency');
  }

  console.log('\nIt never costs the user their answer:');
  {
    const broken = stub({ throws: 'groq chat failed (HTTP 429): rate limit' });
    const out = await digest({ question: 'x', text: INBOX, provider: broken, model: 'stub', logger: quiet });
    check('a failing model falls back to the raw result', out === null);

    const slow = stub({ hangMs: 3000 });
    const t = Date.now();
    const slowOut = await digest({
      question: 'x', text: INBOX, provider: slow, model: 'stub', timeoutMs: 300, logger: quiet
    });
    check('a slow model is given up on', slowOut === null);
    check('and quickly, not after the full stall', Date.now() - t < 1500, `${Date.now() - t}ms`);

    check('no provider at all is fine too',
      (await digest({ question: 'x', text: INBOX, provider: null, model: 'stub', logger: quiet })) === null);
  }

  console.log('\nA summary that is not a summary is rejected:');
  {
    // A model that returns more than it was given has explained itself rather
    // than condensed anything, and speaking that is worse than the list.
    const windy = stub({ text: 'I would be happy to help you with that. ' + 'word '.repeat(200) });
    const out = await digest({ question: 'x', text: INBOX, provider: windy, model: 'stub', logger: quiet });
    check('a longer "summary" is discarded', out === null);

    const empty = stub({ text: '   ' });
    check('and so is an empty one',
      (await digest({ question: 'x', text: INBOX, provider: empty, model: 'stub', logger: quiet })) === null);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
