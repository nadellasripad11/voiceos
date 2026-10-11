'use strict';
/**
 * Runs every test file, one at a time.
 *
 *   node scripts/test-all.js            everything
 *   node scripts/test-all.js --fast     skip the ones that load models
 *
 * Serially, and in a child process each, because several of these load whisper
 * or Kokoro and this machine does not have the memory to hold two at once —
 * running them in parallel does not fail honestly, it fails as an allocation
 * error somewhere unrelated.
 *
 * The exit code is the verdict. The printed "N passed, N failed" line is a
 * convenience and not every file prints one: a reporting loop that reads only
 * that line reports the files without it as whatever it saw last, which is how
 * three passing tests came to be recorded as failures.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** These load a model or need hardware, and are slow rather than broken. */
const HEAVY = new Set([
  'test-kokoro.js', 'test-stt.js', 'test-long-audio.js', 'test-browser.js',
  'test-agent.js', 'test-agent-stream.js', 'test-stream.js', 'test-tts-cache.js',
  'test-bridge.js', 'test-inject.js', 'test-point.js', 'test-wake.js'
]);

const fast = process.argv.includes('--fast');
const dir = path.join(__dirname);
const files = fs.readdirSync(dir)
  .filter((f) => /^test-.*\.js$/.test(f))
  // Not itself. Its own name matches the pattern, and a runner that runs
  // itself runs itself, which is a ten-minute timeout rather than a result.
  .filter((f) => f !== path.basename(__filename))
  .filter((f) => !fast || !HEAVY.has(f))
  .sort();

const results = [];
for (const file of files) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, file)], {
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    cwd: path.join(__dirname, '..')
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const summary = (out.match(/\d+ passed, \d+ failed/g) || []).pop() || null;
  // Some files report differently, and some skip themselves when the thing
  // they test is not installed. Neither is a failure.
  const skipped = /not installed|cannot test|skipping/i.test(out) && r.status === 0;
  results.push({
    file,
    code: r.status,
    timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT'),
    summary,
    skipped,
    seconds: ((Date.now() - started) / 1000).toFixed(1),
    tail: out.trim().split('\n').slice(-3).join(' | ').slice(0, 160)
  });

  const last = results[results.length - 1];
  const mark = last.timedOut ? 'TIMEOUT' : last.code === 0 ? (last.skipped ? 'skip' : 'ok') : 'FAIL';
  console.log(`${mark.padEnd(8)}${file.padEnd(26)}${String(last.seconds).padStart(6)}s  ${last.summary || last.tail.slice(0, 60)}`);
}

const failed = results.filter((r) => r.code !== 0 || r.timedOut);
const skipped = results.filter((r) => r.skipped);
console.log(`\n${results.length} files · ${results.length - failed.length} ok` +
            `${skipped.length ? ` (${skipped.length} skipped)` : ''}` +
            `${failed.length ? ` · ${failed.length} FAILED` : ''}`);
for (const f of failed) console.log(`  ${f.file}: exit ${f.code}${f.timedOut ? ' (timed out)' : ''}\n    ${f.tail}`);
process.exit(failed.length ? 1 : 0);
