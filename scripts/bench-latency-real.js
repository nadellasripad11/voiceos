'use strict';
/**
 * How long until it starts talking back.
 *
 *   node scripts/bench-latency-real.js
 *
 * Through the app's own provider, agent and speech stream — not the raw HTTP
 * API — because the question is not "is Groq fast" but "is VoiceOS fast", and
 * every layer between the two is a place to lose a second.
 *
 * The number that matters is time to first spoken word. A reply that takes
 * four seconds to finish but starts talking in one feels immediate; one that
 * is silent for three seconds and then says everything at once does not,
 * however good the total looks on a chart.
 */
const { config } = require('../src/core/config');
const { paths } = require('../src/core/paths');
const { createBrain } = require('../src/core/llm');
const { Ambient } = require('../src/core/agent/ambient');
const { createTts } = require('../src/core/tts');
const { SpeechStream } = require('../src/core/tts/stream');
const { Agent } = require('../src/core/agent/agent');
const fs = require('fs');

const quiet = { info() {}, warn() {}, debug() {}, error() {} };

const QUESTIONS = [
  'what is the capital of France',
  'what is the weather like',
  'tell me a short joke',
  "what's playing"
];


(async () => {
  const provider = createBrain({ config, logger: quiet });
  console.log(`\nBrain: ${provider.name}  (${config.get('llm.agentModel') || config.get('llm.model')})`);

  let { tts, engine } = createTts({ config, logger: quiet });
  if (tts) await tts.prewarm().catch(() => {});

  // SpeechStream swallows synthesis errors on purpose — the answer is already
  // on screen, so a mute reply beats a crash. That makes it the wrong thing to
  // measure through blind: a failing engine looks like a fast one, because
  // nothing is emitted and nothing complains. Kokoro's voice file resolves
  // differently outside Electron and fails here, which is exactly the trap.
  if (tts) {
    try {
      await tts.synthesizeBase64('Checking the voice works ' + Math.random().toString(36).slice(2, 6));
      console.log(`Voice: ${engine}`);
    } catch (err) {
      console.log(`Voice: ${engine} CANNOT SYNTHESIZE HERE (${err.message.slice(0, 50)})`);
      console.log('       Speech timings would be meaningless, so they are left out.');
      console.log('       Run the app itself to measure speech.');
      tts = null;
    }
  } else {
    console.log('No voice engine installed; measuring text only.');
  }

  // The app keeps these warm in the background, so a bench without them
  // measures a slower assistant than the one that ships.
  const ambient = new Ambient({ config, logger: quiet });
  const warmed = Date.now();
  await ambient.refresh().catch(() => {});
  await ambient.location().catch(() => {});
  console.log(`Context: prefetched in ${Date.now() - warmed}ms (the app does this at launch)`);

  const agent = new Agent({
    provider, config, bridge: null, browser: null, tts, ambient,
    connections: null, logger: quiet,
    requestConfirmation: async () => true
  });

  console.log('\n' + 'question'.padEnd(30) + 'first word   spoken   total   route');
  console.log('-'.repeat(74));

  const rows = [];
  for (const question of QUESTIONS) {
    const started = Date.now();
    let firstWordAt = null;
    let firstClipAt = null;

    const stream = tts
      ? new SpeechStream({ tts, emit: () => { if (firstClipAt === null) firstClipAt = Date.now() - started; }, logger: quiet })
      : null;

    let result;
    try {
      result = await agent.run(question, {
        onPartial: (text, meta) => {
          if (meta.retracted) return;
          if (firstWordAt === null && text.trim()) firstWordAt = Date.now() - started;
          if (!stream) return;
          if (meta.done) stream.finish(text).catch(() => {});
          else stream.push(text);
        }
      });
    } catch (err) {
      console.log(`${question.padEnd(30)} FAILED: ${err.message.slice(0, 40)}`);
      continue;
    }

    // A routed answer never streams — it arrives whole, and main.js hands it
    // to the speech stream in one go. Measuring it as silent would flatter the
    // fast path by leaving out the only part of it the user waits for.
    if (stream && result.usedRouter) {
      const line = result.spoken || result.answer;
      if (line) await stream.finish(line);
    }
    if (stream) await stream.finish('');
    const total = Date.now() - started;
    // The router answers without the model at all, so it has no streamed
    // first word — the whole answer arrives at once and that is the first word.
    if (firstWordAt === null) firstWordAt = total;

    rows.push({ question, firstWordAt, firstClipAt, total, route: result.usedRouter ? 'router' : result.model });
    console.log(
      question.padEnd(30) +
      `${String(firstWordAt).padStart(7)}ms` +
      `${String(firstClipAt === null ? '-' : firstClipAt + 'ms').padStart(9)}` +
      `${String(total + 'ms').padStart(8)}   ` +
      (result.usedRouter ? 'router' : String(result.model).slice(0, 24))
    );
  }

  if (rows.length) {
    const avg = (f) => Math.round(rows.reduce((s, r) => s + (f(r) || 0), 0) / rows.length);
    console.log('-'.repeat(74));
    console.log(`${'average'.padEnd(30)}${String(avg((r) => r.firstWordAt)).padStart(7)}ms` +
                `${String(avg((r) => r.firstClipAt) + 'ms').padStart(9)}` +
                `${String(avg((r) => r.total) + 'ms').padStart(8)}`);
    const worst = rows.reduce((w, r) => (r.total > w.total ? r : w));
    console.log(`\nSlowest: "${worst.question}" at ${worst.total}ms via ${worst.route}`);
  }
  console.log('');
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
