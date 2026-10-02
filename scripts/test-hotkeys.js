'use strict';
/**
 * Verifies the hold-to-talk state machine.
 *
 * Drives HoldToTalk with the exact lines the keyboard daemon emits, rather than
 * synthesizing real keystrokes. That is deliberate: the previous version pressed
 * keys through the native bridge and asserted that ordinary shortcuts did *not*
 * start a session — so when the global hook delivered nothing at all (which
 * happens in a sandboxed or non-interactive session), every negative assertion
 * passed and the suite reported success on a completely dead hook.
 *
 * The daemon's output is a two-event vocabulary, so feeding it directly covers
 * the whole machine — arming, poisoning, hands-free — deterministically and in
 * milliseconds.
 *
 *   node scripts/test-hotkeys.js
 *
 * `--integration` additionally checks that the real hook is alive. It reports
 * UNVERIFIED rather than passing when the hook delivers nothing.
 */
const { HoldToTalk } = require('../src/main/hotkeys');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

let pass = 0;
let fail = 0;

function check(name, condition, detail) {
  if (condition) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); fail++; }
}

const ARM = 60;

/** A hook wired to a recorded event list, with no daemon behind it. */
function makeHook(bindings) {
  const events = [];
  const hook = new HoldToTalk({
    logger: quiet,
    armMs: ARM,
    bindings,
    onStart: (mode, opts) => events.push({ type: 'start', mode, handsFree: Boolean(opts && opts.handsFree) }),
    onStop: (mode) => events.push({ type: 'stop', mode })
  });
  const feed = (msg) => hook.handleLine(JSON.stringify(msg));
  return {
    events,
    hook,
    down: (mod) => feed({ type: 'mod-down', mod }),
    up: (mod) => feed({ type: 'mod-up', mod }),
    key: () => feed({ type: 'other-key' }),
    /** Press the chord, wait past arming, release. */
    async hold(mods, ms = ARM + 90) {
      for (const m of mods) feed({ type: 'mod-down', mod: m });
      await sleep(ms);
      for (const m of [...mods].reverse()) feed({ type: 'mod-up', mod: m });
      await sleep(20);
    },
    /** Press and release the chord inside the arming window. */
    async tap(mods, ms = 15) {
      for (const m of mods) feed({ type: 'mod-down', mod: m });
      await sleep(ms);
      for (const m of [...mods].reverse()) feed({ type: 'mod-up', mod: m });
      await sleep(20);
    }
  };
}

const started = (events) => events.find((e) => e.type === 'start');
const stopped = (events) => events.find((e) => e.type === 'stop');

(async () => {
  console.log('\nHolding a chord:');
  {
    const h = makeHook();
    await h.hold(['ctrl', 'shift']);
    check('Ctrl+Shift starts the agent',
      started(h.events) && started(h.events).mode === 'agent',
      `got ${JSON.stringify(h.events)}`);
    check('releasing ends it',
      stopped(h.events) && stopped(h.events).mode === 'agent',
      `got ${JSON.stringify(h.events)}`);
  }
  {
    const h = makeHook();
    await h.hold(['ctrl', 'alt']);
    check('Ctrl+Alt starts dictation',
      started(h.events) && started(h.events).mode === 'dictation',
      `got ${JSON.stringify(h.events)}`);
  }
  {
    const h = makeHook({ shift: 'dictation', alt: 'agent' });
    await h.hold(['ctrl', 'shift']);
    check('swapped bindings are honoured',
      started(h.events) && started(h.events).mode === 'dictation',
      `got ${JSON.stringify(h.events)}`);
  }

  console.log('\nOrdinary shortcuts must pass through untouched:');
  {
    // Ctrl+Shift+T: the letter lands while the chord is still arming.
    const h = makeHook();
    h.down('ctrl'); h.down('shift');
    await sleep(15);
    h.key();
    await sleep(ARM + 120);
    h.up('shift'); h.up('ctrl');
    await sleep(20);
    check('a letter during arming cancels the hold', !started(h.events), `got ${JSON.stringify(h.events)}`);
  }
  {
    // A key arriving after the hold has begun must end it, not be swallowed.
    const h = makeHook();
    h.down('ctrl'); h.down('shift');
    await sleep(ARM + 60);
    const wasStarted = Boolean(started(h.events));
    h.key();
    await sleep(20);
    check('a key after the hold began ends it',
      wasStarted && stopped(h.events),
      `got ${JSON.stringify(h.events)}`);
  }
  {
    const h = makeHook();
    await h.hold(['ctrl', 'shift', 'alt']);
    check('Ctrl+Shift+Alt is neither mode', !started(h.events), `got ${JSON.stringify(h.events)}`);
  }

  console.log('\nSingle modifiers and stray taps:');
  for (const mod of ['ctrl', 'shift', 'alt']) {
    const h = makeHook();
    await h.hold([mod]);
    check(`${mod} alone does nothing`, !started(h.events), `got ${JSON.stringify(h.events)}`);
  }
  {
    const h = makeHook();
    await h.tap(['ctrl', 'shift']);
    check('one tap starts nothing', !started(h.events), `got ${JSON.stringify(h.events)}`);
  }
  {
    // Two taps too far apart are two separate taps, not a double.
    const h = makeHook();
    await h.tap(['ctrl', 'shift']);
    h.hook.doubleTapMs = 50;
    await sleep(120);
    await h.tap(['ctrl', 'shift']);
    check('two slow taps are not a double tap', !started(h.events), `got ${JSON.stringify(h.events)}`);
  }

  console.log('\nHands-free (double-tap latches on, one tap ends it):');
  {
    const h = makeHook();
    await h.tap(['ctrl', 'shift']);
    await h.tap(['ctrl', 'shift']);
    check('double-tap starts a session',
      started(h.events) && started(h.events).mode === 'agent',
      `got ${JSON.stringify(h.events)}`);
    check('it is flagged hands-free',
      started(h.events) && started(h.events).handsFree === true,
      `got ${JSON.stringify(h.events)}`);
    check('it stays on after the keys come up', !stopped(h.events), `got ${JSON.stringify(h.events)}`);
    check('status reports it', h.hook.status().handsFree === true, JSON.stringify(h.hook.status()));

    h.key();
    await sleep(20);
    check('ordinary typing does not end it', !stopped(h.events), `got ${JSON.stringify(h.events)}`);

    await sleep(h.hook.latchGuardMs + 20);
    h.events.length = 0;
    await h.tap(['ctrl', 'shift']);
    check('one more tap ends it',
      stopped(h.events) && stopped(h.events).mode === 'agent',
      `got ${JSON.stringify(h.events)}`);
    check('and it is no longer latched', h.hook.handsFree === null, String(h.hook.handsFree));
  }
  {
    const h = makeHook();
    await h.tap(['ctrl', 'shift']);
    await h.tap(['ctrl', 'shift']);
    h.events.length = 0;
    h.hook.reset();
    check('reset clears the latch', h.hook.handsFree === null, String(h.hook.handsFree));
  }

  if (process.argv.includes('--integration')) {
    console.log('\nIntegration: is the real keyboard hook delivering events?');
    const { getBridge } = require('../src/core/native/bridge');
    const hook = new HoldToTalk({ logger: quiet, onStart() {}, onStop() {} });
    let delivered = 0;
    const orig = hook.handleLine.bind(hook);
    hook.handleLine = (line) => { if (!line.includes('ready')) delivered++; orig(line); };

    if (!hook.start()) {
      console.log('  UNVERIFIED  the hook helper would not start');
    } else {
      const bridge = getBridge({ logger: quiet });
      await bridge.start();
      await sleep(1500);
      await bridge.keys('shift');
      await sleep(900);
      if (delivered === 0) {
        console.log('  UNVERIFIED  the hook reported no events for a synthesized keypress.');
        console.log('              Global hooks get no input in a sandboxed or non-interactive');
        console.log('              session, so this says nothing about the app. Check by hand.');
      } else {
        check('the hook delivers real key events', delivered > 0, `${delivered} events`);
      }
      bridge.stop();
    }
    hook.shutdown();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
