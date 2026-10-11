'use strict';
/**
 * End-to-end check of the local speech-recognition pipeline.
 *
 * Synthesizes known sentences with the built-in Windows voice at 16 kHz mono,
 * then transcribes them with whisper.cpp and scores word accuracy. No
 * microphone and no network needed, so it is safe to run in CI or on a laptop.
 *
 *   node scripts/test-stt.js
 *   node scripts/test-stt.js --model small.en
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { WhisperEngine } = require('../src/core/stt/whisper');
const { paths, ensureDirs } = require('../src/core/paths');
const { config } = require('../src/core/config');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const SENTENCES = [
  'Send an email to David about the project update.',
  'Remind me to send Maya the deck tomorrow morning.',
  'Search for last year tax returns in my documents folder.'
];

/** Renders text to a 16 kHz mono WAV using the Windows speech synthesizer. */
function synthesize(text, outPath) {
  const script = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile(${JSON.stringify(outPath)}, $fmt)
$synth.Rate = 0
$synth.Speak(${JSON.stringify(text)})
$synth.Dispose()
`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(outPath)));
  });
}

const normalize = (s) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

/** Word-level accuracy, so a trailing comma does not count as an error. */
function wordAccuracy(expected, actual) {
  const e = normalize(expected).split(' ');
  const a = new Set(normalize(actual).split(' '));
  const hits = e.filter((w) => a.has(w)).length;
  return e.length ? hits / e.length : 0;
}

(async () => {
  ensureDirs();
  // Whatever the app is configured to use. Hardcoding a filename here meant
  // this test failed the moment an unused model was cleaned off the disk,
  // reporting a missing file as if speech recognition were broken.
  const model = opt('model', config.get('stt.model'));
  const engine = new WhisperEngine({ model, language: 'en' });

  const status = engine.status();
  console.log('\nEngine status:');
  console.log(`  binary  ${status.exe ? path.relative(paths.app, status.exe) : 'MISSING'}`);
  console.log(`  model   ${status.model ? path.basename(status.model) : 'MISSING'}`);
  console.log(`  threads ${status.threads}`);
  if (!status.ready) {
    console.error('\nNot ready:\n  ' + status.problems.join('\n  '));
    process.exit(1);
  }

  let totalAcc = 0;
  let failures = 0;

  for (const [i, sentence] of SENTENCES.entries()) {
    const wav = path.join(paths.tmp, `stt-test-${i}.wav`);
    console.log(`\n[${i + 1}/${SENTENCES.length}] "${sentence}"`);

    try {
      await synthesize(sentence, wav);
      const kb = Math.round(fs.statSync(wav).size / 1024);
      const result = await engine.transcribe(wav, { language: 'en' });
      const acc = wordAccuracy(sentence, result.text);
      totalAcc += acc;

      console.log(`      heard: "${result.text}"`);
      console.log(`      ${kb} KB audio, ${result.ms} ms to transcribe, RTF ${result.rtf ?? 'n/a'}, ` +
                  `accuracy ${(acc * 100).toFixed(0)}%`);
      // Synthetic speech is clean, so anything under 80% means a real problem
      // in the pipeline rather than ordinary recognition noise.
      if (acc < 0.8) {
        console.log('      FAIL  accuracy below 80%');
        failures++;
      }
    } catch (err) {
      console.log(`      FAIL  ${err.message}`);
      failures++;
    } finally {
      fs.rmSync(wav, { force: true });
    }
  }

  const avg = (totalAcc / SENTENCES.length) * 100;
  console.log(`\nAverage accuracy: ${avg.toFixed(1)}%   failures: ${failures}\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error('\nFATAL:', e.message);
  process.exit(1);
});
