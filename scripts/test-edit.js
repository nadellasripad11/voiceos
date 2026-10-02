'use strict';
/**
 * Verifies Edit Mode: what counts as an instruction, what the model's reply is
 * trimmed down to, and that nothing is ever written into the wrong window.
 *
 *   node scripts/test-edit.js            logic only, no services needed
 *   node scripts/test-edit.js --live     also runs a real edit through Ollama
 *
 * Nothing is inserted anywhere: every case runs with insert disabled or against
 * a fake bridge, so this cannot type into a real application.
 */
const { EditMode, classify, unwrap } = require('../src/core/modes/edit');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};

const SELECTION = 'i think we should probly meet on tuesday to go over the numbers';

function fakeConfig(values = {}) {
  return { get: (k, d) => (k in values ? values[k] : d), all: () => values };
}

/** A provider that returns whatever it is told to, and records what it was asked. */
function fakeProvider(reply) {
  const calls = [];
  return {
    calls,
    get streams() { return false; },
    async chat(req) { calls.push(req); return { text: typeof reply === 'function' ? reply(req) : reply, toolCalls: [] }; }
  };
}

/** A bridge that records instead of touching the machine. */
function fakeBridge({ foreground = { hwnd: 1, process: 'notepad' }, failInsert = false } = {}) {
  const log = [];
  return {
    log,
    async foregroundWindow() { return foreground; },
    async insertText(text, opts) {
      log.push({ insertText: text, opts });
      if (failInsert) throw new Error('insert refused');
      return { ok: true };
    },
    async writeClipboard(text) { log.push({ clipboard: text }); return { ok: true }; }
  };
}

(async () => {
  console.log('\nTelling an instruction from replacement text:');
  const instructions = [
    'make this more formal',
    'fix the grammar',
    'please shorten this',
    'turn this into bullet points',
    'translate this to French',
    'rewrite it as one sentence',
    'more concise',
    'summarise this',
    'correct the spelling',
    'remove the filler words'
  ];
  for (const text of instructions) {
    const r = classify(text, SELECTION);
    check(`"${text}" is an instruction`, r.instruction === true, r.why);
  }

  const replacements = [
    'Tuesday',
    'the quarterly revenue figures',
    'I need to fix the grammar in this paragraph before sending it',
    'we met on Thursday instead',
    'Priya said the numbers were wrong'
  ];
  for (const text of replacements) {
    const r = classify(text, SELECTION);
    check(`"${text.slice(0, 34)}" is replacement text`, r.instruction === false, r.why);
  }

  check('nothing selected is never an instruction', classify('make this formal', '').instruction === false);
  check('silence is never an instruction', classify('', SELECTION).instruction === false);

  console.log('\nTrimming the wrapper off the reply:');
  check('a code fence is stripped', unwrap('```\nHello there.\n```') === 'Hello there.', unwrap('```\nHello there.\n```'));
  check('a language fence is stripped', unwrap('```text\nHello.\n```') === 'Hello.', unwrap('```text\nHello.\n```'));
  check('"Here is the edited text:" is stripped',
    unwrap('Here is the edited text: Hello.') === 'Hello.', unwrap('Here is the edited text: Hello.'));
  check('enclosing quotes are stripped', unwrap('"Hello there."') === 'Hello there.', unwrap('"Hello there."'));
  check('curly quotes are stripped', unwrap('“Hello there.”') === 'Hello there.', unwrap('“Hello there.”'));
  check('an internal quotation keeps its quotes',
    unwrap('She said "no" and left.') === 'She said "no" and left.', unwrap('She said "no" and left.'));
  check('a genuinely quoted passage is not unwrapped twice',
    unwrap('"First." And "second."') === '"First." And "second."', unwrap('"First." And "second."'));

  console.log('\nApplying an edit:');
  {
    const provider = fakeProvider('I think we should probably meet on Tuesday to review the numbers.');
    const bridge = fakeBridge();
    const edit = new EditMode({ provider, config: fakeConfig(), bridge, logger: { error() {} } });
    const r = await edit.run({ instruction: 'fix the spelling', selection: SELECTION, target: { hwnd: 1, process: 'notepad' } });

    check('it succeeds', r.ok === true, JSON.stringify(r));
    check('it reports a change', r.changed === true, JSON.stringify(r.changed));
    check('the edited text was inserted',
      bridge.log.some((e) => e.insertText && e.insertText.startsWith('I think we should probably')),
      JSON.stringify(bridge.log));
    check('it pasted rather than typed character by character',
      bridge.log.some((e) => e.opts && e.opts.mode === 'paste'), JSON.stringify(bridge.log));
    check('the passage and instruction both reached the model',
      provider.calls[0].messages[1].content.includes(SELECTION) &&
      provider.calls[0].messages[1].content.includes('fix the spelling'),
      provider.calls[0].messages[1].content);
    check('it asked for a deterministic edit', provider.calls[0].temperature === 0, String(provider.calls[0].temperature));
  }

  console.log('\nRefusing to write into the wrong window:');
  {
    const provider = fakeProvider('Edited text.');
    const bridge = fakeBridge({ foreground: { hwnd: 999, process: 'excel' } });
    const edit = new EditMode({ provider, config: fakeConfig(), bridge, logger: { error() {} } });
    const r = await edit.run({ instruction: 'fix the grammar', selection: SELECTION, target: { hwnd: 1, process: 'notepad' } });

    check('it does not insert', !bridge.log.some((e) => e.insertText), JSON.stringify(bridge.log));
    check('it says why', /focus moved to excel/.test(r.reason || ''), r.reason);
    check('the edit is left on the clipboard', r.onClipboard === true && bridge.log.some((e) => e.clipboard), JSON.stringify(bridge.log));
  }

  console.log('\nWhen the edit cannot be written:');
  {
    const provider = fakeProvider('Edited text.');
    const bridge = fakeBridge({ failInsert: true });
    const edit = new EditMode({ provider, config: fakeConfig(), bridge, logger: { error() {} } });
    const r = await edit.run({ instruction: 'fix it', selection: SELECTION, target: { hwnd: 1, process: 'notepad' } });
    check('the text is not lost', r.onClipboard === true && bridge.log.some((e) => e.clipboard === 'Edited text.'),
      JSON.stringify(bridge.log));
  }

  console.log('\nGuards:');
  {
    const edit = new EditMode({ provider: fakeProvider('x'), config: fakeConfig(), bridge: fakeBridge() });
    check('an empty selection is refused', (await edit.run({ instruction: 'fix it', selection: '   ' })).reason === 'nothing selected');
  }
  {
    const edit = new EditMode({ provider: fakeProvider('x'), config: fakeConfig({ 'edit.maxChars': 50 }), bridge: fakeBridge() });
    const r = await edit.run({ instruction: 'fix it', selection: 'x'.repeat(51) });
    check('an oversized selection is refused with the limit', /the limit is 50/.test(r.reason || ''), r.reason);
  }
  {
    const provider = fakeProvider(SELECTION);
    const edit = new EditMode({ provider, config: fakeConfig(), bridge: fakeBridge() });
    const r = await edit.run({ instruction: 'make it identical', selection: SELECTION, target: { hwnd: 1 } });
    check('an unchanged reply is not pasted back', r.ok === true && r.changed === false, JSON.stringify(r));
  }
  {
    const edit = new EditMode({ provider: null, config: fakeConfig(), bridge: fakeBridge() });
    check('no model is reported, not crashed',
      (await edit.run({ instruction: 'fix it', selection: SELECTION })).reason === 'no model available');
  }

  console.log('\nHanding off from dictation (one transcription, not two):');
  {
    const { DictationMode } = require('../src/core/modes/dictation');
    const { config } = require('../src/core/config');

    // Real speech is not needed; only that trimSilence keeps something.
    const samples = new Float32Array(16000);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 20) * 0.4;

    let transcriptions = 0;
    const stt = {
      status: () => ({ ready: true, problems: [] }),
      async transcribe() {
        transcriptions++;
        return { text: 'make this more formal', model: 'fake', language: 'en', rtf: 0, audioMs: 1000 };
      }
    };

    {
      const bridge = fakeBridge();
      const dictation = new DictationMode({ stt, provider: null, config, bridge, transcripts: null, logger: { info() {}, warn() {}, debug() {}, error() {} } });
      transcriptions = 0;
      const seen = [];
      const r = await dictation.run(samples, {
        onTranscript: (text, ctx) => { seen.push({ text, ctx }); return { handoff: true, to: 'edit' }; }
      });

      check('the hook sees the raw transcript',
        seen.length === 1 && seen[0].text === 'make this more formal', JSON.stringify(seen));
      check('dictation reports the handoff', r.handoff === true && r.to === 'edit', JSON.stringify(r));
      check('the instruction is NOT typed into the document',
        !bridge.log.some((e) => e.insertText), JSON.stringify(bridge.log));
      check('it transcribed exactly once', transcriptions === 1, String(transcriptions));
      check('the transcript is handed back for the edit', r.raw === 'make this more formal', JSON.stringify(r.raw));
    }

    {
      // No handoff: ordinary dictation, which must still insert as before.
      const bridge = fakeBridge();
      const dictation = new DictationMode({ stt, provider: null, config, bridge, transcripts: null, logger: { info() {}, warn() {}, debug() {}, error() {} } });
      const r = await dictation.run(samples, { onTranscript: () => ({ handoff: false }) });
      check('declining the handoff still dictates', r.ok === true && r.handoff !== true, JSON.stringify({ ok: r.ok, handoff: r.handoff }));
      check('and the words are inserted', bridge.log.some((e) => e.insertText), JSON.stringify(bridge.log));
    }

    {
      // No hook at all: unchanged behaviour for every existing caller.
      const bridge = fakeBridge();
      const dictation = new DictationMode({ stt, provider: null, config, bridge, transcripts: null, logger: { info() {}, warn() {}, debug() {}, error() {} } });
      const r = await dictation.run(samples, {});
      check('dictation without the hook is unaffected', r.ok === true && bridge.log.some((e) => e.insertText), JSON.stringify(r.ok));
    }
  }

  if (process.argv.includes('--live')) {
    console.log('\nA real edit through the local model (nothing is inserted):');
    const { createProvider } = require('../src/core/llm/provider');
    const { config } = require('../src/core/config');
    const provider = createProvider('ollama', { baseUrl: config.get('llm.baseUrl') });
    if (!(await provider.available())) {
      console.log('  note  Ollama is not running; skipped');
    } else {
      const edit = new EditMode({ provider, config, bridge: fakeBridge(), logger: console });
      const r = await edit.run({
        instruction: 'fix the spelling and make it a proper sentence',
        selection: SELECTION,
        insert: false
      });
      check('the model returned an edit', r.ok === true && r.text && r.text !== SELECTION, JSON.stringify(r.text));
      check('it did not wrap the reply in quotes', !/^["'“]/.test(r.text || ''), JSON.stringify(r.text));
      check('it did not explain itself', (r.text || '').length < SELECTION.length * 3, JSON.stringify(r.text));
      console.log(`        before: "${SELECTION}"`);
      console.log(`        after:  "${r.text}"  (${r.ms}ms)`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
