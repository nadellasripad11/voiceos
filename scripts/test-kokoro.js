'use strict';
/**
 * Checks the Kokoro engine from a real CommonJS module.
 *
 *   node scripts/test-kokoro.js
 *
 * Run through `node -e` this fails with ENOENT on <cwd>/../voices: kokoro-js
 * resolves its voice files against `__dirname`, which `node -e` sets to the
 * working directory. From a module file it resolves against the package, which
 * is why this has to be a file rather than a one-liner.
 */
const fs = require('fs');
const { KokoroTts } = require('../src/core/tts/kokoro');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};

(async () => {
  console.log('\nLoading:');
  check('kokoro-js is installed', KokoroTts.available());

  const tts = new KokoroTts({ voice: 'heart', logger: { info: (m) => console.log('       ', m), warn() {}, debug() {} } });
  const t0 = Date.now();
  await tts.start();
  console.log(`        model resident in ${Date.now() - t0}ms`);
  check('it is running', tts.running);

  console.log('\nSynthesis:');
  const r = await tts.synthesize('You have three new messages.', { cache: false });
  check('it produced a file', fs.existsSync(r.path), r.path);
  const bytes = fs.statSync(r.path).size;
  const seconds = (bytes - 44) / 2 / 24000;
  check('the audio is a plausible length', seconds > 1 && seconds < 5, `${seconds.toFixed(2)}s`);
  check('it is faster than speaking it', r.ms / 1000 < seconds, `${r.ms}ms for ${seconds.toFixed(2)}s`);
  console.log(`        ${r.ms}ms for ${seconds.toFixed(2)}s of audio (${(r.ms / 1000 / seconds).toFixed(2)}x realtime)`);
  fs.rmSync(r.path, { force: true });

  console.log('\nOrder is preserved when several are queued:');
  const words = ['One.', 'Two.', 'Three.', 'Four.'];
  const q0 = Date.now();
  const results = await Promise.all(words.map((w) => tts.synthesize(w, { cache: false })));
  check('all four came back', results.every((x) => fs.existsSync(x.path)));
  check('they were serialized, not run at once',
    Date.now() - q0 > Math.max(...results.map((x) => x.ms)),
    `${Date.now() - q0}ms total vs slowest ${Math.max(...results.map((x) => x.ms))}ms`);
  results.forEach((x) => fs.rmSync(x.path, { force: true }));

  console.log('\nThe cache:');
  const LINE = 'Checking your email.';
  const warm = await tts.warmPhrases([LINE]);
  check('the phrase was rendered', warm.rendered >= 0, JSON.stringify(warm));
  check('it is now cached', Boolean(tts.cached(LINE)), String(tts.cached(LINE)));
  const hit = await tts.synthesize(LINE);
  check('a cached phrase costs nothing', hit.cached === true && hit.ms === 0, JSON.stringify(hit));

  const b64 = await tts.synthesizeBase64(LINE);
  check('cached audio survives being played', Boolean(tts.cached(LINE)) && b64.data.length > 100);

  console.log('\nVoices:');
  check('a friendly name resolves', new KokoroTts({ voice: 'bella' }).voice === 'af_bella');
  check('a raw id passes through', new KokoroTts({ voice: 'af_nicole' }).voice === 'af_nicole');
  check('an empty name falls back', new KokoroTts({}).voice === 'af_heart');

  tts.stop();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
