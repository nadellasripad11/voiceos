'use strict';
/**
 * Groq doing the heavy lifting, and what happens when it will not.
 *
 *   node scripts/test-cloud.js
 *
 * Transcription and thinking both run on Groq's free tier now, with nothing
 * local loaded behind the brain. So the part worth testing is the unhappy
 * path: busy, out of quota, offline, a key that stopped working, and the
 * silence Whisper fills with "Thank you." Every case runs against a fake Groq
 * on localhost, so this spends no quota and needs no network.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GroqWhisper, CloudFirstStt, PHANTOM } = require('../src/core/stt/groq');
const { createProvider } = require('../src/core/llm/provider');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};

/** A fake Groq whose next answers are scripted per test. */
function fakeGroq() {
  const queue = [];
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    req.resume();
    req.on('end', () => {
      const next = queue.shift() || { status: 500, body: {} };
      if (next.hang) return; // never answers: a dead network
      const headers = { 'Content-Type': 'application/json', ...(next.headers || {}) };
      res.writeHead(next.status, headers);
      res.end(JSON.stringify(next.body || {}));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    script: (...answers) => queue.push(...answers),
    get hits() { return hits; },
    close: () => server.close()
  })));
}

/** A local engine that records being asked. */
function fakeLocal(text = 'from the laptop') {
  return {
    calls: 0,
    modelName: 'ggml-base.en-q5_1.bin',
    threads: 4,
    status() { return { ready: true, model: 'x', threads: 4, problems: [] }; },
    async transcribe() { this.calls++; return { text, ms: 5, rtf: 0.1 }; }
  };
}

const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const transcript = (text) => ({ status: 200, body: { text, language: 'en', segments: [{ text }] } });

(async () => {
  const wav = path.join(os.tmpdir(), `test-cloud-${process.pid}.wav`);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + 32000, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(32000, 40);
  fs.writeFileSync(wav, Buffer.concat([header, Buffer.alloc(32000)]));

  const groq = await fakeGroq();
  const stt = (local = fakeLocal(), timeoutMs = 1500) => new CloudFirstStt({
    cloud: new GroqWhisper({ apiKey: 'test', baseUrl: groq.url, timeoutMs }),
    local,
    logger: quiet
  });

  console.log('\nTranscription goes to Groq first:');
  {
    const local = fakeLocal();
    groq.script(transcript(' What is the weather tomorrow?'));
    const r = await stt(local).transcribe(wav, {});
    check('Groq answers', r.text === 'What is the weather tomorrow?' && r.engine === 'groq', JSON.stringify(r));
    check('the laptop does no work', local.calls === 0);
  }

  console.log('\nWhen Groq will not, the laptop does:');
  {
    const local = fakeLocal();
    const engine = stt(local);
    groq.script({ status: 429, headers: { 'retry-after': '30' }, body: { error: { message: 'Rate limit' } } });
    const r = await engine.transcribe(wav, {});
    check('out of quota falls back to local', r.text === 'from the laptop' && r.engine === 'local', JSON.stringify(r));
    const before = groq.hits;
    await engine.transcribe(wav, {});
    check('and stops asking until the limit resets', groq.hits === before && local.calls === 2);
  }
  {
    const local = fakeLocal();
    groq.script({ status: 401, body: { error: { message: 'Invalid API Key' } } });
    const r = await stt(local).transcribe(wav, {});
    check('a revoked key falls back to local', r.engine === 'local' && local.calls === 1);
  }
  {
    const local = fakeLocal();
    groq.script({ hang: true });
    const t0 = Date.now();
    const r = await stt(local, 400).transcribe(wav, {});
    check('a dead network falls back once the deadline passes', r.engine === 'local' && Date.now() - t0 < 1500,
      `${Date.now() - t0}ms`);
  }
  {
    const local = fakeLocal();
    const engine = new CloudFirstStt({
      cloud: new GroqWhisper({ apiKey: 'test', baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 }),
      local, logger: quiet
    });
    const r = await engine.transcribe(wav, {});
    check('no internet at all falls back to local', r.engine === 'local');
  }
  {
    const local = fakeLocal();
    const engine = new CloudFirstStt({ cloud: new GroqWhisper({ apiKey: '' }), local, logger: quiet });
    await engine.transcribe(wav, {});
    check('no key means local, without trying', local.calls === 1);
    check('and it still reports ready', engine.status().ready === true);
  }

  console.log('\nThe silence Whisper fills with words:');
  {
    const local = fakeLocal('');
    groq.script(transcript(' Thank you.'));
    const r = await stt(local).transcribe(wav, {});
    check('a phantom "Thank you." is checked locally and dropped', r.text === '' && local.calls === 1, JSON.stringify(r));
  }
  {
    const local = fakeLocal('Thank you.');
    groq.script(transcript(' Thank you.'));
    const r = await stt(local).transcribe(wav, {});
    check('a real "thank you" survives the check', r.text === 'Thank you.');
  }
  {
    const local = fakeLocal();
    groq.script(transcript(' Thank you, Jarvis.'));
    const r = await stt(local).transcribe(wav, {});
    check('anything longer is trusted without a check', r.text === 'Thank you, Jarvis.' && local.calls === 0);
  }
  for (const [t, want] of [['Thanks for watching!', true], ['you', true], ['...', true],
    ['play some drake', false], ['you know what', false], ['bye bye now', false]]) {
    check(`"${t}" ${want ? 'is' : 'is not'} a phantom`, PHANTOM.test(t) === want);
  }

  console.log('\nCancelling is not a failure:');
  {
    const local = fakeLocal();
    groq.script({ hang: true });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    let threw = false;
    try { await stt(local, 5000).transcribe(wav, { signal: ac.signal }); } catch { threw = true; }
    check('a cancelled clip is not re-transcribed locally', threw && local.calls === 0);
  }

  console.log('\nThe brain, when Groq is busy:');
  const brain = () => createProvider('groq', { apiKey: 'test', baseUrl: groq.url, logger: quiet });
  const reply = (text) => ({ status: 200, body: { choices: [{ message: { content: text } }], usage: {} } });
  {
    groq.script({ status: 429, headers: { 'retry-after': '0.3' }, body: {} }, reply('Sunny, sir.'));
    const t0 = Date.now();
    const r = await brain().chat({ model: 'm', messages: [{ role: 'user', content: 'weather' }] });
    check('a short wait is waited out and the answer still comes', r.text === 'Sunny, sir.', JSON.stringify(r.text));
    check('after the wait Groq asked for', Date.now() - t0 >= 290, `${Date.now() - t0}ms`);
  }
  {
    groq.script({ status: 429, headers: { 'retry-after': '600' }, body: {} });
    const before = groq.hits;
    let err = null;
    try { await brain().chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { err = e; }
    check('a long wait is not waited (the daily cap)', err && err.code === 'rate_limited' && groq.hits === before + 1);
    check('and says when to ask again, in words', err && /about 10 minutes/.test(err.message) && !/HTTP|429/.test(err.message),
      err && err.message);
  }
  {
    groq.script({ status: 429, headers: { 'retry-after': '0.2' }, body: {} }, { status: 429, headers: { 'retry-after': '40' }, body: {} });
    let err = null;
    try { await brain().chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { err = e; }
    check('only one retry, then it says so', err && err.code === 'rate_limited' && /in a minute/.test(err.message), err && err.message);
  }
  {
    groq.script({ status: 429, headers: { 'retry-after': '5' }, body: {} });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const t0 = Date.now();
    let err = null;
    try { await brain().chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], signal: ac.signal }); } catch (e) { err = e; }
    check('cancelling during the wait stops it at once', err && Date.now() - t0 < 1000, `${Date.now() - t0}ms`);
  }

  console.log('\nNo local brain behind it:');
  {
    // The shipped default, not this machine's saved settings: what a fresh
    // install does is the thing under test.
    const { DEFAULTS } = require('../src/core/config');
    const { createBrain } = require('../src/core/llm');
    const fakeConfig = { get: (k, d) => (k === 'llm.fallbackProvider' ? DEFAULTS.llm.fallbackProvider : k === 'llm.provider' ? 'groq' : d) };
    const b = createBrain({ config: fakeConfig, logger: quiet, credentials: { groq: 'test' } });
    check('the default brain is Groq alone, nothing that loads a model here', b.name === 'groq' && !b.local,
      `got ${b.name}`);
  }

  groq.close();
  fs.rmSync(wav, { force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
