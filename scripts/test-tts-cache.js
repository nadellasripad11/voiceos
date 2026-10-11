'use strict';
/**
 * Verifies the fixed-phrase cache: that a cached phrase is instant, that it
 * survives being played, and that the cache cannot grow without bound.
 *
 *   node scripts/test-tts-cache.js
 *
 * Needs Piper installed, since the point is to measure real synthesis against
 * a real cache read.
 */
const fs = require('fs');
const { PiperTts } = require('../src/core/tts/piper');
const { config } = require('../src/core/config');

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};

// Phrases unique to this test, so a real install's cache is left alone.
const PHRASES = [
  'Cache test one, checking the inbox.',
  'Cache test two, looking at the calendar.'
];

(async () => {
  const tts = new PiperTts({ voice: config.get('tts.voice'), logger: quiet });
  if (!tts.status().ready) {
    // Skipped, not failed. Piper is the fallback engine and the app speaks
    // with Kokoro, so a machine without it is a normal machine — exiting
    // non-zero here reported a healthy setup as a broken one.
    console.log('\nPiper is not installed; skipping the cache test.\n');
    process.exit(0);
  }

  await tts.start();

  // Start from a known state for these phrases only.
  for (const p of PHRASES) {
    const key = tts.cacheKey(p);
    fs.rmSync(`${tts.cacheDir}/${key}.wav`, { force: true });
  }
  tts.loadCache();

  console.log('\nRendering the fixed phrases:');
  const t0 = Date.now();
  const r = await tts.warmPhrases(PHRASES);
  console.log(`        rendered ${r.rendered} phrase(s) in ${Date.now() - t0}ms`);
  check('both were rendered', r.rendered === 2, JSON.stringify(r));
  check('both are now cached', PHRASES.every((p) => tts.cached(p)), JSON.stringify(PHRASES.map((p) => Boolean(tts.cached(p)))));

  console.log('\nA cached phrase costs nothing to produce:');
  const cold = await tts.synthesize('A line that is deliberately not in the cache at all.', { cache: false });
  fs.rmSync(cold.path, { force: true });

  const t1 = Date.now();
  const hit = await tts.synthesize(PHRASES[0]);
  const hitMs = Date.now() - t1;
  check('it is reported as cached', hit.cached === true, JSON.stringify(hit));
  check('it is far quicker than synthesizing', hitMs < Math.max(50, cold.ms / 4),
    `cache ${hitMs}ms vs synthesis ${cold.ms}ms`);
  console.log(`        synthesis ${cold.ms}ms, cache read ${hitMs}ms`);

  console.log('\nPlaying a cached phrase does not consume it:');
  const audio = await tts.synthesizeBase64(PHRASES[0]);
  check('audio came back', audio.data && audio.data.length > 100, String(audio.data && audio.data.length));
  check('the cached file still exists', Boolean(tts.cached(PHRASES[0])), 'the file was deleted after reading');
  const again = await tts.synthesizeBase64(PHRASES[0]);
  check('and it can be played again', again.data === audio.data, 'the second read differed');

  console.log('\nThe cache stays bounded:');
  const before = tts.cache.size;
  const oneOff = await tts.synthesize('An ordinary reply that nobody registered.', {});
  fs.rmSync(oneOff.path, { force: true });
  check('an unregistered line is not added', tts.cache.size === before, `${before} -> ${tts.cache.size}`);

  console.log('\nRe-warming does no work twice:');
  const second = await tts.warmPhrases(PHRASES);
  check('nothing is re-rendered', second.rendered === 0, JSON.stringify(second));

  console.log('\nChanging voice invalidates the cache:');
  const keyBefore = tts.cacheKey(PHRASES[0]);
  tts.voice = 'en_US-amy-medium';
  check('the key depends on the voice', tts.cacheKey(PHRASES[0]) !== keyBefore, 'the key did not change');
  check('and the old audio is not reused', tts.cached(PHRASES[0]) === null, String(tts.cached(PHRASES[0])));

  // Leave nothing behind.
  tts.voice = config.get('tts.voice');
  for (const p of PHRASES) fs.rmSync(`${tts.cacheDir}/${tts.cacheKey(p)}.wav`, { force: true });

  tts.stop();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
