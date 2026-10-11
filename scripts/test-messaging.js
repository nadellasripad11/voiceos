'use strict';
/**
 * Sending a message to a person.
 *
 *   node scripts/test-messaging.js
 *
 * This is the one tool that speaks to other people in the user's name, so the
 * tests are mostly about who it is addressed to. A misheard name that sends
 * the message anyway is not a bug you can apologise your way out of, and the
 * obvious pattern — take a name, take the rest — turned "text dad dinner is
 * off" into a contact called "dad dinner".
 */
const { config } = require('../src/core/config');
const { buildTools } = require('../src/core/agent/tools');
const { matchIntent } = require('../src/core/agent/agent');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};
const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const tools = buildTools({
  config, logger: quiet,
  connections: { get: () => null, status: () => ({ connected: false }) }
});
const route = (text) => matchIntent(text, tools, config);

(async () => {
  console.log('\nThe name and the message are told apart:');
  for (const [said, to, text] of [
    ['text maya that i am running ten minutes late', 'maya', 'i am running ten minutes late'],
    ['message dad dinner is off tonight', 'dad', 'dinner is off tonight'],
    ['whatsapp coach dan saying practice moved to 5:30', 'coach dan', 'practice moved to 5:30'],
    ['text mum happy birthday', 'mum', 'happy birthday'],
    ['message maya, see you at 8', 'maya', 'see you at 8']
  ]) {
    const m = route(said);
    const got = m && m.args ? m.args : {};
    check(`"${said.slice(0, 42)}"`,
      m && m.tool.name === 'send_message' && got.to === to && got.text === text,
      `to=${JSON.stringify(got.to)} text=${JSON.stringify(got.text)}`);
  }

  console.log('\nThe verb picks the route:');
  {
    // A text and a WhatsApp message reach the same person by different means,
    // and one of them may never be seen. Saying "whatsapp" has to mean it.
    for (const [said, channel] of [
      ['text maya that i am running late', 'sms'],
      ['sms maya on my way', 'sms'],
      ['whatsapp coach dan saying practice moved', 'whatsapp'],
      ['message dad dinner is off', undefined]   // left to the configured default
    ]) {
      const m = route(said);
      check(`"${said.slice(0, 38)}" -> ${channel || 'default'}`,
        m && m.args.channel === channel, JSON.stringify(m && m.args.channel));
    }
  }

  console.log('\nA text needs a number, and says so when it has none:');
  {
    const { sendText } = require('../src/core/agent/messaging');
    const book = { get: (k, d) => (k === 'messaging.contacts' ? { maya: '+1 555 010 1234' } : d) };
    const opened = [];
    const bridge = { openUrl: async (u) => opened.push(u) };

    const known = await sendText({ to: 'maya', text: 'running 10 late', config: book, bridge, logger: quiet, handlerReady: async () => true });
    check('a known contact becomes an sms link', known.ok && /^sms:\+15550101234\?body=/.test(opened[0]), opened[0]);
    check('and it does not claim to have sent it',
      /press send/i.test(known.summary), known.summary);

    // A ten-digit number is how people write their own, and Phone Link wants
    // the country code, so it is added rather than passed through short.
    const spoken = await sendText({ to: '555 010 9999', text: 'hi', config: book, bridge, logger: quiet, handlerReady: async () => true });
    check('a spoken number is tidied and given its country code',
      spoken.ok && opened[1] === 'sms:+15550109999?body=hi', opened[1]);

    const full = await sendText({ to: '+44 7700 900123', text: 'hi', config: book, bridge, logger: quiet, handlerReady: async () => true });
    check('a number that already has one is left alone',
      full.ok && opened[2] === 'sms:+447700900123?body=hi', opened[2]);

    const unknown = await sendText({ to: 'dave', text: 'hi', config: book, bridge, logger: quiet, handlerReady: async () => true });
    check('an unknown name is refused rather than guessed at', unknown.ok === false);
    check('and it says what to do about it',
      /contacts|number|whatsapp/i.test(unknown.summary), unknown.summary);
  }

  console.log('\nWhen nothing on the PC can send a text:');
  {
    // Phone Link installed but never set up: Windows answered the link with a
    // "Pick an app" box, and the reply still claimed the text was written.
    const { sendText } = require('../src/core/agent/messaging');
    const opened = [];
    const r = await sendText({ to: "maya", text: "hi", config: { get: (k, d) => (k === "messaging.contacts" ? { maya: "+15550100000" } : d) }, logger: quiet,
      bridge: { openUrl: async (u) => opened.push(u) }, handlerReady: async () => false });
    check('it does not open the link', opened.length === 0);
    check('it says texts are not set up, and how to fix it', r.ok === false && /Phone Link/.test(r.summary) && /pair/i.test(r.summary), r.summary);
    check('and offers WhatsApp instead', /WhatsApp/.test(r.summary));
  }

  console.log('\nIt never sends without being shown first:');
  {
    const tool = tools.find((t) => t.name === 'send_message');
    check('the tool exists', Boolean(tool));
    check('it is marked as reaching other people', tool.mutating === true);
    check('and it does not auto-confirm', !tool.autoConfirm,
      'this is the one tool where a wrong guess cannot be taken back');

    const prompt = tool.confirm({ to: 'Maya', text: 'running 10 late' });
    check('the recipient is in the prompt', /Maya/.test(prompt.title), JSON.stringify(prompt));
    check('and the whole message is, not a summary of it',
      prompt.detail === 'running 10 late',
      'approving something you cannot read is not approval');
  }

  console.log('\nOrdinary requests are not mistaken for messages:');
  for (const said of ['what is the weather', 'play some drake', 'what do I have today']) {
    const m = route(said);
    check(`"${said}" does not message anyone`,
      !m || m.tool.name !== 'send_message', m && m.tool.name);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
