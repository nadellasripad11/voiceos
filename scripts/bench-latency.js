'use strict';
/**
 * Measures what the user actually waits for: the gap between asking and
 * hearing the first word, and between asking and seeing the answer.
 *
 *   node scripts/bench-latency.js
 *
 * Read-only. Mutating tools are declined.
 */
const { Agent } = require('../src/core/agent/agent');
const { ConnectionManager } = require('../src/core/connect/manager');
const { getBridge } = require('../src/core/native/bridge');
const { createProvider } = require('../src/core/llm/provider');
const { PiperTts, speakableSummary } = require('../src/core/tts/piper');
const { OPENINGS, SMALL_TALK } = require('../src/core/agent/tools');
const { config } = require('../src/core/config');
const { paths } = require('../src/core/paths');
const fs = require('fs');

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const creds = {
  read: () => { try { return JSON.parse(fs.readFileSync(paths.credentials, 'utf8')); } catch { return {}; } },
  write: () => {}
};

const QUESTIONS = [
  'check my email',
  'what is on my calendar today',
  'what homework do I have',
  "what's playing"
];

(async () => {
  const bridge = getBridge({ logger: quiet });
  await bridge.start();

  const tts = new PiperTts({ voice: config.get('tts.voice'), logger: quiet });
  process.stdout.write('warming speech… ');
  const warm0 = Date.now();
  await tts.prewarm();
  // The app renders its fixed phrases at launch, so the benchmark must too, or
  // it measures a cost the user never actually pays.
  const phrases = await tts.warmPhrases([
    ...Object.values(OPENINGS).filter(Boolean),
    ...Object.values(SMALL_TALK).flat(),
    'Let me think about that.'
  ]);
  console.log(`${Date.now() - warm0}ms (once, at launch; ${phrases.cached} phrases cached)\n`);

  const connections = new ConnectionManager({ config, bridge, browser: null, logger: quiet, credentials: creds });
  const agent = new Agent({
    provider: createProvider('ollama', { baseUrl: config.get('llm.baseUrl') }),
    config, bridge, connections, logger: quiet,
    requestConfirmation: async () => false
  });

  console.log('question                        first word   answer shown   route');
  console.log('-'.repeat(72));

  const rows = [];
  for (const q of QUESTIONS) {
    const t0 = Date.now();
    let firstWordAt = null;

    // One run only. The opening line is synthesized while the tool is still
    // working, which is exactly how the app does it.
    const result = await agent.run(q, {
      onOpening: async (line) => {
        const r = await tts.synthesize(line).catch(() => null);
        if (r) { firstWordAt = Date.now() - t0; fs.rmSync(r.path, { force: true }); }
      }
    });

    const shownAt = Date.now() - t0;

    // With no opening line, speech only starts once the answer exists.
    let spokenAt = shownAt;
    const line = speakableSummary(result.spoken || result.answer);
    if (line) {
      const r = await tts.synthesize(line).catch(() => null);
      if (r) { spokenAt = Date.now() - t0; fs.rmSync(r.path, { force: true }); }
    }

    const heard = firstWordAt !== null ? firstWordAt : spokenAt;
    rows.push({ q, heard, shownAt, spokenAt, route: result.model });

    console.log(
      q.padEnd(32) +
      `${heard}ms`.padStart(9) + '   ' +
      `${shownAt}ms`.padStart(10) + '   ' +
      result.model
    );
  }

  const avgHeard = Math.round(rows.reduce((n, r) => n + r.heard, 0) / rows.length);
  const avgNoOpening = Math.round(rows.reduce((n, r) => n + r.spokenAt, 0) / rows.length);

  console.log('-'.repeat(72));
  console.log(`\naverage time to first word : ${avgHeard}ms`);
  console.log(`without the opening line   : ${avgNoOpening}ms`);
  console.log(`improvement                : ${(avgNoOpening / avgHeard).toFixed(1)}x sooner\n`);

  tts.stop();
  bridge.stop();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
