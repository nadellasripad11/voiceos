'use strict';
/**
 * Shortcuts, taught phrases, corrections and the activity log.
 *
 *   node scripts/test-skills.js
 *
 * With a scripted model and a stand-in bridge, so nothing on the PC moves:
 *   - an ask the model answers with a quick tool is kept, and the same ask
 *     again runs with no model at all;
 *   - one that read something (the clipboard) is not kept;
 *   - a taught phrase runs each of its steps;
 *   - "no, I meant…" drops the shortcut and saves a rule from the model;
 *   - every tool run lands in the activity log, secrets masked.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('../src/core/agent/agent');
const { Shortcuts, normalise } = require('../src/core/agent/shortcuts');
const { ActivityLog } = require('../src/core/agent/activity-log');
const { pickControl, deletable, RISKY_BUTTON } = require('../src/core/agent/tools-desktop');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};
const quiet = { info() {}, warn() {}, debug() {}, error() {} };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));

const settings = { 'agent.confirmBeforeActions': true, 'llm.model': 'test' };
const config = { get: (k, d) => (k in settings ? settings[k] : d), set() {} };

/** A model that answers from a script: each ask gets the calls listed for it. */
function scriptedProvider(script) {
  const p = {
    calls: 0,
    streams: false,
    available: async () => true,
    chat: async ({ messages, tools }) => {
      p.calls++;
      const last = messages[messages.length - 1];
      const user = [...messages].reverse().find((m) => m.role === 'user');
      if (messages[0].content.startsWith('A user corrected')) return { text: 'When asked to open Spotify, put it on the left.' };
      if (last.role === 'tool') return { text: 'Done.' };
      const plan = script[user.content.toLowerCase()];
      if (!plan) return { text: 'I am not sure.' };
      return { text: '', toolCalls: plan.map((c, i) => ({ id: `c${p.calls}${i}`, name: c.name, args: c.args })) };
    }
  };
  return p;
}

const ran = [];
const bridge = {
  listWindows: async () => [],
  call: async (cmd, args) => (cmd === 'getClipboard' ? { text: 'copied words' } : (ran.push({ cmd, args }), { ok: true })),
  openApp: async (name) => { ran.push({ cmd: 'openApp', args: name }); return { ok: true }; }
};

(async () => {
  const memory = { added: [], add(t) { this.added.push(...t); }, summary: () => '' };
  const shortcuts = new Shortcuts({ file: path.join(dir, 'shortcuts.json'), logger: quiet });
  const activity = new ActivityLog({ file: path.join(dir, 'activity.jsonl'), logger: quiet });
  const provider = scriptedProvider({
    'do the spotify thing': [{ name: 'open_app', args: { name: 'spotify' } }],
    'what is the thing i copied': [{ name: 'read_clipboard', args: {} }],
  });
  const agent = new Agent({ provider, config, bridge, memory, shortcuts, activity, logger: quiet, requestConfirmation: async () => true });

  console.log('\nLearned shortcuts');
  await agent.run('do the spotify thing');
  const afterFirst = provider.calls;
  check('the first time goes to the model', afterFirst >= 1);
  check('a quick, working ask is kept', Boolean(shortcuts.match('Do the spotify thing, please')), JSON.stringify(shortcuts.list()));
  const r = await agent.run('Do the spotify thing please');
  check('the same ask again needs no model', provider.calls === afterFirst, `model calls ${afterFirst} -> ${provider.calls}`);
  check('and it ran the tool again', ran.filter((x) => x.cmd === 'openApp').length === 2, JSON.stringify(ran));
  check('answered by the shortcut', r.model === 'shortcut', r.model);

  await agent.run('what is the thing I copied');
  check('an ask that read something is not kept', !shortcuts.match('what is the thing i copied'));

  console.log('\nTaught phrases');
  // Parsed by the router, so no model is needed to teach it either.
  await agent.run('when I say study time, do the spotify thing');
  const taught = shortcuts.match('study time');
  check('the phrase is kept', Boolean(taught && taught.kind === 'taught'), JSON.stringify(taught));
  const before = provider.calls;
  await agent.run('study time');
  check('saying it runs its steps, with no model', provider.calls === before && ran.filter((x) => x.cmd === 'openApp').length === 3, `${before} -> ${provider.calls}`);

  console.log('\nCorrections');
  await agent.run('do the spotify thing');
  await agent.run('no, I meant put it on the left');
  await new Promise((r) => setTimeout(r, 50));
  check('the shortcut that answered is dropped', !shortcuts.match('do the spotify thing'));
  check('a rule is saved from the correction', memory.added.some((m) => /^Rule: .*Spotify/i.test(m)), JSON.stringify(memory.added));
  check('other shortcuts survive', Boolean(shortcuts.match('study time')));

  console.log('\nActivity log');
  const log = activity.recent(50);
  check('every tool run is logged', log.length >= 4 && log.some((l) => l.tool === 'open_app'), `${log.length} entries`);
  activity.add({ tool: 'call_service', args: { api_key: 'sk-123', path: '/x' }, ok: true, summary: 'ok' });
  check('secrets are masked', activity.recent(1)[0].args.api_key === '•••');

  console.log('\nButtons and deletes');
  const list = [{ name: 'Shuffle', type: 'Button' }, { name: 'Repeat', type: 'Button' }, { name: 'Send message', type: 'Button' }];
  check('an exact name wins', pickControl(list, 'shuffle').name === 'Shuffle');
  check('words in common find it', pickControl(list, 'the send button').name === 'Send message');
  check('nothing close is nothing', pickControl(list, 'volume') === null);
  check('Send and Delete ask first', RISKY_BUTTON.test('Send message') && RISKY_BUTTON.test('Delete') && !RISKY_BUTTON.test('Shuffle'));
  check('own files may go to the Recycle Bin', deletable(path.join(os.homedir(), 'Documents', 'a.txt')));
  check('Windows and AppData may not', !deletable('C:\\Windows\\notepad.exe') && !deletable(path.join(os.homedir(), 'AppData', 'x.txt')));
  check('normalising drops filler', normalise('Hey Jarvis, could you open Spotify please?') === 'open spotify');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
