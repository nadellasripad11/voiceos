'use strict';
/** CLI-per-utterance vs a resident whisper server, at the settings in use. */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { WhisperEngine } = require('../src/core/stt/whisper');
const { WhisperServerEngine } = require('../src/core/stt/whisper-server');
const { config } = require('../src/core/config');
const { paths, ensureDirs } = require('../src/core/paths');

const SENTENCE = 'Send David the project update and ask if the migration is still blocked.';

function synth(text, out) {
  const script = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile(${JSON.stringify(out)}, $f); $s.Speak(${JSON.stringify(text)}); $s.Dispose()`;
  return new Promise((res, rej) =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      (e, _o, se) => (e ? rej(new Error(se || e.message)) : res(out))));
}

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

(async () => {
  ensureDirs();
  const wav = path.join(paths.tmp, 'bench-now.wav');
  await synth(SENTENCE, wav);

  const opts = {
    model: config.get('stt.model'),
    language: 'en',
    threads: config.get('stt.threads'),
    beamSize: config.get('stt.beamSize'),
    bestOf: config.get('stt.bestOf'),
    noFallback: config.get('stt.noFallback'),
    audioCtx: config.get('stt.audioCtx')
  };
  console.log(`model ${opts.model}, beam ${opts.beamSize}, audioCtx ${opts.audioCtx}\n`);

  const cli = new WhisperEngine(opts);
  const cliTimes = [];
  let text = '';
  for (let i = 0; i < 4; i++) {
    const r = await cli.transcribe(wav, { language: 'en' });
    cliTimes.push(r.ms); text = r.text;
  }
  console.log(`CLI per utterance : ${med(cliTimes)}ms   "${text.slice(0, 54)}"`);

  const server = new WhisperServerEngine({ ...opts, logger: { info() {}, warn() {}, debug() {} } });
  const t0 = Date.now();
  await server.start();
  const startup = Date.now() - t0;

  const srvTimes = [];
  for (let i = 0; i < 4; i++) {
    const r = await server.transcribe(wav, { language: 'en' });
    srvTimes.push(r.ms); text = r.text;
  }
  console.log(`server per utterance: ${med(srvTimes)}ms   "${text.slice(0, 54)}"`);
  console.log(`server startup      : ${startup}ms (once, at launch)\n`);

  const c = med(cliTimes), s = med(srvTimes);
  console.log(c > s
    ? `resident server is ${(c / s).toFixed(1)}x faster — ${c - s}ms saved per dictation`
    : `no gain from the server (${s}ms vs ${c}ms); the cost is inference, not startup`);

  server.stop();
  fs.rmSync(wav, { force: true });
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
