'use strict';
/**
 * Where the time actually goes, from the key coming up to the first word heard.
 *
 *   node scripts/bench-pipeline.js
 *
 * Measures each stage of a real request separately, because "it feels slow" has
 * meant something different every time it has been investigated: once it was
 * the router missing the sentence, once prompt evaluation, once the silence
 * detector never firing. Read-only — mutating tools are declined.
 */
const fs = require('fs');
const path = require('path');
const { Agent } = require('../src/core/agent/agent');
const { ConnectionManager } = require('../src/core/connect/manager');
const { getBridge } = require('../src/core/native/bridge');
const { createProvider } = require('../src/core/llm/provider');
const { KokoroTts } = require('../src/core/tts/kokoro');
const { speakableSummary } = require('../src/core/tts/piper');
const { WhisperEngine } = require('../src/core/stt/whisper');
const { matchIntent } = require('../src/core/agent/intents');
const { buildTools } = require('../src/core/agent/tools');
const { config } = require('../src/core/config');
const { paths } = require('../src/core/paths');

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const creds = {
  read: () => { try { return JSON.parse(fs.readFileSync(paths.credentials, 'utf8')); } catch { return {}; } },
  write: () => {}
};

/** Questions that exercise the paths people actually use. */
const CASES = [
  'what do we have today',
  'what are my grades',
  'what is the weather tomorrow',
  'check my email',
  'what is playing'
];

const pad = (n, w = 7) => `${n}ms`.padStart(w);

(async () => {
  const bridge = getBridge({ logger: quiet });
  await bridge.start();

  const connections = new ConnectionManager({ config, bridge, browser: null, logger: quiet, credentials: creds });
  const provider = createProvider('ollama', { baseUrl: config.get('llm.baseUrl') });
  const agent = new Agent({ provider, config, bridge, connections, logger: quiet, requestConfirmation: async () => false });
  const tools = buildTools({ config, bridge, connections, browser: null, provider, logger: quiet });

  // Warmed exactly as the app warms them, or this measures the cold path the
  // user never sees.
  process.stdout.write('\nwarming speech… ');
  const tts = new KokoroTts({
    voice: config.get('tts.voice', 'af_heart'),
    dtype: config.get('tts.dtype', 'q4'),
    logger: quiet
  });
  let t = Date.now();
  await tts.start();
  console.log(`${Date.now() - t}ms`);

  process.stdout.write('warming the model… ');
  t = Date.now();
  await agent.prewarm().catch(() => {});
  console.log(`${Date.now() - t}ms\n`);

  // --- transcription, on a real clip -------------------------------------
  const stt = new WhisperEngine({
    model: config.get('stt.model'),
    language: config.get('stt.language'),
    threads: config.get('stt.threads'),
    beamSize: config.get('stt.beamSize'),
    audioCtx: config.get('stt.audioCtx'),
    logger: quiet
  });
  const sample = path.join(paths.tmp, 'vocab', 'v0-r0.wav');
  let sttMs = null;
  if (fs.existsSync(sample)) {
    t = Date.now();
    await stt.transcribe(sample, { language: 'en' });
    sttMs = Date.now() - t;
  }

  console.log('question                        route      tool    speak   total');
  console.log('-'.repeat(68));

  const rows = [];
  for (const q of CASES) {
    // Routing on its own: this is what decides whether the slow path is taken.
    t = Date.now();
    const routed = matchIntent(q, tools, config);
    const routeMs = Date.now() - t;

    t = Date.now();
    const result = await agent.run(q);
    const toolMs = Date.now() - t;

    // What it takes to say the first sentence of the answer.
    const line = speakableSummary(result.spoken || result.answer);
    const first = (line.split(/(?<=[.!?])\s+/)[0] || line).slice(0, 180);
    t = Date.now();
    let speakMs = 0;
    if (first) {
      const cached = tts.cached(first);
      if (cached) speakMs = 0;
      else { const r = await tts.synthesize(first, { cache: false }); speakMs = r.ms; fs.rmSync(r.path, { force: true }); }
    }
    speakMs = Date.now() - t;

    rows.push({ q, routeMs, toolMs, speakMs, via: routed ? routed.tool.name : 'model' });
    console.log(
      q.padEnd(32) + pad(routeMs, 6) + ' ' + pad(toolMs) + ' ' + pad(speakMs) + ' ' + pad(routeMs + toolMs + speakMs)
    );
  }

  console.log('-'.repeat(68));
  const avg = (k) => Math.round(rows.reduce((n, r) => n + r[k], 0) / rows.length);
  console.log(`\naverage: routing ${avg('routeMs')}ms, tool ${avg('toolMs')}ms, speech ${avg('speakMs')}ms`);
  if (sttMs !== null) console.log(`transcription of a real clip: ${sttMs}ms`);
  console.log(`\nso from the key coming up to the first word: about ${sttMs !== null ? sttMs + avg('routeMs') + avg('toolMs') : avg('toolMs')}ms`);
  console.log('(the opening line is pre-rendered, so speech itself starts at 0ms)\n');

  tts.stop();
  bridge.stop();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
