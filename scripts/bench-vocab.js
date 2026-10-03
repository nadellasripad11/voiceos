'use strict';
/**
 * Does priming the vocabulary actually change what is heard?
 *
 *   node scripts/bench-vocab.js
 *
 * The log showed the assistant's own name coming back as "Darris" and app
 * names being mangled, which makes a request unroutable. Whisper's initial
 * prompt biases decoding toward the words in it. This renders sentences that
 * contain those words and transcribes each one twice — once primed, once not —
 * so the claim is measured rather than assumed.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { WhisperEngine } = require('../src/core/stt/whisper');
const { paths, ensureDirs } = require('../src/core/paths');
const { SITES } = require('../src/core/agent/intents');

const SENTENCES = [
  'Hey Jarvis, play some music on Spotify.',
  'Jarvis, open Canvas and check my assignments.',
  'Open Google Classroom and tell me what is due.',
  'Jarvis, what is on my calendar today?',
  'Put on a playlist in Spotify please.'
];

const VOCAB = (() => {
  const own = ['Jarvis', 'VoiceOS'];
  const verbs = ['play', 'pause', 'skip', 'volume', 'open', 'email', 'inbox', 'calendar',
    'homework', 'assignment', 'due', 'remind', 'reminder', 'note', 'weather',
    'forecast', 'search', 'screen', 'dictate'];
  return process.argv.includes('--short') ? ['Jarvis','Spotify','Canvas','Classroom','Gmail','YouTube','Drive'] : [...new Set([...own, ...Object.keys(SITES), ...verbs])].slice(0, 60);
})();

/** Renders at 16 kHz mono with a Windows voice. */
function synthesize(text, outPath, rate) {
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

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

/** The words that matter: did the names survive? */
function keyWordsHit(expected, heard) {
  const keys = normalize(expected).split(' ').filter((w) => VOCAB.some((v) => v.toLowerCase() === w));
  if (!keys.length) return null;
  const h = new Set(normalize(heard).split(' '));
  return { hit: keys.filter((k) => h.has(k)).length, of: keys.length, keys };
}

(async () => {
  ensureDirs();
  const tmp = path.join(paths.tmp, 'vocab');
  fs.mkdirSync(tmp, { recursive: true });

  const model = process.argv.includes('--model')
    ? process.argv[process.argv.indexOf('--model') + 1]
    : 'ggml-base.en-q5_1.bin';

  const engine = new WhisperEngine({
    config: {
      get: (k, d) => ({ 'stt.model': model, 'stt.threads': 0, 'stt.language': 'en',
        'stt.beamSize': 0, 'stt.audioCtx': 'auto' })[k] ?? d
    },
    logger: { info() {}, warn() {}, debug() {}, error() {} }
  });

  // Two speaking rates, because a faster talker is harder and closer to real use.
  const clips = [];
  for (const [i, text] of SENTENCES.entries()) {
    for (const rate of [0, 3]) {
      const wav = path.join(tmp, `v${i}-r${rate}.wav`);
      if (!fs.existsSync(wav)) await synthesize(text, wav, rate);
      clips.push({ text, wav, rate });
    }
  }

  console.log(`\nmodel: ${model}   ${clips.length} clips\n`);
  console.log('heard without priming'.padEnd(52) + 'heard with priming');
  console.log('-'.repeat(104));

  let plainHits = 0, primedHits = 0, total = 0, plainMs = 0, primedMs = 0;

  for (const c of clips) {
    let t = Date.now();
    const plain = (await engine.transcribe(c.wav, { language: 'en' })).text;
    plainMs += Date.now() - t;

    t = Date.now();
    const primed = (await engine.transcribe(c.wav, {
      language: 'en', prompt: `Vocabulary: ${VOCAB.join(', ')}.`
    })).text;
    primedMs += Date.now() - t;

    const a = keyWordsHit(c.text, plain);
    const b = keyWordsHit(c.text, primed);
    if (a && b) { plainHits += a.hit; primedHits += b.hit; total += a.of; }

    const mark = (x) => (x && x.hit === x.of ? ' ' : '*');
    console.log(
      `${mark(a)}${plain.trim().slice(0, 50).padEnd(51)}${mark(b)}${primed.trim().slice(0, 50)}`
    );
  }

  console.log('-'.repeat(104));
  console.log(`\nkey words heard correctly:`);
  console.log(`  without priming : ${plainHits}/${total}  (${Math.round(100 * plainHits / total)}%)   ${Math.round(plainMs / clips.length)}ms per clip`);
  console.log(`  with priming    : ${primedHits}/${total}  (${Math.round(100 * primedHits / total)}%)   ${Math.round(primedMs / clips.length)}ms per clip`);
  console.log(`\n(* marks a line where a key word was lost)\n`);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
