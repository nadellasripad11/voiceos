'use strict';
/**
 * How long until you hear the answer — the number that decides whether this
 * feels like talking to someone.
 *
 *   node scripts/bench-firstword.js
 *
 * Measures the two moments that matter separately:
 *
 *   first sound   the opening line, which is pre-rendered, so this is really
 *                 "how long after you stop speaking does it react"
 *   the answer    the first sentence of the actual reply
 *
 * The second is what the old speak() made slow: it synthesized the whole reply
 * before making any sound at all.
 */
const fs = require('fs');
const path = require('path');
const { KokoroTts } = require('../src/core/tts/kokoro');
const { SpeechStream } = require('../src/core/tts/stream');
const { WhisperEngine } = require('../src/core/stt/whisper');
const { buildTools } = require('../src/core/agent/tools');
const { matchIntent } = require('../src/core/agent/intents');
const { ConnectionManager } = require('../src/core/connect/manager');
const { getBridge } = require('../src/core/native/bridge');
const { openingFor } = require('../src/core/agent/tools');
const { config } = require('../src/core/config');
const { paths } = require('../src/core/paths');

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const creds = {
  read: () => { try { return JSON.parse(fs.readFileSync(paths.credentials, 'utf8')); } catch { return {}; } },
  write: () => {}
};

const CASES = ['what is the weather', 'what are my grades', 'what do we have today', 'check my email'];

(async () => {
  const bridge = getBridge({ logger: quiet });
  await bridge.start();
  const connections = new ConnectionManager({ config, bridge, browser: null, logger: quiet, credentials: creds });
  const tools = buildTools({ config, bridge, connections, browser: null, provider: null, logger: quiet });

  const tts = new KokoroTts({
    voice: config.get('tts.voice', 'af_heart'),
    dtype: config.get('tts.dtype', 'q4'),
    logger: quiet
  });
  await tts.start();

  const stt = new WhisperEngine({
    model: config.get('stt.model'), language: 'en',
    threads: config.get('stt.threads'), beamSize: config.get('stt.beamSize'),
    audioCtx: config.get('stt.audioCtx'), logger: quiet
  });

  // A real clip, so transcription is measured rather than assumed.
  const clip = path.join(paths.tmp, 'vocab', 'v0-r0.wav');
  let sttMs = 0;
  if (fs.existsSync(clip)) {
    const t = Date.now();
    await stt.transcribe(clip, { language: 'en' });
    sttMs = Date.now() - t;
  }

  console.log(`\ntranscription of a real command: ${sttMs}ms\n`);
  console.log('question                    react   answer   whole reply   (old way)');
  console.log('-'.repeat(74));

  for (const q of CASES) {
    const routed = matchIntent(q, tools, config);
    if (!routed) { console.log(`${q.padEnd(28)} not routed`); continue; }

    const t0 = Date.now();

    // What it says immediately, which is pre-rendered.
    const opening = openingFor(routed.tool.name);
    const openingMs = opening ? (tts.cached(opening) ? 0 : 999) : null;

    const result = await routed.tool.run(routed.args);
    const toolMs = Date.now() - t0;

    const line = result.spoken || result.answer || '';

    // New: streamed, so the first sentence is spoken while the rest is made.
    let firstSentenceAt = null;
    const started = Date.now();
    const stream = new SpeechStream({
      tts,
      logger: quiet,
      emit: () => { if (firstSentenceAt === null) firstSentenceAt = Date.now() - started; }
    });
    await stream.finish(line);
    const allMs = Date.now() - started;

    // Old: the whole line in one go before any sound.
    const t2 = Date.now();
    const whole = await tts.synthesize(line, { cache: false });
    const oldMs = Date.now() - t2;
    fs.rmSync(whole.path, { force: true });

    console.log(
      q.padEnd(28) +
      `${sttMs + (openingMs === 0 ? 0 : toolMs)}ms`.padStart(7) +
      `${sttMs + toolMs + (firstSentenceAt || 0)}ms`.padStart(9) +
      `${sttMs + toolMs + allMs}ms`.padStart(14) +
      `${sttMs + toolMs + oldMs}ms`.padStart(11)
    );
  }

  console.log('-'.repeat(74));
  console.log('\nreact       = stop speaking -> first sound (the opening line, pre-rendered)');
  console.log('answer      = stop speaking -> first sentence of the reply');
  console.log('whole reply = everything synthesized');
  console.log('(old way)   = what it was before routed answers were streamed\n');

  tts.stop();
  bridge.stop();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
