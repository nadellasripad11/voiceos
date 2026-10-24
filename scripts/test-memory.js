'use strict';
/**
 * What Jarvis remembers, and what he must never write down.
 *
 *   node scripts/test-memory.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Memory, SECRET } = require('../src/core/agent/memory');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};
const quiet = { info() {}, warn() {}, debug() {} };
const file = path.join(os.tmpdir(), `voiceos-memory-test-${process.pid}.json`);
const fresh = () => { fs.rmSync(file, { force: true }); return new Memory({ file, logger: quiet }); };
const replying = (obj) => { const calls = []; return { calls, chat: async (req) => { calls.push(req); return { text: JSON.stringify(obj) }; } }; };

(async () => {
  console.log('\nRemembering:');
  {
    const m = fresh();
    m.add(['Their sister is Maya']);
    check('a fact is kept', m.facts.length === 1);
    check('and survives a restart', new Memory({ file, logger: quiet }).facts[0].text === 'Their sister is Maya');
    m.add(['their sister is maya.']);
    check('a near-duplicate is not added twice', m.facts.length === 1);
    check('it goes into the prompt', /sister is Maya/.test(m.summary()));
  }

  console.log('\nNever written down:');
  for (const s of ['My password is hunter2', 'my locker combination is 12-34-56', 'card number 4111 1111 1111 1111',
    'my PIN is 4821', 'SSN 123-45-6789', 'the verification code is 552910']) {
    const m = fresh();
    m.add([s]);
    check(`"${s}"`, m.facts.length === 0, JSON.stringify(m.facts));
  }
  check('an ordinary fact is not mistaken for a secret', !SECRET.test('They play the piano on Tuesdays'));

  console.log('\nLearning from a conversation:');
  {
    const m = fresh();
    const p = replying({ add: ['They have a chemistry test on Friday'], remove: [] });
    const added = await m.learn({ question: 'remind me I have a chemistry test on friday morning', answer: 'Noted.', provider: p, model: 'g' });
    check('a durable fact is picked up', added[0] === 'They have a chemistry test on Friday', JSON.stringify(added));
  }
  {
    const m = fresh();
    const p = replying({ add: ['x'], remove: [] });
    await m.learn({ question: 'what time is it', answer: '3pm', provider: p, model: 'g' });
    check('a short command costs no model call', p.calls.length === 0);
  }
  {
    const m = fresh();
    m.add(['Their favourite team is the Falcons']);
    const p = replying({ add: ['Their favourite team is the Braves'], remove: [1] });
    await m.learn({ question: 'actually my favourite team is the braves now not the falcons', answer: 'Noted.', provider: p, model: 'g' });
    check('a contradicted fact is replaced', m.facts.length === 1 && /Braves/.test(m.facts[0].text), JSON.stringify(m.facts));
  }
  {
    const m = fresh();
    const p = replying({ add: ['Their password is hunter2'], remove: [] });
    await m.learn({ question: 'my email password is hunter2 can you note it', answer: 'I will not.', provider: p, model: 'g' });
    check('a secret said aloud is not even sent to be learnt from', p.calls.length === 0 && m.facts.length === 0);
  }
  {
    const m = fresh();
    const p = { chat: async () => ({ text: 'not json at all' }) };
    const added = await m.learn({ question: 'my brother jake is coming over on saturday', answer: 'ok', provider: p, model: 'g' });
    check('a garbled reply changes nothing', added.length === 0 && m.facts.length === 0);
  }

  console.log('\nForgetting:');
  {
    const m = fresh();
    m.add(['Their sister is Maya', 'They like pizza']);
    const gone = m.forget('pizza');
    check('a fact can be forgotten', gone.length === 1 && m.facts.length === 1 && m.facts[0].text === 'Their sister is Maya');
  }

  console.log('\nRouting:');
  {
    const { matchIntent } = require('../src/core/agent/agent');
    const { buildTools } = require('../src/core/agent/tools');
    const { config } = require('../src/core/config');
    const tools = buildTools({ bridge: {}, config, connections: {}, logger: quiet });
    const route = (q) => { const h = matchIntent(q, tools, config); return h ? `${h.tool.name} ${JSON.stringify(h.args)}` : 'MODEL'; };
    check('"remember that my sister is maya" -> remember', /^remember .*sister is maya/i.test(route('remember that my sister is maya')), route('remember that my sister is maya'));
    check('"what do you remember about me" -> recall', /^recall/.test(route('what do you remember about me')));
    check('"forget about the pizza thing" -> forget', /^forget .*pizza/.test(route('forget about the pizza thing')), route('forget about the pizza thing'));
    check('"remember to call mom" is a reminder, not a fact', !/^remember /.test(route('remember to remind me to call mom')));
  }

  fs.rmSync(file, { force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
