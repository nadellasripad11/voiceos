'use strict';
/**
 * The laptop link, end to end, offline: the website's server (web/_worker.js)
 * with an in-memory stand-in for D1, and the desktop side (src/main/web-link.js)
 * polling it with a fake agent.
 *
 *   node scripts/test-link.js
 */
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { pathToFileURL } = require('url');
const { WebLink } = require('../src/main/web-link');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Just enough of D1 for the worker. */
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE memory (fact TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, task TEXT NOT NULL, status TEXT NOT NULL, title TEXT, detail TEXT, answer TEXT, result TEXT, at INTEGER NOT NULL);
    CREATE TABLE frame (k INTEGER PRIMARY KEY, data TEXT, url TEXT, at INTEGER);
    CREATE TABLE link (k INTEGER PRIMARY KEY, hash TEXT, seen INTEGER);`);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) || null,
    run: async () => db.prepare(sql).run(...args),
    all: async () => ({ results: db.prepare(sql).all(...args) })
  });
  return { raw: db, prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}

(async () => {
  const worker = (await import(pathToFileURL(path.join(__dirname, '..', 'web', '_worker.js')).href)).default;
  const DB = fakeD1();
  const token = crypto.randomBytes(16).toString('hex');
  DB.raw.prepare('INSERT INTO link (k, hash, seen) VALUES (1, ?, 0)').run(crypto.createHash('sha256').update(token).digest('hex'));
  const env = { JARVIS_PASSWORD: 'pw', DB, ASSETS: { fetch: async () => new Response('site') } };
  const site = 'https://jarvis.example';

  // The desktop side reaches the worker through this, not the network.
  const realFetch = global.fetch;
  global.fetch = (u, init) => (String(u).startsWith(site) ? worker.fetch(new Request(u, init), env) : realFetch(u, init));

  const call = (p, { method = 'GET', body, cookie } = {}) => worker.fetch(new Request(site + p, {
    method, headers: { 'Content-Type': 'application/json', Origin: site, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined
  }), env);
  const cookie = ((await call('/api/login', { method: 'POST', body: { password: 'pw' } })).headers.get('set-cookie') || '').split(';')[0];

  console.log('\nThe key:');
  check('a wrong key is refused', (await worker.fetch(new Request(`${site}/api/link/next`, { headers: { Authorization: 'Bearer nope' } }), env)).status === 401);
  check('the laptop shows offline before it polls', (await (await call('/api/session', { cookie })).json()).laptop === false);

  const memory = { facts: [{ text: 'The user drinks oat milk' }], save() {}, add(list) { for (const t of list) this.facts.push({ text: t }); return list; } };
  const confirmSeen = [];
  let link;
  link = new WebLink({
    url: site, token, memory, logger: { info() {}, debug() {}, warn() {} },
    run: async (task) => {
      if (/buy/.test(task)) {
        const ok = await link.confirm({ title: 'Buy the socks for $9?', detail: 'amazon.com' });
        confirmSeen.push(ok);
        return { answer: ok ? 'Bought.' : 'Not bought.' };
      }
      link.frame({ data: 'AAAA', url: 'https://example.com' });
      await sleep(300);
      return { answer: `Done: ${task}` };
    }
  });
  link.start();
  await sleep(500);

  console.log('\nJobs:');
  check('the laptop shows online once it polls', (await (await call('/api/session', { cookie })).json()).laptop === true);
  const quick = await (await call('/api/tool', { method: 'POST', cookie, body: { name: 'laptop', args: { task: 'turn the volume to 30' } } })).json();
  check('a quick job comes back in the same answer', /Done: turn the volume to 30/.test(quick.text), quick.text);

  const buy = await (await call('/api/tool', { method: 'POST', cookie, body: { name: 'laptop', args: { task: 'buy socks' } } })).json();
  check('a job waiting on approval hands back a job id', Boolean(buy.pendingJob), JSON.stringify(buy));
  const st = await (await call(`/api/laptop?job=${buy.pendingJob}`, { cookie })).json();
  check('the website sees the approval request', st.job && st.job.status === 'confirm' && /socks/.test(st.job.title), JSON.stringify(st));
  await call('/api/laptop/answer', { method: 'POST', cookie, body: { id: buy.pendingJob, yes: false } });
  await sleep(3000);
  const after = await (await call(`/api/laptop?job=${buy.pendingJob}`, { cookie })).json();
  check('declining on the website declines on the laptop', confirmSeen[0] === false && after.job.result.answer === 'Not bought.', JSON.stringify(after));

  console.log('\nMemory:');
  await link.syncMemory();
  const web = await (await call('/api/memory', { cookie })).json();
  check('the laptop\'s facts reach the website', web.facts.includes('The user drinks oat milk'));
  await call('/api/memory', { method: 'POST', cookie, body: { add: ['The user has a dog named Rex'], remove: ['The user drinks oat milk'] } });
  await link.syncMemory();
  const texts = memory.facts.map((f) => f.text);
  check('the website\'s facts reach the laptop', texts.includes('The user has a dog named Rex'));
  check('forgetting on the website forgets on the laptop', !texts.includes('The user drinks oat milk'), texts.join(' | '));
  const secret = await (await call('/api/memory', { method: 'POST', cookie, body: { add: ['My PIN is 4821'] } })).json();
  check('secrets are never stored', !secret.facts.some((f) => /PIN/.test(f)));

  link.stop();
  global.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
