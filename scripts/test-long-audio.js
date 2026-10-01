'use strict';
/**
 * Guards against the adaptive audio-context setting truncating long dictation.
 *
 * A fixed small -ac value is fast but silently drops audio past its window,
 * which would lose the end of a long sentence without any error. This dictates
 * a long passage and asserts the tail survives.
 *
 *   node scripts/test-long-audio.js
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { WhisperEngine, readWavDurationMs } = require('../src/core/stt/whisper');
const { paths, ensureDirs } = require('../src/core/paths');

// Long enough to exceed a 768-frame context (~15s) comfortably.
const LONG_TEXT =
  'This is a deliberately long dictation used to prove that the adaptive audio context ' +
  'does not cut off the end of what I said. I am going to keep talking for a while about ' +
  'the quarterly roadmap, the hiring plan, and the migration we keep postponing. ' +
  'If the audio context were fixed at a small value, everything after roughly fifteen ' +
  'seconds would vanish without any error at all. ' +
  'The final sentence is the one that matters most, so remember this phrase: ' +
  'purple elephant seventeen.';

const TAIL_MARKER = 'purple elephant seventeen';

// Whisper normalizes number words to digits ("seventeen" -> "17"), which is
// correct behaviour for dictation and must not be read as truncation.
const NUMBER_WORDS = {
  seventeen: '17', sixteen: '16', fifteen: '15', fourteen: '14', thirteen: '13',
  twelve: '12', eleven: '11', ten: '10', nine: '9', eight: '8', seven: '7',
  six: '6', five: '5', four: '4', three: '3', two: '2', one: '1'
};

function canonical(s) {
  let out = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  for (const [word, digit] of Object.entries(NUMBER_WORDS)) {
    out = out.replace(new RegExp(`\\b${word}\\b`, 'g'), digit);
  }
  return out.replace(/\s+/g, ' ').trim();
}

const containsTail = (text) => canonical(text).includes(canonical(TAIL_MARKER));

function synthesize(text, outPath) {
  const script = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile(${JSON.stringify(outPath)}, $f)
$s.Speak(${JSON.stringify(text)})
$s.Dispose()
`;
  return new Promise((res, rej) =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      (e, _o, se) => (e ? rej(new Error(se || e.message)) : res(outPath))));
}

(async () => {
  ensureDirs();
  const wav = path.join(paths.tmp, 'long-audio.wav');
  console.log('Rendering a long passage…');
  await synthesize(LONG_TEXT, wav);

  const ms = readWavDurationMs(wav);
  console.log(`Audio duration detected from header: ${(ms / 1000).toFixed(1)}s`);
  if (ms < 20000) {
    console.log('WARNING: clip shorter than expected; the truncation guard is weak here.');
  }

  let failures = 0;

  // The adaptive setting should scale the context up for this clip.
  const adaptive = new WhisperEngine({
    model: 'ggml-tiny.en-q5_1.bin', language: 'en', threads: 7, audioCtx: 'auto'
  });
  const chosen = adaptive.resolveAudioCtx(wav);
  console.log(`Adaptive audio context chose: ${chosen === 0 ? 'full (1500)' : chosen} frames\n`);

  const r1 = await adaptive.transcribe(wav, { language: 'en' });
  const keptTail = containsTail(r1.text);
  console.log(`adaptive  ${String(r1.ms).padStart(6)}ms  ${r1.text.length} chars  tail kept: ${keptTail}`);
  if (!keptTail) {
    console.log(`  FAIL  the closing phrase "${TAIL_MARKER}" is missing`);
    console.log(`  got tail: …${r1.text.slice(-120)}`);
    failures++;
  }

  // Demonstrate the bug the adaptive logic exists to prevent.
  const fixedSmall = new WhisperEngine({
    model: 'ggml-tiny.en-q5_1.bin', language: 'en', threads: 7, audioCtx: 768
  });
  const r2 = await fixedSmall.transcribe(wav, { language: 'en' });
  const fixedKeptTail = containsTail(r2.text);
  console.log(`ac=768    ${String(r2.ms).padStart(6)}ms  ${r2.text.length} chars  tail kept: ${fixedKeptTail}`);
  if (!fixedKeptTail) {
    console.log('  (expected: this is exactly the truncation the adaptive setting avoids)');
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: long dictation ${failures === 0 ? 'survives' : 'is being truncated'}\n`);
  fs.rmSync(wav, { force: true });
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
