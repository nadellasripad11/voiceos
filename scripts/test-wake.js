'use strict';
/**
 * Does it hear its name, and does it stay quiet otherwise?
 *
 *   node scripts/test-wake.js
 *
 * The second half matters more than the first. A wake word that fires on
 * ordinary conversation is worse than one that occasionally misses, because
 * it means the machine starts listening while you are talking to someone else.
 * So there are more negatives here than positives, including phrases chosen to
 * sound like the wake word.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { WakeDetector } = require('../src/core/wake/detector');
const { paths, ensureDirs } = require('../src/core/paths');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};

/** Renders a phrase at 16kHz mono with a Windows voice. */
function synthesize(text, outPath, rate = 0) {
  const script = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile(${JSON.stringify(outPath)}, $fmt)
$synth.Rate = ${rate}
$synth.Speak(${JSON.stringify(text)})
$synth.Dispose()
`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(outPath)));
  });
}

/** Reads a 16-bit mono WAV into floats, with a little silence either side. */
function readWav(file) {
  const buf = fs.readFileSync(file);
  let offset = 12;
  while (offset < buf.length - 8) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'data') {
      const n = Math.floor(size / 2);
      // The rolling window needs about three seconds of audio before it can
      // score at all. Live, it is always full; a short clip has to be padded
      // or it is the test that fails rather than the detector.
      const pad = 16000 * 2;
      const out = new Float32Array(pad + n + pad);
      for (let i = 0; i < n; i++) out[pad + i] = buf.readInt16LE(offset + 8 + i * 2) / 32768;
      return out;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('no data chunk in ' + file);
}

/** Feeds a clip in 80ms frames, the way the microphone will, and takes the peak. */
async function peakScore(detector, samples) {
  detector.reset();
  detector.pending = new Float32Array(0);
  detector.lastHit = 0;
  detector.lastScore = 0;
  let peak = 0;
  let fired = false;
  const FRAME = 1280;
  for (let i = 0; i + FRAME <= samples.length; i += FRAME) {
    const r = await detector.push(samples.subarray(i, i + FRAME));
    if (r.score > peak) peak = r.score;
    if (r.hit) fired = true;
  }
  return { peak, fired };
}

(async () => {
  ensureDirs();
  const modelDir = path.join(paths.models, 'wake');
  const detector = new WakeDetector({ modelDir, threshold: 0.5, logger: { info: () => {} } });

  console.log('\nModels:');
  check('the three models are present', detector.available(), modelDir);
  if (!detector.available()) { console.log('\nCannot test without the models.\n'); process.exit(1); }

  const t0 = Date.now();
  await detector.load();
  console.log(`        loaded in ${Date.now() - t0}ms`);

  const tmp = path.join(paths.tmp, 'wake');
  fs.mkdirSync(tmp, { recursive: true });
  const clip = async (text, rate = 0) => {
    const f = path.join(tmp, text.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) + `_r${rate}.wav`);
    if (!fs.existsSync(f)) await synthesize(text, f, rate);
    return readWav(f);
  };

  console.log('\nIt should hear its name:');
  const positives = [
    ['Hey Jarvis', 0],
    ['Hey Jarvis', -1],
    ['Hey Jarvis, play some music', 0],
    ['hey jarvis what is the weather', 0],
    ['Hey Jarvis, what is due this week', 0]
  ];
  const posScores = [];
  for (const [text, rate] of positives) {
    const { peak, fired } = await peakScore(detector, await clip(text, rate));
    posScores.push({ text, peak, fired });
    check(`"${text}"${rate ? ` (faster)` : ''} -> ${peak.toFixed(3)}`, fired, `peak ${peak.toFixed(3)}, below the 0.5 threshold`);
  }

  console.log('\nIt must stay quiet otherwise:');
  const negatives = [
    'Hello there, how are you today',
    'play some music on Spotify',
    'What is the weather going to be tomorrow',
    'I was talking to Dave about the project',
    'Can you pass me the salt please',
    // Deliberately close: these are the ones that would be embarrassing.
    'Hey Travis',
    'Harvest festival',
    'Service is down again',
    'Hey Jeeves'
  ];
  const negScores = [];
  for (const text of negatives) {
    const { peak, fired } = await peakScore(detector, await clip(text));
    negScores.push({ text, peak });
    check(`"${text}" stays quiet (${peak.toFixed(3)})`, !fired, `peak ${peak.toFixed(3)} fired`);
  }

  console.log('\nTwo limitations, asserted so they cannot be quietly forgotten:');
  {
    // The pretrained model keys on one exact phrase. "Wake up Jarvis" is not
    // a variation of it as far as the model is concerned — it scores near
    // zero rather than near the threshold, so no tuning reaches it and a
    // different wake phrase would need a model trained for it.
    const { peak } = await peakScore(detector, await clip('Wake up Jarvis'));
    check(`"Wake up Jarvis" is not recognised (${peak.toFixed(3)}) — the model knows one phrase`,
      peak < 0.5, `it scored ${peak.toFixed(3)}; this limitation may have gone away`);
  }
  {
    // Said quickly, the phrase is compressed relative to what the model was
    // trained on and the score collapses. 0.18 against a worst false positive
    // of 0.14 leaves no room to lower the threshold, so the honest answer is
    // that it needs to be said at a normal pace.
    const { peak } = await peakScore(detector, await clip('Hey Jarvis', 3));
    check(`said quickly it is missed (${peak.toFixed(3)}) — it needs a normal pace`,
      peak < 0.5, `it scored ${peak.toFixed(3)}; rate sensitivity may have improved`);
  }

  console.log('\nThe gap between them:');
  const lowestPos = Math.min(...posScores.map((p) => p.peak));
  const highestNeg = Math.max(...negScores.map((n) => n.peak));
  console.log(`        quietest wake phrase : ${lowestPos.toFixed(3)}`);
  console.log(`        loudest other speech : ${highestNeg.toFixed(3)}  ("${negScores.find((n) => n.peak === highestNeg).text}")`);
  check('there is clear daylight between them', lowestPos > highestNeg,
    `${lowestPos.toFixed(3)} vs ${highestNeg.toFixed(3)}`);

  console.log('\nIt fires once per phrase, not once per window:');
  {
    const samples = await clip('Hey Jarvis');
    detector.reset();
    detector.pending = new Float32Array(0);
    detector.lastHit = 0;
    detector.lastScore = 0;
    let hits = 0;
    for (let i = 0; i + 1280 <= samples.length; i += 1280) {
      const r = await detector.push(samples.subarray(i, i + 1280));
      if (r.hit) hits++;
    }
    check('exactly one hit', hits === 1, `${hits} hits`);
  }

  console.log('\nCost, which has to be near nothing to run all the time:');
  {
    const silence = new Float32Array(16000 * 3);
    const t = Date.now();
    for (let i = 0; i + 1280 <= silence.length; i += 1280) await detector.push(silence.subarray(i, i + 1280));
    const ms = Date.now() - t;
    const realtime = ms / 3000;
    check('it runs far faster than realtime', realtime < 0.25, `${(realtime * 100).toFixed(1)}% of one core`);
    console.log(`        3s of audio in ${ms}ms — ${(realtime * 100).toFixed(1)}% of a core`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
