'use strict';
/**
 * Cuts the wait before the user hears anything.
 *
 * Three changes, all aimed at perceived latency rather than total work:
 *
 * 1. Speech is warmed at launch, so the first reply does not pay the model load.
 * 2. The agent emits a short opening line the moment it knows which tool it is
 *    about to run, and that line is spoken while the tool is still working.
 *    This is the difference between silence for two seconds and an immediate
 *    "Checking your email".
 * 3. The microphone is opened ahead of time, so holding the key starts
 *    capturing immediately instead of waiting on getUserMedia.
 */
const fs = require('fs');

// --- tools: say what you are about to do ----------------------------------
const tp = 'src/core/agent/tools.js';
let t = fs.readFileSync(tp, 'utf8');

if (!t.includes('OPENINGS')) {
  t = t.replace(
    '// --- Registry -------------------------------------------------------------',
    `/**
 * What to say while a tool runs.
 *
 * Spoken before the work starts, so the reply begins immediately instead of
 * after the round trip. Deliberately vague about the outcome: it has not
 * happened yet, and promising a result that might fail would be worse than
 * silence.
 */
const OPENINGS = {
  list_email: 'Checking your email.',
  read_email: 'Finding that message.',
  send_email: 'Drafting that.',
  list_events: 'Looking at your calendar.',
  create_event: 'Adding that.',
  list_coursework: 'Checking what is due.',
  search_drive: 'Searching your Drive.',
  search_web: 'Searching the web.',
  answer_from_web: 'Looking that up.',
  fetch_page: 'Reading that page.',
  search_files: 'Looking through your files.',
  read_screen: 'Reading your screen.',
  point_and_ask: 'Having a look.',
  now_playing: null,          // instant; an opening line would arrive after it
  control_playback: null,
  set_volume: null,
  list_reminders: null,
  create_reminder: null,
  take_note: null,
  list_windows: null,
  open_app: null,
  open_url: null
};

/** The line to speak while a tool runs, or null when it is not worth one. */
function openingFor(toolName) {
  return OPENINGS[toolName] || null;
}

// --- Registry -------------------------------------------------------------`
  );
  t = t.replace('module.exports = {\n  readCursorContext,', 'module.exports = {\n  readCursorContext,\n  openingFor,\n  OPENINGS,');
  fs.writeFileSync(tp, t);
}

// --- agent: emit the opening before running -------------------------------
const ap = 'src/core/agent/agent.js';
let a = fs.readFileSync(ap, 'utf8');

a = a.replace(
  "const { buildTools, toolSchemas } = require('./tools');",
  "const { buildTools, toolSchemas, openingFor } = require('./tools');"
);

a = a.replace(
  `    if (routed) {
      onStage('thinking');
      this.logger.info?.(\`[agent] routed "\${question}" -> \${routed.tool.name}\`);
      const result = await this.execute(routed.tool, routed.args, { signal });`,
  `    if (routed) {
      onStage('thinking');
      this.logger.info?.(\`[agent] routed "\${question}" -> \${routed.tool.name}\`);

      // Say what is about to happen while it happens. Synthesis and the tool
      // run concurrently, so the reply starts immediately rather than after
      // the round trip.
      const opening = openingFor(routed.tool.name);
      if (opening && onOpening) onOpening(opening);

      const result = await this.execute(routed.tool, routed.args, { signal });`
);

a = a.replace(
  '  async run(question, { onStage = () => {}, signal } = {}) {',
  '  async run(question, { onStage = () => {}, onOpening = null, signal } = {}) {'
);

// The model path gets one too, since it is the slow path.
a = a.replace(
  `    onStage('thinking');
    return this.runModelLoop(question, tools, { started, signal, onStage });`,
  `    onStage('thinking');
    // The model path is the slow one, so it benefits most from speaking first.
    if (onOpening) onOpening('Let me think about that.');
    return this.runModelLoop(question, tools, { started, signal, onStage });`
);

fs.writeFileSync(ap, a);

// --- main: warm speech, speak the opening, pre-warm the mic ---------------
const mp = 'src/main/main.js';
let m = fs.readFileSync(mp, 'utf8');

// Warm speech at launch.
if (!m.includes('services.tts.prewarm')) {
  m = m.replace(
    "  services.transcripts.prune()",
    `  // Warmed now so the first spoken reply does not pay the model load.
  services.tts.prewarm().catch(() => {});

  services.transcripts.prune()`
  );
}

// Speak the opening line as soon as the agent knows what it is doing.
m = m.replace(
  `        const result = await services.agent.run(transcript, {
          signal,
          onStage: (stage, detail) => broadcast('session-stage', { stage, detail })
        });`,
  `        const result = await services.agent.run(transcript, {
          signal,
          onStage: (stage, detail) => broadcast('session-stage', { stage, detail }),
          // Spoken while the tool is still running, not after it.
          onOpening: (line) => speak(line, { opening: true })
        });`
);

m = m.replace(
  `      const result = await services.agent.run(question, {
        signal: session.abort.signal,
        onStage: (stage, detail) => broadcast('session-stage', { stage, detail })
      });`,
  `      const result = await services.agent.run(question, {
        signal: session.abort.signal,
        onStage: (stage, detail) => broadcast('session-stage', { stage, detail }),
        onOpening: (line) => speak(line, { opening: true })
      });`
);

// speak() learns about openings, which must not be summarised or queued behind.
m = m.replace(
  /async function speak\(text, \{ force = false \} = \{\}\) \{/,
  `async function speak(text, { force = false, opening = false } = {}) {`
);
m = m.replace(
  "  const line = speakableSummary(text);\n  if (!line) return logger.debug('[tts] nothing worth speaking');",
  `  // An opening line is already short and deliberate; summarising it would
  // only risk mangling it.
  const line = opening ? String(text).trim() : speakableSummary(text);
  if (!line) return logger.debug('[tts] nothing worth speaking');`
);

fs.writeFileSync(mp, m);

// --- renderer: pre-warm the microphone ------------------------------------
const np = 'src/renderer/notch/notch.js';
let n = fs.readFileSync(np, 'utf8');

if (!n.includes('prewarmMic')) {
  n = n.replace(
    'async function startCapture(mode, config) {',
    `/**
 * Holds an open microphone stream so recording starts instantly.
 *
 * getUserMedia costs a few hundred milliseconds, and paying it after the key
 * is pressed means the first words of a sentence are lost. The stream is
 * opened once and reused; it is released when the app sleeps so a stale device
 * handle is not kept forever.
 */
let warmStream = null;

async function prewarmMic() {
  if (warmStream && warmStream.active) return warmStream;
  try {
    warmStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    return warmStream;
  } catch {
    // Permission not granted yet, or no device: fall back to asking on demand.
    warmStream = null;
    return null;
  }
}

function releaseWarmMic() {
  if (!warmStream) return;
  for (const track of warmStream.getTracks()) track.stop();
  warmStream = null;
}

async function startCapture(mode, config) {`
  );

  // Use the warm stream when it is available.
  n = n.replace(
    `  try {
    capture.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (err) {
    fail('Microphone unavailable', describeMicError(err));
    return;
  }`,
    `  try {
    // The pre-warmed stream if it is still live, otherwise open one now.
    capture.stream = (warmStream && warmStream.active)
      ? warmStream
      : await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
  } catch (err) {
    fail('Microphone unavailable', describeMicError(err));
    return;
  }`
  );

  // Teardown must not kill the warm stream, or the next session is slow again.
  n = n.replace(
    "  if (capture.stream) { for (const t of capture.stream.getTracks()) t.stop(); capture.stream = null; }",
    `  if (capture.stream) {
    // Keep the pre-warmed stream alive; only stop one we opened ourselves.
    if (capture.stream !== warmStream) {
      for (const t of capture.stream.getTracks()) t.stop();
    }
    capture.stream = null;
  }`
  );

  // Warm it once the overlay is up, and again when the machine wakes.
  n = n.replace(
    'drawWave();\nsetState(',
    `// Opened ahead of time so holding the key starts capturing immediately.
prewarmMic();
// A stream held across sleep goes stale and yields silence, so it is renewed.
window.addEventListener('focus', () => { if (!warmStream || !warmStream.active) prewarmMic(); });

drawWave();
setState(`
  );

  fs.writeFileSync(np, n);
}

const checks = {
  'tool openings': t.includes('const OPENINGS'),
  'agent emits opening': a.includes('const opening = openingFor(routed.tool.name)'),
  'main speaks opening': m.includes("onOpening: (line) => speak(line, { opening: true })"),
  'speech warmed': m.includes('services.tts.prewarm()'),
  'mic prewarm': n.includes('async function prewarmMic'),
  'warm stream reused': n.includes('capture.stream !== warmStream')
};
for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'ok  ' : 'MISS'} ${k}`);
