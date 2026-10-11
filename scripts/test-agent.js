'use strict';
/**
 * Exercises Agent Mode without a microphone: feeds spoken phrases straight in
 * and prints what it answers and what it found.
 *
 *   node scripts/test-agent.js
 *   node scripts/test-agent.js "what's playing"
 *
 * Read-only by default. Mutating tools are auto-declined unless --allow is
 * passed, so a test run never opens apps or changes anything.
 */
const { Agent, matchIntent } = require('../src/core/agent/agent');
const { buildTools } = require('../src/core/agent/tools');
const { getBridge } = require('../src/core/native/bridge');
const { createBrain } = require('../src/core/llm');
const { config } = require('../src/core/config');
const { ensureDirs } = require('../src/core/paths');

const args = process.argv.slice(2);
const allowMutations = args.includes('--allow');
const custom = args.filter((a) => !a.startsWith('--'));

const PHRASES = custom.length ? custom : [
  "what's playing",
  'what apps are open',
  'what are my reminders',
  'remind me to send Maya the deck in 20 minutes',
  'search the web for whisper.cpp benchmarks',
  'who is Ada Lovelace?',
  'what is on my screen',
  'open Spotify',
  'turn it up',
  'take a note: the migration is blocked on auth',
  'tell me a joke about compilers'   // deliberately unroutable: exercises the model path
];

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

(async () => {
  ensureDirs();
  const bridge = getBridge({ logger: quiet });
  await bridge.start();

  // The brain the app would build, keys and fallback and all. Constructing
  // one by hand here is how this test came to report "No groq API key is set"
  // on a machine that had one.
  const provider = createBrain({ config, logger: quiet });

  const agent = new Agent({
    provider,
    config,
    bridge,
    tts: null,
    logger: quiet,
    // Mirrors the real confirmation gate: the user says yes or nothing happens.
    requestConfirmation: async (prompt) => {
      console.log(`        [confirm] ${prompt.title} ${allowMutations ? '-> approved' : '-> declined (pass --allow)'}`);
      return allowMutations;
    }
  });

  const tools = buildTools({ bridge, config, logger: quiet });
  console.log(`\n${tools.length} tools available: ${tools.map((t) => t.name).join(', ')}`);
  const brainUp = await provider.available().catch(() => false);
  console.log(`Brain: ${config.get('llm.provider')} ${brainUp ? 'reachable' : 'NOT reachable (router-only)'}\n`);
  console.log('─'.repeat(74));

  let routed = 0;
  let answered = 0;

  for (const phrase of PHRASES) {
    const hit = matchIntent(phrase, tools);
    console.log(`\n> ${phrase}`);
    console.log(`  route: ${hit ? hit.tool.name + '(' + JSON.stringify(hit.args) + ')' : 'none — needs the model'}`);
    if (hit) routed++;

    try {
      const r = await agent.run(phrase);
      if (r.needsBrain) {
        console.log(`  ⚠ ${r.answer}`);
        continue;
      }
      answered++;
      console.log(`  answer: ${r.answer.replace(/\n/g, '\n          ')}`);
      for (const f of (r.found || []).slice(0, 4)) {
        console.log(`    · ${f.title}${f.subtitle ? ` — ${f.subtitle}` : ''}`);
      }
      console.log(`  ${r.ms}ms via ${r.model}`);
    } catch (e) {
      console.log(`  FAILED: ${e.message}`);
    }
  }

  console.log('\n' + '─'.repeat(74));
  console.log(`${routed}/${PHRASES.length} matched the router · ${answered}/${PHRASES.length} produced an answer\n`);
  bridge.stop();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
