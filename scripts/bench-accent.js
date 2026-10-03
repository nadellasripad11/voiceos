'use strict';
/**
 * Which speech model copes with an accent, and what it costs.
 *
 *   node scripts/bench-accent.js
 *
 * The existing speech test synthesizes with a clean American voice, which is
 * the one case that was never the problem. This machine also has Microsoft
 * Heera and Ravi — Indian English — so the same sentences are rendered in both
 * accents and every installed model is scored on both.
 *
 * Synthesized accents are not the same as a real speaker, and a model that
 * does better here is not guaranteed to do better on the user's voice. What it
 * does show is the direction and the size of the gap, which is enough to
 * choose between models.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { WhisperEngine } = require('../src/core/stt/whisper');
const { paths, ensureDirs } = require('../src/core/paths');

const SENTENCES = [
  'Play some music on Spotify.',
  'What homework do I have due this week?',
  'Remind me to send Maya the deck tomorrow morning.',
  'Open Canvas and check my assignments.',
  'What is the weather going to be tomorrow?'
];

/**
 * Renders text with a named WinRT voice at 16 kHz mono.
 *
 * WinRT is used rather than System.Speech because the Indian English voices
 * are only exposed there. Its synthesizer returns a compressed stream, so the
 * result is decoded and resampled through the media pipeline.
 */
function synthesize(text, voiceName, outPath) {
  const script = `
$ErrorActionPreference = 'Stop'
[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType=WindowsRuntime]
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]

function Await($task, $resultType) {
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
  $netTask = $asTask.MakeGenericMethod($resultType).Invoke($null, @($task))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices |
  Where-Object { $_.DisplayName -like ${JSON.stringify('*' + voiceName + '*')} } | Select-Object -First 1
if (-not $voice) { throw "voice not found: ${voiceName}" }
$synth.Voice = $voice

$stream = Await ($synth.SynthesizeTextToStreamAsync(${JSON.stringify(text)})) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
$input = $stream.GetInputStreamAt(0)
$reader = New-Object Windows.Storage.Streams.DataReader($input)
[void](Await ($reader.LoadAsync([uint32]$stream.Size)) ([uint32]))
$bytes = New-Object byte[] $stream.Size
$reader.ReadBytes($bytes)
[System.IO.File]::WriteAllBytes(${JSON.stringify(outPath)}, $bytes)
`;
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 1 << 26 },
      (err, _o, stderr) => (err ? reject(new Error((stderr || err.message).slice(0, 300))) : resolve(outPath)));
  });
}

/** Resamples whatever Windows produced into the 16 kHz mono WAV whisper wants. */
function toWhisperWav(src, dest) {
  const ff = path.join(paths.vendor, 'ffmpeg', 'ffmpeg.exe');
  const exe = fs.existsSync(ff) ? ff : 'ffmpeg';
  return new Promise((resolve, reject) => {
    execFile(exe, ['-y', '-i', src, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', dest],
      (err) => (err ? reject(new Error('ffmpeg: ' + err.message.slice(0, 160))) : resolve(dest)));
  });
}

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

/** Word-level accuracy, which is what actually matters for a command. */
function accuracy(expected, heard) {
  const e = normalize(expected).split(' ');
  const h = new Set(normalize(heard).split(' '));
  const hit = e.filter((w) => h.has(w)).length;
  return Math.round((hit / e.length) * 100);
}

(async () => {
  ensureDirs();
  const tmp = path.join(paths.tmp, 'accent');
  fs.mkdirSync(tmp, { recursive: true });

  const models = fs.readdirSync(paths.models).filter((f) => f.endsWith('.bin')).sort();
  const voices = [
    { name: 'Heera', label: 'Indian English (Heera)' },
    { name: 'Ravi', label: 'Indian English (Ravi)' },
    { name: 'Zira', label: 'American English (Zira)' }
  ];

  // Render once; every model hears exactly the same audio.
  const clips = [];
  for (const v of voices) {
    for (const [i, text] of SENTENCES.entries()) {
      const raw = path.join(tmp, `${v.name}-${i}.raw.wav`);
      const wav = path.join(tmp, `${v.name}-${i}.wav`);
      if (!fs.existsSync(wav)) {
        try {
          await synthesize(text, v.name, raw);
          await toWhisperWav(raw, wav);
        } catch (err) {
          console.log(`  could not render ${v.name}: ${err.message}`);
          break;
        }
      }
      if (fs.existsSync(wav)) clips.push({ voice: v.label, text, wav });
    }
  }

  if (!clips.length) {
    console.log('\nNo audio could be rendered; cannot compare models.\n');
    process.exit(1);
  }

  const byVoice = [...new Set(clips.map((c) => c.voice))];
  console.log(`\n${clips.length} clips across ${byVoice.length} voices, ${models.length} models\n`);
  console.log('model'.padEnd(28) + byVoice.map((v) => v.split(' (')[0].padStart(18)).join('') + '      ms/clip');
  console.log('-'.repeat(28 + byVoice.length * 18 + 13));

  const rows = [];
  for (const model of models) {
    const engine = new WhisperEngine({
      config: {
        get: (k, d) => ({
          'stt.model': model, 'stt.threads': 0, 'stt.language': 'en',
          'stt.beamSize': 0, 'stt.audioCtx': 'auto'
        })[k] ?? d
      },
      logger: { info() {}, warn() {}, debug() {}, error() {} }
    });

    const scores = {};
    let totalMs = 0;
    for (const c of clips) {
      const t0 = Date.now();
      let heard = '';
      try { heard = (await engine.transcribe(c.wav, { language: 'en' })).text; } catch { heard = ''; }
      totalMs += Date.now() - t0;
      (scores[c.voice] ||= []).push(accuracy(c.text, heard));
    }

    const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
    const row = {
      model,
      ms: Math.round(totalMs / clips.length),
      perVoice: byVoice.map((v) => avg(scores[v] || [0]))
    };
    rows.push(row);
    console.log(
      model.padEnd(28) +
      row.perVoice.map((p) => `${p}%`.padStart(18)).join('') +
      `${row.ms}ms`.padStart(13)
    );
  }

  // The accented columns are the ones that matter here.
  const accentCols = byVoice.map((v, i) => (v.startsWith('Indian') ? i : -1)).filter((i) => i >= 0);
  const accentScore = (r) => Math.round(accentCols.reduce((n, i) => n + r.perVoice[i], 0) / (accentCols.length || 1));
  const best = [...rows].sort((a, b) => accentScore(b) - accentScore(a))[0];
  const current = rows.find((r) => r.model === 'ggml-tiny.en-q5_1.bin');

  console.log('\nOn the accented voices:');
  for (const r of [...rows].sort((a, b) => accentScore(b) - accentScore(a))) {
    console.log(`  ${String(accentScore(r)).padStart(3)}%  ${r.ms}ms  ${r.model}`);
  }
  if (best && current) {
    console.log(`\nbest on accent : ${best.model} (${accentScore(best)}%, ${best.ms}ms)`);
    console.log(`in use now     : ${current.model} (${accentScore(current)}%, ${current.ms}ms)`);
  }
  console.log();
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
