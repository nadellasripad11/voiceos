'use strict';
/**
 * The task agent: doing a piece of work, and being clear about where it came from.
 *
 *   node scripts/test-task.js
 *
 * The model and the browser are stubbed, so this runs offline and fast. What
 * is being tested is not whether the model writes well — it is whether the
 * result says truthfully how it was arrived at.
 *
 * That is the whole point of the file under test. Twice in this project an
 * answer has been presented as researched when it was recalled: grades read
 * out of the wrong system, and an otter fact recited from memory under a claim
 * of having looked it up. Both read as confident and correct. So: found is
 * found, written is written, and the two are never swapped.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTask, isProduction } = require('../src/core/agent/task');

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { console.log(`  PASS  ${n}`); pass++; }
  else { console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); fail++; }
};

const quiet = { info() {}, warn() {}, debug() {} };
const tmp = path.join(os.tmpdir(), 'voiceos-task-tests');
const config = {
  get: (k, d) => (k === 'tasks.folder' ? tmp : (k === 'llm.model' ? 'stub' : d)),
  set: () => {}
};

/** A model that answers whatever it is told to. */
function stubProvider(replies) {
  const calls = [];
  return {
    calls,
    get streams() { return false; },
    async chat(req) {
      calls.push(req);
      const system = (req.messages.find((m) => m.role === 'system') || {}).content || '';
      // The page-reading prompt and the writing prompt are distinguishable.
      const forPage = /only the page below/i.test(system);
      const reply = forPage ? replies.page : replies.write;
      return { text: typeof reply === 'function' ? reply(req) : (reply || ''), toolCalls: [] };
    }
  };
}

/** A browser whose page says whatever the test wants. */
function stubBrowser(pageText, title = 'Test Page', url = 'https://example.com/a') {
  return {
    async launch() {},
    async openOrReuse() {
      return {
        page: {
          async navigate() {},
          async url() { return url; },
          async title() { return title; },
          async evaluate(expr) {
            // page-map asks for the whole page as JSON.
            if (String(expr).includes('THINGS YOU CAN DO') || String(expr).includes('data-voiceos-ref')) {
              return JSON.stringify({ url, title, text: pageText, items: [], scrollY: 0, scrollHeight: 100 });
            }
            return JSON.stringify({ url, title, text: pageText, items: [] });
          }
        }
      };
    }
  };
}

// No test here should touch the network. One of them did, silently, and so
// measured the real web instead of the branch it was meant to exercise.
let allowFetch = null;
const realFetch = global.fetch;
global.fetch = async (...args) => {
  if (allowFetch) return allowFetch(...args);
  throw new Error('network disabled in tests');
};

(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('\nA question and a piece of work are not the same thing:');
  for (const [goal, want] of [
    ['How much does a capybara weigh?', false],
    ['what is due this week', false],
    ['who is Ada Lovelace', false],
    ['explain photosynthesis', false],
    ['Write a short paragraph explaining what I learned', true],
    ['answer these questions', true],
    ['finish my essay', true],
    ['summarise this page', true],
    ['solve these problems', true],
    ['explain photosynthesis in a paragraph', true]
  ]) {
    check(`"${goal.slice(0, 44)}" is ${want ? 'work' : 'a question'}`, isProduction(goal) === want);
  }

  console.log('\nAn answer that is on the page is reported as found:');
  {
    const browser = stubBrowser('The capybara is the largest living rodent. Adults weigh 35 to 66 kg.');
    const provider = stubProvider({ page: 'Capybaras weigh 35 to 66 kg.' });
    const r = await runTask({
      goal: 'How much does a capybara weigh?', url: 'https://example.com/a',
      browser, provider, model: 'stub', config, logger: quiet
    });
    check('it is found, not written', r.found.length === 1 && !r.written, JSON.stringify({ found: r.found, written: r.written }));
    check('the page is cited', r.sources.some((s) => /example\.com/.test(s)), JSON.stringify(r.sources));
    check('the report says FOUND', /FOUND/.test(r.summary), r.summary);
    check('and does not claim to have written it', !/WRITTEN BY ME/.test(r.summary), r.summary);
  }

  console.log('\nAn answer that is NOT on the page is not passed off as found:');
  {
    // The model answers from its own memory; the page says nothing of the kind.
    const browser = stubBrowser('Kelis Rogers is an American singer and songwriter.');
    const provider = stubProvider({
      page: 'Otters belong to the family Mustelidae.',
      write: 'Otters are in the family Mustelidae, which also includes badgers and weasels.'
    });
    const r = await runTask({
      goal: 'What family do otters belong to?', url: 'https://example.com/a',
      browser, provider, model: 'stub', config, logger: quiet
    });
    check('the ungrounded page answer is rejected and nothing is claimed found',
      r.found.length === 0, JSON.stringify(r.found));
    check('it is reported as written instead', Boolean(r.written), JSON.stringify(r.written));
    check('and labelled as unchecked', /WRITTEN BY ME/.test(r.summary), r.summary);
  }

  console.log('\nWork is written, not searched for:');
  {
    // The failure that prompted this: asked to write a paragraph, it searched
    // the web, found blog posts about how to write paragraphs, and reported
    // them under FOUND.
    const provider = stubProvider({ write: 'The Day 19 assignment taught me to structure a pitch.' });
    const r = await runTask({
      goal: 'Write a short paragraph explaining what I learned',
      browser: null, provider, model: 'stub', config, logger: quiet
    });
    check('nothing is claimed as found', r.found.length === 0, JSON.stringify(r.found));
    check('the work is produced', /Day 19/.test(r.written || ''), String(r.written));
    check('it is labelled as mine', /WRITTEN BY ME/.test(r.summary), r.summary);
    check('the web was never searched',
      provider.calls.every((c) => !/SOURCE \d/.test(JSON.stringify(c.messages))),
      'it searched anyway');
  }

  console.log('\nA page becomes the material to work from:');
  {
    const browser = stubBrowser('Question 1: Name three causes of the French Revolution.');
    let sawPage = false;
    const provider = stubProvider({
      write: (req) => {
        sawPage = /French Revolution/.test(JSON.stringify(req.messages));
        return 'Taxation, famine, and the example of the American Revolution.';
      }
    });
    const r = await runTask({
      goal: 'answer these questions', url: 'https://example.com/a',
      browser, provider, model: 'stub', config, logger: quiet
    });
    check('the page is read and passed to the writing', sawPage, 'the page never reached the model');
    check('the answer is produced', Boolean(r.written), String(r.written));
    check('and still labelled as written', /WRITTEN BY ME/.test(r.summary), r.summary);
  }

  console.log('\nThe work is left somewhere:');
  {
    const provider = stubProvider({ write: 'Some finished work.' });
    const r = await runTask({
      goal: 'write something short', browser: null, provider, model: 'stub', config, logger: quiet
    });
    check('a file is written', r.file && fs.existsSync(r.file), String(r.file));
    const body = r.file ? fs.readFileSync(r.file, 'utf8') : '';
    check('it carries the goal', /write something short/i.test(body), body.slice(0, 80));
    check('and the same labelling as the reply', /Written by me/i.test(body), body.slice(0, 200));
  }

  console.log('\nWhen there is no model at all:');
  {
    const r = await runTask({ goal: 'write something', browser: null, provider: null, config, logger: quiet });
    check('it says so rather than inventing', r.ok === false && /model/i.test(r.summary), JSON.stringify(r.summary));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
