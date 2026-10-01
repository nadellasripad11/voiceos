'use strict';
/**
 * Compares CLI-per-utterance against the resident server, and checks that a
 * vocabulary prompt rescues proper nouns.
 *
 *   node scripts/bench-stt.js
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { WhisperEngine } = require('../src/core/stt/whisper');
const { WhisperServerEngine } = require('../src/core/stt/whisper-server');
const { paths, ensureDirs } = require('../src/core/paths');

const SENTENCES = [
  'Send an email to David about the project update.',
  'Remind me to send Maya the deck tomorrow morning.',
  'Search for last year tax returns in my documents folder.'
];
// Exactly the kind of words a general model has no reason to favour.
const VOCABULARY = ['Maya', 'Sripad', 'Hackatime', 'VoiceOS', 'Rojo'];

function synthesize(text, outPath) {
  const script = `
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth.SetOutputToWaveFile(${JSON.stringify(outPath)}, $fmt)
$synth.Speak(${JSON.stringify(text)})
$synth.Dispose()
`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      (err, _o, se) => (err ? reject(new Error(se || err.message)) : resolve(outPath)));
  });
}

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
function accuracy(expected, actual) {
  const e = normalize(expected).split(' ');
  const a = new Set(normalize(actual).split(' '));
  return e.length ? e.filter((w) => a.has(w)).length / e.length : 0;
}

(async () => {
  ensureDirs();

  console.log('Rendering test audio…');
  const wavs = [];
  for (const [i, s] of SENTENCES.entries()) {
    const p = path.join(paths.tmp, `bench-${i}.wav`);
    await synthesize(s, p);
    wavs.push(p);
  }

  // --- CLI mode -----------------------------------------------------------
  console.log('\nCLI mode (model reloaded per utterance):');
  const cli = new WhisperEngine({ model: 'ggml-base.en.bin', language: 'en' });
  const cliTimes = [];
  for (const [i, wav] of wavs.entries()) {
    const r = await cli.transcribe(wav, { language: 'en' });
    cliTimes.push(r.ms);
    console.log(`  ${String(r.ms).padStart(5)} ms  rtf ${String(r.rtf).padStart(5)}  "${r.text}"`);
    if (i === 0) console.log('         (first call also pays OS file-cache warm-up)');
  }

  // --- Server mode --------------------------------------------------------
  console.log('\nServer mode (model resident):');
  const server = new WhisperServerEngine({ model: 'ggml-base.en.bin', language: 'en' });
  const t0 = Date.now();
  await server.start();
  console.log(`  startup: ${Date.now() - t0} ms (paid once, at app launch)`);

  const srvTimes = [];
  for (const wav of wavs) {
    const r = await server.transcribe(wav, { language: 'en' });
    srvTimes.push(r.ms);
    console.log(`  ${String(r.ms).padStart(5)} ms  rtf ${String(r.rtf).padStart(5)}  "${r.text}"`);
  }

  const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  const cliAvg = avg(cliTimes);
  const srvAvg = avg(srvTimes);
  console.log(`\n  CLI average    ${cliAvg} ms`);
  console.log(`  Server average ${srvAvg} ms`);
  console.log(`  Speedup        ${(cliAvg / srvAvg).toFixed(1)}x faster per utterance`);

  // --- Vocabulary prompt --------------------------------------------------
  console.log('\nCustom vocabulary (fixing the proper-noun miss):');
  const mayaWav = wavs[1];
  const without = await server.transcribe(mayaWav, { language: 'en' });
  const withVocab = await server.transcribe(mayaWav, {
    language: 'en',
    prompt: `Vocabulary: ${VOCABULARY.join(', ')}.`
  });
  console.log(`  without vocab: "${without.text}"  (${(accuracy(SENTENCES[1], without.text) * 100).toFixed(0)}%)`);
  console.log(`  with vocab:    "${withVocab.text}"  (${(accuracy(SENTENCES[1], withVocab.text) * 100).toFixed(0)}%)`);
  const fixed = /maya/i.test(withVocab.text) && !/maya/i.test(without.text);
  console.log(`  verdict: ${fixed ? 'vocabulary prompt recovered the name' :
    /maya/i.test(withVocab.text) ? 'name recognised in both runs' : 'name still missed — needs a larger model'}`);

  server.stop();
  for (const w of wavs) fs.rmSync(w, { force: true });
  console.log();
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
