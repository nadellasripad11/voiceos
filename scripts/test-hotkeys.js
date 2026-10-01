'use strict';
/**
 * Verifies the hold-to-talk keyboard hook.
 *
 * Synthesizes real key events through the native bridge and asserts which
 * gestures start a session and, just as importantly, which do not: an ordinary
 * shortcut like Ctrl+Shift+T must pass through untouched.
 *
 *   node scripts/test-hotkeys.js
 */
const { HoldToTalk } = require('../src/main/hotkeys');
const { getBridge } = require('../src/core/native/bridge');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const events = [];
let pass = 0;
let fail = 0;

function check(name, condition, detail) {
  if (condition) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); fail++; }
}

(async () => {
  const hook = new HoldToTalk({
    logger: quiet,
    onStart: (mode) => events.push({ type: 'start', mode }),
    onStop: (mode) => events.push({ type: 'stop', mode })
  });

  if (!hook.start()) {
    console.error('\nThe keyboard hook could not start; hold-to-talk is unavailable here.');
    process.exit(1);
  }
  console.log('\nKeyboard hook running. Synthesizing gestures…\n');

  const bridge = getBridge({ logger: quiet });
  await bridge.start();

  /** A genuine hold: press, wait past the arming window, release. */
  async function hold(combo, ms = 450) {
    events.length = 0;
    await bridge.keyDown(combo);
    await sleep(ms);
    await bridge.keyUp(combo);
    await sleep(250);
    return [...events];
  }

  /** A normal shortcut: everything pressed and released at once. */
  async function tap(combo) {
    events.length = 0;
    await bridge.keys(combo);
    await sleep(500);
    return [...events];
  }

  console.log('Gestures that should start a session:');
  const dictation = await hold('ctrl+shift');
  check('Ctrl+Shift starts dictation',
    dictation.some((e) => e.type === 'start' && e.mode === 'dictation'),
    `got ${JSON.stringify(dictation)}`);
  check('releasing ends it',
    dictation.some((e) => e.type === 'stop'),
    `got ${JSON.stringify(dictation)}`);

  const agent = await hold('ctrl+alt');
  check('Ctrl+Alt starts agent',
    agent.some((e) => e.type === 'start' && e.mode === 'agent'),
    `got ${JSON.stringify(agent)}`);

  console.log('\nOrdinary shortcuts that must pass through untouched:');
  for (const combo of ['ctrl+shift+t', 'ctrl+alt+delete', 'ctrl+c', 'ctrl+shift+escape', 'alt+tab']) {
    const result = await tap(combo);
    check(`${combo} does not start a session`,
      !result.some((e) => e.type === 'start'),
      `got ${JSON.stringify(result)}`);
  }

  console.log('\nSingle modifiers alone:');
  for (const combo of ['ctrl', 'shift', 'alt']) {
    const result = await hold(combo);
    check(`${combo} alone does nothing`,
      !result.some((e) => e.type === 'start'),
      `got ${JSON.stringify(result)}`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  hook.shutdown();
  bridge.stop();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
