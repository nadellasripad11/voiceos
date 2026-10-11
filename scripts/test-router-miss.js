'use strict';
/**
 * The router is a guess, and a guess must not be the final answer.
 *
 *   node scripts/test-router-miss.js
 *
 * This is the failure that kept coming back in different clothes:
 *
 *   "what are you doing"        -> web search -> "I could not find anything"
 *   "what's going on in the news
 *    today? can you research..."-> web search for that whole sentence -> nothing
 *   "weather in cauley creek"   -> no such place -> answered for somewhere else
 *
 * Each was patched where it appeared, and another one turned up, because the
 * shape was never addressed: the router matches on wording, a wrong match runs
 * a tool that finds nothing, and the nothing is read out as though it settled
 * the question.
 *
 * Two things fix the shape rather than the instance. A tool that finds nothing
 * says so, and the agent then asks the model — which is what would have
 * happened had the router not matched at all. And a spoken question is turned
 * into something searchable before it is searched, because people do not speak
 * in queries.
 */
const { config } = require('../src/core/config');
const { Agent, matchIntent } = require('../src/core/agent/agent');
const { buildTools } = require('../src/core/agent/tools');

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

/** What the router would actually send to a search engine. */
const queryFor = (text) => {
  const m = matchIntent(text, tools, config);
  return m && m.args ? (m.args.query || '') : null;
};

(async () => {
  console.log('\nA rambling news question is a news question:');
  {
    // This used to become a web search for "what's going around in the news
    // today". It now goes to the headlines themselves, which is what it asks.
    const m = matchIntent("Hey Jarvis, what's going around in the news today? Can you research and give me a brief summary of what's going on in the news?", tools, config);
    check('goes to the news, top stories', m && m.tool.name === 'news' && m.args.topic === '',
      m ? `${m.tool.name} ${JSON.stringify(m.args)}` : 'no route');
  }

  console.log('\nA spoken question becomes something searchable:');
  for (const [spoken, want] of [
    ['what is the capital of france', 'what is the capital of france'],
    ['how do i boil an egg please', 'how do i boil an egg'],
    ['what is a black hole? can you explain it simply?', 'what is a black hole']
  ]) {
    const got = queryFor(spoken);
    check(`"${spoken.slice(0, 44)}"`, got === want, `got ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
  }

  console.log('\nNothing useful is ever stripped down to nothing:');
  {
    // Over-trimming would be worse than not trimming: an empty query finds
    // nothing, which is the bug this is meant to remove.
    for (const spoken of ['what is love', 'who is ada lovelace', 'why is the sky blue']) {
      const got = queryFor(spoken);
      check(`"${spoken}" survives`, got && got.length >= 8, JSON.stringify(got));
    }
  }

  console.log('\nA tool that finds nothing says so:');
  {
    const { answerFromWeb } = require('../src/core/agent/web');
    check('the web answerer can report a miss',
      typeof answerFromWeb === 'function', 'answerFromWeb is missing');
    // The flag itself is what the agent keys on, so it has to be in the source.
    const web = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'core', 'agent', 'web.js'), 'utf8');
    check('and marks it as a miss rather than an answer', /miss: true/.test(web));
  }

  console.log('\nA miss goes to the model instead of being read out:');
  {
    let asked = false;
    const provider = {
      name: 'stub', get streams() { return false; },
      async available() { return true; },
      async chat() { asked = true; return { text: 'Here is what is actually going on.', toolCalls: [] }; }
    };
    const logs = [];
    const agent = new Agent({
      provider, config,
      logger: { info: (m) => logs.push(m), warn() {}, debug() {}, error() {} },
      requestConfirmation: async () => true
    });

    const missing = [{
      name: 'answer_from_web',
      description: 'Answer a general question using the web.',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
      run: async () => ({ ok: true, miss: true, summary: 'I could not find anything for "x".' })
    }];

    const r = await agent.runModelLoop('whats in the news', missing, { started: Date.now(), onStage: () => {} });
    check('the model answers when the tool could not', asked && /actually going on/.test(r.answer), r.answer);
  }

  console.log('\nA real answer is never second-guessed:');
  {
    // Escalating on a successful answer would mean every question costs a
    // model call, which is the latency this router exists to avoid.
    let asked = false;
    const provider = {
      name: 'stub', get streams() { return false; },
      async available() { return true; },
      async chat() { asked = true; return { text: 'should not happen', toolCalls: [] }; }
    };
    const agent = new Agent({ provider, config, logger: quiet, requestConfirmation: async () => true });
    const done = await agent.finish({
      question: "what's playing",
      result: { ok: true, summary: 'Paused: Make Them Cry by Drake.' },
      started: Date.now(), model: 'router', usedRouter: true
    });
    check('a short successful answer is kept as-is',
      done.answer === 'Paused: Make Them Cry by Drake.', done.answer);
    check('and the model was never consulted', asked === false);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
