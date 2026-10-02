'use strict';
/**
 * Verifies what counts as homework still owed.
 *
 *   node scripts/test-coursework.js
 *
 * Google is stubbed, so this needs no account and touches nothing. The cases
 * come from a real Classroom account where every assignment has no due date
 * and all of them are already turned in — which the old code reported as
 * "nothing due", indistinguishable from not having looked.
 */
const { buildTools } = require('../src/core/agent/tools');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};

const COURSE = { id: '1', name: 'AI x Business', courseState: 'ACTIVE' };

/** Serves canned Classroom responses in place of the network. */
function stubGoogle({ work, submissions, courses = [COURSE] }) {
  const original = global.fetch;
  global.fetch = async (url) => {
    let body;
    if (url.includes('/courses?')) body = { courses };
    else if (url.includes('/studentSubmissions')) body = { studentSubmissions: submissions };
    else if (url.includes('/courseWork')) body = { courseWork: work };
    else body = {};
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return () => { global.fetch = original; };
}

function tool({ work, submissions, courses }) {
  const restore = stubGoogle({ work, submissions, courses });
  const tools = buildTools({
    config: { get: (k, d) => (k === 'apps' ? {} : d) },
    bridge: {}, browser: null, logger: { info() {}, warn() {}, debug() {} },
    connections: { tokenFor: async () => ({ token: 'stub' }) }
  });
  const t = tools.find((x) => x.name === 'list_coursework');
  return { run: async (args) => { try { return await t.run(args || {}); } finally { restore(); } } };
}

const dated = (id, title, y, m, d) => ({ id, title, dueDate: { year: y, month: m, day: d } });
const undated = (id, title) => ({ id, title });
const sub = (courseWorkId, state) => ({ courseWorkId, state });

const PAST = [2020, 1, 1];
const FUTURE = [2099, 6, 15];

(async () => {
  console.log('\nThe real account: 21 undated assignments, all turned in:');
  {
    const work = Array.from({ length: 21 }, (_, i) => undated(String(i), `Day ${i + 1} Homework`));
    const submissions = work.map((w) => sub(w.id, 'RETURNED'));
    const r = await tool({ work, submissions }).run();
    check('it is not reported as due', !/overdue|coming up/i.test(r.spoken), r.spoken);
    check('it says how many it checked', /21/.test(r.summary), r.summary);
    check('it names the class', /AI x Business/.test(r.summary), r.summary);
    console.log(`        spoken: "${r.spoken}"`);
  }

  console.log('\nUndated work that is NOT turned in must still be reported:');
  {
    const work = [undated('a', 'Pitch deck'), undated('b', 'Reflection')];
    const submissions = [sub('a', 'NEW'), sub('b', 'RETURNED')];
    const r = await tool({ work, submissions }).run();
    check('the outstanding one is listed', /Pitch deck/.test(r.summary), r.summary);
    check('the finished one is not', !/Reflection/.test(r.summary), r.summary);
    check('it is described as having no due date', /No due date/.test(r.summary), r.summary);
    check('the count is right', /1 with no due date/.test(r.spoken), r.spoken);
  }

  console.log('\nOverdue and unsubmitted is exactly what you want to hear:');
  {
    const work = [dated('a', 'Essay', ...PAST)];
    const r = await tool({ work, submissions: [sub('a', 'CREATED')] }).run();
    check('it is reported, not discarded as past', /Essay/.test(r.summary), r.summary);
    check('it is marked overdue', /OVERDUE/.test(r.summary), r.summary);
    check('the spoken line says overdue', /overdue/i.test(r.spoken), r.spoken);
  }

  console.log('\nWork already handed in is never called due:');
  for (const state of ['TURNED_IN', 'RETURNED']) {
    const work = [dated('a', 'Quiz', ...FUTURE)];
    const r = await tool({ work, submissions: [sub('a', state)] }).run();
    check(`${state} is treated as done`, !/Quiz/.test(r.summary), r.summary);
  }
  for (const state of ['NEW', 'CREATED', 'RECLAIMED_BY_STUDENT']) {
    const work = [dated('a', 'Quiz', ...FUTURE)];
    const r = await tool({ work, submissions: [sub('a', state)] }).run();
    check(`${state} is still outstanding`, /Quiz/.test(r.summary), r.summary);
  }

  console.log('\nOrdering and the spoken summary:');
  {
    const work = [
      dated('late', 'Late thing', ...PAST),
      dated('soon', 'Soon thing', 2099, 1, 2),
      dated('later', 'Later thing', 2099, 11, 30),
      undated('none', 'Undated thing')
    ];
    const submissions = work.map((w) => sub(w.id, 'NEW'));
    const r = await tool({ work, submissions }).run();
    const lines = r.summary.split('\n');
    check('overdue sorts before upcoming', lines[0].includes('Late thing'), r.summary);
    check('upcoming is in date order',
      lines.findIndex((l) => l.includes('Soon thing')) < lines.findIndex((l) => l.includes('Later thing')), r.summary);
    check('undated goes last', lines[lines.length - 1].includes('Undated thing'), r.summary);
    check('all three buckets are counted',
      /1 overdue/.test(r.spoken) && /2 coming up/.test(r.spoken) && /1 with no due date/.test(r.spoken), r.spoken);
    check('the next thing is named, not the overdue one',
      /Next: Soon thing/.test(r.spoken), r.spoken);
    console.log(`        spoken: "${r.spoken}"`);
  }

  console.log('\nEdge cases:');
  {
    const r = await tool({ work: [], submissions: [], courses: [] }).run();
    check('no classes is reported plainly', /no active classes/i.test(r.summary), r.summary);
  }
  {
    const r = await tool({ work: [], submissions: [] }).run();
    check('a class with no assignments says so', /No assignments/i.test(r.summary), r.summary);
  }
  {
    // A missing submission record must not be read as "handed in".
    const work = [dated('a', 'Orphan', ...FUTURE)];
    const r = await tool({ work, submissions: [] }).run();
    check('work with no submission record counts as outstanding', /Orphan/.test(r.summary), r.summary);
  }
  {
    const work = Array.from({ length: 12 }, (_, i) => undated(String(i), `Task ${i}`));
    const r = await tool({ work, submissions: work.map((w) => sub(w.id, 'NEW')) }).run({ limit: 3 });
    check('the limit caps what is shown', r.summary.split('\n').length === 3, r.summary);
    check('but the count is of everything', /12 with no due date/.test(r.spoken), r.spoken);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
