'use strict';
/**
 * How long the spoken answer takes to make, and what that depends on.
 *
 *   node scripts/bench-speech.js
 *
 * Must be a file rather than `node -e`: kokoro-js resolves its voice data
 * against __dirname, which `node -e` sets to the working directory.
 */
const fs = require('fs');
const os = require('os');
const { KokoroTts } = require('../src/core/tts/kokoro');
const { config } = require('../src/core/config');

const quiet = { info() {}, warn() {}, debug() {} };

/** The lines the assistant actually says, longest first. */
const LINES = [
  ['weather', 'Tomorrow in Marietta: foggy, high of 82, low of 69, 30 percent chance of rain.'],
  ['weather, trimmed', 'Tomorrow: foggy, high 82, low 69.'],
  ['briefing', 'You have 1 thing on your calendar, nothing due and 6 unread emails. First up, Coding Team Update Meeting at 10:30 PM.'],
  ['briefing, first sentence', 'You have 1 thing on your calendar, nothing due and 6 unread emails.'],
  ['grades', 'You are on 99.1 percent, 218 out of 220.'],
  ['email', 'You have 6 messages. The latest is from PostHog.'],
  ['opening line', 'Checking your email.']
];

(async () => {
  console.log(`\nfree RAM: ${(os.freemem() / 1e9).toFixed(2)}GB of ${(os.totalmem() / 1e9).toFixed(1)}GB\n`);

  const speed = Number(process.argv[2]) || config.get('tts.speed', 1);
  const tts = new KokoroTts({
    voice: config.get('tts.voice', 'af_heart'),
    dtype: config.get('tts.dtype', 'q4'),
    speed,
    logger: quiet
  });
  console.log(`speaking rate: ${speed}`);
  const t0 = Date.now();
  await tts.start();
  console.log(`model resident in ${Date.now() - t0}ms\n`);

  console.log('line                           chars   audio    synth   realtime');
  console.log('-'.repeat(66));

  for (const [label, text] of LINES) {
    // Warm once so the first line does not carry the first-call cost.
    await tts.synthesize(text, { cache: false }).then((r) => fs.rmSync(r.path, { force: true }));

    const t = Date.now();
    const r = await tts.synthesize(text, { cache: false });
    const ms = Date.now() - t;
    const seconds = (fs.statSync(r.path).size - 44) / 2 / 24000;
    fs.rmSync(r.path, { force: true });

    console.log(
      label.padEnd(30) +
      String(text.length).padStart(5) +
      `${seconds.toFixed(1)}s`.padStart(8) +
      `${ms}ms`.padStart(9) +
      `${(ms / 1000 / seconds).toFixed(2)}x`.padStart(10)
    );
  }

  console.log('-'.repeat(66));
  console.log('\nSynthesis time is proportional to how much is said, so the single');
  console.log('biggest lever on how long a reply takes is how long the reply is.\n');

  tts.stop();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
