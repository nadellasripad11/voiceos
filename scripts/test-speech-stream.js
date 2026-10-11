'use strict';
/**
 * Verifies that a reply spoken while it is still being written comes out whole,
 * in order, and no more than once.
 *
 *   node scripts/test-speech-stream.js
 *
 * Uses a fake synthesizer with deliberately uneven delays, so a race in the
 * queue shows up as clips arriving out of order rather than as a flaky timing.
 */
const { SpeechStream, completeLength, firstClipLength } = require('../src/core/tts/stream');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Returns later for shorter lines, so ordering cannot pass by luck. */
function fakeTts(spokenOut) {
  return {
    async synthesizeBase64(line) {
      await sleep(Math.max(5, 60 - line.length));
      spokenOut.push(line);
      return { data: Buffer.from(line).toString('base64'), voice: 'test', ms: 1 };
    }
  };
}

function makeStream(opts = {}) {
  const spoken = [];
  const clips = [];
  const stream = new SpeechStream({
    tts: fakeTts(spoken),
    emit: (clip) => clips.push(clip),
    logger: { warn() {} },
    minFirstChars: 0,
    ...opts
  });
  return { stream, spoken, clips };
}

/** Feeds text one character at a time, as a token stream would. */
async function typeIn(stream, text, step = 3) {
  for (let i = step; i <= text.length; i += step) {
    stream.push(text.slice(0, i));
    await sleep(1);
  }
  return stream.finish(text);
}

(async () => {
  console.log('\nFinding sentence boundaries:');
  check('no boundary yet in a part-written sentence', completeLength('A compiler translates') === 0);
  check('a full stop is a boundary', completeLength('One. Two') === 4, String(completeLength('One. Two')));
  check('the last boundary wins', completeLength('One. Two. Three') === 9, String(completeLength('One. Two. Three')));
  check('a trailing stop with no space is not yet complete', completeLength('One.') === 0, String(completeLength('One.')));
  check('a closing quote is part of the boundary',
    completeLength('He said "stop." Then') === 15, String(completeLength('He said "stop." Then')));
  check('decimals are not boundaries', completeLength('It costs 3.50 and') === 0, String(completeLength('It costs 3.50 and')));

  console.log('\nSpeaking a streamed reply:');
  {
    const text = 'A compiler translates source code. It checks for errors first. Then it emits machine code.';
    const { stream, spoken, clips } = makeStream();
    await typeIn(stream, text);

    check('every sentence was spoken', spoken.length === 3, JSON.stringify(spoken));
    check('nothing was spoken twice', new Set(spoken).size === spoken.length, JSON.stringify(spoken));
    check('the whole reply was covered',
      spoken.join(' ').replace(/\s+/g, ' ') === text,
      `got "${spoken.join(' ')}"`);
    check('clips are emitted in order',
      clips.every((c, i) => c.seq === i),
      JSON.stringify(clips.map((c) => c.seq)));
    check('clip order matches sentence order',
      clips.map((c) => Buffer.from(c.data, 'base64').toString()).join(' ') === spoken.join(' '),
      JSON.stringify(clips.map((c) => Buffer.from(c.data, 'base64').toString())));
  }

  console.log('\nSpeech starts before the reply is finished:');
  {
    const { stream, clips } = makeStream();
    stream.push('The kettle is on. ');
    await sleep(120);
    const early = clips.length;
    stream.push('The kettle is on. It will whistle shortly. ');
    await stream.finish('The kettle is on. It will whistle shortly. And then it stops.');
    check('the first sentence was spoken before the rest arrived', early === 1, `${early} clip(s) after the first sentence`);
    check('the remaining sentences followed', clips.length === 3, `${clips.length} clips`);
  }

  console.log('\nA reply with no sentence ending at all:');
  {
    const { stream, spoken } = makeStream();
    stream.push('seventeen degrees');
    await sleep(60);
    const before = spoken.length;
    await stream.finish('seventeen degrees');
    check('nothing is spoken until it is finished', before === 0, JSON.stringify(spoken));
    check('finish speaks the remainder', spoken.join('') === 'seventeen degrees', JSON.stringify(spoken));
  }

  console.log('\nLong replies are not read out in full:');
  {
    const sentence = 'This sentence is exactly the sort of filler that pads a reply. ';
    const text = sentence.repeat(12);
    const { stream, spoken } = makeStream({ maxChars: 120 });
    await typeIn(stream, text, 20);
    const total = spoken.join(' ').length;
    check('speech stops near the budget', total > 0 && total < 240, `${total} chars spoken of ${text.length}`);
    check('it still spoke whole sentences',
      spoken.every((s) => /[.!?]$/.test(s.trim())),
      JSON.stringify(spoken));
  }

  console.log('\nA reply handed over complete is still split:');
  {
    // Routed answers arrive whole rather than a token at a time, and finish()
    // used to enqueue the lot as one utterance — so nothing was heard until
    // all of it had been synthesized. Measured, that was 5502ms of silence
    // for the weather against 2921ms when split.
    const { stream, spoken, clips } = makeStream();
    await stream.finish('78 and overcast. High 82, low 69.');
    check('a complete reply is split into sentences', spoken.length === 2, JSON.stringify(spoken));
    check('the first clip is the first sentence',
      clips.length > 0 && Buffer.from(clips[0].data, 'base64').toString() === '78 and overcast.',
      JSON.stringify(clips.map((c) => Buffer.from(c.data, 'base64').toString())));
    check('nothing is lost in the split',
      spoken.join(' ') === '78 and overcast. High 82, low 69.', JSON.stringify(spoken));
  }
  {
    // A fragment too short to be worth its own synthesis call rides along
    // with the next one.
    const { stream, spoken } = makeStream();
    await stream.finish('Yes. The capybara is the largest living rodent.');
    check('a tiny fragment is not given its own call', spoken.length === 1, JSON.stringify(spoken));
  }

  console.log('\nCancelling mid-reply:');
  {
    const { stream, spoken, clips } = makeStream();
    stream.push('One sentence here. Another sentence here. ');
    stream.cancel();
    await stream.finish('One sentence here. Another sentence here. A third one.');
    check('cancelling stops further clips', clips.length === 0, JSON.stringify(clips.map((c) => c.seq)));
    check('and stops synthesis too', spoken.length === 0, JSON.stringify(spoken));
  }

  console.log('\nRetracting preamble the model abandoned:');
  {
    // The model writes a line, decides to call a tool, and the real answer
    // replaces what it wrote. The offsets must not carry over.
    const { stream, spoken, clips } = makeStream();
    stream.push('Let me check that for you. ');
    await sleep(80);
    stream.reset();
    await typeIn(stream, 'You have three messages waiting. The first is from Priya.');

    const all = spoken.join(' ');
    check('the real answer is spoken whole',
      all.includes('You have three messages waiting.') && all.includes('The first is from Priya.'),
      JSON.stringify(spoken));
    check('nothing is sliced from the abandoned text',
      !spoken.some((s) => s.includes('check that for you') && s.includes('You have')),
      JSON.stringify(spoken));
    check('clips still arrive in order', clips.every((c, i) => i === 0 || c.seq > clips[i - 1].seq),
      JSON.stringify(clips.map((c) => c.seq)));
  }

  console.log('\nMarkdown is not read aloud:');
  {
    const { stream, spoken } = makeStream();
    await typeIn(stream, '**Bold** and `code` and a [link](https://example.com) here. Done.');
    const all = spoken.join(' ');
    check('backticks and asterisks are stripped',
      !all.includes('`') && !all.includes('**'), JSON.stringify(all));
    check('a URL becomes "a link"', all.includes('a link'), JSON.stringify(all));
  }

  console.log('\nThe first clip is the only one the user waits in silence for:');
  {
    // Every later clip is synthesized while the previous one plays, so its
    // length is free. The first is pure waiting, and synthesis here runs at
    // roughly realtime: each second of audio in it is a second of nothing
    // happening. Shortest usable fragment wins, even mid-sentence.
    const long = 'The capital of France is Paris, a city known for its art, fashion and cuisine, and the seat of government for centuries.';
    const first = long.slice(0, firstClipLength(long, 24));
    check('it breaks at the first clause, not the full stop',
      first === 'The capital of France is Paris,', JSON.stringify(first));
    check('which is a fraction of the whole sentence',
      first.length < long.length / 3, first.length + ' of ' + long.length);

    // Short clauses are passed over until one is worth a synthesis call:
    // "Yes," and "Yes, I can do that," are both under the floor, so the first
    // clip runs on to the full stop.
    const stubby = 'Yes, I can do that, certainly. ';
    check('short clauses are passed over for the next one',
      stubby.slice(0, firstClipLength(stubby, 24)) === 'Yes, I can do that, certainly.',
      JSON.stringify(stubby.slice(0, firstClipLength(stubby, 24))));
    check('nothing is spoken before a long enough clause arrives',
      firstClipLength('The capital of France', 24) === 0);

    // Later clips must still take the longest complete run, or the reply comes
    // out as a stutter of fragments.
    check('later clips still take whole sentences',
      completeLength('One. Two. Three. ') === 'One. Two. Three.'.length,
      String(completeLength('One. Two. Three. ')));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
