'use strict';
// Streaming must produce the same result as not streaming, and must deliver
// tool calls intact — otherwise the agent loop silently loses its tools.
const { createProvider } = require('../src/core/llm/provider');
const { config } = require('../src/core/config');

// This test drives the local engine on purpose, so it asks for the local
// model. config.llm.model is whatever the primary brain uses, which is a
// hosted model id that Ollama answers 404 to.
const model = config.get('llm.fallbackModel') || config.get('llm.model');
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { console.log(`  PASS  ${n}`); pass++; } else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; } };

const TOOLS = [{
  name: 'now_playing',
  description: 'What music is currently playing',
  parameters: { type: 'object', properties: {}, required: [] }
}];

(async () => {
  const p = createProvider('ollama', { baseUrl: config.get('llm.baseUrl') });
  if (!(await p.available())) { console.log('\nOllama is not running; cannot test streaming.\n'); process.exit(1); }

  console.log('\nWarming the model:');
  const w0 = Date.now();
  await p.warm(model);
  console.log(`  loaded in ${Date.now() - w0}ms`);

  console.log('\nPlain text:');
  const msgs = [{ role: 'user', content: 'Say exactly: the kettle is on.' }];

  const plain = await p.chat({ messages: msgs, model, temperature: 0 });
  check('non-streaming still returns text', plain.text.length > 0, JSON.stringify(plain.text));

  const chunks = [];
  let firstAt = null;
  const t0 = Date.now();
  const streamed = await p.chat({
    messages: msgs, model, temperature: 0,
    onToken: (chunk, full) => { if (firstAt === null) firstAt = Date.now() - t0; chunks.push({ chunk, full }); }
  });
  check('streaming returns text', streamed.text.length > 0, JSON.stringify(streamed.text));
  check('it arrived in pieces', chunks.length > 1, `${chunks.length} chunk(s)`);
  check('pieces concatenate to the whole', chunks.map((c) => c.chunk).join('').trim() === streamed.text,
    `joined="${chunks.map((c) => c.chunk).join('').trim()}" text="${streamed.text}"`);
  check('the running total is cumulative',
    chunks.length > 1 && chunks[chunks.length - 1].full.startsWith(chunks[0].full),
    JSON.stringify(chunks.slice(0, 2)));
  check('first token beats the full reply', firstAt < Date.now() - t0, `first ${firstAt}ms of ${Date.now() - t0}ms`);
  check('token counts still reported', streamed.usage.completionTokens > 0, JSON.stringify(streamed.usage));
  console.log(`        first token ${firstAt}ms, full reply ${Date.now() - t0}ms`);

  console.log('\nTool calling over a stream:');
  const toolMsgs = [{ role: 'user', content: 'What song is playing right now? Use the tool.' }];
  const withTools = await p.chat({ messages: toolMsgs, model, tools: TOOLS, temperature: 0, onToken: () => {} });
  check('tool calls survive streaming',
    withTools.toolCalls.length > 0 && withTools.toolCalls[0].name === 'now_playing',
    JSON.stringify(withTools.toolCalls));
  check('tool args are an object',
    withTools.toolCalls.length > 0 && typeof withTools.toolCalls[0].args === 'object',
    JSON.stringify(withTools.toolCalls[0] && withTools.toolCalls[0].args));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
