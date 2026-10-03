'use strict';
/**
 * The daily briefing: what you have on, from your own accounts.
 *
 *   node scripts/test-myday.js
 *
 * Google is stubbed, so this needs no account. The case that prompted it is
 * the first routing test: "what do we have today" was being answered from a
 * web search with "Today is celebrated on National Today."
 */
const { buildTools } = require('../src/core/agent/tools');
const { matchIntent } = require('../src/core/agent/intents');
const { config } = require('../src/core/config');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};

/** Canned Google responses, with any part able to fail on its own. */
function stub({ events = [], work = [], subs = [], unread = [], fail: failing = [] } = {}) {
  const original = global.fetch;
  global.fetch = async (url) => {
    const dead = failing.some((f) => url.includes(f));
    if (dead) return { ok: false, status: 503, text: async () => 'unavailable' };
    let body = {};
    if (url.includes('/calendar/')) body = { items: events };
    else if (url.includes('/messages?')) body = { messages: unread.map((_, i) => ({ id: String(i) })) };
    else if (url.includes('/messages/')) {
      const i = Number(url.split('/messages/')[1].split('?')[0]);
      const m = unread[i] || {};
      body = { id: String(i), snippet: m.snippet || '', payload: { headers: [
        { name: 'From', value: m.from || 'a@b.com' },
        { name: 'Subject', value: m.subject || 'Hello' }
      ] } };
    } else if (url.includes('/courses?')) body = { courses: [{ id: '1', name: 'Physics', courseState: 'ACTIVE' }] };
    else if (url.includes('/studentSubmissions')) body = { studentSubmissions: subs };
    else if (url.includes('/courseWork')) body = { courseWork: work };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return () => { global.fetch = original; };
}

function briefing(opts) {
  const restore = stub(opts);
  const tools = buildTools({
    config, bridge: {}, browser: null, provider: null,
    connections: { tokenFor: async () => ({ token: 'stub' }), status: () => ({}) },
    logger: { info() {}, warn() {}, debug() {} }
  });
  const tool = tools.find((t) => t.name === 'my_day');
  return { run: async () => { try { return await tool.run({}); } finally { restore(); } } };
}

const route = (text) => {
  const tools = buildTools({
    config, bridge: {}, browser: null, provider: null,
    connections: { tokenFor: async () => ({ token: 'x' }), status: () => ({}) },
    logger: { info() {}, warn() {}, debug() {} }
  });
  const r = matchIntent(text, tools, config);
  return r ? r.tool.name : null;
};

const event = (title, hour) => ({
  summary: title,
  start: { dateTime: new Date(Date.now() + hour * 3600000).toISOString() }
});

(async () => {
  console.log('\nAsking about the day reaches the briefing, not the web:');
  for (const text of [
    'Hey Jarvis, what do we have today today?',
    'what do we have today',
    'what do I have to do today',
    'brief me',
    'catch me up',
    "what's my day look like"
  ]) {
    check(`"${text.slice(0, 42)}" -> my_day`, route(text) === 'my_day', String(route(text)));
  }
  check('and never a web lookup',
    route('what do we have today') !== 'answer_from_web', String(route('what do we have today')));

  console.log('\nNaming one part still goes to that part:');
  for (const [text, want] of [
    ['what is on my calendar today', 'list_events'],
    ['what homework do i have', 'list_coursework'],
    ['check my email', 'list_email'],
    ['what is the weather today', 'weather'],
    ['what are my grades', 'list_grades']
  ]) {
    check(`"${text}" -> ${want}`, route(text) === want, String(route(text)));
  }

  console.log('\nA full day:');
  {
    const r = await briefing({
      events: [event('Standup', 1), event('Dentist', 4)],
      work: [{ id: 'a', title: 'Essay' }],
      subs: [{ courseWorkId: 'a', state: 'NEW' }],
      unread: [{ from: 'Priya <p@x.com>', subject: 'Re: deck' }, { from: 'b@y.com', subject: 'Invoice' }]
    }).run();

    check('it succeeds', r.ok === true, JSON.stringify(r));
    check('all three sections are shown',
      /CALENDAR/.test(r.summary) && /DUE/.test(r.summary) && /UNREAD/.test(r.summary), r.summary);
    // Asserting the counts are present, not the exact wording: spoken lines
    // are deliberately short, because synthesis time is proportional to how
    // much is said, and they get shortened again when that matters.
    check('the spoken line counts each one',
      /\b2\b.*calendar/.test(r.spoken) && /\b1\b.*due/.test(r.spoken) && /\b2\b.*unread/.test(r.spoken),
      r.spoken);
    check('and names the first thing', /First,? Standup/.test(r.spoken), r.spoken);
    check('and stays short enough to say quickly', r.spoken.length < 110, `${r.spoken.length} chars`);
    check('it reads as one sentence, not a list of two',
      !/starting with .* and \d+ unread/.test(r.spoken), r.spoken);
    check('cards are produced', (r.found || []).length > 0, String((r.found || []).length));
    console.log(`        "${r.spoken}"`);
  }

  console.log('\nAn empty day says so rather than saying nothing:');
  {
    const r = await briefing({ events: [], work: [], subs: [], unread: [] }).run();
    check('it still answers', r.ok === true && r.spoken.length > 0, JSON.stringify(r.spoken));
    check('nothing is reported as nothing',
      /nothing on your calendar/.test(r.spoken) && /no unread email/.test(r.spoken), r.spoken);
    console.log(`        "${r.spoken}"`);
  }

  console.log('\nOne account failing does not lose the others:');
  {
    // Gmail unreachable; the calendar and the classwork should still arrive.
    const r = await briefing({
      events: [event('Standup', 2)],
      work: [], subs: [], unread: [],
      fail: ['gmail.googleapis.com']
    }).run();
    check('the briefing still comes back', r.ok === true, JSON.stringify(r));
    check('the calendar survived', /Standup/.test(r.summary), r.summary);
    check('mail is simply absent', !/UNREAD/.test(r.summary), r.summary);
    console.log(`        "${r.spoken}"`);
  }

  console.log('\nEvery account failing is reported honestly:');
  {
    const r = await briefing({
      fail: ['gmail.googleapis.com', 'googleapis.com/calendar', 'classroom.googleapis.com']
    }).run();
    check('it does not pretend', /could not reach/i.test(r.summary), r.summary);
    check('and does not invent a day', !/calendar\n/i.test(r.summary), r.summary);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
