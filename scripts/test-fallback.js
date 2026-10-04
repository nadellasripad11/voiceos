'use strict';
/**
 * A hosted brain with the local one behind it.
 *
 *   node scripts/test-fallback.js
 *
 * The interesting half is what it does NOT fall back on. A model that says
 * "I don't know" has answered; asking a second model the same question would
 * be a different answer, not a better one, and would quietly overrule the
 * first one's judgement. Only a failure to get an answer at all is worth
 * retrying.
 */
const { FallbackProvider, worthRetrying } = require('../src/core/llm/fallback');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};

const quiet = { info() {}, warn() {}, debug() {} };

/** A provider that answers, or fails in a named way. */
function stub(name, behaviour) {
  const calls = [];
  return {
    name,
    calls,
    get streams() { return behaviour.streams !== false; },
    async available() { return behaviour.available !== false; },
    async listModels() {
      if (behaviour.listThrows) throw new Error(behaviour.listThrows);
      return [{ id: `${name}-model` }];
    },
    async warm(model) { calls.push({ warm: model }); return true; },
    async chat(req) {
      calls.push({ model: req.model, messages: req.messages });
      if (behaviour.throws) throw new Error(behaviour.throws);
      return { text: `${name} answered`, toolCalls: [], model: req.model };
    }
  };
}

(async () => {
  console.log('\nWhat counts as "ask someone else":');
  for (const [message, want] of [
    ['No groq API key set. Add one in Settings.', true],
    ['groq chat failed (HTTP 429): rate limit exceeded', true],
    ['groq chat failed (HTTP 503): service unavailable', true],
    ['fetch failed', true],
    ['getaddrinfo ENOTFOUND api.groq.com', true],
    ['The operation was aborted due to timeout', true],
    ['groq chat failed (HTTP 401): unauthorized', true],
    // These are answers, or faults a second attempt will not fix.
    ['context length exceeded for this model', false],
    ['invalid request: messages must be an array', false],
    ['the model refused to answer', false]
  ]) {
    check(`"${message.slice(0, 48)}" -> ${want ? 'retry' : 'do not retry'}`,
      worthRetrying(new Error(message)) === want);
  }

  console.log('\nWhen the quick one works, the local one is never touched:');
  {
    const fast = stub('groq', {});
    const local = stub('ollama', {});
    const p = new FallbackProvider({ primary: fast, secondary: local, secondaryModel: 'qwen', logger: quiet });
    const r = await p.chat({ model: 'llama-3.3-70b', messages: [{ role: 'user', content: 'hi' }] });
    check('the quick one answered', r.text === 'groq answered', r.text);
    check('the local one was not asked', local.calls.length === 0, JSON.stringify(local.calls));
    check('it reports which answered', p.lastUsed === 'groq', String(p.lastUsed));
  }

  console.log('\nWhen it cannot answer, the local one does:');
  {
    const fast = stub('groq', { throws: 'groq chat failed (HTTP 429): rate limit exceeded' });
    const local = stub('ollama', {});
    const p = new FallbackProvider({ primary: fast, secondary: local, secondaryModel: 'qwen2.5:1.5b', logger: quiet });
    const r = await p.chat({ model: 'llama-3.3-70b', messages: [{ role: 'user', content: 'hi' }] });
    check('the local one answered', r.text === 'ollama answered', r.text);
    check('it was asked for its own model, not the other one\'s',
      local.calls[0].model === 'qwen2.5:1.5b', JSON.stringify(local.calls[0].model));
    check('and the question survived intact',
      local.calls[0].messages[0].content === 'hi', JSON.stringify(local.calls[0].messages));
    check('it reports which answered', p.lastUsed === 'ollama', String(p.lastUsed));
  }

  console.log('\nA real answer is never second-guessed:');
  {
    // "I don't know" is an answer. Asking another model would overrule it.
    const fast = stub('groq', { throws: 'context length exceeded for this model' });
    const local = stub('ollama', {});
    const p = new FallbackProvider({ primary: fast, secondary: local, logger: quiet });
    let threw = null;
    try { await p.chat({ model: 'x', messages: [] }); } catch (e) { threw = e.message; }
    check('the failure is passed on', /context length/.test(threw || ''), String(threw));
    check('the local one was not asked', local.calls.length === 0, JSON.stringify(local.calls));
  }

  console.log('\nA half-spoken reply is retracted before the second one starts:');
  {
    // Otherwise the fallback continues someone else's sentence out loud.
    const fast = stub('groq', { throws: 'fetch failed' });
    const local = stub('ollama', {});
    const p = new FallbackProvider({ primary: fast, secondary: local, logger: quiet });
    const tokens = [];
    await p.chat({
      model: 'x',
      messages: [],
      onToken: (chunk, full, meta) => tokens.push({ chunk, meta })
    });
    check('the caller is told to start again',
      tokens.some((t) => t.meta && t.meta.restart), JSON.stringify(tokens));
  }

  console.log('\nAvailability and warming:');
  {
    const down = stub('groq', { available: false });
    const local = stub('ollama', {});
    const p = new FallbackProvider({ primary: down, secondary: local, secondaryModel: 'qwen', logger: quiet });
    check('available if either is', (await p.available()) === true);

    const bothDown = new FallbackProvider({
      primary: stub('groq', { available: false }),
      secondary: stub('ollama', { available: false }),
      logger: quiet
    });
    check('and not if neither is', (await bothDown.available()) === false);

    await p.warm('ignored');
    check('only the local one is warmed, with its own model',
      local.calls.some((c) => c.warm === 'qwen'), JSON.stringify(local.calls));
  }

  console.log('\nStreaming:');
  {
    const bothStream = new FallbackProvider({
      primary: stub('groq', {}), secondary: stub('ollama', {}), logger: quiet
    });
    check('streams when both do', bothStream.streams === true);

    const oneDoesNot = new FallbackProvider({
      primary: stub('groq', {}), secondary: stub('ollama', { streams: false }), logger: quiet
    });
    check('does not when only one does', oneDoesNot.streams === false,
      'a fallback must not change streaming mid-reply');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
