'use strict';
/**
 * Verifies point-and-ask: put the cursor over a window with real content, ask a
 * demonstrative question, and check the agent answers about what is under the
 * pointer rather than searching the web for the literal words.
 *
 *   node scripts/test-point.js
 *
 * Output is capped hard. Whatever is on screen belongs to the user, so this
 * reports lengths, counts and match/no-match, never the contents.
 */
const { Agent } = require('../src/core/agent/agent');
const { readCursorContext } = require('../src/core/agent/tools');
const { getBridge } = require('../src/core/native/bridge');
const { createProvider } = require('../src/core/llm/provider');
const { config } = require('../src/core/config');
const { ensureDirs } = require('../src/core/paths');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const PEEK = 50;
const peek = (s) => {
  const str = String(s ?? '');
  return str.length > PEEK ? `${str.slice(0, PEEK)}… (${str.length} chars)` : str;
};

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); fail++; }
};

(async () => {
  ensureDirs();
  const bridge = getBridge({ logger: quiet });
  await bridge.start();

  const origin = await bridge.cursorPos();

  // Aim at the largest window on screen. listWindows reports one window per
  // process, so our own main window is not always listed; what matters is that
  // the cursor lands somewhere with real content to read.
  const wins = await bridge.listWindows();
  const target = wins
    .filter((w) => w.bounds && w.bounds.width > 400 && w.bounds.height > 300)
    .sort((a, b) => (b.bounds.width * b.bounds.height) - (a.bounds.width * a.bounds.height))[0];

  if (!target) {
    console.error('\nNo sizeable window is open to point at.\n');
    bridge.stop();
    process.exit(1);
  }

  const point = {
    x: Math.round(target.bounds.x + target.bounds.width / 2),
    y: Math.round(target.bounds.y + target.bounds.height / 2)
  };
  await bridge.call('setCursorPos', point);
  await sleep(600);

  console.log(`\nPointing at ${target.process} at ${point.x},${point.y}\n`);
  console.log('Cursor context:');

  const ctx = { bridge, config, logger: quiet };
  const context = await readCursorContext(ctx);
  console.log(`  window:  ${context.window ? context.window.process : 'none'}`);
  console.log(`  element: ${context.element ? `${peek(context.element.name) || '(unnamed)'} [${context.element.controlType}]` : 'none'}`);
  console.log(`  ocr:     ${context.lines} lines, ${context.text.length} chars`);

  check('resolved the window under the cursor',
    Boolean(context.window && context.window.process),
    `got ${context.window && context.window.process}`);
  check('read content under the cursor',
    context.lines > 0 || Boolean(context.element && (context.element.name || context.element.value)),
    `ocr ${context.lines} lines, element ${context.element ? 'present' : 'none'}`);
  check('OCR returned usable text',
    context.text.length > 20,
    `${context.text.length} chars`);

  console.log('\nDemonstrative questions route to the cursor, not the web:');
  const agent = new Agent({
    provider: createProvider(config.get('llm.provider'), { baseUrl: config.get('llm.baseUrl'), logger: quiet }),
    config,
    bridge,
    logger: quiet,
    requestConfirmation: async () => false
  });

  for (const question of ['what is this', 'what does this say', 'who is that', 'tell me about this']) {
    const r = await agent.run(question);
    const usedCursor = r.model === 'router' && /under the cursor|text around the cursor|window:/i.test(r.answer || '');
    check(`"${question}"`, usedCursor, `model=${r.model}, answer ${String(r.answer || '').length} chars`);
  }

  await bridge.call('setCursorPos', origin);
  console.log(`\n${pass} passed, ${fail} failed\n`);
  bridge.stop();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('\nFATAL:', e.message); process.exit(1); });
