'use strict';
/**
 * Does splitting a reply into sentences get it heard sooner?
 *
 *   node scripts/bench-split.js
 *
 * Synthesis here runs slower than speech (about 1.2x realtime), so splitting
 * cannot remove the wait — it moves it. The question this answers is whether
 * it moves it to a better place: a shorter wait before the first word, at the
 * cost of a pause between sentences.
 */
const fs = require('fs');
const os = require('os');
const { KokoroTts } = require('../src/core/tts/kokoro');
const { SpeechStream, splitSentences } = require('../src/core/tts/stream');
const { config } = require('../src/core/config');

const quiet = { info() {}, warn() {}, debug() {} };

/** The lines it actually says. */
const LINES = [
  ['weather', '78 and overcast. High 82, low 69.'],
  ['briefing', 'You have 1 on your calendar, nothing due and 6 unread. First, Coding Team Update Meeting at 10:30 PM.'],
  ['grades', "You're on 99.1 percent."],
  ['email', '6 messages, latest from PostHog.']
];

(async () => {
  console.log(`\nfree RAM: ${(os.freemem() / 1e9).toFixed(2)}GB of ${(os.totalmem() / 1e9).toFixed(1)}GB\n`);

  const tts = new KokoroTts({
    voice: config.get('tts.voice', 'af_heart'),
    dtype: config.get('tts.dtype', 'q4'),
    logger: quiet
  });
  await tts.start();

  console.log('line         sentences   first word   all of it   whole-at-once');
  console.log('-'.repeat(68));

  for (const [label, text] of LINES) {
    const pieces = splitSentences(text);

    // Streamed, which is what it does now.
    let firstAt = null;
    const t0 = Date.now();
    const stream = new SpeechStream({
      tts, logger: quiet,
      emit: () => { if (firstAt === null) firstAt = Date.now() - t0; }
    });
    await stream.finish(text);
    const allAt = Date.now() - t0;

    // In one piece, which is what it did before.
    const t1 = Date.now();
    const whole = await tts.synthesize(text, { cache: false });
    const wholeAt = Date.now() - t1;
    fs.rmSync(whole.path, { force: true });

    console.log(
      label.padEnd(13) +
      String(pieces.length).padStart(6) +
      `${firstAt}ms`.padStart(13) +
      `${allAt}ms`.padStart(12) +
      `${wholeAt}ms`.padStart(15)
    );
  }

  console.log('-'.repeat(68));
  console.log('\nfirst word     = when the reply starts being heard');
  console.log('whole-at-once  = how long before any sound, the old way\n');

  tts.stop();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
