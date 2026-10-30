'use strict';
/**
 * Texting Jarvis through Sendblue, with Sendblue itself stood in for.
 *
 *   node scripts/test-texting.js
 *
 * Asks the real brain (the desktop app's Groq/Gemini keys) one question by
 * "text" and checks what would have been texted back; nothing is sent.
 *   - only the owner's number is answered, and only at the secret address;
 *   - the reply goes to the owner, from Jarvis's line, with both keys;
 *   - a reminder is texted too;
 *   - a laptop job asked by text asks its approval by text, a YES answers
 *     it, and the result is texted back.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { fakeD1 } = require('./fake-d1');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};

(async () => {
  const worker = (await import(pathToFileURL(path.join(__dirname, '..', 'web', '_worker.js')).href)).default;
  let creds = {};
  try { creds = require(path.join(process.env.APPDATA || '', 'VoiceOS', 'credentials.json')); } catch { /* offline */ }
  const dbFile = path.join(os.tmpdir(), `texting-${Date.now()}.db`);
  const env = {
    JARVIS_PASSWORD: 'x', GROQ_API_KEY: creds.groq || '', GEMINI_API_KEY: creds.gemini || '',
    DB: fakeD1(dbFile),
    SENDBLUE_KEY_ID: 'key-id', SENDBLUE_SECRET: 'key-secret', SENDBLUE_FROM: '(555) 000-1111',
    OWNER_PHONE: '555-123-4567', SENDBLUE_HOOK: 'hook-abc'
  };

  // Sendblue, stood in for; everything else goes out for real (the brain).
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('sendblue.com')) {
      sent.push({ headers: opts.headers, ...JSON.parse(opts.body) });
      return new Response('{"status":"QUEUED"}', { status: 202 });
    }
    return realFetch(url, opts);
  };

  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const text = async (body, hook = 'hook-abc') => {
    const res = await worker.fetch(new Request(`https://jarvis.test/api/sendblue/${hook}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env, ctx);
    await Promise.all(waits.splice(0));
    return res;
  };
  const link = async (p, body) => {
    // The laptop's own key, as the desktop app sends it.
    return worker.fetch(new Request(`https://jarvis.test/api/link/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer laptop-key' }, body: JSON.stringify(body) }), env, ctx);
  };
  const { createHash } = require('crypto');
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS link (k INTEGER PRIMARY KEY, hash TEXT, seen INTEGER)').run();
  await env.DB.prepare('INSERT OR REPLACE INTO link (k, hash, seen) VALUES (1, ?, ?)').bind(createHash('sha256').update('laptop-key').digest('hex'), Date.now()).run();

  console.log('\nWho is answered');
  let r = await text({ number: '+15559999999', content: 'what time is it', is_outbound: false });
  check('a stranger gets nothing', r.status === 200 && sent.length === 0, `${sent.length} sent`);
  r = await text({ number: '+15551234567', content: 'what time is it' }, 'wrong-hook');
  check('the wrong address is refused', r.status === 404 && sent.length === 0);
  r = await text({ number: '+15551234567', content: 'hi', is_outbound: true });
  check("Jarvis's own sent messages are ignored", sent.length === 0);

  console.log('\nA question by text');
  r = await text({ number: '+15551234567', content: 'what time is it', is_outbound: false, service: 'iMessage' });
  const reply = sent[0] || {};
  check('answered', r.status === 200 && sent.length === 1, JSON.stringify(sent));
  check('to the owner, from Jarvis\'s line', reply.number === '+15551234567' && reply.from_number === '+15550001111', JSON.stringify(reply));
  check('with both keys', reply.headers && reply.headers['sb-api-key-id'] === 'key-id' && reply.headers['sb-api-secret-key'] === 'key-secret');
  check('the answer is in it', /\d{1,2}:\d{2}/.test(reply.content || ''), reply.content);

  console.log('\nAlerts');
  sent.length = 0;
  await link('notify', { title: 'Jarvis', body: 'Your download finished: notes.pdf.' });
  check('a laptop alert is texted', sent.some((s) => /download finished/.test(s.content)), JSON.stringify(sent));

  console.log('\nA laptop job by text, with an approval');
  sent.length = 0;
  // Asking for something on the laptop: the brain hands it over as a job.
  const asking = text({ number: '+15551234567', content: 'on my laptop, close spotify' });
  let job = null;
  for (let i = 0; i < 30 && !job; i++) {
    await new Promise((res) => setTimeout(res, 300));
    job = await env.DB.prepare("SELECT id FROM jobs WHERE status = 'queued' ORDER BY at DESC LIMIT 1").first().catch(() => null);
  }
  check('the brain handed it to the laptop', Boolean(job), 'no job queued');
  if (job) {
    await env.DB.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").bind(job.id).run();
    await asking;
    await link('confirm', { id: job.id, title: 'Close spotify?', detail: 'Anything unsaved in it is lost.' });
    check('the approval is asked by text', sent.some((s) => /Close spotify\?[\s\S]*Reply YES/.test(s.content)), JSON.stringify(sent.map((s) => s.content)));
    await text({ number: '+15551234567', content: 'Yes' });
    const after = await env.DB.prepare('SELECT status, answer FROM jobs WHERE id = ?').bind(job.id).first();
    check('YES approves it', after.answer === 'yes' && after.status === 'running', JSON.stringify(after));
    sent.length = 0;
    await link('done', { id: job.id, answer: 'Closed spotify.' });
    check('the result is texted back', sent.some((s) => /Closed spotify/.test(s.content)), JSON.stringify(sent));
  } else await asking;

  globalThis.fetch = realFetch;
  try { fs.unlinkSync(dbFile); } catch { /* temp */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
