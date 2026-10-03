'use strict';
/**
 * Does it actually work? Every capability, exercised for real.
 *
 *   node scripts/verify.js
 *
 * This exists because "it works" has been wrong several times in a row — most
 * recently the grades answer, which looked right, was labelled right, and came
 * from the wrong system entirely. So nothing here is asserted from reading the
 * code: every capability is run, and what comes back is checked.
 *
 * Read-only throughout. Anything that sends, creates or changes is listed as
 * NOT EXERCISED rather than being run, because verifying send_email by sending
 * email is not a thing to do to someone's account.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const { buildTools } = require('../src/core/agent/tools');
const { matchIntent } = require('../src/core/agent/intents');
const { ConnectionManager } = require('../src/core/connect/manager');
const { getBridge } = require('../src/core/native/bridge');
const { createProvider } = require('../src/core/llm/provider');
const { KokoroTts } = require('../src/core/tts/kokoro');
const { WhisperEngine } = require('../src/core/stt/whisper');
const { WakeDetector } = require('../src/core/wake/detector');
const { config } = require('../src/core/config');
const { paths } = require('../src/core/paths');

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const creds = {
  read: () => { try { return JSON.parse(fs.readFileSync(paths.credentials, 'utf8')); } catch { return {}; } },
  write: () => {}
};

const results = [];
const record = (area, name, state, detail) => {
  results.push({ area, name, state, detail });
  const mark = { ok: 'WORKS   ', no: 'BROKEN  ', skip: 'SKIPPED ', info: '        ' }[state];
  console.log(`  ${mark}${name}${detail ? `  — ${detail}` : ''}`);
};

/** Runs a tool and judges the answer, never just that it returned. */
async function exercise(area, name, fn, judge) {
  const started = Date.now();
  try {
    const out = await fn();
    const verdict = judge(out);
    const ms = Date.now() - started;
    if (verdict === true) record(area, name, 'ok', `${ms}ms`);
    else record(area, name, 'no', `${ms}ms — ${verdict}`);
    return out;
  } catch (err) {
    record(area, name, 'no', err.message.slice(0, 90));
    return null;
  }
}

(async () => {
  console.log('\n' + '='.repeat(74));
  console.log('VoiceOS — verifying every capability against reality');
  console.log('='.repeat(74));
  console.log(`\n${os.cpus().length} cores, ${(os.freemem() / 1e9).toFixed(1)}GB free of ${(os.totalmem() / 1e9).toFixed(1)}GB\n`);

  // --- foundations --------------------------------------------------------
  console.log('FOUNDATIONS');
  const bridge = getBridge({ logger: quiet });
  await exercise('core', 'native bridge starts', async () => {
    await bridge.start();
    return bridge.call('ping', {});
  }, (r) => (r && r.ok ? true : 'no reply to ping'));

  await exercise('core', 'reads the screen size', () => bridge.call('screenInfo', {}),
    (r) => (r && r.ok ? true : 'no screen info'));
  await exercise('core', 'reads the cursor', () => bridge.cursorPos(),
    (r) => (r && typeof r.x === 'number' ? true : 'no cursor position'));
  await exercise('core', 'lists windows', () => bridge.listWindows(),
    (r) => { const w = r.windows || r; return Array.isArray(w) && w.length ? true : 'no windows listed'; });

  const connections = new ConnectionManager({ config, bridge, browser: null, logger: quiet, credentials: creds });
  const provider = createProvider('ollama', { baseUrl: config.get('llm.baseUrl') });
  const tools = buildTools({ config, bridge, connections, browser: null, provider, logger: quiet });
  record('core', `${tools.length} tools registered`, 'info');

  // --- speech in ----------------------------------------------------------
  console.log('\nHEARING');
  const stt = new WhisperEngine({
    model: config.get('stt.model'), language: config.get('stt.language'),
    threads: config.get('stt.threads'), beamSize: config.get('stt.beamSize'),
    audioCtx: config.get('stt.audioCtx'), logger: quiet
  });
  const clip = path.join(paths.tmp, 'vocab', 'v0-r0.wav');
  if (fs.existsSync(clip)) {
    await exercise('stt', `transcription (${config.get('stt.model')})`, () => stt.transcribe(clip, { language: 'en' }),
      (r) => (r && r.text && /jarvis|spotify|play/i.test(r.text) ? true : `heard "${r && r.text}"`));
  } else {
    record('stt', 'transcription', 'skip', 'no sample clip; run bench-vocab.js first');
  }

  const wake = new WakeDetector({ modelDir: path.join(paths.models, 'wake'), logger: quiet });
  if (wake.available()) {
    await exercise('wake', 'wake word models load', () => wake.load(), () => true);
    await exercise('wake', 'scores silence as silence', async () => {
      const silence = new Float32Array(16000 * 3);
      let peak = 0;
      for (let i = 0; i + 1280 <= silence.length; i += 1280) {
        const r = await wake.push(silence.subarray(i, i + 1280));
        peak = Math.max(peak, r.score);
      }
      return peak;
    }, (peak) => (peak < 0.5 ? true : `silence scored ${peak.toFixed(3)}`));
  } else {
    record('wake', 'wake word', 'no', 'models missing from models/wake');
  }

  // --- speech out ---------------------------------------------------------
  console.log('\nSPEAKING');
  const tts = new KokoroTts({
    voice: config.get('tts.voice', 'af_heart'),
    dtype: config.get('tts.dtype', 'q4'),
    logger: quiet
  });
  await exercise('tts', `voice loads (${config.get('tts.voice')})`, () => tts.start(), () => true);
  await exercise('tts', 'synthesizes speech', async () => {
    const r = await tts.synthesize('Checking that this works.', { cache: false });
    const bytes = fs.statSync(r.path).size;
    fs.rmSync(r.path, { force: true });
    return { bytes, ms: r.ms };
  }, (r) => (r.bytes > 10000 ? true : `only ${r.bytes} bytes`));
  record('tts', 'fixed phrases cached', 'info', `${tts.loadCache()} phrases`);

  // --- routing ------------------------------------------------------------
  console.log('\nUNDERSTANDING (every command shape, routed)');
  const ROUTES = [
    ['hey', 'small_talk'],
    ['what is the weather', 'weather'],
    ['what is the weather in London tomorrow', 'weather'],
    ['what do we have today', 'my_day'],
    ['what are my grades', 'list_grades'],
    ['check my grades on canvas', 'canvas_grades'],
    ['what do i have due on canvas', 'canvas_assignments'],
    ['what homework do i have', 'list_coursework'],
    ['check my email', 'list_email'],
    ['what is on my calendar today', 'list_events'],
    ['play some music', 'control_playback'],
    ['play Drake', 'play_search'],
    ['pause the music', 'control_playback'],
    ['next song', 'control_playback'],
    ['what is playing', 'now_playing'],
    ['go to canvas', 'open_url'],
    ['open notepad', 'open_app'],
    ['what does a capybara look like', 'show_image'],
    ['read my screen', 'read_screen'],
    ['what is this', 'point_and_ask'],
    ['what is the capital of peru', 'answer_from_web'],
    ['Oh hey Darris, so can you play some music on Spotify', 'control_playback'],
    ['hey jarvis can you check my email please', 'list_email']
  ];
  let routed = 0;
  for (const [text, want] of ROUTES) {
    const r = matchIntent(text, tools, config);
    const got = r ? r.tool.name : 'none';
    if (got === want) routed++;
    else record('route', `"${text.slice(0, 44)}"`, 'no', `wanted ${want}, got ${got}`);
  }
  record('route', `${routed}/${ROUTES.length} commands route correctly`, routed === ROUTES.length ? 'ok' : 'no');

  // --- the things that answer ---------------------------------------------
  console.log('\nANSWERING (run for real)');
  const run = (name, args) => tools.find((t) => t.name === name).run(args || {});

  await exercise('tool', 'weather', () => run('weather', { when: 'now' }),
    (r) => (r.ok && /\d/.test(r.spoken) ? true : `said "${r.spoken}"`));
  await exercise('tool', 'weather, named place', () => run('weather', { place: 'London', when: 'tomorrow' }),
    (r) => (r.ok && /London/i.test(r.spoken) ? true : `said "${r.spoken}"`));
  await exercise('tool', 'weather, unknown place falls back', () => run('weather', { place: 'Kali Creek Park' }),
    (r) => (r.ok && /could not find/i.test(r.spoken) ? true : `said "${r.spoken}"`));
  await exercise('tool', 'small talk', () => run('small_talk', { kind: 'greeting' }),
    (r) => (r.ok && r.spoken ? true : 'no greeting'));
  await exercise('tool', 'now playing', () => run('now_playing'),
    (r) => (r.ok ? true : r.summary));
  await exercise('tool', 'list windows', () => run('list_windows'),
    (r) => (r.ok && (r.found || []).length ? true : 'no windows'));
  await exercise('tool', 'web answer', () => run('answer_from_web', { query: 'what is the capital of peru' }),
    (r) => (r.ok && /lima/i.test(r.summary) ? true : `said "${String(r.summary).slice(0, 60)}"`));
  await exercise('tool', 'picture lookup', () => run('show_image', { subject: 'a capybara' }),
    (r) => (r.ok && r.image && r.image.data ? true : 'no image returned'));

  // --- connected accounts -------------------------------------------------
  console.log('\nCONNECTED ACCOUNTS');
  const status = connections.status ? connections.status() : {};
  const connected = Object.values((status && status.providers) || {})
    .filter((p) => p && p.connected)
    .map((p) => p.name);
  record('connect', `connected: ${connected.length ? connected.join(', ') : 'none'}`, 'info');

  const googleUp = await connections.tokenFor('gmail').then((c) => Boolean(c && c.token)).catch(() => false);
  if (googleUp) {
    await exercise('google', 'email', () => run('list_email', { limit: 3 }),
      (r) => (r.ok ? true : r.summary));
    await exercise('google', 'calendar', () => run('list_events', { days: 1 }),
      (r) => (r.ok ? true : r.summary));
    await exercise('google', 'coursework', () => run('list_coursework'),
      (r) => (r.ok && /Google Classroom/.test(r.summary) ? true : 'the source is not named'));
    await exercise('google', 'grades', () => run('list_grades'),
      (r) => (r.ok && /Google Classroom/.test(r.summary) ? true : 'the source is not named'));
    await exercise('google', 'daily briefing', () => run('my_day'),
      (r) => (r.ok && r.spoken ? true : 'no briefing'));
  } else {
    record('google', 'Google', 'skip', 'not connected');
  }

  const canvasUp = await connections.tokenFor('canvas').then((c) => Boolean(c && c.token)).catch(() => false);
  if (canvasUp) {
    await exercise('canvas', 'grades', () => run('canvas_grades'),
      (r) => (r.ok && /Canvas/.test(r.summary) ? true : r.summary));
    await exercise('canvas', 'assignments', () => run('canvas_assignments'),
      (r) => (r.ok && /Canvas/.test(r.summary) ? true : r.summary));
  } else {
    await exercise('canvas', 'explains it is not connected', () => run('canvas_grades'),
      (r) => (r.ok && /not connected/i.test(r.spoken) && !/%/.test(r.summary)
        ? true : 'it should say so and report no marks'));
  }

  // --- the brain ----------------------------------------------------------
  console.log('\nTHE MODEL');
  const llmUp = await provider.available().catch(() => false);
  record('llm', llmUp ? `${config.get('llm.model')} reachable` : 'Ollama not running', llmUp ? 'ok' : 'no');

  // --- not exercised ------------------------------------------------------
  console.log('\nNOT EXERCISED (they change things; verifying them means doing them)');
  for (const name of ['send_email', 'create_event', 'create_reminder', 'take_note', 'open_app', 'open_url', 'play_search', 'control_playback', 'set_volume', 'open_file']) {
    if (tools.some((t) => t.name === name)) record('skip', name, 'skip');
  }

  // --- verdict ------------------------------------------------------------
  const broken = results.filter((r) => r.state === 'no');
  const working = results.filter((r) => r.state === 'ok');
  console.log('\n' + '='.repeat(74));
  console.log(`${working.length} verified working, ${broken.length} broken, ` +
    `${results.filter((r) => r.state === 'skip').length} not exercised`);
  if (broken.length) {
    console.log('\nBROKEN:');
    for (const b of broken) console.log(`  ${b.name}${b.detail ? ` — ${b.detail}` : ''}`);
  }
  console.log('='.repeat(74) + '\n');

  tts.stop();
  bridge.stop();
  process.exit(broken.length ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
