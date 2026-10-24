'use strict';
/**
 * The Live voice's guards, and the tools it calls actually running.
 *
 *   node scripts/test-live.js
 *
 * In use: a TV said "¿Qué?" and Jarvis answered in Spanish; and remember,
 * recall, forget and look all crashed with "ctx is not defined" — the route
 * tests passed because they only checked where a phrase went, never that the
 * tool there could run.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { heardNoise } = require('../src/core/live/noise');
const { cleanSchema } = require('../src/core/live/gemini-live');
const { buildTools } = require('../src/core/agent/tools');
const { config } = require('../src/core/config');
const { Memory } = require('../src/core/agent/memory');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};

(async () => {
  console.log('\nNoise and other languages are not answered:');
  for (const t of ['¿Qué?', 'Qué pasa', 'Hola amigo', 'Bonjour, ça va?', 'Привет', 'uh', 'hmm', '', '...']) {
    check(`"${t}" is dropped`, heardNoise(t));
  }
  for (const t of ['What?', 'Stop.', 'Thanks', 'Is that good or bad?', 'Hey Jarvis, what am I holding?', 'Play some Drake', 'remember that my favourite food is sushi']) {
    check(`"${t}" is answered`, !heardNoise(t));
  }

  console.log('\nTool schemas are cleaned for Gemini:');
  {
    const c = cleanSchema({ type: 'object', additionalProperties: false, properties: { a: { type: 'string', default: 'x' } }, $schema: 'y' });
    check('unsupported keys removed', !('additionalProperties' in c) && !('$schema' in c) && !('default' in c.properties.a));
  }

  console.log('\nThe new tools run, not just route:');
  {
    const file = path.join(os.tmpdir(), `test-live-mem-${process.pid}.json`);
    const memory = new Memory({ file, logger: {} });
    const tools = buildTools({ bridge: {}, config, connections: {}, memory, logger: { info() {}, warn() {}, debug() {} },
      look: async (q) => ({ ok: true, summary: `saw something for "${q}"` }) });
    const run = async (name, args) => {
      try { return await tools.find((t) => t.name === name).run(args); } catch (err) { return { ok: false, summary: `THREW: ${err.message}` }; }
    };
    let r = await run('remember', { fact: 'Their favourite food is sushi' });
    check('remember', r.ok && /sushi/.test(r.summary), r.summary);
    r = await run('recall', {});
    check('recall', r.ok && /sushi/.test(r.summary), r.summary);
    r = await run('forget', { about: 'sushi' });
    check('forget', r.ok && /Forgotten/.test(r.summary), r.summary);
    r = await run('look', { question: 'what am i holding' });
    check('look', r.ok && /saw something/.test(r.summary), r.summary);
    fs.rmSync(file, { force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
