'use strict';
/**
 * End-to-end check that a model-path answer arrives progressively.
 *
 *   node scripts/test-agent-stream.js
 *
 * Read-only: mutating tools are declined, so this never sends mail or changes
 * anything. Needs Ollama running.
 */
const fs = require('fs');
const { Agent } = require('../src/core/agent/agent');
const { ConnectionManager } = require('../src/core/connect/manager');
const { getBridge } = require('../src/core/native/bridge');
const { createProvider } = require('../src/core/llm/provider');
const { createTts } = require('../src/core/tts');
const { SpeechStream } = require('../src/core/tts/stream');
const { config } = require('../src/core/config');
const { paths } = require('../src/core/paths');

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const creds = {
  read: () => { try { return JSON.parse(fs.readFileSync(paths.credentials, 'utf8')); } catch { return {}; } },
  write: () => {}
};

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};

(async () => {
  const bridge = getBridge({ logger: quiet });
  await bridge.start();

  const provider = createProvider('ollama', { baseUrl: config.get('llm.baseUrl') });
  if (!(await provider.available())) {
    console.log('\nOllama is not running; cannot test the model path.\n');
    process.exit(1);
  }
  // Must be the agent's own warm-up, not provider.warm: the latter loads the
  // weights but not the tool prompt, which is where the first-question cost is.

  const connections = new ConnectionManager({ config, bridge, browser: null, logger: quiet, credentials: creds });

  // This test drives Ollama on purpose, so it must ask for Ollama's model.
  // llm.model and llm.agentModel name whatever the primary brain uses, and a
  // hosted model id gets a 404 from a local server — which is the whole
  // reason the fallback pair carries its own model name.
  const localModel = config.get('llm.fallbackModel') || config.get('llm.model');
  const localConfig = {
    ...config,
    get: (key, fallback) => (
      key === 'llm.model' || key === 'llm.agentModel'
        ? localModel
        : config.get(key, fallback)
    ),
    set: (...args) => config.set(...args),
    all: () => config.all()
  };

  const agent = new Agent({
    provider, config: localConfig, bridge, connections, logger: quiet,
    requestConfirmation: async () => false
  });

  // A question with no deterministic route, so it goes to the model.
  const QUESTION = 'In two sentences, why is the sky blue?';

  process.stdout.write('\nwarming the model and tool prompt… ');
  const w0 = Date.now();
  await agent.prewarm();
  console.log(`${Date.now() - w0}ms (once, at launch)`);

  console.log('\nStreaming a model answer:');
  const partials = [];
  const t0 = Date.now();
  let firstPartialAt = null;

  const result = await agent.run(QUESTION, {
    onPartial: (text, meta) => {
      if (firstPartialAt === null) firstPartialAt = Date.now() - t0;
      partials.push({ text, meta, at: Date.now() - t0 });
    }
  });
  const totalMs = Date.now() - t0;

  check('the model path was taken', result.usedRouter === false, JSON.stringify(result.model));
  check('partial text arrived', partials.length > 1, `${partials.length} update(s)`);
  check('it arrived well before the final answer',
    firstPartialAt !== null && firstPartialAt < totalMs / 2,
    `first at ${firstPartialAt}ms of ${totalMs}ms`);
  check('each update is longer than the last',
    partials.filter((p) => !p.meta.done && !p.meta.retracted)
      .every((p, i, a) => i === 0 || p.text.length >= a[i - 1].text.length),
    'text went backwards');
  const done = partials.filter((p) => p.meta && p.meta.done);
  check('exactly one update is marked done', done.length === 1, `${done.length}`);
  check('the final update matches the answer',
    done.length === 1 && done[0].text.trim() === result.answer.trim(),
    `done="${done.length && done[0].text.slice(0, 60)}" answer="${result.answer.slice(0, 60)}"`);
  console.log(`        first words at ${firstPartialAt}ms, full answer at ${totalMs}ms`);
  console.log(`        "${result.answer.replace(/\s+/g, ' ').slice(0, 100)}…"`);

  console.log('\nSpeaking it as it streams:');
  // Whatever the app would speak with on this machine. Constructing Piper
  // directly here reported "0 clips" on a machine that had Kokoro and no
  // Piper, which is a fact about the test rather than about the code.
  const { tts, engine, reason } = createTts({ config, logger: quiet });
  if (!tts) {
    console.log(`
  skip  no voice engine installed (${reason})
`);
    console.log(`
${pass} passed, ${fail} failed
`);
    process.exit(fail > 0 ? 1 : 0);
  }
  console.log(`  using ${engine}`);
  await tts.prewarm();

  const clips = [];
  const stream = new SpeechStream({ tts, emit: (c) => clips.push({ ...c, at: Date.now() }), logger: quiet });
  const s0 = Date.now();
  let firstClipAt = null;

  await agent.run(QUESTION, {
    onPartial: (text, meta) => {
      if (meta.retracted) return;
      if (meta.done) stream.finish(text).catch(() => {});
      else stream.push(text);
      if (clips.length && firstClipAt === null) firstClipAt = Date.now() - s0;
    }
  });
  await stream.finish('');
  const spokeBy = Date.now() - s0;

  check('speech was produced', clips.length > 0, `${clips.length} clip(s)`);
  check('clips are in order', clips.every((c, i) => c.seq === i), JSON.stringify(clips.map((c) => c.seq)));
  const firstClip = clips.length ? clips[0].at - s0 : null;
  // How many sentences the model writes is its own business, so a one-clip
  // answer is not a failure. What must hold is that when there is more than
  // one, the first is spoken before the last is even synthesized.
  if (clips.length > 1) {
    check('the first clip is spoken before the last is ready',
      clips[0].at < clips[clips.length - 1].at,
      JSON.stringify(clips.map((c) => c.at - s0)));
  } else {
    console.log('  note  the model answered in a single sentence; ordering covered by test-speech-stream');
  }
  console.log(`        first clip at ${firstClip}ms, all ${clips.length} clip(s) by ${spokeBy}ms`);

  tts.stop();
  bridge.stop();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
