'use strict';
/**
 * Finds the fastest usable Whisper configuration for THIS machine.
 *
 * Transcribes identical audio across model/thread combinations and reports
 * median latency plus accuracy, so the defaults in config.js are chosen from
 * measurement rather than assumption.
 *
 *   node scripts/bench-sweep.js
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { WhisperEngine } = require('../src/core/stt/whisper');
const { paths, ensureDirs } = require('../src/core/paths');

const SENTENCE = 'Remind me to send Maya the deck tomorrow morning.';
const VOCAB_PROMPT = 'Vocabulary: Maya, Sripad, Hackatime, VoiceOS, Rojo.';
const RUNS = 3;

const COMBOS = [
  { model: 'ggml-tiny.en.bin', threads: 4 },
  { model: 'ggml-tiny.en.bin', threads: 7 },
  { model: 'ggml-base.en.bin', threads: 2 },
  { model: 'ggml-base.en.bin', threads: 4 },
  { model: 'ggml-base.en.bin', threads: 7 }
];

function synthesize(text, outPath) {
  const script = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile(${JSON.stringify(outPath)}, $fmt)
$s.Speak(${JSON.stringify(text)})
$s.Dispose()
`;
  return new Promise((res, rej) =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      (e, _o, se) => (e ? rej(new Error(se || e.message)) : res(outPath))));
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const acc = (exp, act) => {
  const e = norm(exp).split(' ');
  const a = new Set(norm(act).split(' '));
  return e.length ? e.filter((w) => a.has(w)).length / e.length : 0;
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

(async () => {
  ensureDirs();
  const wav = path.join(paths.tmp, 'sweep.wav');
  await synthesize(SENTENCE, wav);
  const audioSec = 3.4;

  console.log(`\nAudio: "${SENTENCE}" (~${audioSec}s)`);
  console.log(`Runs per combo: ${RUNS} (median reported)\n`);
  console.log('model            threads   median    rtf   accuracy');
  console.log('-'.repeat(54));

  const results = [];
  for (const combo of COMBOS) {
    const modelPath = path.join(paths.models, combo.model);
    if (!fs.existsSync(modelPath)) {
      console.log(`${combo.model.padEnd(24)} ${String(combo.threads).padStart(2)}   (not downloaded, skipped)`);
      continue;
    }
    const engine = new WhisperEngine({ model: combo.model, language: 'en', threads: combo.threads });
    const times = [];
    let text = '';
    for (let i = 0; i < RUNS; i++) {
      const r = await engine.transcribe(wav, { language: 'en', prompt: VOCAB_PROMPT });
      times.push(r.ms);
      text = r.text;
    }
    const m = median(times);
    const a = acc(SENTENCE, text);
    results.push({ ...combo, median: m, acc: a, text });
    const label = combo.model.replace('ggml-', '').replace('.bin', '');
    console.log(
      `${label.padEnd(24)} ${String(combo.threads).padStart(2)}   ` +
      `${String(m).padStart(6)}ms  ${(m / (audioSec * 1000)).toFixed(2)}  ${(a * 100).toFixed(0)}%`
    );
  }

  console.log('-'.repeat(54));
  // Only configurations that actually transcribed correctly are candidates;
  // a fast wrong answer is not a win.
  const usable = results.filter((r) => r.acc >= 0.9);
  const best = (usable.length ? usable : results).sort((a, b) => a.median - b.median)[0];
  if (best) {
    console.log(`\nFastest at >=90% accuracy: ${best.model} with ${best.threads} threads`);
    console.log(`  ${best.median}ms for ${audioSec}s of audio (RTF ${(best.median / (audioSec * 1000)).toFixed(2)})`);
    console.log(`  heard: "${best.text}"`);
    const slowest = results.sort((a, b) => b.median - a.median)[0];
    console.log(`\n  vs slowest combo (${slowest.model} / ${slowest.threads}t): ` +
                `${(slowest.median / best.median).toFixed(1)}x slower`);
  }

  fs.rmSync(wav, { force: true });
  console.log();
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
