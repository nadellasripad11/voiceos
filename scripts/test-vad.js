'use strict';
/**
 * Knowing when someone has stopped talking.
 *
 *   node scripts/test-vad.js
 *
 * When the microphone moved from the island overlay to the console this was
 * left behind, and a wake-word session then recorded until something else
 * stopped it. One in the log ran for 73 seconds, cost 20 seconds to
 * transcribe, and came back as "Okay. Okay. Okay." because most of it was an
 * empty room. That single missing piece was most of "the whole system is
 * slow".
 *
 * Two ways to get this wrong and they are not symmetrical. Ending too late
 * wastes time. Ending too early cuts someone off mid-sentence, and they have
 * to say the whole thing again — so the tests for "does not stop early"
 * outnumber the rest.
 */
const path = require('path');

// The class lives in a browser file that ends by assigning to window.
const src = require('fs').readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'console', 'audio.js'), 'utf8'
);
// Date must be the one this file can stub. A fresh context gets its own, and
// then the clock these tests drive is not the clock the class reads — every
// call sees no time elapsed and bails at minRecordMs, which looks exactly
// like the detector being broken.
const sandbox = {
  window: {}, navigator: {}, Date,
  AudioContext: function () {}, Audio: function () {}
};
new (require('vm').Script)(src).runInNewContext(sandbox);
const ConsoleAudio = sandbox.window.ConsoleAudio;

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};

const VAD = {
  enabled: true, silenceMs: 900, threshold: 0.008,
  noiseFactor: 3.5, minRecordMs: 1200, maxUtteranceMs: 20000
};

/** Audio blocks arrive about every 85ms at 4096 samples / 48kHz. */
const BLOCK_MS = 85;

/**
 * Plays loudness values at one block each and reports when it decided the
 * person had finished. Returns the elapsed ms, or null if it never did.
 */
function play(levels, { handsFree = false, followUp = false, followUpMs = 5000 } = {}) {
  const audio = new ConsoleAudio({}, {});
  audio.beginCapture('agent', { vad: VAD, handsFree, followUp, followUpMs });
  const start = audio.capture.startedAt;
  for (let i = 0; i < levels.length; i++) {
    // Drive the clock rather than sleeping: a real-time test of a 90-second
    // pause would take 90 seconds.
    audio.capture.startedAt = start;
    const now = start + i * BLOCK_MS;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const v = audio.shouldStop(levels[i]);
      if (v) return { at: now - start, verdict: v };
    } finally { Date.now = realNow; }
  }
  return null;
}

/** Just the timing, for the tests that only care when it ended. */
const playAt = (...a) => { const r = play(...a); return r ? r.at : null; };

const quiet = (n) => Array(n).fill(0.002);
const speech = (n) => Array.from({ length: n }, (_, i) => 0.05 + 0.04 * Math.abs(Math.sin(i)));

(async () => {
  console.log('\nIt ends after a pause:');
  {
    // Two seconds of talking, then silence.
    const at = playAt([...quiet(12), ...speech(24), ...quiet(40)]);
    check('it stops', at !== null, 'never stopped');
    check('about a second after they finish, not instantly',
      at !== null && at > 900 && at < 4000, `${at}ms`);
  }

  console.log('\nIt does not cut people off:');
  {
    check('silence before the first word is not the end of anything',
      playAt([...quiet(60)]) === null, 'stopped while nobody had spoken');

    // A pause for breath mid-sentence is shorter than the silence window.
    const at = playAt([...speech(12), ...quiet(8), ...speech(12), ...quiet(40)]);
    check('a breath mid-sentence does not end it',
      at !== null && at > (12 + 8 + 12) * BLOCK_MS, `${at}ms, speech ended at ${(32) * BLOCK_MS}ms`);

    check('a very short utterance is not ended before minRecordMs',
      playAt([...speech(2), ...quiet(6)]) === null, 'ended inside the minimum');
  }

  console.log('\nHands-free leaves it to the user:');
  {
    check('a long pause does not end a hands-free recording',
      playAt([...speech(20), ...quiet(60)], { handsFree: true }) === null,
      'hands-free was cut off by silence');
  }

  console.log('\nIt gives up eventually:');
  {
    const audio = new ConsoleAudio({}, {});
    audio.beginCapture('agent', { vad: { ...VAD, maxUtteranceMs: 5000 } });
    const realNow = Date.now;
    Date.now = () => audio.capture.startedAt + 6000;
    let stopped;
    try { stopped = audio.shouldStop(0.5); } finally { Date.now = realNow; }
    check('past the cap it stops even while someone is still talking', stopped === 'send');
  }

  console.log('\nA noisy room cannot record forever:');
  {
    // A fan or an air conditioner sits above the bare threshold and never
    // stops, so the measured floor never catches up and every block reads as
    // speech. Silence alone will not end this one — the hard cap has to, and
    // that is exactly why it exists. Without it this is the 73-second
    // recording again, reached by a different route.
    const at = playAt([...speech(20), ...Array(400).fill(0.02)]);
    check('the cap ends it even when silence never arrives',
      at !== null, 'it recorded forever in a noisy room');
    check('and it ends at the cap, not long after',
      at !== null && at <= 20000 + 200, `${at}ms against a 20000ms cap`);
  }

  console.log('\nTurned off, it never interferes:');
  {
    const audio = new ConsoleAudio({}, {});
    audio.beginCapture('agent', { vad: { ...VAD, enabled: false } });
    check('disabled means the recording runs on', !audio.shouldStop(0.001));
    const none = new ConsoleAudio({}, {});
    none.beginCapture('agent', {});
    check('and so does no config at all', !none.shouldStop(0.001));
  }

  console.log('\nA conversation closes itself when it is over:');
  {
    // After an answer the microphone reopens on its own — that is what makes
    // this a conversation rather than a series of commands. The risk runs the
    // other way: if nobody replies it must not sit recording an empty room
    // for the full cap and send that off to be transcribed into "Okay. Okay."
    const r = play([...quiet(80)], { followUp: true, followUpMs: 5000 });
    check('silence after an answer ends the conversation',
      r && r.verdict === 'abandon', JSON.stringify(r));
    check('and in about the follow-up window, not the 20s cap',
      r && r.at > 5000 && r.at < 7000, `${r && r.at}ms`);

    const spoke = play([...quiet(6), ...speech(20), ...quiet(30)], { followUp: true, followUpMs: 5000 });
    check('answering back is sent, not abandoned',
      spoke && spoke.verdict === 'send', JSON.stringify(spoke));
  }

  console.log('\nA turn the user started is never abandoned:');
  {
    // Only a follow-up opens the microphone unasked. A turn they asked for
    // waits for them, however long they take to begin.
    check('a wake-word turn waits rather than giving up',
      play([...quiet(80)]) === null);
  }

  console.log('\nTalking over it stops it:');
  {
    // The microphone stays open through the reply so it can be interrupted the
    // way a person can. The danger runs the other way: a cough, a door, or its
    // own voice leaking past echo cancellation must not cut it off mid-answer.
    const run = (levels) => {
      const a = new ConsoleAudio({}, {});
      let fired = 0;
      a.onBargeIn = () => { fired++; };
      a.speaking = { pause() {} };            // pretend a reply is playing
      for (const level of levels) {
        if (!a.speaking) break;
        a.overTalk = level >= 0.05 ? a.overTalk + 1 : 0;
        if (a.overTalk >= 3) { a.overTalk = 0; a.silence(); a.onBargeIn(); }
      }
      return fired;
    };

    check('speaking over it interrupts', run([0.09, 0.08, 0.10, 0.09]) === 1);
    check('a single bang does not', run([0.12, 0.01, 0.11, 0.01, 0.09]) === 0,
      'one loud block is a noise, not a sentence');
    check('its own voice leaking through does not', run(Array(40).fill(0.02)) === 0,
      'echo-cancelled leakage sits well under the bar');
    check('and a quiet room does not', run(Array(40).fill(0.004)) === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
