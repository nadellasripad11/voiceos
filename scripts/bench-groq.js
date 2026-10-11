'use strict';
/**
 * Which Groq model should answer, measured rather than assumed.
 *
 *   node scripts/bench-groq.js
 *
 * Two things matter and they are not the same thing. Time to first token is
 * what the user experiences as "it is answering" — it is what gets speech
 * started. Tool calling is what makes this an assistant rather than a chatbot:
 * a model that is quick but cannot be trusted to emit a tool call turns every
 * "play some music" into a sentence about music.
 *
 * Measured against the real tool schemas the agent sends, because a model that
 * handles one toy function may still fall over on twenty-odd of them.
 */
const { paths } = require('../src/core/paths');
const fs = require('fs');

const key = (() => {
  try { return JSON.parse(fs.readFileSync(paths.credentials, 'utf8')).groq; }
  catch { return null; }
})();

const MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b'];

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'play_music',
      description: 'Play music, resume playback, or play a named artist or song.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Artist, song or album' } }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Current weather and forecast for a place.',
      parameters: {
        type: 'object',
        properties: { place: { type: 'string' } },
        required: ['place']
      }
    }
  }
];

async function once(model, { tools = null, prompt, maxTokens = 120 }) {
  const started = Date.now();
  let firstToken = null;
  let text = '';
  let toolCall = null;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0.2,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: 'You are a voice assistant. Answer in one or two short sentences. Prefer calling a tool over guessing.' },
        { role: 'user', content: prompt }
      ],
      ...(tools ? { tools, tool_choice: 'auto' } : {})
    })
  });

  if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` };

  // Server-sent events, read as they arrive — the whole point is when the
  // first one lands, so buffering the body would measure the wrong thing.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      const delta = json.choices?.[0]?.delta || {};
      if (delta.content) {
        if (firstToken === null) firstToken = Date.now() - started;
        text += delta.content;
      }
      if (delta.tool_calls?.length) {
        if (firstToken === null) firstToken = Date.now() - started;
        toolCall = toolCall || delta.tool_calls[0].function?.name || '(unnamed)';
      }
    }
  }

  return { firstToken, total: Date.now() - started, text: text.trim(), toolCall };
}

(async () => {
  if (!key) {
    console.log('\nNo Groq key stored; nothing to measure.\n');
    process.exit(0);
  }

  console.log('\nPlain answer — time to first word is what starts the speech:');
  const plain = {};
  for (const model of MODELS) {
    const r = await once(model, { prompt: 'What is the capital of France?' });
    plain[model] = r;
    if (r.error) { console.log(`  ${model.padEnd(22)} ${r.error}`); continue; }
    console.log(`  ${model.padEnd(22)} first ${String(r.firstToken).padStart(5)}ms  done ${String(r.total).padStart(5)}ms  "${r.text.slice(0, 48)}"`);
  }

  console.log('\nTool calling — an assistant that cannot do this is a chatbot:');
  for (const model of MODELS) {
    const r = await once(model, { prompt: 'play some jazz', tools: TOOLS });
    if (r.error) { console.log(`  ${model.padEnd(22)} ${r.error}`); continue; }
    const got = r.toolCall || 'NO TOOL — answered in words';
    console.log(`  ${model.padEnd(22)} first ${String(r.firstToken).padStart(5)}ms  -> ${got}`);
  }

  console.log('\nA question that should NOT call a tool:');
  for (const model of MODELS) {
    const r = await once(model, { prompt: 'tell me a short joke', tools: TOOLS });
    if (r.error) { console.log(`  ${model.padEnd(22)} ${r.error}`); continue; }
    console.log(`  ${model.padEnd(22)} ${r.toolCall ? `WRONGLY called ${r.toolCall}` : 'answered in words, correct'}`);
  }

  // A model that produced no content at all is not the quickest, it is broken
  // — gpt-oss streams its thinking on a separate channel and can finish with
  // an empty content field, which read as "0ms to first word" until this.
  const answered = MODELS.filter((m) => plain[m] && !plain[m].error && plain[m].firstToken !== null);
  const silent = MODELS.filter((m) => plain[m] && !plain[m].error && plain[m].firstToken === null);
  const best = answered.sort((a, b) => plain[a].firstToken - plain[b].firstToken)[0];
  if (silent.length) console.log(`\nProduced no spoken content: ${silent.join(', ')}`);
  console.log(`\nQuickest to start speaking: ${best || 'none responded'}\n`);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
