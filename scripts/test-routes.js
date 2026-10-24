'use strict';
/**
 * Where the console's buttons and everyday questions are sent.
 *
 *   node scripts/test-routes.js
 *
 * Every case here was wrong in a live run of the console:
 *   - "Summarise my day" went to the writing agent, which "wrote" that it had
 *     no access to the calendar and saved it to a file.
 *   - "Plan tomorrow" searched the web for the user's own schedule.
 *   - "What time is it" was a web search that found nothing, then a model
 *     call: two round trips to read the clock.
 *   - "Summarize world news" was written from nothing, with no news in it.
 */
const { matchIntent } = require('../src/core/agent/agent');
const { buildTools } = require('../src/core/agent/tools');
const { config } = require('../src/core/config');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};

const quiet = { info() {}, warn() {}, debug() {} };
// connections present, so the account tools (my_day, calendar, mail) exist,
// as they do in the app.
const tools = buildTools({ bridge: {}, config, connections: {}, logger: quiet });
const route = (q) => {
  const hit = matchIntent(q, tools, config);
  return hit ? { tool: hit.tool.name, args: hit.args || {} } : { tool: 'MODEL', args: {} };
};
const expect = (q, tool, args = null) => {
  const r = route(q);
  const argsOk = !args || Object.entries(args).every(([k, v]) => r.args[k] === v);
  check(`"${q}" -> ${tool}${args ? ' ' + JSON.stringify(args) : ''}`, r.tool === tool && argsOk,
    `went to ${r.tool} ${JSON.stringify(r.args)}`);
};
const notTo = (q, tool) => {
  const r = route(q);
  check(`"${q}" does not go to ${tool}`, r.tool !== tool, `went to ${r.tool}`);
};

(async () => {
  console.log('\nThe console\'s quick actions:');
  {
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'renderer', 'console', 'index.html'), 'utf8');
    const asks = [...html.matchAll(/data-ask="([^"]+)"/g)].map((m) => m[1]);
    check('the two asking buttons are found', asks.length === 2, JSON.stringify(asks));
    const [day, tomorrow] = asks;
    expect(day, 'my_day');
    expect(tomorrow, 'my_day', { day: 'tomorrow' });
  }

  console.log('\nThe user\'s own day, never the web or the writing agent:');
  expect('Summarise my day', 'my_day');
  expect('summarize my day please', 'my_day');
  expect('what do i have today', 'my_day');
  expect('what do i have tomorrow', 'my_day', { day: 'tomorrow' });
  expect('plan tomorrow', 'my_day', { day: 'tomorrow' });
  expect('how does tomorrow look', 'my_day', { day: 'tomorrow' });
  expect('whats on my calendar tomorrow', 'list_events', { day: 'tomorrow' });
  expect('whats on my calendar', 'list_events', { day: 'today' });
  expect('am i free tomorrow', 'list_events', { day: 'tomorrow' });
  expect('whats due tomorrow', 'list_coursework');
  expect('check my email', 'list_email');

  console.log('\nThe clock is read, not searched for:');
  expect('what time is it', 'clock', { what: 'time' });
  expect("what's the time", 'clock', { what: 'time' });
  expect('what time is it right now?', 'clock', { what: 'time' });
  expect('what is the date today', 'clock', { what: 'date' });
  expect('what day is it', 'clock', { what: 'date' });
  notTo('what time is it in tokyo', 'clock');
  notTo('what time does the store close', 'clock');
  {
    const clock = tools.find((t) => t.name === 'clock');
    const r = await clock.run({ what: 'time' });
    check('and the answer is the actual time', r.ok && /\d{1,2}:\d{2}/.test(r.spoken), r.spoken);
  }

  console.log('\nSummarising something to look up is not writing:');
  notTo('summarize world news in 60 seconds', 'do_task');
  notTo('summarise the news', 'do_task');
  notTo('summarize my inbox', 'do_task');
  notTo('summarize todays headlines', 'do_task');
  expect('summarize this essay into three bullet points: the industrial revolution began in britain', 'do_task');
  expect('write a two line poem about rain', 'do_task');
  expect('draft an email to my teacher about the deadline', 'do_task');

  console.log('\nThe camera, only when asked to look:');
  expect('what am i holding', 'look');
  expect('how do i look', 'look');
  expect('what do you see', 'look');
  notTo('what is this', 'look');
  notTo('whats on my screen', 'look');

  console.log('\nSigning in, once, in the assistant\'s browser:');
  expect('sign in to amazon', 'browser_signin', { site: 'amazon' });
  expect('log into canvas', 'browser_signin', { site: 'canvas' });
  expect('can you log in to netflix', 'browser_signin', { site: 'netflix' });
  notTo('sign up for the newsletter', 'browser_signin');

  console.log('\nThings that live on a website go to the browser:');
  expect('check the score of the falcons game', 'browse');
  expect('go on amazon and find a good usb c hub under 20 dollars', 'browse');
  expect('find me a cheap flight to new york next weekend', 'browse');
  expect('how much is a ps5', 'browse');
  notTo('whats the weather tomorrow', 'browse');

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
