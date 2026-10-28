'use strict';
/**
 * The website's server (web/_worker.js), run in Node with a stand-in for
 * Cloudflare.
 *
 *   node scripts/test-worker.js          offline: the door, the cookie, the guards
 *   node scripts/test-worker.js --live   also asks real questions (uses the local keys)
 */
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};
const live = process.argv.includes('--live');

(async () => {
  const worker = (await import(pathToFileURL(path.join(__dirname, '..', 'web', '_worker.js')).href)).default;
  let creds = {};
  try { creds = require(path.join(process.env.APPDATA || '', 'VoiceOS', 'credentials.json')); } catch { /* offline */ }
  const env = {
    JARVIS_PASSWORD: 'correct horse battery staple',
    GROQ_API_KEY: live ? creds.groq : '',
    GEMINI_API_KEY: live ? creds.gemini : '',
    ASSETS: { fetch: async () => new Response('the static site', { status: 200 }) }
  };
  const site = 'https://jarvis.example';
  const call = (p, { method = 'GET', body, cookie, origin = site } = {}) => {
    const headers = { 'Content-Type': 'application/json', Origin: origin };
    if (cookie) headers.Cookie = cookie;
    const req = new Request(site + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return worker.fetch(req, env);
  };

  console.log('\nThe site itself:');
  check('pages are served as they are', (await (await call('/')).text()) === 'the static site');

  console.log('\nThe door:');
  {
    const r = await call('/api/ask', { method: 'POST', body: { question: 'hi' } });
    check('asking without signing in is refused', r.status === 401);
    const bad = await call('/api/login', { method: 'POST', body: { password: 'guess' } });
    check('a wrong password is refused', bad.status === 401 && !bad.headers.get('set-cookie'));
  }
  const good = await call('/api/login', { method: 'POST', body: { password: env.JARVIS_PASSWORD } });
  const setCookie = good.headers.get('set-cookie') || '';
  check('the right password signs in', good.status === 200 && /^jv=\d+\.[0-9a-f]{64};/.test(setCookie), setCookie);
  check('with a cookie scripts cannot read and other sites cannot send', /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie) && /Secure/.test(setCookie));
  const cookie = setCookie.split(';')[0];
  check('the session says so', (await (await call('/api/session', { cookie })).json()).signedIn === true);
  {
    const forged = cookie.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
    check('a forged cookie is not a session', (await (await call('/api/session', { cookie: forged })).json()).signedIn === false);
    const expired = `jv=1000.${'0'.repeat(64)}`;
    check('an expired cookie is not a session', (await (await call('/api/session', { cookie: expired })).json()).signedIn === false);
    const cross = await call('/api/ask', { method: 'POST', body: { question: 'hi' }, cookie, origin: 'https://evil.example' });
    check('another site cannot post with the cookie', cross.status === 403);
  }
  {
    const noPw = await worker.fetch(new Request(site + '/api/session'), { ...env, JARVIS_PASSWORD: '' });
    check('with no password set, nothing answers', noPw.status === 503);
  }

  console.log('\nThe clock, without a model:');
  {
    const r = await (await call('/api/ask', { method: 'POST', cookie, body: { question: 'what time is it', tz: 'America/New_York' } })).json();
    check('reads the time', /\d{1,2}:\d{2}/.test(r.answer) && r.via === 'clock', JSON.stringify(r));
  }

  console.log('\nMemory never takes secrets:');
  {
    const r = await (await call('/api/tool', { method: 'POST', cookie, body: { name: 'remember', args: { fact: 'My PIN is 4821' } } })).json();
    check('a PIN is not stored', !r.memoryAdd, JSON.stringify(r));
    const ok = await (await call('/api/tool', { method: 'POST', cookie, body: { name: 'remember', args: { fact: 'Their favourite food is sushi' } } })).json();
    check('an ordinary fact is', ok.memoryAdd && ok.memoryAdd[0] === 'Their favourite food is sushi');
    const out = await (await call('/api/tool', { method: 'POST', cookie, body: { name: 'read_page', args: { url: `https://x.example/?d=${'A'.repeat(220)}` } } })).json();
    check('an address smuggling data out is not opened', /carrying data out/.test(out.text));
  }

  if (live) {
    console.log('\nReal questions (live keys):');
    for (const [q, want] of [
      ['whats the weather tomorrow in london', /london|°/i],
      ['give me the top news headlines', /./],
      ['who wrote pride and prejudice', /austen/i]
    ]) {
      const t = Date.now();
      const r = await (await call('/api/ask', { method: 'POST', cookie, body: { question: q, tz: 'America/New_York', memory: [] } })).json();
      check(`"${q}" (${Date.now() - t}ms via ${r.via})`, r.answer && want.test(r.answer), String(r.answer || r.error).slice(0, 200));
      console.log(`        ${String(r.answer).replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    const tok = await (await call('/api/live-token', { method: 'POST', cookie, body: {} })).json();
    check('a voice pass is issued, and it is not the key', tok.token && tok.token.startsWith('auth_tokens/') && tok.token !== creds.gemini);
    const learnt = await (await call('/api/learn', { method: 'POST', cookie, body: { question: 'my sister maya has her piano recital on friday at six', answer: 'Noted.', memory: [] } })).json();
    check('memory learns from a conversation', learnt.add && learnt.add.length > 0, JSON.stringify(learnt));
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
